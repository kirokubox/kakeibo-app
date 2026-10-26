import { useMemo, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { counterpartySuggestions, validateReimb } from "./reimburseLogic";
import type { Reimb } from "./reimburseLogic";
import type { Transaction } from "./types";
import { YenInput } from "./YenInput";

interface Props {
  /** 直す立替（なければ新しく付ける） */
  initial: Reimb | null;
  /** 支出の金額（立替の上限）。まだ入れていないときは null */
  expenseAmount: number | null;
  /** 相手の候補を出すための、過去の立替の支出 */
  history: readonly Transaction[];
  onDecide: (reimb: Reimb) => void;
  onRemove: () => void;
  onClose: () => void;
}

/** 立替のシート：うち誰の分か（相手と金額） */
export function ReimburseSheet({ initial, expenseAmount, history, onDecide, onRemove, onClose }: Props) {
  const [counterparty, setCounterparty] = useState(initial?.counterparty ?? "");
  const [amount, setAmount] = useState<number | null>(initial?.amount ?? null);
  const [touched, setTouched] = useState(false);
  const suggestions = useMemo(() => counterpartySuggestions(history, counterparty), [history, counterparty]);
  const error = validateReimb(counterparty, amount, expenseAmount);

  const decide = () => {
    setTouched(true);
    if (error) return;
    onDecide({ counterparty: counterparty.trim(), amount: amount! });
  };

  return (
    <BottomSheet title="立替（うち誰の分）" onClose={onClose}>
      <p className="sheet-message">人の分を払ったとき。返ってくるまで、自分の支出には数えません。</p>
      <div className="form">
        <div className="field">
          <label className="field-label" htmlFor="reimb-who">
            相手
          </label>
          <input
            id="reimb-who"
            className="text-input"
            type="text"
            autoComplete="off"
            placeholder="人の名前・会社名"
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
          />
          {suggestions.length > 0 && (
            <ul className="chips" aria-label="相手の候補">
              {suggestions.map((name) => (
                <li key={name} className="chip-item">
                  <button type="button" className="chip" onClick={() => setCounterparty(name)}>
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="field">
          <span className="field-label">金額{expenseAmount !== null ? `（支出 ${expenseAmount.toLocaleString("ja-JP")}円まで）` : ""}</span>
          <YenInput value={amount} onChange={setAmount} ariaLabel="立替の金額" />
          {expenseAmount !== null && (
            <div>
              <button type="button" className="secondary-btn" onClick={() => setAmount(expenseAmount)}>
                全額
              </button>
            </div>
          )}
        </div>
        {touched && error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="sheet-actions between">
        {initial ? (
          <button type="button" className="danger-btn" onClick={onRemove}>
            立替をやめる
          </button>
        ) : (
          <button type="button" className="secondary-btn" onClick={onClose}>
            やめる
          </button>
        )}
        <button type="button" className="primary-btn" onClick={decide}>
          決定
        </button>
      </div>
    </BottomSheet>
  );
}
