// 振替の入力のロジック（画面から切り離した純粋なロジック）。
// 振替 = 出金の資産から（金額＋手数料）が出て、入金の資産へ金額が入る。分類・タグ・立替は付けない。
import { MAX_AMOUNT } from "./calculator.js";
import { isAccountSelectable } from "./entryLogic.js";
import type { EntryDraft, EntryType } from "./entryLogic.js";
import { isYen } from "./money.js";
import type { Account, Base, Id, Transaction, TransactionTemplate } from "./types.js";

export interface TransferDraft {
  date: string;
  fromId: Id | null; // 出金
  toId: Id | null; // 入金
  amount: number | null;
  fee: number | null; // 手数料。null と 0 は「なし」
  content: string;
  memo: string;
}

export const CARD_DEBIT_CONTENT = "カード引き落とし";
export const CARD_PREPAY_CONTENT = "繰上返済";

export function emptyTransferDraft(date: string): TransferDraft {
  return { date, fromId: null, toId: null, amount: null, fee: null, content: "", memo: "" };
}

// ---- 保存できるか ----

export type TransferMissing = "from" | "to" | "amount";
export type TransferCheck = { ok: true } | { ok: false; field: TransferMissing; message: string };

/** 出金・入金・金額がそろい、出金と入金が違う資産であること */
export function checkTransferDraft(d: TransferDraft): TransferCheck {
  if (!d.fromId) return { ok: false, field: "from", message: "出金の資産を選んでください" };
  if (!d.toId) return { ok: false, field: "to", message: "入金の資産を選んでください" };
  if (d.fromId === d.toId) return { ok: false, field: "to", message: "出金と入金は別の資産にしてください" };
  if (d.amount === null || !isYen(d.amount) || d.amount <= 0 || d.amount > MAX_AMOUNT) {
    return { ok: false, field: "amount", message: "金額を入れてください" };
  }
  return { ok: true };
}

/** 出金と入金を入れ替える */
export function swapTransferAccounts(d: TransferDraft): TransferDraft {
  return { ...d, fromId: d.toId, toId: d.fromId };
}

/** 手数料として保存する額（なし・0 は 0） */
export function feeOf(d: TransferDraft): number {
  return d.fee !== null && isYen(d.fee) && d.fee > 0 ? d.fee : 0;
}

/** 出金の資産から出る額（金額＋手数料） */
export function totalOut(d: TransferDraft): number {
  return (d.amount ?? 0) + feeOf(d);
}

// ---- 下書きと取引の変換 ----

export function transferFromTransaction(t: Transaction): TransferDraft | null {
  if (t.type !== "transfer") return null;
  return {
    date: t.date,
    fromId: t.accountId,
    toId: t.toAccountId ?? null,
    amount: t.amount,
    fee: t.fee && t.fee > 0 ? t.fee : null,
    content: t.content,
    memo: t.memo,
  };
}

/** コピーして新しく入力：日付は今日、ほかは同じ */
export function copyTransferDraft(t: Transaction, today: string): TransferDraft | null {
  const d = transferFromTransaction(t);
  return d ? { ...d, date: today } : null;
}

/** 続ける：種類・日付・出金を残し、ほかを空にする */
export function continueTransferDraft(d: TransferDraft): TransferDraft {
  return { ...emptyTransferDraft(d.date), fromId: d.fromId };
}

/** 下書き → 取引。existing があれば上書き（作成日時・取り込み元などは残し、分類・タグ・立替などは外す） */
export function transferToTransaction(d: TransferDraft, base: Base, existing?: Transaction): Transaction {
  const t: Transaction = {
    ...(existing ?? { ...base, source: "manual" as const }),
    type: "transfer",
    date: d.date,
    amount: d.amount ?? 0,
    accountId: d.fromId ?? "",
    toAccountId: d.toId ?? undefined,
    content: d.content.trim(),
    memo: d.memo.trim(),
  };
  const fee = feeOf(d);
  if (fee > 0) t.fee = fee;
  else delete t.fee;
  if (t.toAccountId === undefined) delete t.toAccountId;
  delete t.categoryId;
  delete t.tag;
  delete t.reimbursement;
  delete t.settles;
  delete t.reserveId;
  return t;
}

// ---- 種類を替えたときの引き継ぎ ----

/** 収入・支出 → 振替：日付・金額・内容・メモを残し、資産は出金へ。分類・タグ・入金は空 */
export function toTransferDraft(e: EntryDraft, prev?: TransferDraft): TransferDraft {
  return { ...emptyTransferDraft(e.date), fromId: e.accountId, amount: e.amount, content: e.content, memo: e.memo, fee: prev?.fee ?? null };
}

/** 振替 → 収入・支出：日付・金額・内容・メモを残し、出金は資産へ。分類・タグは空 */
export function toEntryDraftFromTransfer(d: TransferDraft, type: EntryType): EntryDraft {
  return { type, date: d.date, accountId: d.fromId, categoryId: null, amount: d.amount, content: d.content, memo: d.memo, tag: null };
}

// ---- よく使う入力 ----

