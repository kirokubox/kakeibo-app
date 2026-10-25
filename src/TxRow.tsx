import { categoryNames } from "./entryLogic";
import { formatYen } from "./money";
import type { Category, Id, Transaction } from "./types";

interface Props {
  tx: Transaction;
  accountNames: ReadonlyMap<Id, string>;
  categories: readonly Category[];
  onSelect: (tx: Transaction) => void;
}

/** 明細の1行：左に大分類/小分類、中央に内容とメモと資産、右に金額 */
export function TxRow({ tx, accountNames, categories, onSelect }: Props) {
  const names = categoryNames(categories, tx.categoryId);
  const left =
    tx.type === "transfer" ? { top: "振替", bottom: "" } : tx.type === "adjustment" ? { top: "残高修正", bottom: "" } : { top: names?.parent ?? "分類なし", bottom: names?.child ?? "" };
  const account = accountNames.get(tx.accountId) ?? "資産不明";
  const accountLine = tx.type === "transfer" ? `${account} → ${accountNames.get(tx.toAccountId ?? "") ?? "資産不明"}` : account;
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
        {tx.tag === "satisfied" && <span className="tag-mark satisfied">満足</span>}
        {tx.tag === "regret" && <span className="tag-mark regret">反省</span>}
      </span>
    </button>
  );
}
