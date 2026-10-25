// 残高修正と資産の明細のロジック（画面から切り離した純粋なロジック）。
// 残高修正 = 実際の残高に合わせるための、符号つきの差額の明細（type: 'adjustment'、amount は増えたら正・減ったら負）。
import { cardOpeningToStored, txEffect } from "./accountLogic.js";
import { isYen } from "./money.js";
import type { Account, Base, Id, Transaction } from "./types.js";

export const ADJUST_CONTENT = "残高修正";

function bySequence(a: Transaction, b: Transaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
}

/** その資産が出てくる、論理削除されていない取引（出金側・入金側の両方） */
export function accountTransactions(accountId: Id, transactions: readonly Transaction[]): Transaction[] {
  return transactions.filter((t) => t.deletedAt === null && (t.accountId === accountId || t.toAccountId === accountId));
}

/**
 * 選んだ日の終わりの残高：初期残高 + 選んだ日まで（その日を含む）の明細。後の日付の明細は入れない。
 * excludeTxId の明細は入れない（残高修正を編集するとき、その修正自身を除いて数える）。
 */
export function balanceAsOf(account: Account, transactions: readonly Transaction[], date: string, excludeTxId?: Id): number {
  let balance = account.openingBalance;
  for (const t of accountTransactions(account.id, transactions)) {
    if (t.date > date || t.id === excludeTxId) continue;
    balance += txEffect(account.id, t);
  }
  return balance;
}

/** 入力した「実際の残高」を保存する形の残高にする。カードは「実際の未払い額」を正の数で入れてもらい、マイナスにする */
export function actualToBalance(account: Account, input: number): number {
  return account.group === "card" ? cardOpeningToStored(input) : input;
}

/** 差額 = 実際の残高 − アプリの残高。増えたら正 */
export function adjustmentDiff(appBalance: number, actualBalance: number): number {
  return actualBalance - appBalance;
}

export type AdjustCheck = { ok: true } | { ok: false; message: string };

/** 保存できるか：差額が 0 でない整数 */
export function checkAdjustDiff(diff: number | null): AdjustCheck {
  if (diff === null || !isYen(diff)) return { ok: false, message: "金額を入れてください" };
  if (diff === 0) return { ok: false, message: "合っています" };
  return { ok: true };
}

/** 差額の説明：差額 ＋655円（アプリより多い） / 差額 −300円（アプリより少ない） / 合っています */
export function describeDiff(diff: number): string {
  if (diff === 0) return "合っています";
  const abs = Math.abs(diff).toLocaleString("ja-JP");
  return diff > 0 ? `差額 ＋${abs}円（アプリより多い）` : `差額 −${abs}円（アプリより少ない）`;
}

/** 残高修正の明細を作る。existing があれば金額・日付・メモだけ直す */
export function makeAdjustment(accountId: Id, date: string, diff: number, memo: string, base: Base, existing?: Transaction): Transaction {
  const t: Transaction = existing
    ? { ...existing, date, amount: diff, memo: memo.trim() }
    : { ...base, type: "adjustment", date, amount: diff, accountId, content: ADJUST_CONTENT, memo: memo.trim(), source: "manual" };
  return t;
}

/**
 * 各明細の「あとの残高」。初期残高から、日付・作った順に積み上げる（同じ日は作った順。表示は新しいものが上）。
 * 論理削除済みは除く。
 */
export function runningBalances(account: Account, transactions: readonly Transaction[]): Map<Id, number> {
  const list = accountTransactions(account.id, transactions).sort(bySequence);
  const result = new Map<Id, number>();
  let balance = account.openingBalance;
  for (const t of list) {
    balance += txEffect(account.id, t);
    result.set(t.id, balance);
  }
  return result;
}

export interface MonthBlock {
  month: string; // YYYY-MM
  items: Transaction[]; // 新しい順
}

/** 資産の明細を月ごとに（新しい月から。月の中は日付・作った順の新しいものが上）。論理削除済みは除く */
export function monthBlocks(accountId: Id, transactions: readonly Transaction[]): MonthBlock[] {
  const list = accountTransactions(accountId, transactions).sort(bySequence).reverse();
  const blocks: MonthBlock[] = [];
  for (const t of list) {
    const month = t.date.slice(0, 7);
    const last = blocks[blocks.length - 1];
    if (last && last.month === month) last.items.push(t);
    else blocks.push({ month, items: [t] });
  }
  return blocks;
}

/** 最初に出す月の数：今月と先月の分（それより新しい月も入る）。明細がある月だけ数え、最低1つ */
export function initialMonthCount(blocks: readonly MonthBlock[], thisMonth: string): number {
  const [y, m] = thisMonth.split("-").map(Number);
  const t = y * 12 + (m - 1) - 1;
  const cutoff = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  const n = blocks.filter((b) => b.month >= cutoff).length;
  return Math.min(blocks.length, Math.max(n, 1));
}