export function transferToTemplate(d: TransferDraft): TransactionTemplate {
  const t: TransactionTemplate = {
    type: "transfer",
    amount: d.amount ?? 0,
    accountId: d.fromId ?? "",
    content: d.content.trim(),
    memo: d.memo.trim(),
  };
  if (d.toId) t.toAccountId = d.toId;
  const fee = feeOf(d);
  if (fee > 0) t.fee = fee;
  return t;
}

export type TransferFocus = "from" | "to" | "amount";

/** 振替のひな形を呼び出す：日付は今のまま。資産が使えないものは空にして、そのパネルを開く。それ以外は金額のテンキー */
export function recallTransferFavorite(
  template: TransactionTemplate,
  date: string,
  accounts: readonly Account[],
): { draft: TransferDraft; focus: TransferFocus } | null {
  if (template.type !== "transfer") return null;
  const fromOk = isAccountSelectable(accounts, template.accountId);
  const toOk = isAccountSelectable(accounts, template.toAccountId) && template.toAccountId !== template.accountId;
  const draft: TransferDraft = {
    date,
    fromId: fromOk ? template.accountId : null,
    toId: toOk ? (template.toAccountId ?? null) : null,
    amount: template.amount > 0 ? template.amount : null,
    fee: template.fee && template.fee > 0 ? template.fee : null,
    content: template.content,
    memo: template.memo,
  };
  return { draft, focus: !fromOk ? "from" : !toOk ? "to" : "amount" };
}

// ---- 内容の候補・前回 ----

/** 入金がカードで、出金がそのカードの引き落とし口座なら、先頭に出す内容 */
export function cardTransferContents(accounts: readonly Account[], fromId: Id | null, toId: Id | null): string[] {
  if (!fromId || !toId) return [];
  const card = accounts.find((a) => a.id === toId && a.deletedAt === null);
  if (!card || card.group !== "card" || !card.card) return [];
  return card.card.paymentAccountId === fromId ? [CARD_DEBIT_CONTENT, CARD_PREPAY_CONTENT] : [];
}

/** 何も打っていないときの候補：カードの内容を先頭に、続けて過去の内容。重複は除いて limit 件 */
export function mergeTransferSuggestions(cardContents: readonly string[], past: readonly string[], limit: number): string[] {
  return [...new Set([...cardContents, ...past])].slice(0, limit);
}

export interface TransferHint {
  fromId: Id | null;
  toId: Id | null;
}

/** 内容を決めたあとの「前回：A → B」。いま選べない資産は含めず、いまと同じなら null */
export function transferUsageHint(
  last: { accountId: Id; toAccountId?: Id } | null,
  draft: TransferDraft,
  accounts: readonly Account[],
): TransferHint | null {
  if (!last) return null;
  const fromOk = isAccountSelectable(accounts, last.accountId);
  const toOk = isAccountSelectable(accounts, last.toAccountId);
  if (!fromOk || !toOk || last.accountId === last.toAccountId) return null;
  if (last.accountId === draft.fromId && last.toAccountId === draft.toId) return null;
  return { fromId: last.accountId, toId: last.toAccountId ?? null };
}

export function applyTransferHint(d: TransferDraft, hint: TransferHint): TransferDraft {
  return { ...d, fromId: hint.fromId, toId: hint.toId };
}

// ---- カードの引き落とし ----

/** カードの未払い額（残高のマイナスを正の数で。プラスなら 0） */
export function unpaidAmount(balance: number): number {
  return balance < 0 ? -balance : 0;
}

/**
 * 「引き落としを記録」：出金＝引き落とし口座、入金＝そのカード、金額＝今の未払い額、内容＝カード引き落とし、日付＝今日。
 * 引き落とし口座が削除済み・非表示なら出金を空にして出金のパネルを開く。未払いが 0 のときは金額を空にして、金額のテンキーを開く。
 */
export function prepareCardDebit(
  card: Account,
  accounts: readonly Account[],
  balance: number,
  today: string,
): { draft: TransferDraft; focus: TransferFocus } {
  const payId = card.card?.paymentAccountId ?? null;
  const fromOk = isAccountSelectable(accounts, payId);
  const unpaid = unpaidAmount(balance);
  const draft: TransferDraft = {
    ...emptyTransferDraft(today),
    fromId: fromOk ? payId : null,
    toId: card.id,
    amount: unpaid > 0 ? unpaid : null,
    content: CARD_DEBIT_CONTENT,
  };
  return { draft, focus: fromOk ? "amount" : "from" };
}

/**
 * ホームの「今日は◯◯カードの引き落とし日です［引き落としを記録］」：金額は確定した請求額（なければ空）、日付は引き落とし日。
 * 引き落とし口座が選べないときは出金を空にして出金のパネルを開く。金額がないときは金額のテンキーを開く。
 */
export function prepareCardDebitOn(card: Account, accounts: readonly Account[], amount: number | null, date: string): { draft: TransferDraft; focus: TransferFocus } {
  const payId = card.card?.paymentAccountId ?? null;
  const fromOk = isAccountSelectable(accounts, payId);
  const draft: TransferDraft = {
    ...emptyTransferDraft(date),
    fromId: fromOk ? payId : null,
    toId: card.id,
    amount: amount !== null && amount > 0 ? amount : null,
    content: CARD_DEBIT_CONTENT,
  };
  return { draft, focus: fromOk ? "amount" : "from" };
}
