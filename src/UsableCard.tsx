import { useState } from "react";
import { BottomSheet } from "./BottomSheet";
import type { HomeSummary } from "./budgetLogic";
import { addDays, formatMonthDayWeekday } from "./dateUtils";
import { formatYen } from "./money";

/** 給料日までに使える額のカード。押すと内訳 */
export function UsableCard({ summary }: { summary: HomeSummary }) {
  const [open, setOpen] = useState(false);
  const u = summary.usable;
  const hasData = summary.hasTransactions;
  const negative = u.usable < 0;
  return (
    <>
      <button type="button" className="card home-card usable-card" onClick={() => setOpen(true)} aria-label="給料日までに使える額。内訳を見る">
        <span className="home-label">給料日までに使える額</span>
        {!hasData ? (
          <span className="home-hint">明細を入れると、使える額が出ます</span>
        ) : negative ? (
          <>
            <span className="home-big caution">生活防衛資金を{formatYen(-u.usable)}割り込む見込みです</span>
            <UsableSub perDay="—" days={u.days} deadline={u.deadline} />
          </>
        ) : (
          <>
            <span className="home-big">{formatYen(u.usable)}</span>
            <UsableSub perDay={formatYen(u.perDay)} days={u.days} deadline={u.deadline} />
          </>
        )}
        <span className="home-more">内訳を見る</span>
      </button>
      {open && <UsableBreakdown summary={summary} onClose={() => setOpen(false)} />}
    </>
  );
}

function UsableSub({ perDay, days, deadline }: { perDay: string; days: number; deadline: string }) {
  return (
    <span className="home-sub">
      <span>1日あたり {perDay}</span>
      <span>
        給料日まであと{days}日（{formatMonthDayWeekday(deadline)}）
      </span>
    </span>
  );
}

function UsableBreakdown({ summary, onClose }: { summary: HomeSummary; onClose: () => void }) {
  const u = summary.usable;
  return (
    <BottomSheet title="使える額の内訳" onClose={onClose}>
      <dl className="rows breakdown">
        <div className="row">
          <dt>使える資産</dt>
          <dd>{formatYen(u.usableAssets)}</dd>
        </div>
        <div className="row">
          <dt>− 生活防衛資金</dt>
          <dd>{formatYen(u.defenseFund)}</dd>
        </div>
        <div className="row">
          <dt>− 取り置き</dt>
          <dd>{formatYen(u.reserveTotal)}</dd>
        </div>
        <div className="row">
          <dt>− 決まった出費</dt>
          <dd>{formatYen(u.committed)}</dd>
        </div>
        <div className="row total">
          <dt>＝ 使える額</dt>
          <dd className={u.usable < 0 ? "caution" : undefined}>{formatYen(u.usable)}</dd>
        </div>
      </dl>
      <h3 className="breakdown-title">決まった出費の中身</h3>
      {u.items.length === 0 ? (
        <p className="muted small">給料日の前日（{formatMonthDayWeekday(addDays(u.deadline, -1))}）までの予定はありません。</p>
      ) : (
        <ul className="list breakdown-list">
          {u.items.map((i, idx) => (
            <li key={`${i.date}-${i.label}-${idx}`} className="list-row static">
              <span className="list-main">
                <span className="list-name">{i.label}</span>
                <span className="list-sub">{i.kind === "planned" ? `予定出費（${i.date.slice(0, 7)}）` : formatMonthDayWeekday(i.date)}</span>
              </span>
              <span className="list-amount">{formatYen(i.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small breakdown-note">
        残り{u.days}日（今日から給料日の前日まで）。給料日より前に入る収入は足していません。
      </p>
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </BottomSheet>
  );
}
