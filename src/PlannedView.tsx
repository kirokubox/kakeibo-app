import { useMemo, useState } from "react";
import { BottomSheet, ConfirmSheet } from "./BottomSheet";
import type { BudgetBundle } from "./budgetStore";
import { formatMonthJa, nowIso } from "./dateUtils";
import { formatYen } from "./money";
import { shortDate } from "./periodLogic";
import { doneCandidates, isPlannedDone, markPlannedDone, planSetAside, plannedStatuses, reopenPlanned, sortPlanned, validatePlannedDraft } from "./plannedLogic";
import { ReserveMoveSheet } from "./ReserveDetailView";
import { balanceOf, newMove, reserveBalances, splitReserves } from "./reserveLogic";
import { newBase, saveRecord, saveStores } from "./storage";
import type { ShowToast } from "./Toast";
import type { PlannedExpense, Reserve } from "./types";
import { YenInput } from "./YenInput";

interface Props {
  bundle: BudgetBundle;
  today: string;
  /** いまの使える額（取り置きに入れるときの案内に使う） */
  usable: number | null;
  onChanged: () => void;
  showToast: ShowToast;
}

/** 予定出費の一覧の上の説明 */
export const PLANNED_INTRO = "先の月に出ていくと分かっている出費。「取っておく」で、今のうちから使える額から外しておけます";

type Sheet = { kind: "assign"; planned: PlannedExpense; reserve: Reserve } | { kind: "menu"; planned: PlannedExpense } | { kind: "edit"; planned: PlannedExpense | null } | { kind: "done"; planned: PlannedExpense } | { kind: "delete"; planned: PlannedExpense } | null;

