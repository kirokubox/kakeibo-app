import { useContext } from "react";
import { categoryNames } from "./entryLogic";
import { formatYen } from "./money";
import { RecurringLabelsContext } from "./recurringStore";
import type { Category, Id, Transaction } from "./types";

interface Props {
  tx: Transaction;
  accountNames: ReadonlyMap<Id, string>;
  categories: readonly Category[];
  onSelect: (tx: Transaction) => void;
  /** 資産の明細で、この明細のあとの残高を右端の金額の下に小さく出す */
  balanceAfter?: number;
  /** 先の日付の明細（予定）の印を出す */
  planned?: boolean;
}

/** 明細の1行：左に大分類/小分類、中央に内容とメモと資産、右に金額 */
export function TxRow({ tx, accountNames, categories, onSelect, balanceAfter, planned }: Props) {
  const recurringLabels = useContext(RecurringLabelsContext);
  const names = categoryNames(categories, tx.categoryId);
  const left =
    tx.type === "transfer" ? { top: "振替", bottom: "" } : tx.type === "adjustment" ? { top: "残高修正", bottom: "" } : { top: names?.parent ?? "分類なし", bottom: names?.child ?? "" };
  const account = accountNames.get(tx.accountId) ?? "資産不明";
  const baseAccountLine = tx.type === "transfer" ? `${account} → ${accountNames.get(tx.toAccountId ?? "") ?? "資産不明"}` : account;
  // 繰り返しで作った明細は、資産名の横に「(毎月)」のように小さく出す
  const accountLine = tx.recurringId ? `${baseAccountLine} (${recurringLabels.get(tx.recurringId) ?? "繰り返し"})` : baseAccountLine;
  const amount = tx.type === "adjustment" ? `${tx.amount > 0 ? "＋" : ""}${formatYen(tx.amount)}` : formatYen(tx.amount);
  const tone = tx.type === "income" ? "income" : tx.type === "expense" ? "expense" : "";
  return (
    <button type="button" className="tx-row" onClick={() => onSelect(tx)}>
      <span className="tx-cat">
        <span className="tx-cat-top">{left.top}</span>
        {left.bottom && <span className="tx-cat-bottom">{left.bottom}</span>}
      </span>
      <span className="tx-main">
        <span className="tx-title">
          <span className="tx-content">{tx.content || "\u00a0"}</span>
          {tx.memo && <span className="tx-memo">{tx.memo}</span>}
        </span>
        <span className="tx-account">{accountLine}</span>
      </span>
      <span className="tx-right">
        <span className={`tx-amount ${tone}`}>{amount}</span>
        {tx.type === "transfer" && !!tx.fee && <span className="tx-sub">手数料 {formatYen(tx.fee)}</span>}
        {tx.type === "expense" && !!tx.reimbursement && <span className="tx-sub">うち立替 {formatYen(tx.reimbursement.amount)}</span>}
        {tx.type === "income" && !!tx.settles && <span className="tx-sub">立替の返金</span>}
        {planned && <span className="tag-mark estimated">予定</span>}
        {tx.estimated && <span className="tag-mark estimated">見込み</span>}
        {tx.tag === "satisfied" && <span className="tag-mark satisfied">満足</span>}
        {tx.tag === "regret" && <span className="tag-mark regret">反省</span>}
        {balanceAfter !== undefined && <span className={`tx-balance${balanceAfter < 0 ? " neg" : ""}`}>残高 {formatYen(balanceAfter)}</span>}
      </span>
    </button>
  );
}
