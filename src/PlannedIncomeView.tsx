import { useMemo, useState } from "react";
import { BottomSheet, ConfirmSheet } from "./BottomSheet";
import type { BudgetBundle } from "./budgetStore";
import { formatMonthJa, nowIso } from "./dateUtils";
import { formatYen } from "./money";
import { shortDate } from "./periodLogic";
import { incomeDoneCandidates, isIncomeDone, markIncomeDone, reopenIncome, sortPlannedIncomes, validatePlannedIncomeDraft } from "./plannedLogic";
import { newBase, saveRecord } from "./storage";
import type { ShowToast } from "./Toast";
import type { PlannedIncome } from "./types";
import { YenInput } from "./YenInput";

interface Props {
  bundle: BudgetBundle;
  today: string;
  onChanged: () => void;
  showToast: ShowToast;
}

/** 予定収入の一覧の上の説明 */
export const PLANNED_INCOME_INTRO = "賞与など、入る月は分かるが額が決まっていない収入。見通しにだけ入り、使える額には入りません";

type Sheet = { kind: "menu"; planned: PlannedIncome } | { kind: "edit"; planned: PlannedIncome | null } | { kind: "done"; planned: PlannedIncome } | { kind: "delete"; planned: PlannedIncome } | null;

/** 見通しタブの「予定収入」：一覧・追加・直す・入った・削除 */
export function PlannedIncomeView({ bundle, today, onChanged, showToast }: Props) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const active = useMemo(() => sortPlannedIncomes(bundle.plannedIncomes.filter((p) => p.deletedAt === null)), [bundle.plannedIncomes]);
  const accountName = useMemo(() => new Map(bundle.accounts.map((a) => [a.id, a.name])), [bundle.accounts]);
  const open = active.filter((p) => !isIncomeDone(p));
  const done = active.filter(isIncomeDone);

  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : "保存できませんでした");

  const row = (p: PlannedIncome) => {
    const sub: string[] = [formatMonthJa(p.month)];
    if (isIncomeDone(p)) sub.push("入った");
    if (p.accountId) sub.push(accountName.get(p.accountId) ?? "資産不明");
    return (
      <li key={p.id}>
        <button type="button" className={`list-row${isIncomeDone(p) ? " dim" : ""}`} onClick={() => setSheet({ kind: "menu", planned: p })}>
          <span className="list-main">
            <span className="list-name">{p.name}</span>
            <span className="list-sub">{sub.join("・")}</span>
          </span>
          <span className="list-amount">{formatYen(p.amount)}</span>
        </button>
      </li>
    );
  };

  return (
    <section className="card list-card outlook-section" aria-label="予定収入">
      <h2 className="list-head">
        <span>予定収入</span>
        <button type="button" className="text-btn" onClick={() => setSheet({ kind: "edit", planned: null })}>
          追加
        </button>
      </h2>
      <p className="field-hint list-intro">{PLANNED_INCOME_INTRO}</p>
      {active.length === 0 ? (
        <p className="empty-note small">予定収入はまだありません。入る月が分かっている収入（賞与など）を、見込みの額で入れておくと、見通しの期末に足されます。</p>
      ) : (
        <ul className="list">
          {open.map(row)}
          {done.map(row)}
        </ul>
      )}

      {sheet?.kind === "menu" && (
        <BottomSheet title={sheet.planned.name} onClose={() => setSheet(null)}>
          <ul className="choice-list">
            <li>
              {isIncomeDone(sheet.planned) ? (
                <button
                  type="button"
                  className="choice"
                  onClick={() => {
                    saveRecord("plannedIncomes", reopenIncome(sheet.planned))
                      .then(() => {
                        showToast("「入った」を取り消しました");
                        setSheet(null);
                        onChanged();
                      })
                      .catch(fail);
                  }}
                >
                  <span className="choice-label">「入った」を取り消す</span>
                </button>
              ) : (
                <button type="button" className="choice" onClick={() => setSheet({ kind: "done", planned: sheet.planned })}>
                  <span className="choice-label">入った</span>
                </button>
              )}
            </li>
            <li>
              <button type="button" className="choice" onClick={() => setSheet({ kind: "edit", planned: sheet.planned })}>
                <span className="choice-label">直す</span>
              </button>
            </li>
            <li>
              <button type="button" className="choice danger" onClick={() => setSheet({ kind: "delete", planned: sheet.planned })}>
                <span className="choice-label">削除</span>
              </button>
            </li>
          </ul>
        </BottomSheet>
      )}
      {sheet?.kind === "edit" && (
        <PlannedIncomeEditor
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
            saveRecord("plannedIncomes", markIncomeDone(sheet.planned, txId, nowIso()))
              .then(() => {
                showToast("「入った」にしました");
                setSheet(null);
                onChanged();
              })
              .catch(fail);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "delete" && (
        <ConfirmSheet
          title="この予定収入を削除しますか"
          message={`「${sheet.planned.name}」を削除します。`}
          confirmLabel="削除する"
          danger
          onConfirm={() => {
            saveRecord("plannedIncomes", { ...sheet.planned, deletedAt: nowIso() })
              .then(() => {
                showToast("削除しました");
                setSheet(null);
                onChanged();
              })
              .catch(fail);
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
}

function PlannedIncomeEditor({
  planned,
  bundle,
  today,
  showToast,
  onDone,
  onClose,
}: {
  planned: PlannedIncome | null;
  bundle: BudgetBundle;
  today: string;
  showToast: ShowToast;
  onDone: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(planned?.name ?? "");
  const [month, setMonth] = useState(planned?.month ?? today.slice(0, 7));
  const [amount, setAmount] = useState<number | null>(planned?.amount ?? null);
  const [accountId, setAccountId] = useState(planned?.accountId ?? "");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const error = validatePlannedIncomeDraft({ name, month, amount });
  const choices = bundle.accounts.filter((a) => a.deletedAt === null && (!a.hidden || a.id === planned?.accountId));

  const save = async () => {
    setTouched(true);
    if (error || busy || amount === null) return;
    setBusy(true);
    try {
      const next: PlannedIncome = { ...(planned ?? { ...newBase(), name: "", month: "", amount: 0 }), name: name.trim(), month, amount };
      if (accountId) next.accountId = accountId;
      else delete next.accountId;
      await saveRecord("plannedIncomes", next);
      showToast(planned ? "予定収入を更新しました" : "予定収入を追加しました");
      onDone();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  return (
    <BottomSheet title={planned ? "予定収入を直す" : "予定収入を追加"} onClose={onClose}>
      <div className="form">
        <div className="field">
          <label className="field-label" htmlFor="pincome-name">
            名前
          </label>
          <input id="pincome-name" className="text-input" type="text" value={name} placeholder="例：賞与（見込み）" autoFocus onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pincome-month">
            月
          </label>
          <input id="pincome-month" className="date-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">金額（見込み）</span>
          <YenInput value={amount} onChange={setAmount} ariaLabel="金額" />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pincome-account">
            入る資産（なくてもよい）
          </label>
          <select id="pincome-account" className="text-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">選ばない</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
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

function DoneSheet({ planned, bundle, onPick, onClose }: { planned: PlannedIncome; bundle: BudgetBundle; onPick: (txId: string | null) => void; onClose: () => void }) {
  const candidates = useMemo(() => incomeDoneCandidates(planned, bundle.transactions, bundle.plannedIncomes), [planned, bundle.transactions, bundle.plannedIncomes]);
  return (
    <BottomSheet title="入った" onClose={onClose}>
      <p className="sheet-message">{formatMonthJa(planned.month)}の収入から、この予定収入にあたる明細を選びます。</p>
      {candidates.length > 0 && (
        <ul className="list done-candidates">
          {candidates.map((t) => (
            <li key={t.id}>
              <button type="button" className="list-row" onClick={() => onPick(t.id)}>
                <span className="list-main">
                  <span className="list-name">{t.content || "（内容なし）"}</span>
                  <span className="list-sub">{shortDate(t.date)}</span>
                </span>
                <span className="list-amount">{formatYen(t.amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length === 0 && <p className="muted small">その月の収入はありません。</p>}
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
