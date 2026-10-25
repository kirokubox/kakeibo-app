// カードの照合のロジック（画面から切り離した純粋なロジック）。
// 照合 = 請求額と、照合していない明細（そのカードの支出・返金・残高修正）のチェックを合わせる。
// 確定すると CardStatement を作り、チェックした明細に reconciledStatementId を付け、引き落としの振替を（選べば）作る。
import { ADJUST_CONTENT } from "./adjustLogic.js";
import { nowIso } from "./dateUtils.js";
import { CARD_DEBIT_CONTENT } from "./transferLogic.js";
import type { Account, Base, CardStatement, Id, Transaction } from "./types.js";

/** 1件が「未払い額」を動かす額：支出は＋、返金（収入）は−、残高修正は残高の符号の逆（残高が減れば未払いが増える） */
export function unpaidEffect(t: Transaction): number {
  if (t.type === "expense") return t.amount;
  return -t.amount; // income, adjustment
}

function bySequence(a: Transaction, b: Transaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
}

/** 照合していない明細：そのカードの支出・返金・残高修正で reconciledStatementId のないもの。古い順 */
export function unreconciledOf(cardId: Id, txs: readonly Transaction[]): Transaction[] {
  return txs
    .filter((t) => t.deletedAt === null && t.accountId === cardId && (t.type === "expense" || t.type === "income" || t.type === "adjustment") && !t.reconciledStatementId)
    .sort(bySequence);
}

/** チェックした明細の合計（未払いを動かす額の合計） */
export function checkedTotal(checked: readonly Transaction[]): number {
  return checked.reduce((s, t) => s + unpaidEffect(t), 0);
}

/** 差額 = 請求額 − チェックした合計。0なら合っている。正＝請求のほうが多い */
export function reconcileDiff(requested: number, checked: readonly Transaction[]): number {
  return requested - checkedTotal(checked);
}

/** 差額の説明 */
export function describeReconcileDiff(diff: number): string {
  if (diff === 0) return "合っています";
  const abs = Math.abs(diff).toLocaleString("ja-JP");
  return diff > 0 ? `請求のほうが ${abs}円 多い` : `請求のほうが ${abs}円 少ない`;
}

/** 差額を残高修正にする明細（カードの残高は、請求が多いぶん減る＝負）。日付は請求の日付 */
export function makeDiffAdjustment(cardId: Id, paymentDate: string, diff: number, base: Base): Transaction {
  return {
    ...base,
    type: "adjustment",
    date: paymentDate,
    amount: -diff,
    accountId: cardId,
    content: ADJUST_CONTENT,
    memo: "カード照合の差額",
    source: "manual",
  };
}

/** 同じ月に、そのカードへの振替（引き落とし・繰上返済）が既にあるか。あれば最初の1件 */
export function findCardTransferInMonth(cardId: Id, paymentDate: string, txs: readonly Transaction[]): Transaction | undefined {
  const ym = paymentDate.slice(0, 7);
  return txs.find((t) => t.deletedAt === null && t.type === "transfer" && t.toAccountId === cardId && t.date.slice(0, 7) === ym);
}

/** 引き落とし口座を使えるか（削除済み・存在しないは不可） */
export function paymentAccountOf(card: Account, accounts: readonly Account[]): Account | null {
  const id = card.card?.paymentAccountId;
  return accounts.find((a) => a.id === id && a.deletedAt === null) ?? null;
}

export interface ConfirmInput {
  card: Account;
  paymentDate: string;
  requested: number;
  /** チェックした明細（差額の残高修正は含めない） */
  checked: readonly Transaction[];
  /** 差額を残高修正にして確定する */
  adjustDiff: boolean;
  /** 引き落としの振替を作る（引き落とし口座があるときだけ有効） */
  createDebit: boolean;
  paymentAccountId: Id | null;
  makeBase: () => Base;
  now?: string;
}

export type ConfirmCheck = { ok: true } | { ok: false; message: string };

export function checkConfirm(input: Pick<ConfirmInput, "requested" | "checked" | "adjustDiff" | "createDebit" | "paymentAccountId">): ConfirmCheck {
  if (!Number.isSafeInteger(input.requested) || input.requested <= 0) return { ok: false, message: "請求額を1円以上で入れてください" };
  if (input.checked.length === 0) return { ok: false, message: "明細にチェックを付けてください" };
  const diff = reconcileDiff(input.requested, input.checked);
  if (diff !== 0 && !input.adjustDiff) return { ok: false, message: "差額が残っています" };
  if (input.createDebit && input.paymentAccountId === null) return { ok: false, message: "引き落とし口座が決まっていません" };
  return { ok: true };
}

export interface ConfirmPlan {
  statement: CardStatement;
  /** reconciledStatementId を付けた明細（チェックした明細） */
  reconciled: Transaction[];
  /** 差額の残高修正（作る場合。reconciledStatementId 付き） */
  adjustment?: Transaction;
  /** 引き落としの振替（作る場合） */
  transfer?: Transaction;
}

/** 確定で書くものを作る（保存は呼び出し側が1つのトランザクションで行う） */
export function planConfirm(input: ConfirmInput): ConfirmPlan {
  const diff = reconcileDiff(input.requested, input.checked);
  const statement: CardStatement = {
    ...input.makeBase(),
    cardAccountId: input.card.id,
    paymentDate: input.paymentDate,
    actualAmount: input.requested,
    diff,
  };
  const reconciled = input.checked.map((t) => ({ ...t, reconciledStatementId: statement.id }));
  const plan: ConfirmPlan = { statement, reconciled };
  if (diff !== 0 && input.adjustDiff) {
    plan.adjustment = { ...makeDiffAdjustment(input.card.id, input.paymentDate, diff, input.makeBase()), reconciledStatementId: statement.id };
  }
  if (input.createDebit && input.paymentAccountId !== null) {
    plan.transfer = {
      ...input.makeBase(),
      type: "transfer",
      date: input.paymentDate,
      amount: input.requested,
      accountId: input.paymentAccountId,
      toAccountId: input.card.id,
      content: CARD_DEBIT_CONTENT,
      memo: "",
      source: "manual",
    };
  }
  return plan;
}

// ---- 履歴と取り消し ----

/** 照合の履歴（新しい請求日が上）。取り消した（論理削除した）ものは除く */
export function statementHistory(cardId: Id, statements: readonly CardStatement[]): CardStatement[] {
  return statements
    .filter((s) => s.deletedAt === null && s.cardAccountId === cardId)
    .sort((a, b) => (a.paymentDate < b.paymentDate ? 1 : a.paymentDate > b.paymentDate ? -1 : a.createdAt < b.createdAt ? 1 : -1));
}

/** その回に照合した明細 */
export function statementItems(statementId: Id, txs: readonly Transaction[]): Transaction[] {
  return txs.filter((t) => t.deletedAt === null && t.reconciledStatementId === statementId).sort(bySequence);
}

export interface UndoPlan {
  statement: CardStatement;
  /** reconciledStatementId を外した明細（引き落としの振替は残す） */
  released: Transaction[];
}

/** 照合を取り消す：明細の reconciledStatementId を外し、請求を論理削除する。振替は残す */
export function planUndo(statement: CardStatement, txs: readonly Transaction[], now: string = nowIso()): UndoPlan {
  const released = txs
    .filter((t) => t.reconciledStatementId === statement.id)
    .map((t) => {
      const next = { ...t };
      delete next.reconciledStatementId;
      return next;
    });
  return { statement: { ...statement, deletedAt: now, updatedAt: now }, released };
}
