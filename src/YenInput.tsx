import { useState } from "react";
import { AmountSheet } from "./AmountSheet";

interface Props {
  value: number | null;
  onChange: (value: number | null) => void;
  /** マイナスの切り替えを出す（初期残高など、必要な欄だけ） */
  allowNegative?: boolean;
  id?: string;
  /** 開いたらすぐテンキーを出す（金額を入れるためのシートなど） */
  autoFocus?: boolean;
  ariaLabel?: string;
}

/**
 * 金額の入力欄：押すと、入力画面と同じ電卓つきのテンキーが下から出る（#29。前はスマホの数字キーボード）。
 * 3桁区切りで表示、整数だけ。空欄は null
 */
export function YenInput({ value, onChange, allowNegative = false, id, autoFocus, ariaLabel }: Props) {
  const [negative, setNegative] = useState(value !== null && value < 0);
  const [open, setOpen] = useState(autoFocus === true);

  const shown = value === null ? "" : Math.abs(value).toLocaleString("ja-JP");

  return (
    <div className="yen-input">
      {allowNegative && (
        <button
          type="button"
          className={`neg-btn${negative ? " on" : ""}`}
          aria-pressed={negative}
          onClick={() => {
            const next = !negative;
            setNegative(next);
            if (value !== null) onChange(next && value !== 0 ? -Math.abs(value) : Math.abs(value));
          }}
        >
          マイナス
        </button>
      )}
      <button
        id={id}
        type="button"
        className={`text-input yen-field yen-btn${open ? " active" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {shown === "" ? <span className="entry-ph">0</span> : `${negative && value !== 0 ? "−" : ""}${shown}`}
      </button>
      <span className="unit">円</span>
      {open && (
        <AmountSheet
          title={ariaLabel ?? "金額"}
          value={value === null ? null : Math.abs(value)}
          negative={allowNegative && negative}
          onDone={(n) => onChange(n === null ? null : negative && n !== 0 ? -n : n)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
