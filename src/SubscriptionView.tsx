import { useMemo, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { formatMonthDayWeekday } from "./dateUtils";
import { ruleLabel } from "./recurrence";
import { formatYen } from "./money";
import { getAll, newBase, saveStores } from "./storage";
import {
  REVIEW_INTERVAL_DAYS,
  continuedAfterCancel,
  endRecurringBeforeNext,
  findMatchingRecurrings,
  isReviewDue,
  isStale,
  lastReviewDate,
  latestDecisions,
  monthlyTotal,
  recordDecision,
  summarizeSubscriptions,
} from "./subscriptionLogic";
import type { ShowToast } from "./Toast";
import type { Id, Recurring, SubscriptionDecision, SubscriptionReview, Transaction } from "./types";

interface Props {
  transactions: readonly Transaction[];
  reviews: readonly SubscriptionReview[];
  today: string;
  showToast: ShowToast;
  /** 記録したあと（ホームのお知らせなどを読み直してもらう） */
  onChanged: () => void;
}

function dateWithYear(d: string): string {
  return `${d.slice(0, 4)}/${formatMonthDayWeekday(d)}`;
}

/** サブスク見直し：サブスクの分類の一覧で、3か月に1回「続ける／やめる」を記録する */
export function SubscriptionView({ transactions, reviews, today, showToast, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  /** 「やめる」を押したとき、同じ内容の繰り返しが見つかった：終わりにするか聞く */
  const [asking, setAsking] = useState<{ content: string; amount: number; recs: Recurring[]; endThem: boolean } | null>(null);
  const summaries = useMemo(() => summarizeSubscriptions(transactions), [transactions]);
  const decisions = useMemo(() => latestDecisions(reviews), [reviews]);
  const continued = useMemo(() => new Map(continuedAfterCancel(reviews, transactions).map((c) => [c.key, c])), [reviews, transactions]);
  const last = lastReviewDate(reviews);
  const due = isReviewDue(reviews, transactions, today);
  const monthly = monthlyTotal(summaries, decisions, today);

  /** 「やめる」：同じ内容・同じ分類の、終わっていない繰り返しがあれば聞く。なければそのまま記録 */
  const askCancel = async (content: string, amount: number, categoryId: Id | undefined) => {
    if (busy) return;
    try {
      const recs = findMatchingRecurrings(await getAll("recurrings"), content, categoryId, today);
      if (recs.length > 0) {
        setAsking({ content, amount, recs, endThem: true });
        return;
      }
    } catch {
      // 繰り返しを読めなかったときは、記録だけ行う
    }
    await decide(content, amount, "cancel");
  };

  const decide = async (content: string, amount: number, decision: SubscriptionDecision, endRecs: readonly Recurring[] = []) => {
    if (busy) return;
    setBusy(true);
    try {
      const rec = recordDecision(reviews, today, { content, decision, amount }, () => newBase());
      const ended = endRecs.map((r) => endRecurringBeforeNext(r, today)).filter((r): r is Recurring => r !== null);
      await saveStores({ subscriptionReviews: [rec], ...(ended.length > 0 ? { recurrings: ended } : {}) });
      showToast(
        decision === "keep" ? `「${content}」は続けると記録しました` : ended.length > 0 ? `「${content}」はやめると記録し、繰り返しも終わりにしました` : `「${content}」はやめると記録しました`,
      );
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "記録できませんでした");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card summary-section" aria-label="サブスク見直し">
      <h2>サブスク見直し</h2>
      <p className="muted small">
        サブスクの分類の支出を、内容ごとにまとめています。{REVIEW_INTERVAL_DAYS}日（3か月）に1回、続けるかやめるかを記録します。
        {last ? `最後の見直し：${dateWithYear(last)}。` : "まだ見直していません。"}
      </p>
      {due && <p className="payroll-note review-due">サブスクを見直す時期です</p>}
      {summaries.length === 0 ? (
        <p className="empty-note">サブスクの分類の明細はまだありません。</p>
      ) : (
        <>
          <p className="field-hint">毎月続いているものの合計の目安：{formatYen(monthly)}（やめると記録したものは除く）</p>
          <ul className="list sub-list">
            {summaries.map((s) => {
              const d = decisions.get(s.key);
              const cont = continued.get(s.key);
              return (
                <li key={s.key} className={`sub-row${d?.decision === "cancel" && !cont ? " dim" : ""}`}>
                  <div className="sub-head">
                    <span className="list-name">{s.content}</span>
                    <span className="list-amount">{formatYen(s.amount)}</span>
                  </div>
                  <p className="list-sub">
                    {s.monthly ? (isStale(s.lastDate, today) ? "毎月だった（最近は払っていない）" : "毎月") : "毎月ではない"}・最後に払った日 {dateWithYear(s.lastDate)}・{s.count}回
                    {d ? `・${dateWithYear(d.reviewedAt)}に「${d.decision === "keep" ? "続ける" : "やめる"}」` : ""}
                  </p>
                  {cont && <p className="field-error">やめると決めたのに続いています（決めた日 {dateWithYear(cont.decidedAt)}、最後の支払い {dateWithYear(cont.lastDate)}）。解約できているか確かめてください。</p>}
                  <div className="sub-actions" role="group" aria-label={`${s.content}を続けるか`}>
                    <button type="button" className={`chip${d?.decision === "keep" ? " on" : ""}`} aria-pressed={d?.decision === "keep"} disabled={busy} onClick={() => void decide(s.content, s.amount, "keep")}>
                      続ける
                    </button>
                    <button type="button" className={`chip${d?.decision === "cancel" ? " on" : ""}`} aria-pressed={d?.decision === "cancel"} disabled={busy} onClick={() => void askCancel(s.content, s.amount, s.categoryId)}>
                      やめる
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {asking && (
        <BottomSheet title={`「${asking.content}」をやめる`} onClose={() => setAsking(null)}>
          <p className="sheet-message">同じ内容の繰り返しが見つかりました。</p>
          <ul className="list">
            {asking.recs.map((r) => (
              <li key={r.id} className="list-row static">
                <span className="list-main">
                  <span className="list-name">{r.template.content || "（内容なし）"}</span>
                  <span className="list-sub">{ruleLabel(r.rule)}</span>
                </span>
                <span className="list-amount">{formatYen(r.template.amount)}</span>
              </li>
            ))}
          </ul>
          <label className="check-row">
            <input type="checkbox" checked={asking.endThem} onChange={(e) => setAsking({ ...asking, endThem: e.target.checked })} />
            <span>この繰り返しも終わりにする（終わりの日は次の予定日の前日。作り済みの明細は残します）</span>
          </label>
          <div className="sheet-actions">
            <button type="button" className="secondary-btn" onClick={() => setAsking(null)}>
              やめる
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={() => {
                const a = asking;
                void decide(a.content, a.amount, "cancel", a.endThem ? a.recs : []).then(() => setAsking(null));
              }}
            >
              記録する
            </button>
          </div>
        </BottomSheet>
      )}
    </section>
  );
}
