// 給料明細のひな形と毎月の入力で共通の部品
import type { ReactNode } from "react";
import { AccountPanel } from "./AccountPanel";
import { CategoryPanel } from "./CategoryPanel";
import { selectableAccounts, selectableCategoryGroups } from "./entryLogic";
import { formatYen } from "./money";
import { PAYROLL_KIND_LABELS } from "./payrollLogic";
import type { PayrollLineKind, PayrollTotals } from "./payrollLogic";
import type { Account, Category, Id } from "./types";
import { YenInput } from "./YenInput";

/** 行の行き先（支給・控除＝分類、天引きで払う後払い＝資産）を選ぶパネル */
export function TargetPanel({
  kind,
  currentId,
  accounts,
  categories,
  payAccountId,
  onPick,
  onClose,
}: {
  kind: PayrollLineKind;
  currentId: Id | null;
  accounts: readonly Account[];
  categories: readonly Category[];
  /** 天引きで払う後払いでは、入金する資産（給料が入る資産）は選べないようにする */
  payAccountId: Id | null;
  onPick: (id: Id) => void;
  onClose: () => void;
}) {
  if (kind === "settlement") {
    return (
      <AccountPanel
        title="後払いの資産（社員証など）"
        accounts={selectableAccounts(accounts, currentId)}
        selectedId={currentId}
        lastUsedId={null}
        disabledId={payAccountId}
        onSelect={onPick}
        onClose={onClose}
      />
    );
  }
  return <CategoryPanel groups={selectableCategoryGroups(categories, kind === "pay" ? "income" : "expense", currentId)} selectedId={currentId} onSelect={onPick} onClose={onClose} />;
}

interface RowProps {
  kind: PayrollLineKind;
  targetName: string;
  label: string;
  amount: number;
  /** 行の先頭（毎月の入力のチェックなど） */
  leading?: ReactNode;
  /** 行の末尾（↑↓・削除など） */
  trailing?: ReactNode;
  dim?: boolean;
  disabled?: boolean;
  /** 行の下に足すもの（「毎月変わる」のチェックなど） */
  extra?: ReactNode;
  onPickTarget: () => void;
  onLabel: (label: string) => void;
  onAmount: (amount: number) => void;
}

/** 給料明細の1行：1段目に行き先（分類／資産）、2段目に項目名と金額 */
export function PayrollLineRow({ kind, targetName, label, amount, leading, trailing, dim, disabled, extra, onPickTarget, onLabel, onAmount }: RowProps) {
  return (
    <li className={`payroll-line${dim ? " off" : ""}`}>
      <div className="payroll-line-top">
        {leading}
        <button type="button" className="select-btn" onClick={onPickTarget} disabled={disabled}>
          <span>{targetName || <span className="entry-ph">{kind === "settlement" ? "資産を選ぶ" : "分類を選ぶ"}</span>}</span>
        </button>
        {trailing}
      </div>
      <div className="payroll-line-bottom">
        <input
          className="text-input"
          type="text"
          autoComplete="off"
          placeholder={kind === "pay" ? "項目名（例 通勤費）" : kind === "deduction" ? "項目名（例 所得税）" : "項目名（例 社員食堂）"}
          aria-label={`${PAYROLL_KIND_LABELS[kind]}の項目名`}
          value={label}
          disabled={disabled}
          onChange={(e) => onLabel(e.target.value)}
        />
        <YenInput value={amount === 0 ? null : amount} onChange={(n) => onAmount(n ?? 0)} ariaLabel={`${label || PAYROLL_KIND_LABELS[kind]}の金額`} />
      </div>
      {extra}
    </li>
  );
}

/** 画面の下の「支給 計 − 控除 計 − 後払い 計 ＝ 手取り」 */
export function TakeHome({ totals }: { totals: PayrollTotals }) {
  return (
    <div className="take-home" aria-live="polite">
      支給 計 {formatYen(totals.pay)} − 控除 計 {formatYen(totals.deduction)} − 天引き後払い 計 {formatYen(totals.settlement)} ＝ 手取り
      <strong className={totals.takeHome < 0 ? "neg" : undefined}>{formatYen(totals.takeHome)}</strong>
    </div>
  );
}