/** 見通しタブの「予定出費」：一覧・追加・直す・済みにする・削除 */
export function PlannedView({ bundle, today, usable, onChanged, showToast }: Props) {
  const [sheet, setSheet] = useState<Sheet>(null);

  /** 「この予定のために取っておく」：結んだ取り置きがなければ作って結び、そのまま「入れる」を開く。あれば「入れる」を開くだけ */
  const setAside = async (p: PlannedExpense) => {
    const plan = planSetAside(p, bundle.reserves, newBase());
    if (plan.kind === "existing") {
      setSheet({ kind: "assign", planned: p, reserve: plan.reserve });
      return;
    }
    try {
      await saveStores({ reserves: [plan.reserve], plannedExpenses: [plan.planned] });
      onChanged();
      setSheet({ kind: "assign", planned: plan.planned, reserve: plan.reserve });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存できませんでした");
    }
  };
  const active = useMemo(() => sortPlanned(bundle.plannedExpenses.filter((p) => p.deletedAt === null)), [bundle.plannedExpenses]);
  const statuses = useMemo(
    () => plannedStatuses(active, reserveBalances(bundle.reserveMoves)),
    [active, bundle.reserveMoves],
  );
  const reserveName = useMemo(() => new Map(bundle.reserves.map((r) => [r.id, r.name])), [bundle.reserves]);
  const open = active.filter((p) => !isPlannedDone(p));
  const done = active.filter(isPlannedDone);

  const row = (p: PlannedExpense) => {
    const st = statuses.get(p.id);
    const sub: string[] = [formatMonthJa(p.month)];
    if (isPlannedDone(p)) sub.push("済み");
    else if (p.reserveId && st) sub.push(`取り置き済み ${formatYen(st.covered)} ／ 足りない ${formatYen(st.shortfall)}`);
    return (
      <li key={p.id}>
        <button type="button" className={`list-row${isPlannedDone(p) ? " dim" : ""}`} onClick={() => setSheet({ kind: "menu", planned: p })}>
          <span className="list-main">
            <span className="list-name">{p.name}</span>
            <span className="list-sub">{sub.join("・")}</span>
            {p.reserveId && <span className="list-sub">取り置き：{reserveName.get(p.reserveId) ?? "（なし）"}</span>}
          </span>
          <span className="list-amount">{formatYen(p.amount)}</span>
        </button>
      </li>
    );
  };

  return (
    <section className="card list-card outlook-section" aria-label="予定出費">
      <h2 className="list-head">
        <span>予定出費</span>
        <button type="button" className="text-btn" onClick={() => setSheet({ kind: "edit", planned: null })}>
          追加
        </button>
      </h2>
      <p className="field-hint list-intro">{PLANNED_INTRO}</p>
      {active.length === 0 ? (
        <p className="empty-note small">予定出費はまだありません。月が決まっている先の出費（旅行・車検など）を入れておくと、使える額と見通しに入ります。</p>
      ) : (
        <ul className="list">
          {open.map(row)}
          {done.map(row)}
        </ul>
      )}

      {sheet?.kind === "menu" && (
        <PlannedMenu
          planned={sheet.planned}
          onSetAside={() => void setAside(sheet.planned)}
          onEdit={() => setSheet({ kind: "edit", planned: sheet.planned })}
          onDone={() => setSheet({ kind: "done", planned: sheet.planned })}
          onReopen={() => {
            saveRecord("plannedExpenses", reopenPlanned(sheet.planned))
              .then(() => {
                showToast("済みを取り消しました");
                setSheet(null);
                onChanged();
              })
              .catch((e) => showToast(e instanceof Error ? e.message : "保存できませんでした"));
          }}
          onDelete={() => setSheet({ kind: "delete", planned: sheet.planned })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "assign" && (
        <ReserveMoveSheet
          kind="assign"
          balance={balanceOf(sheet.reserve.id, bundle.reserveMoves)}
          usable={usable}
          onSave={async (amount) => {
            await saveRecord("reserveMoves", newMove(newBase(), sheet.reserve.id, "assign", amount, today));
            showToast(`${formatYen(amount)}を「${sheet.reserve.name}」に入れました`);
            onChanged();
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "edit" && (
        <PlannedEditor
          planned={sheet.planned}
          bundle={bundle}
          today={today}
          showToast={showToast}
          onDone={() => {
            setSheet(null);
            onChanged();
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "done" && (
        <DoneSheet
          planned={sheet.planned}
          bundle={bundle}
          onPick={(txId) => {
            saveRecord("plannedExpenses", markPlannedDone(sheet.planned, txId, nowIso()))
              .then(() => {
                showToast("済みにしました");
                setSheet(null);
                onChanged();
              })
              .catch((e) => showToast(e instanceof Error ? e.message : "保存できませんでした"));
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "delete" && (
        <ConfirmSheet
          title="この予定出費を削除しますか"
          message={`「${sheet.planned.name}」を削除します。`}
          confirmLabel="削除する"
          danger
          onConfirm={() => {
            saveRecord("plannedExpenses", { ...sheet.planned, deletedAt: nowIso() })
              .then(() => {
                showToast("削除しました");
                setSheet(null);
                onChanged();
              })
              .catch((e) => showToast(e instanceof Error ? e.message : "削除できませんでした"));
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
}

function PlannedMenu({
  planned,
  onSetAside,
  onEdit,
  onDone,
  onReopen,
  onDelete,
  onClose,
}: {
  planned: PlannedExpense;
  onSetAside: () => void;
  onEdit: () => void;
  onDone: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet title={planned.name} onClose={onClose}>
      <ul className="choice-list">
        {!isPlannedDone(planned) && (
          <li>
            <button type="button" className="choice" onClick={onSetAside}>
              <span className="choice-label">この予定のために取っておく</span>
            </button>
          </li>
        )}
        <li>
          <button type="button" className="choice" onClick={onEdit}>
            <span className="choice-label">直す</span>
          </button>
        </li>
        <li>
          {isPlannedDone(planned) ? (
            <button type="button" className="choice" onClick={onReopen}>
              <span className="choice-label">済みを取り消す</span>
            </button>
          ) : (
            <button type="button" className="choice" onClick={onDone}>
              <span className="choice-label">済みにする</span>
            </button>
          )}
        </li>
        <li>
          <button type="button" className="choice danger" onClick={onDelete}>
            <span className="choice-label">削除</span>
          </button>
        </li>
      </ul>
    </BottomSheet>
  );
}

function PlannedEditor({
  planned,
  bundle,
  today,
  showToast,
  onDone,
  onClose,
}: {
  planned: PlannedExpense | null;
  bundle: BudgetBundle;
  today: string;
  showToast: ShowToast;
  onDone: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(planned?.name ?? "");
  const [month, setMonth] = useState(planned?.month ?? today.slice(0, 7));
  const [amount, setAmount] = useState<number | null>(planned?.amount ?? null);
  const [reserveId, setReserveId] = useState(planned?.reserveId ?? "");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const error = validatePlannedDraft({ name, month, amount });
  // 結べる取り置き：閉じていないもの(いま結んでいるものは閉じていても出す)
  const choices = splitReserves(bundle.reserves).open.concat(bundle.reserves.filter((r) => r.deletedAt === null && r.id === planned?.reserveId && r.closedAt));

  const save = async () => {
    setTouched(true);
    if (error || busy || amount === null) return;
    setBusy(true);
    try {
      const next: PlannedExpense = { ...(planned ?? { ...newBase(), name: "", month: "", amount: 0 }), name: name.trim(), month, amount };
      if (reserveId) next.reserveId = reserveId;
      else delete next.reserveId;
      await saveRecord("plannedExpenses", next);
      showToast(planned ? "予定出費を更新しました" : "予定出費を追加しました");
      onDone();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  return (
    <BottomSheet title={planned ? "予定出費を直す" : "予定出費を追加"} onClose={onClose}>
      <div className="form">
        <div className="field">
          <label className="field-label" htmlFor="planned-name">
            名前
          </label>
          <input id="planned-name" className="text-input" type="text" value={name} placeholder="例：車検" autoFocus onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="planned-month">
            月
          </label>
          <input id="planned-month" className="date-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">金額</span>
          <YenInput value={amount} onChange={setAmount} ariaLabel="金額" />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="planned-reserve">
            取り置き（なくてもよい）
          </label>
          <select id="planned-reserve" className="text-input" value={reserveId} onChange={(e) => setReserveId(e.target.value)}>
            <option value="">結ばない</option>
            {choices.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="field-hint">結ぶと、取り置きの残高ぶんは足りない額から引かれます。</p>
        </div>
        {touched && error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" onClick={onClose}>
          やめる
        </button>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => void save()}>
          保存
        </button>
      </div>
    </BottomSheet>
  );
}

function DoneSheet({ planned, bundle, onPick, onClose }: { planned: PlannedExpense; bundle: BudgetBundle; onPick: (txId: string | null) => void; onClose: () => void }) {
  const candidates = useMemo(() => doneCandidates(planned, bundle.transactions, bundle.plannedExpenses), [planned, bundle.transactions, bundle.plannedExpenses]);
  return (
    <BottomSheet title="済みにする" onClose={onClose}>
      <p className="sheet-message">
        {formatMonthJa(planned.month)}の支出から、この予定出費にあたる明細を選びます。
      </p>
      {candidates.length > 0 && (
        <ul className="list done-candidates">
          {candidates.map((t) => (
            <li key={t.id}>
              <button type="button" className="list-row" onClick={() => onPick(t.id)}>
                <span className="list-main">
                  <span className="list-name">{t.content || "（内容なし）"}</span>
                  <span className="list-sub">
                    {shortDate(t.date)}
                    {planned.reserveId && t.reserveId === planned.reserveId ? "・結んだ取り置きで払った分" : ""}
                  </span>
                </span>
                <span className="list-amount">{formatYen(t.amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length === 0 && <p className="muted small">その月の支出はありません。</p>}
      <div className="sheet-actions stack">
        <button type="button" className="secondary-btn" onClick={() => onPick(null)}>
          明細なしで済みにする
        </button>
        <button type="button" className="text-btn" onClick={onClose}>
          やめる
        </button>
      </div>
    </BottomSheet>
  );
}
