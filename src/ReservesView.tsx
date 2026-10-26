import { useMemo, useState } from "react";
import type { BudgetBundle } from "./budgetStore";
import { formatMonthJa } from "./dateUtils";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { ReserveDetailView } from "./ReserveDetailView";
import { ReserveEditor } from "./ReserveEditor";
import { reserveBalances, splitReserves, targetNote, totalReserveBalance } from "./reserveLogic";
import { plannedNotesByReserve } from "./plannedLogic";
import type { ShowToast } from "./Toast";
import type { Id, Reserve } from "./types";

/** 取り置きの一覧の上の説明 */
export const RESERVE_INTRO = "今あるお金を、アプリの中で先に別枠にしておきます。口座は動きません";

interface RowsProps {
  reserves: Reserve[];
  balances: ReadonlyMap<Id, number>;
  /** 結んでいる予定出費の説明（取り置きのid → 「予定：帰省 2027-01」） */
  plannedNotes?: ReadonlyMap<Id, string>;
  onOpen: (id: Id) => void;
}

/** 取り置きの行(名前・目標・使う月・残高) */
export function ReserveRows({ reserves, balances, plannedNotes, onOpen }: RowsProps) {
  return (
    <ul className="list">
      {reserves.map((r) => {
        const balance = Math.max(0, balances.get(r.id) ?? 0);
        const note = targetNote(r, balance);
        const month = r.targetMonth ? `${formatMonthJa(r.targetMonth)}に使う` : "";
        return (
          <li key={r.id}>
            <button type="button" className="list-row" onClick={() => onOpen(r.id)}>
              <span className="list-main">
                <span className="list-name">{r.name}</span>
                {(note || month) && <span className="list-sub">{[month, note].filter(Boolean).join("・")}</span>}
                {plannedNotes?.get(r.id) && <span className="list-sub">{plannedNotes.get(r.id)}</span>}
              </span>
              <span className="list-amount">{formatYen(balance)}</span>
              <Icon name="chevron-right" size={18} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface Props {
  bundle: BudgetBundle;
  today: string;
  /** いまの使える額(入れすぎの案内に使う) */
  usable: number | null;
  initialOpenId?: Id | null;
  initialAdding?: boolean;
  onBack: () => void;
  onChanged: () => void;
  showToast: ShowToast;
}

/** 取り置きの一覧の画面(ホームの取り置きの行・見通しタブから開く)。行を押すと出し入れの履歴 */
export function ReservesView({ bundle, today, usable, initialOpenId = null, initialAdding = false, onBack, onChanged, showToast }: Props) {
  const [openId, setOpenId] = useState<Id | null>(initialOpenId);
  const [adding, setAdding] = useState(initialAdding);
  const { open, closed } = useMemo(() => splitReserves(bundle.reserves), [bundle.reserves]);
  const balances = useMemo(() => reserveBalances(bundle.reserveMoves), [bundle.reserveMoves]);
  const total = totalReserveBalance(bundle.reserves, bundle.reserveMoves);
  const plannedNotes = useMemo(() => plannedNotesByReserve(bundle.plannedExpenses), [bundle.plannedExpenses]);
  const opened = openId ? bundle.reserves.find((r) => r.id === openId && r.deletedAt === null) : undefined;

  if (opened) {
    return (
      <ReserveDetailView reserve={opened} bundle={bundle} today={today} usable={usable} onBack={() => setOpenId(null)} onChanged={onChanged} showToast={showToast} />
    );
  }

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">取り置き</h1>
        <button type="button" className="text-btn" onClick={() => setAdding(true)}>
          追加
        </button>
      </header>
      <main className="content">
        <section className="card summary">
          <p className="summary-label">取り置きの合計</p>
          <p className="summary-main">{formatYen(total)}</p>
          <p className="summary-note">使える額からは、この分を先に外しています。</p>
        </section>
        {open.length === 0 ? (
          <section className="card">
            <p className="field-hint list-intro">{RESERVE_INTRO}</p>
            <p>取り置きはまだありません。旅行や車検など、先の出費のためにお金を外しておくときに作ります。</p>
          </section>
        ) : (
          <section className="card list-card">
            <p className="field-hint list-intro">{RESERVE_INTRO}</p>
            <ReserveRows reserves={open} balances={balances} plannedNotes={plannedNotes} onOpen={setOpenId} />
          </section>
        )}
        {closed.length > 0 && (
          <>
            <h2 className="list-group-title">閉じた取り置き</h2>
            <section className="card list-card">
              <ReserveRows reserves={closed} balances={balances} plannedNotes={plannedNotes} onOpen={setOpenId} />
            </section>
          </>
        )}
      </main>
      {adding && (
        <ReserveEditor
          reserve={null}
          reserves={bundle.reserves}
          showToast={showToast}
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
