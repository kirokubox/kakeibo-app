import { useState } from "react";
import { PadKeys, usePadKeyboard } from "./AmountPad";
import { BottomSheet } from "./BottomSheet";
import { formatExpr, hasOperator, padValue, pressKey, startPad } from "./calculator";
import type { PadKey, PadState } from "./calculator";

interface Props {
  title: string;
  description?: string;
  value: number;
  kind: "yen" | "days";
  /** エラーの文章。なければ null */
  validate: (value: number | null) => string | null;
  onSave: (value: number) => Promise<void> | void;
  onClose: () => void;
}

/** 日数は3桁まで */
const MAX_DAY_DIGITS = 3;

/**
 * 金額・日数を1つ入れるシート（設定の行をタップしたとき）。
 * 入力画面の金額と同じテンキーをシートの中に出し、「保存」のキーで保存する（#29。前はスマホの数字キーボード）
 */
export function NumberSheet({ title, description, value, kind, validate, onSave, onClose }: Props) {
  const [pad, setPad] = useState<PadState>(() => (value >= 0 ? { expr: String(value), fresh: true } : startPad(null)));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const digits = kind === "days";
  const calc = !digits && hasOperator(pad.expr);
  // 金額は式を計算した値（計算できない途中の式は undefined）。日数は数字のまま
  const n = digits ? (pad.expr === "" ? null : Number(pad.expr)) : padValue(pad.expr);
  const error = n === undefined ? "式を最後まで入れてください" : validate(n);

  const key = (k: PadKey) =>
    setPad((p) => {
      const next = pressKey(p, k);
      return digits && next.expr.length > MAX_DAY_DIGITS ? p : next;
    });

  const save = async () => {
    if (error || n === null || n === undefined || busy) return;
    setBusy(true);
    try {
      await onSave(n);
      onClose();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };
  usePadKeyboard({ onKey: key, onFinish: () => void save(), digitsOnly: digits });

  const shown = pad.expr === "" ? "" : digits ? pad.expr : formatExpr(pad.expr);
  return (
    <BottomSheet title={title} onClose={onClose}>
      {description && <p className="sheet-message">{description}</p>}
      <div className="pad-display in-sheet" aria-label={title} aria-live="polite">
        <span className={`pad-display-value${pad.fresh ? " selected" : ""}`}>{shown === "" ? <span className="entry-ph">0</span> : shown}</span>
        <span className="unit">{digits ? "日" : "円"}</span>
      </div>
      {calc && typeof n === "number" && <p className="pad-preview">＝ {n.toLocaleString("ja-JP")}円</p>}
      {(error || failure) && pad.expr !== "" && (
        <p className="field-error" role="alert">
          {failure || error}
        </p>
      )}
      <div className="sheet-pad">
        <PadKeys onKey={key} onFinish={() => void save()} finishable={!busy && error === null} calc={false} finishLabel="保存" variant={digits ? "digits" : "amount"} />
      </div>
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" onClick={onClose}>
          やめる
        </button>
      </div>
    </BottomSheet>
  );
}
