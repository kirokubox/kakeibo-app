// 立替と返金のロジック（画面から切り離した純粋なロジック）。
// 立替 = 支出に付く reimbursement。返金 = 収入に付く settles（どの立替を返したか）。
import { isYen } from "./money.js";
import type { Id, Transaction } from "./types.js";

/** 初期分類「一時収入＞立替返金」のID。本人が名前を変えても同じIDで判定する */
export const SETTLE_CATEGORY_ID = "seed:income:一時収入/立替返金";

export interface Reimb {
  counterparty: string;
  amount: number;
}

/** 立替の金額（支出の金額を超えないように丸める） */
export function reimbAmountOf(t: Transaction): number {
  if (!t.reimbursement) return 0;
  return Math.max(0, Math.min(t.reimbursement.amount, t.amount));
}

/** シートの入力チェック。エラーの文章（なければ null） */
export function validateReimb(counterparty: string, amount: number | null, expenseAmount: number | null): string | null {
  if (counterparty.trim() === "") return "相手を入れてください";
  if (amount === null || !isYen(amount) || amount <= 0) return "金額を1円以上で入れてください";
  if (expenseAmount !== null && amount > expenseAmount) return "金額は支出の金額以下にしてください";
  return null;
}

/** 保存の直前のチェック：支出を立替より小さくしていないか。エラーの文章（なければ null） */
export function checkReimbWithin(expenseAmount: number | null, reimb: Reimb | null): string | null {
  if (!reimb || expenseAmount === null) return null;
  return reimb.amount > expenseAmount ? "立替の金額が支出より大きくなっています" : null;
}

/** 収入の下書きに「返金した立替」の行を出すか */
export function isSettleCategory(categoryId: Id | null | undefined): boolean {
  return categoryId === SETTLE_CATEGORY_ID;
}

/**
 * 支出・収入の取引に立替と返金の項目を付ける（付けないものは取り除く）。
 *  立替は支出だけ、返金（settles）は「立替返金」の分類の収入だけ。ほかは外す（別の分類に変えたら未回収に戻る）。
 */
export function applyReimbFields(t: Transaction, reimb: Reimb | null, settlesTxId: Id | null): Transaction {
  const next: Transaction = { ...t };
  if (next.type === "expense" && reimb) next.reimbursement = { counterparty: reimb.counterparty.trim(), amount: reimb.amount };
  else delete next.reimbursement;
  if (next.type === "income" && isSettleCategory(next.categoryId) && settlesTxId) next.settles = { txId: settlesTxId };
  else delete next.settles;
  return next;
}

function byDateAsc(a: Transaction, b: Transaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
}

export interface Allocation {
  /** 立替（支出）のid → 残り（0以上） */
  remaining: Map<Id, number>;
  /** 返金（収入）のid → その返金のうち、立替に充てた額。多い分は含めない */
  applied: Map<Id, number>;
}

/**
 * 立替の残りと、返金に充てた額。論理削除済みは除く。
 *  残り = 立替の金額 − その支出を settles で指す収入の金額の合計（0未満は0）。
 *  同じ立替を指す返金が複数あるときは、日付の古い順に残りへ充てる（多い分だけ収入に数える）。
 *  立替の支出が無い・削除済みなら、その返金は充てた額0（普通の収入）。
 */
export function computeAllocation(transactions: readonly Transaction[]): Allocation {
  const expenses = new Map<Id, Transaction>();
  const returns = new Map<Id, Transaction[]>();
  for (const t of transactions) {
    if (t.deletedAt !== null) continue;
    if (t.type === "expense" && t.reimbursement) expenses.set(t.id, t);
    else if (t.type === "income" && t.settles) {
      const list = returns.get(t.settles.txId);
      if (list) list.push(t);
      else returns.set(t.settles.txId, [t]);
    }
  }
  const remaining = new Map<Id, number>();
  const applied = new Map<Id, number>();
  for (const [id, expense] of expenses) {
    let left = reimbAmountOf(expense);
    const list = (returns.get(id) ?? []).sort(byDateAsc);
    for (const r of list) {
      const use = Math.min(Math.max(r.amount, 0), left);
      applied.set(r.id, use);
      left -= use;
    }
    remaining.set(id, left);
  }
  return { remaining, applied };
}

export interface OutstandingItem {
  tx: Transaction; // 立て替えた支出
  amount: number; // 立替の金額
  returned: number; // 返ってきた額
  remaining: number; // 残り
}

export interface OutstandingGroup {
  counterparty: string;
  remaining: number; // 相手ごとの残りの合計
  items: OutstandingItem[]; // 古い順
}

/**
 * 未回収の一覧（相手ごと）。残りが0より大きい立替だけ。明細は古い順。
 * 相手は、いちばん古い明細が古い順。excludeReturnId の返金は「無かったこと」にして数える（返金を編集中に、その返金が指す立替を選べるように）。
 */
export function outstandingGroups(transactions: readonly Transaction[], excludeReturnId?: Id): OutstandingGroup[] {
  const source = excludeReturnId === undefined ? transactions : transactions.filter((t) => t.id !== excludeReturnId);
  const { remaining } = computeAllocation(source);
  const groups = new Map<string, OutstandingGroup>();
  const items: OutstandingItem[] = [];
  for (const t of source) {
    if (t.deletedAt !== null || t.type !== "expense" || !t.reimbursement) continue;
    const left = remaining.get(t.id) ?? 0;
    if (left <= 0) continue;
    const amount = reimbAmountOf(t);
    items.push({ tx: t, amount, returned: amount - left, remaining: left });
  }
  items.sort((a, b) => byDateAsc(a.tx, b.tx));
  for (const item of items) {
    const name = item.tx.reimbursement!.counterparty.trim();
    let g = groups.get(name);
    if (!g) {
      g = { counterparty: name, remaining: 0, items: [] };
      groups.set(name, g);
    }
    g.remaining += item.remaining;
    g.items.push(item);
  }
  return [...groups.values()];
}

export function outstandingSummary(groups: readonly OutstandingGroup[]): { count: number; total: number } {
  let count = 0;
  let total = 0;
  for (const g of groups) {
    count += g.items.length;
    total += g.remaining;
  }
  return { count, total };
}

/** 立替の相手の候補：過去の立替（論理削除済みを除く）の相手を、回数の多い順（同数は名前順）。typed があれば含むものだけ */
export function counterpartySuggestions(transactions: readonly Transaction[], typed = "", limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const t of transactions) {
    if (t.deletedAt !== null || t.type !== "expense" || !t.reimbursement) continue;
    const name = t.reimbursement.counterparty.trim();
    if (name !== "") counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const needle = typed.trim().normalize("NFKC").toLowerCase();
  return [...counts.entries()]
    .filter(([name]) => needle === "" || (name.normalize("NFKC").toLowerCase().includes(needle) && name !== typed.trim()))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([name]) => name);
}

/** 返金の入力で、選んだ立替の残り（編集中の返金自身は数えない） */
export function remainingFor(expenseId: Id, transactions: readonly Transaction[], excludeReturnId?: Id): number | null {
  const source = excludeReturnId === undefined ? transactions : transactions.filter((t) => t.id !== excludeReturnId);
  return computeAllocation(source).remaining.get(expenseId) ?? null;
}

/** 返金の金額が残りより多いか（多ければ、多い分を返す） */
export function overReturn(amount: number | null, remaining: number | null): number {
  if (amount === null || remaining === null) return 0;
  return Math.max(0, amount - remaining);
}
