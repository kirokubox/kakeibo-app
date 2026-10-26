// カードの引き落とし予定のロジック（画面から切り離した純粋なロジック。改善2）。
// 引き落としは「予定出費」にはしない（カードで使った時点で使える額から引いているため。予定出費にすると二重に引かれる）。
// ここは見せるだけで、使える額・予算の計算には入れない。
import { computeBalancesUntil } from "./accountLogic.js";
import { cardPaymentDateOf, nextCardPayment } from "./businessDay.js";
import { addDays, addMonths } from "./dateUtils.js";
import { findCardTransferInMonth, unpaidEffect, unreconciledOf } from "./reconcileLogic.js";
import type { Account, CardStatement, Id, Transaction } from "./types.js";

/** ホームに出す期間（今日から何日先まで） */
export const DEBIT_HORIZON_DAYS = 14;
/** 引き落とし日を過ぎても、お知らせを出し続ける日数 */
export const DEBIT_NOTICE_DAYS = 7;

export type CardDebitSource = "statement" | "transfer" | "estimate";

export interface CardDebit {
  cardId: Id;
  cardName: string;
  date: string;
  amount: number;
  /** statement＝照合で確定した請求／transfer＝先の日付の、そのカードへの振替／estimate＝照合していない明細の合計（見込み） */
  source: CardDebitSource;
  paymentAccountId: Id | null;
  paymentAccountName: string;
  /** 引き落とし口座の今日の残高が足りない額（足りていれば 0。同じ口座の先の引き落としも続けて引いて数える） */
  shortfall: number;
}

type DebitData = {
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  cardStatements: readonly CardStatement[];
};

/** 照合していないカードの明細の合計（前回の引き落とし以降のもの。0以下なら null） */
export function estimatedCardAmount(card: Account, txs: readonly Transaction[], today: string): number | null {
  const lastDebit = txs
    .filter((t) => t.deletedAt === null && t.type === "transfer" && t.toAccountId === card.id && t.date <= today)
    .reduce((max, t) => (t.date > max ? t.date : max), "");
  const sum = unreconciledOf(card.id, txs)
    .filter((t) => t.date <= today && t.date > lastDebit)
    .reduce((s, t) => s + unpaidEffect(t), 0);
  return sum > 0 ? sum : null;
}

/**
 * 今日から horizonDays 日先までの引き落とし予定（日付の順）。カードごとに、次の順で元を決める。
 *  ①照合で確定した請求（支払日が今日以降）、②先の日付の、そのカードへの振替、③どちらもなければ、照合していない明細の合計を「見込み」として。
 * 引き落としの振替がもう記録済み（今日までの日付）の請求は出さない。
 */
export function upcomingCardDebits(data: DebitData, today: string, horizonDays: number = DEBIT_HORIZON_DAYS): CardDebit[] {
  const limit = addDays(today, horizonDays);
  const txs = data.transactions.filter((t) => t.deletedAt === null);
  const accounts = data.accounts.filter((a) => a.deletedAt === null);
  const list: Array<Omit<CardDebit, "shortfall">> = [];

  for (const card of accounts) {
    if (card.group !== "card" || !card.card) continue;
    const pay = accounts.find((a) => a.id === card.card!.paymentAccountId) ?? null;
    const base = { cardId: card.id, cardName: card.name, paymentAccountId: pay?.id ?? null, paymentAccountName: pay?.name ?? "口座未設定" };
    const transfersTo = txs.filter((t) => t.type === "transfer" && t.toAccountId === card.id);
    const entries = new Map<string, Omit<CardDebit, "shortfall">>();

    for (const st of data.cardStatements) {
      if (st.deletedAt !== null || st.cardAccountId !== card.id || st.paymentDate < today) continue;
      const done = transfersTo.some((t) => t.date === st.paymentDate && t.date <= today);
      if (done) continue;
      entries.set(st.paymentDate, { ...base, date: st.paymentDate, amount: st.actualAmount, source: "statement" });
    }
    const futureByDate = new Map<string, number>();
    for (const t of transfersTo) if (t.date > today) futureByDate.set(t.date, (futureByDate.get(t.date) ?? 0) + t.amount);
    for (const [date, amount] of futureByDate) {
      if (!entries.has(date)) entries.set(date, { ...base, date, amount, source: "transfer" });
    }
    if (entries.size === 0) {
      const est = estimatedCardAmount(card, txs, today);
      if (est !== null) {
        const date = nextCardPayment(card.card, today);
        entries.set(date, { ...base, date, amount: est, source: "estimate" });
      }
    }
    for (const e of entries.values()) if (e.date >= today && e.date <= limit) list.push(e);
  }

  list.sort((a, b) => a.date.localeCompare(b.date) || a.cardName.localeCompare(b.cardName));
  // 引き落とし口座の今日の残高が足りるか（同じ口座の先の引き落としは続けて引く）
  const balances = computeBalancesUntil(accounts, txs, today);
  const left = new Map<Id, number>();
  return list.map((e) => {
    if (e.paymentAccountId === null) return { ...e, shortfall: 0 };
    const rest = left.get(e.paymentAccountId) ?? balances.get(e.paymentAccountId) ?? 0;
    left.set(e.paymentAccountId, rest - e.amount);
    return { ...e, shortfall: Math.max(0, e.amount - Math.max(0, rest)) };
  });
}

export interface DebitNotice {
  cardId: Id;
  cardName: string;
  /** 引き落とし日 */
  date: string;
  /** 確定した請求額（なければ見込み。どちらもなければ null） */
  amount: number | null;
  amountSource: "statement" | "estimate" | null;
}

/**
 * 「今日は◯◯カードの引き落とし日です」のお知らせ。引き落とし日の当日以降（DEBIT_NOTICE_DAYS 日まで）で、
 * そのカードへの振替がその月にまだ記録されていないもの。
 */
export function debitDueNotices(data: DebitData, today: string): DebitNotice[] {
  const txs = data.transactions.filter((t) => t.deletedAt === null);
  const out: DebitNotice[] = [];
  for (const card of data.accounts) {
    if (card.deletedAt !== null || card.group !== "card" || !card.card) continue;
    const ym = today.slice(0, 7);
    const date = [addMonths(ym, -1), ym]
      .map((m) => cardPaymentDateOf(card.card!, m))
      .filter((d) => d <= today)
      .sort()
      .pop();
    if (!date || addDays(date, DEBIT_NOTICE_DAYS) < today) continue;
    if (findCardTransferInMonth(card.id, date, txs)) continue;
    const st = data.cardStatements.find((s) => s.deletedAt === null && s.cardAccountId === card.id && s.paymentDate === date);
    if (st) {
      out.push({ cardId: card.id, cardName: card.name, date, amount: st.actualAmount, amountSource: "statement" });
      continue;
    }
    const est = estimatedCardAmount(card, txs, today);
    out.push({ cardId: card.id, cardName: card.name, date, amount: est, amountSource: est === null ? null : "estimate" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.cardName.localeCompare(b.cardName));
}
