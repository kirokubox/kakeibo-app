import { useMemo, useState } from "react";
import { formatMonthDayWeekday } from "./dateUtils";
import { formatYen } from "./money";
import { newBase, saveRecord } from "./storage";
import {
  REVIEW_INTERVAL_DAYS,
  continuedAfterCancel,
  isReviewDue,
  isStale,
  lastReviewDate,
  latestDecisions,
  monthlyTotal,
  recordDecision,
  summarizeSubscriptions,
} from "./subscriptionLogic";
import type { ShowToast } from "./Toast";
import type { SubscriptionDecision, SubscriptionReview, Transaction } from "./types";

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

/** サブスク見直し：固定費＞サブスクの一覧で、3か月に1回「続ける／やめる」を記録する */
export function SubscriptionView({ transactions, reviews, today, showToast, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const summaries = useMemo(() => summarizeSubscriptions(transactions), [transactions]);
  const decisions = useMemo(() => latestDecisions(reviews), [reviews]);
  const continued = useMemo(() => new Map(continuedAfterCancel(reviews, transactions).map((c) => [c.key, c])), [reviews, transactions]);
  const last = lastReviewDate(reviews);
  const due = isReviewDue(reviews, transactions, today);
  const monthly = monthlyTotal(summaries, decisions, today);

  const decide = async (content: string, amount: number, decision: SubscriptionDecision) => {
    if (busy) return;
    setBusy(true);
    try {
      const rec = recordDecision(reviews, today, { content, decision, amount }, () => newBase());
      await saveRecord("subscriptionReviews", rec);
      showToast(decision === "keep" ? `「${content}」は続けると記録しました` : `「${content}」はやめると記録しました`);
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
        固定費＞サブスクの支出を、内容ごとにまとめています。{REVIEW_INTERVAL_DAYS}日（3か月）に1回、続けるかやめるかを記録します。
        {last ? `最後の見直し：${dateWithYear(last)}。` : "まだ見直していません。"}
      </p>
      {due && <p className="payroll-note review-due">サブスクを見直す時期です</p>}
      {summaries.length === 0 ? (
        <p className="empty-note">固定費＞サブスクの明細はまだありません。</p>
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
                    <button type="button" className={`chip${d?.decision === "cancel" ? " on" : ""}`} aria-pressed={d?.decision === "cancel"} disabled={busy} onClick={() => void decide(s.content, s.amount, "cancel")}>
                      やめる
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
