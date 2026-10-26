import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AdjustSheet } from "./AdjustSheet";
import type { EntryMode } from "./EntryView";
import { debitDueNotices, upcomingCardDebits } from "./cardDebitLogic";
import { MonthCard, WeekCard } from "./BudgetCard";
import { backupNotice, summarizeHome } from "./budgetLogic";
import { recalcBudget, useBudgetBundle } from "./budgetStore";
import { formatMonthDayWeekday } from "./dateUtils";
import { Fab } from "./Fab";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { OutstandingView } from "./OutstandingView";
import { ReservesView } from "./ReservesView";
import { estimatedTransactions } from "./recurrence";
import { outstandingGroups, outstandingSummary } from "./reimburseLogic";
import { isReviewDue } from "./subscriptionLogic";
import { prepareCardDebitOn } from "./transferLogic";
import { useToast } from "./Toast";
import { TxRow } from "./TxRow";
import { UsableCard } from "./UsableCard";
import { WelcomeCard } from "./WelcomeCard";
import type { Id, Settings, Transaction } from "./types";

interface Props {
  tabBar: ReactNode;
  today: string;
  /** 保存・削除などで増える。変わったら読み直す */
  version: number;
  settings: Settings;
  onOpenSettings: () => void;
  onAdd: (date: string) => void;
  onEdit: (tx: Transaction) => void;
  /** 入力画面を開く（カードの引き落としの記録） */
  onOpenEntry: (mode: EntryMode) => void;
  /** 給料明細の入力を開く */
  onOpenPayroll: () => void;
  /** 明細タブへ */
  onGoEntries: () => void;
  /** 資産タブへ（はじめに） */
  onGoAssets: () => void;
  /** 設定の分類（支出）を開く（はじめに） */
  onGoCategories: () => void;
  /** 集計タブへ（サブスク見直しのお知らせ） */
  onGoSummary: () => void;
  onChanged: () => void;
}

type Page = "home" | "reserves" | "outstanding";

