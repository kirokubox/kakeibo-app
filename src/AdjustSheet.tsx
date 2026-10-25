import { useEffect, useMemo, useState } from "react";
import { actualToBalance, adjustmentDiff, balanceAsOf, checkAdjustDiff, describeDiff, makeAdjustment } from "./adjustLogic";
import { unpaidAmount } from "./transferLogic";
import { BottomSheet, ConfirmSheet } from "./BottomSheet";
import { isLocalDate, nowIso } from "./dateUtils";
import { formatYen } from "./money";
import { getAccountTransactions, newBase, saveRecord, softDelete } from "./storage";
import { noteTransactionChanged } from "./suggestStore";
import type { ShowToast } from "./Toast";
import type { Account, Transaction } from "./types";
import { YenInput } from "./YenInput";

export type AdjustMode = { kind: "new" } | { kind: "edit"; tx: Transaction };

interface Props {
  account: Account;
  mode: AdjustMode;
  today: string;
  showToast: ShowToast;
  /** 保存・削除したあと（一覧を読み直してもらう） */
  onChanged: () => void;
  onClose: () => void;
}

/** 残高を合わせる（新規）／残高修正の編集 */
export function AdjustSheet({ account, mode, today, showToast, onChanged, onClose }: Props) {
  const editing = mode.kind === "edit" ? mode.tx : null;
  const isCard = account.group === "card";
  const [txs, setTxs] = useState<Transaction[] | null>(editing ? [] : null);
  const [date, setDate] = useState(editing?.date ?? today);
  const [memo, setMemo] = useState(editing?.memo ?? "");
  const [actual, setActual] = useState<number | null>(null); // 新規：実際の残高（カードは未払い額）
  const [signed, setSigned] = useState<number | null>(editing?.amount ?? null); // 編集：符号つきの差額
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    getAccountTransactions(account.id)
      .then((t) => !cancelled && setTxs(t))
      .catch((e) => !cancelled && setFailure(e instanceof Error ? e.message : "読み込めませんでした"));
    return () => {
      cancelled = true;
    };
  }, [account.id, editing]);

  const appBalance = useMemo(() => (txs && isLocalDate(date) ? balanceAsOf(account, txs, date) : null), [account, txs, date]);
  const diff = editing ? signed : actual !== null && appBalance !== null ? adjustmentDiff(appBalance, actualToBalance(account, actual)) : null;
  const check = checkAdjustDiff(diff);
  const canSave = check.ok && isLocalDate(date) && !busy;

  const save = async () => {
    if (!canSave || diff === null) return;
    setBusy(true);
    try {
      const record = makeAdjustment(account.id, date, diff, memo, newBase(), editing ?? undefined);
      const saved = await saveRecord("transactions", record);
      noteTransactionChanged(saved);
      onChanged();
      showToast(editing ? "保存しました" : "残高を合わせました");
      onClose();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await softDelete("transactions", editing.id);
      const now = nowIso();
      noteTransactionChanged({ ...editing, deletedAt: now, updatedAt: now });
      onChanged();
      const original = editing;
      showToast("削除しました", 5000, {
        label: "元に戻す",
        onClick: () => {
          saveRecord("transactions", { ...original, deletedAt: null })
            .then((restored) => {
              noteTransactionChanged(restored);
              onChanged();
              showToast("元に戻しました");
            })
            .catch((e) => showToast(e instanceof Error ? e.message : "元に戻せませんでした"));
        },
      });
      onClose();
    } catch (e) {
      setConfirmDelete(false);
      setFailure(e instanceof Error ? e.message : "削除できませんでした");
      setBusy(false);
    }
  };

  if (confirmDelete) {
    return (
      <ConfirmSheet
        title="この残高修正を削除しますか"
        message="削除したあと、数秒のあいだは「元に戻す」で戻せます。"
        confirmLabel="削除する"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    );
  }

  const showUnpaid = isCard && appBalance !== null && appBalance <= 0;
  const appText = appBalance === null ? "…" : showUnpaid ? formatYen(unpaidAmount(appBalance)) : formatYen(appBalance);
  const appLabel = showUnpaid ? "アプリの未払い" : "アプリの残高";

  return (
    <BottomSheet title={editing ? "残高修正を編集" : "残高を合わせる"} onClose={onClose}>
      <div className="form">
        {!editing && (
          <p className="adjust-app">
            <span className="muted">{account.name}　{appLabel}</span> <strong>{appText}</strong>
          </p>
        )}
        {editing ? (
          <div className="field">
            <span className="field-label">差額（増えたら＋、減ったら−）</span>
            <YenInput value={signed} onChange={setSigned} allowNegative ariaLabel="差額" autoFocus />
          </div>
        ) : (
          <div className="field">
            <span className="field-label">{isCard ? "実際の未払い額" : "実際の残高"}</span>
            <YenInput value={actual} onChange={setActual} allowNegative={!isCard} ariaLabel={isCard ? "実際の未払い額" : "実際の残高"} autoFocus />
          </div>
        )}
        {diff !== null && (
          <p className={`adjust-diff${diff === 0 ? "" : diff > 0 ? " plus" : " minus"}`} role="status">
            {describeDiff(diff)}
          </p>
        )}
        <div className="field">
          <label className="field-label" htmlFor="adjust-date">
            日付{editing ? "" : "（この日の終わりの残高に合わせます）"}
          </label>
          <input id="adjust-date" className="text-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="adjust-memo">
            メモ（任意）
          </label>
          <input id="adjust-memo" className="text-input" type="text" autoComplete="off" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        {failure && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}
      </div>
      <div className="sheet-actions between">
        {editing ? (
          <button type="button" className="danger-btn" disabled={busy} onClick={() => setConfirmDelete(true)}>
            削除
          </button>
        ) : (
          <button type="button" className="secondary-btn" onClick={onClose}>
            やめる
          </button>
        )}
        <button type="button" className="primary-btn" disabled={!canSave} onClick={() => void save()}>
          保存
        </button>
      </div>
    </BottomSheet>
  );
}
