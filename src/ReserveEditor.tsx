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

/** 取り置きを作る・直す(種類・名前・目標額・使う月) */
export function ReserveEditor({ reserve, reserves, showToast, onDone, onClose }: EditorProps) {
  const [name, setName] = useState(reserve?.name ?? "");
  const [repeat, setRepeat] = useState(reserve?.repeat === true);
  const [target, setTarget] = useState<number | null>(reserve?.targetAmount ?? null);
  const [month, setMonth] = useState(reserve?.targetMonth ?? "");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const error = validateReserveDraft({ name, targetAmount: target, targetMonth: repeat ? "" : month }, reserves, reserve?.id);

  const save = async () => {
    setTouched(true);
    if (error || busy) return;
    setBusy(true);
    try {
      const next: Reserve = { ...(reserve ?? { ...newBase(), name: "" }), name: name.trim() };
      if (repeat) next.repeat = true;
      else delete next.repeat;
      if (target !== null) next.targetAmount = target;
      else delete next.targetAmount;
      if (month !== "" && !repeat) next.targetMonth = month;
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
          <span className="field-label">種類</span>
          <div className="segmented" role="group" aria-label="取り置きの種類">
            <button type="button" className={`seg${repeat ? "" : " on"}`} aria-pressed={!repeat} onClick={() => setRepeat(false)}>
              1回きり
            </button>
            <button type="button" className={`seg${repeat ? " on" : ""}`} aria-pressed={repeat} onClick={() => setRepeat(true)}>
              くり返し使う
            </button>
          </div>
          <p className="field-hint">
            {repeat
              ? "美容院・洋服など、何度も使う取り置き。払っても閉じません。目標額を1回分の目安にすると、使ったあとに「目標額まで補充」で戻せます。"
              : "旅行・帰省・家電など、1回使ったら終わる取り置き。払ったあとに、残りを戻して閉じるかを選べます。"}
          </p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="reserve-name">
            名前
          </label>
          <input id="reserve-name" className="text-input" type="text" value={name} placeholder={repeat ? "例：美容院" : "例：旅行"} autoFocus onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">{repeat ? "1回分の目安（なくてもよい）" : "目標額（なくてもよい）"}</span>
          <YenInput value={target} onChange={setTarget} ariaLabel="目標額" />
        </div>
        {!repeat && (
        <div className="field">
          <label className="field-label" htmlFor="reserve-month">
            使う月（なくてもよい）
          </label>
          <input id="reserve-month" className="date-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        )}
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