/** ホーム：今週あと◯円、給料日までに使える額、今月の予算、取り置き、お知らせ、最近の明細 */
export function HomeView({ tabBar, today, version, settings, onOpenSettings, onAdd, onEdit, onOpenEntry, onOpenPayroll, onGoEntries, onGoAssets, onGoCategories, onGoSummary, onChanged }: Props) {
  const [page, setPage] = useState<Page>("home");
  const [adjusting, setAdjusting] = useState<Transaction | null>(null);
  const [toast, showToast] = useToast();
  const { bundle, error } = useBudgetBundle(version, { settings, today });

  const summary = useMemo(() => (bundle ? summarizeHome(bundle, bundle.budgetSnapshots, settings, today) : null), [bundle, settings, today]);
  const accountNames = useMemo(() => new Map<Id, string>((bundle?.accounts ?? []).map((a) => [a.id, a.name])), [bundle]);
  const outstanding = useMemo(() => outstandingSummary(outstandingGroups(bundle?.transactions ?? [])), [bundle]);
  const recent = useMemo(
    () =>
      (bundle?.transactions ?? [])
        .filter((t) => t.deletedAt === null && t.date <= today)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, 5),
    [bundle, today],
  );
  const debits = useMemo(() => (bundle ? upcomingCardDebits(bundle, today) : []), [bundle, today]);
  const dueNotices = useMemo(() => (bundle ? debitDueNotices(bundle, today) : []), [bundle, today]);
  const estimated = useMemo(() => estimatedTransactions(bundle?.transactions ?? []), [bundle]);

  const recalc = (kind: "week" | "month") => async () => {
    try {
      await recalcBudget(kind, settings, today);
      showToast(kind === "week" ? "今週の予算を決めました" : "今月の予算を決めました");
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "予算を決められませんでした");
    }
  };

  const select = (tx: Transaction) => {
    if (tx.type === "adjustment") setAdjusting(tx);
    else onEdit(tx);
  };

  if (page === "reserves" && bundle && summary) {
    return <ReservesView bundle={bundle} today={today} usable={summary.usable.usable} onBack={() => setPage("home")} onChanged={onChanged} showToast={showToast} />;
  }
  if (page === "outstanding") {
    return (
      <>
        <OutstandingView version={version} onBack={() => setPage("home")} onOpen={onEdit} />
        {toast}
      </>
    );
  }

  const notices: Array<{ key: string; text: string; action?: { label: string; run: () => void } }> = [];
  if (summary) {
    const backup = backupNotice(settings, summary.hasTransactions, today);
    if (backup) notices.push({ key: "backup", text: backup, action: { label: "保存する", run: onOpenSettings } });
    if (estimated.length > 0) notices.push({ key: "estimated", text: `見込みのままの明細 ${estimated.length}件`, action: { label: "直す", run: () => onEdit(estimated[0]) } });
    if (bundle && isReviewDue(bundle.subscriptionReviews, bundle.transactions, today)) {
      notices.push({ key: "subscription", text: "サブスクを見直す時期です", action: { label: "見直す", run: onGoSummary } });
    }
    for (const d of dueNotices) {
      const card = bundle?.accounts.find((a) => a.id === d.cardId && a.deletedAt === null);
      if (!card || !bundle) continue;
      notices.push({
        key: `debit-${d.cardId}`,
        text: `${d.date === today ? "今日は" : `${formatMonthDayWeekday(d.date)}は`}${d.cardName}の引き落とし日です`,
        action: {
          label: "引き落としを記録",
          run: () => onOpenEntry({ kind: "new", date: d.date, transfer: prepareCardDebitOn(card, bundle.accounts.filter((a) => a.deletedAt === null), d.amount, d.date) }),
        },
      });
    }
    if (summary.salaryPending) {
      notices.push({ key: "salary", text: `${formatMonthDayWeekday(summary.salaryPending)}の給料明細がまだです`, action: { label: "入れる", run: onOpenPayroll } });
    }
  }

  return (
    <>
      <header className="topbar">
        <h1 className="topbar-title">ホーム</h1>
        <button type="button" className="icon-btn" aria-label="設定" onClick={onOpenSettings}>
          <Icon name="settings" size={22} />
        </button>
      </header>
      <main className="content home-content">
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        {!summary && !error && <p className="muted small">データを準備しています…</p>}
        {summary && (
          <>
            {summary.firstUse && <WelcomeCard onGoAssets={onGoAssets} onGoCategories={onGoCategories} onAdd={() => onAdd(today)} onOpenSettings={onOpenSettings} />}
            <WeekCard
              week={summary.week}
              bars={summary.week.bars}
              figure={settings.homeMainFigure}
              today={today}
              hasData={summary.hasTransactions}
              onRecalc={recalc("week")}
              manual={summary.manual}
              limitText={summary.limit ? `使い切れる上限：週 ${formatYen(summary.limit.week)}` : null}
            />
            <UsableCard summary={summary} />
            <MonthCard
              month={summary.month}
              hasData={summary.hasTransactions}
              onRecalc={recalc("month")}
              onOpenPayroll={onOpenPayroll}
              manual={summary.manual}
              limitText={summary.limit && summary.limit.month !== null ? `使い切れる上限：月 ${formatYen(summary.limit.month)}` : null}
            />
            {debits.length > 0 && (
              <section className="card list-card debit-list" aria-label="引き落とし予定">
                <h2 className="list-head">
                  <span>引き落とし予定</span>
                </h2>
                <ul className="list">
                  {debits.map((d) => (
                    <li key={`${d.cardId}-${d.date}`} className="list-row static">
                      <span className="list-main">
                        <span className="list-name">
                          {formatMonthDayWeekday(d.date)} {d.cardName}
                        </span>
                        <span className="list-sub">
                          {d.paymentAccountName}から{d.source === "estimate" ? "・見込み（照合していない明細の合計）" : ""}
                        </span>
                        {d.shortfall > 0 && <span className="list-sub caution">残高が {formatYen(d.shortfall)} 足りません</span>}
                      </span>
                      <span className="list-amount">{formatYen(d.amount)}</span>
                    </li>
                  ))}
                </ul>
                <p className="field-hint list-intro">カードで使った時点で使える額から引いているので、使える額には影響しません。</p>
              </section>
            )}

            <button type="button" className="link-row" onClick={() => setPage("reserves")}>
              <span>取り置き</span>
              <span className="link-row-value">
                {formatYen(summary.reserveTotal)}
                <Icon name="chevron-right" size={18} />
              </span>
            </button>
            {outstanding.count > 0 && (
              <button type="button" className="link-row" onClick={() => setPage("outstanding")}>
                <span>未回収の立替</span>
                <span className="link-row-value">
                  {outstanding.count}件 {formatYen(outstanding.total)}
                  <Icon name="chevron-right" size={18} />
                </span>
              </button>
            )}

            {notices.length > 0 && (
              <section className="notice-list" aria-label="お知らせ">
                {notices.map((n) => (
                  <div key={n.key} className="payroll-note">
                    <span>{n.text}</span>
                    {n.action && (
                      <button type="button" className="text-btn" onClick={n.action.run}>
                        {n.action.label}
                      </button>
                    )}
                  </div>
                ))}
              </section>
            )}

            <h2 className="list-group-title">最近の明細</h2>
            {recent.length === 0 ? (
              <p className="empty-note">まだ明細はありません。右下の＋から入れられます。</p>
            ) : (
              <section className="card list-card recent-list">
                <ul className="list">
                  {recent.map((t) => (
                    <li key={t.id}>
                      <TxRow tx={t} accountNames={accountNames} categories={bundle?.categories ?? []} onSelect={select} />
                    </li>
                  ))}
                </ul>
                <div className="more-row">
                  <button type="button" className="text-btn" onClick={onGoEntries}>
                    明細をもっと見る
                  </button>
                </div>
              </section>
            )}
          </>
        )}
        <div className="fab-space" aria-hidden="true" />
      </main>
      <Fab onClick={() => onAdd(today)} />
      {tabBar}
      {adjusting && bundle?.accounts.find((a) => a.id === adjusting.accountId) && (
        <AdjustSheet
          account={bundle.accounts.find((a) => a.id === adjusting.accountId)!}
          mode={{ kind: "edit", tx: adjusting }}
          today={today}
          showToast={showToast}
          onChanged={onChanged}
          onClose={() => setAdjusting(null)}
        />
      )}
      {toast}
    </>
  );
}
