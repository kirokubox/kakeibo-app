import { useMemo, useState } from "react";
import { BottomSheet, ConfirmSheet } from "./BottomSheet";
import type { BudgetBundle } from "./budgetStore";
import { formatMonthJa, nowIso } from "./dateUtils";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import type { MenuItem } from "./KebabMenu";
import { formatYen } from "./money";
import { shortDate } from "./periodLogic";
import { ReserveEditor } from "./ReserveEditor";
import { plannedNotesByReserve } from "./plannedLogic";
import { RESERVE_KIND_LABELS, assignWarning, balanceOf, moveHistory, newMove, targetNote, validateAssign, validateRelease } from "./reserveLogic";
import { newBase, saveRecord, saveStores } from "./storage";
import type { ShowToast } from "./Toast";
import type { Reserve } from "./types";
import { YenInput } from "./YenInput";

type Sheet = null | "assign" | "release" | "close" | "closeConfirm" | "edit" | "delete";

interface Props {
  reserve: Reserve;
  bundle: BudgetBundle;
  today: string;
  usable: number | null;
  onBack: () => void;
  onChanged: () => void;
  showToast: ShowToast;
}

/** 取り置き1つの画面：残高、入れる・戻す、出し入れの履歴 */
export function ReserveDetailView({ reserve, bundle, today, usable, onBack, onChanged, showToast }: Props) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const balance = balanceOf(reserve.id, bundle.reserveMoves);
  const history = useMemo(() => moveHistory(reserve.id, bundle.reserveMoves), [reserve.id, bundle.reserveMoves]);
  const txById = useMemo(() => new Map(bundle.transactions.map((t) => [t.id, t])), [bundle.transactions]);
  const note = targetNote(reserve, balance);
  const plannedNote = plannedNotesByReserve(bundle.plannedExpenses).get(reserve.id);
  const closed = !!reserve.closedAt;
  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : "保存できませんでした");

  const items: MenuItem[] = [
    { label: "名前や目標を直す", onSelect: () => setSheet("edit") },
    closed
      ? {
          label: "また使う（閉じるのをやめる）",
          onSelect: () => {
            const next: Reserve = { ...reserve };
            delete next.closedAt;
            saveRecord("reserves", next)
              .then(() => {
                showToast("取り置きを開きました");
                onChanged();
              })
              .catch(fail);
          },
        }
      : { label: "閉じる", onSelect: () => setSheet(balance > 0 ? "close" : "closeConfirm") },
  ];
  if (balance === 0) items.push({ label: "削除", onSelect: () => setSheet("delete"), danger: true });

  const closeOnly = (message: string) => {
    saveRecord("reserves", { ...reserve, closedAt: nowIso() })
      .then(() => {
        showToast(message);
        setSheet(null);
        onChanged();
      })
      .catch(fail);
  };

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{reserve.name}</h1>
        <KebabMenu items={items} />
      </header>
      <main className="content">
        <section className="card summary">
          <p className="summary-label">残高{closed ? "（閉じています）" : ""}</p>
          <p className="summary-main">{formatYen(balance)}</p>
          {reserve.targetMonth && <p className="summary-note">{formatMonthJa(reserve.targetMonth)}に使う</p>}
          {note && <p className="summary-note">{note}</p>}
          {plannedNote && <p className="summary-note">{plannedNote}</p>}
          <div className="actions center">
            <button type="button" className="primary-btn" onClick={() => setSheet("assign")}>
              入れる
            </button>
            <button type="button" className="secondary-btn" disabled={balance <= 0} onClick={() => setSheet("release")}>
              戻す
            </button>
          </div>
        </section>
        <h2 className="list-group-title">出し入れの履歴</h2>
        {history.length === 0 ? (
          <section className="card">
            <p>まだ出し入れはありません。</p>
          </section>
        ) : (
          <section className="card list-card">
            <ul className="list">
              {history.map((m) => {
                const t = m.txId ? txById.get(m.txId) : undefined;
                return (
                  <li key={m.id} className="list-row static">
                    <span className="list-main">
                      <span className="list-name">{RESERVE_KIND_LABELS[m.kind]}</span>
                      <span className="list-sub">
                        {shortDate(m.date)}
                        {t ? `・${t.content || "（内容なし）"}` : ""}
                      </span>
                    </span>
                    <span className="list-amount">
                      {m.kind === "assign" ? "＋" : "−"}
                      {formatYen(m.amount)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>

      {sheet === "assign" && (
        <ReserveMoveSheet
          kind="assign"
          balance={balance}
          usable={usable}
          onSave={async (amount) => {
            await saveRecord("reserveMoves", newMove(newBase(), reserve.id, "assign", amount, today));
            showToast(`${formatYen(amount)}を入れました`);
            onChanged();
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "release" && (
        <ReserveMoveSheet
          kind="release"
          balance={balance}
          usable={usable}
          onSave={async (amount) => {
            await saveRecord("reserveMoves", newMove(newBase(), reserve.id, "release", amount, today));
            showToast(`${formatYen(amount)}を使える額に戻しました`);
            onChanged();
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "close" && (
        <BottomSheet title="取り置きを閉じる" onClose={() => setSheet(null)}>
          <p className="sheet-message">残っている{formatYen(balance)}を使える額に戻しますか。</p>
          <div className="sheet-actions stack">
            <button
              type="button"
              className="primary-btn"
              onClick={() => {
                saveStores({
                  reserveMoves: [newMove(newBase(), reserve.id, "release", balance, today)],
                  reserves: [{ ...reserve, closedAt: nowIso() }],
                })
                  .then(() => {
                    showToast("使える額に戻して、閉じました");
                    setSheet(null);
                    onChanged();
                  })
                  .catch(fail);
              }}
            >
              戻して閉じる
            </button>
            <button type="button" className="secondary-btn" onClick={() => closeOnly("残したまま閉じました")}>
              残したまま閉じる
            </button>
            <button type="button" className="text-btn" onClick={() => setSheet(null)}>
              やめる
            </button>
          </div>
        </BottomSheet>
      )}
      {sheet === "closeConfirm" && (
        <ConfirmSheet title="取り置きを閉じますか" message="閉じた取り置きは、一覧の下にまとめます。" confirmLabel="閉じる" onConfirm={() => closeOnly("閉じました")} onClose={() => setSheet(null)} />
      )}
      {sheet === "delete" && (
        <ConfirmSheet
          title="この取り置きを削除しますか"
          message="残高が0円の取り置きだけ削除できます。結んだ予定出費の取り置きは外れます。"
          confirmLabel="削除する"
          danger
          onConfirm={() => {
            const linked = bundle.plannedExpenses
              .filter((p) => p.deletedAt === null && p.reserveId === reserve.id)
              .map((p) => {
                const next = { ...p };
                delete next.reserveId;
                return next;
              });
            saveStores({ reserves: [{ ...reserve, deletedAt: nowIso() }], plannedExpenses: linked })
              .then(() => {
                showToast("削除しました");
                onChanged();
                onBack();
              })
              .catch(fail);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "edit" && (
        <ReserveEditor
          reserve={reserve}
          reserves={bundle.reserves}
          showToast={showToast}
          onDone={() => {
            setSheet(null);
            onChanged();
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}

interface MoveProps {
  kind: "assign" | "release";
  balance: number;
  usable: number | null;
  onSave: (amount: number) => Promise<void>;
  onClose: () => void;
}

/** 入れる・戻すの金額を入れるシート（予定出費の「この予定のために取っておく」からも使う） */
export function ReserveMoveSheet({ kind, balance, usable, onSave, onClose }: MoveProps) {
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const error = kind === "assign" ? validateAssign(amount) : validateRelease(amount, balance);
  const warning = kind === "assign" ? assignWarning(amount, usable) : null;

  const save = async () => {
    if (error || amount === null || busy) return;
    setBusy(true);
    try {
      await onSave(amount);
      onClose();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  return (
    <BottomSheet title={kind === "assign" ? "取り置きに入れる" : "使える額に戻す"} onClose={onClose}>
      <p className="sheet-message">{kind === "assign" ? "使える額から、この金額を外します。" : `戻せるのは残高の${formatYen(balance)}までです。`}</p>
      <YenInput value={amount} onChange={setAmount} autoFocus ariaLabel="金額" />
      {kind === "release" && (
        <div className="sheet-inline">
          <button type="button" className="secondary-btn" onClick={() => setAmount(balance)}>
            全部
          </button>
        </div>
      )}
      {warning && (
        <p className="field-hint caution-note" role="status">
          {warning}。入れることはできます。
        </p>
      )}
      {(amount !== null && error) || failure ? (
        <p className="field-error" role="alert">
          {failure || error}
        </p>
      ) : null}
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" onClick={onClose}>
          やめる
        </button>
        <button type="button" className="primary-btn" disabled={busy || error !== null} onClick={() => void save()}>
          {kind === "assign" ? "入れる" : "戻す"}
        </button>
      </div>
    </BottomSheet>
  );
}
