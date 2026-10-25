import { useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { validateReserveDraft } from "./reserveLogic";
import { newBase, saveRecord } from "./storage";
import type { ShowToast } from "./Toast";
import type { Reserve } from "./types";
import { YenInput } from "./YenInput";

interface EditorProps {
  reserve: Reserve | null;
  reserves: Reserve[];
  showToast: ShowToast;
  onDone: () => void;
  onClose: () => void;
}

/** 取り置きを作る・直す(名前・目標額・使う月) */
export function ReserveEditor({ reserve, reserves, showToast, onDone, onClose }: EditorProps) {
  const [name, setName] = useState(reserve?.name ?? "");
  const [target, setTarget] = useState<number | null>(reserve?.targetAmount ?? null);
  const [month, setMonth] = useState(reserve?.targetMonth ?? "");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const error = validateReserveDraft({ name, targetAmount: target, targetMonth: month }, reserves, reserve?.id);

  const save = async () => {
    setTouched(true);
    if (error || busy) return;
    setBusy(true);
    try {
      const next: Reserve = { ...(reserve ?? { ...newBase(), name: "" }), name: name.trim() };
      if (target !== null) next.targetAmount = target;
      else delete next.targetAmount;
      if (month !== "") next.targetMonth = month;
      else delete next.targetMonth;
      await saveRecord("reserves", next);
      showToast(reserve ? "取り置きを更新しました" : "取り置きを作りました");
      onDone();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  return (
    <BottomSheet title={reserve ? "取り置きを直す" : "取り置きを作る"} onClose={onClose}>
      <div className="form">
        <div className="field">
          <label className="field-label" htmlFor="reserve-name">
            名前
          </label>
          <input id="reserve-name" className="text-input" type="text" value={name} placeholder="例：旅行" autoFocus onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">目標額（なくてもよい）</span>
          <YenInput value={target} onChange={setTarget} ariaLabel="目標額" />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="reserve-month">
            使う月（なくてもよい）
          </label>
          <input id="reserve-month" className="date-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
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
