import { useEffect, useMemo, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { shortDate } from "./periodLogic";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { outstandingGroups, outstandingSummary } from "./reimburseLogic";
import type { OutstandingGroup, OutstandingItem } from "./reimburseLogic";
import { getReimburseSet } from "./reimburseStore";
import type { Transaction } from "./types";

/** 相手ごとの未回収の一覧（相手の合計と、その中の明細。古い順） */
export function OutstandingList({ groups, onPick }: { groups: OutstandingGroup[]; onPick: (item: OutstandingItem) => void }) {
  return (
    <div className="outstanding-groups">
      {groups.map((g) => (
        <section key={g.counterparty} className="card list-card outstanding-group">
          <h2 className="list-head">
            <span>{g.counterparty}</span>
            <span>{formatYen(g.remaining)}</span>
          </h2>
          <ul className="list">
            {g.items.map((item) => (
              <li key={item.tx.id}>
                <button type="button" className="list-row" onClick={() => onPick(item)}>
                  <span className="list-main">
                    <span className="list-name">{item.tx.content || "（内容なし）"}</span>
                    <span className="list-sub">
                      {shortDate(item.tx.date)}・立替 {formatYen(item.amount)}・返ってきた額 {formatYen(item.returned)}
                    </span>
                  </span>
                  <span className="list-amount">残り {formatYen(item.remaining)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 未回収の立替の一覧（資産タブから開く画面）。明細を押すとその支出の編集を開く */
export function OutstandingView({ version, onBack, onOpen }: { version: number; onBack: () => void; onOpen: (tx: Transaction) => void }) {
  const [set, setSet] = useState<Transaction[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    getReimburseSet()
      .then((s) => !cancelled && setSet(s))
      .catch(() => !cancelled && setSet([]));
    return () => {
      cancelled = true;
    };
  }, [version]);
  const groups = useMemo(() => outstandingGroups(set ?? []), [set]);
  const summary = outstandingSummary(groups);
  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">未回収の立替</h1>
      </header>
      <main className="content">
        {set !== null && groups.length === 0 && (
          <section className="card">
            <p>未回収の立替はありません。</p>
          </section>
        )}
        {groups.length > 0 && (
          <>
            <p className="muted small">
              {summary.count}件 {formatYen(summary.total)}
            </p>
            <OutstandingList groups={groups} onPick={(item) => onOpen(item.tx)} />
          </>
        )}
      </main>
    </>
  );
}

/** 返金の入力で「返金した立替」を選ぶシート */
export function OutstandingPicker({ groups, onPick, onClose }: { groups: OutstandingGroup[]; onPick: (item: OutstandingItem) => void; onClose: () => void }) {
  return (
    <BottomSheet title="返金した立替を選ぶ" onClose={onClose}>
      {groups.length === 0 ? <p className="sheet-message">未回収の立替はありません。</p> : <OutstandingList groups={groups} onPick={onPick} />}
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </BottomSheet>
  );
}
