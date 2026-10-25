import { useState } from "react";

interface Props {
  value: number | null;
  onChange: (value: number | null) => void;
  /** マイナスの切り替えを出す（初期残高など、必要な欄だけ） */
  allowNegative?: boolean;
  id?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}

/** 金額の入力欄：数字キーボード、3桁区切りで表示、整数だけ。空欄は null */
export function YenInput({ value, onChange, allowNegative = false, id, autoFocus, ariaLabel }: Props) {
  const [negative, setNegative] = useState(value !== null && value < 0);

  const emit = (digits: string, neg: boolean) => {
    if (digits === "") {
      onChange(null);
      return;
    }
    const n = Number(digits);
    onChange(neg && n !== 0 ? -n : n);
  };

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
      <input
        id={id}
        className="text-input yen-field"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        placeholder="0"
        value={shown}
        // 押したら中身を全部選ぶ：最初の「0」の前に打った数字がつながって桁が増えるのを防ぐ
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => emit(e.target.value.replace(/[^0-9]/g, "").slice(0, 12), negative)}
      />
      <span className="unit">円</span>
    </div>
  );
}
