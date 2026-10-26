import assert from "node:assert/strict";
import test from "node:test";
import { debitDueNotices, estimatedCardAmount, upcomingCardDebits } from "../src/cardDebitLogic.js";
import { computeBalancesUntil, plannedBalanceNote, plannedEffects } from "../src/accountLogic.js";
import { prepareCardDebitOn } from "../src/transferLogic.js";
import type { CardStatement } from "../src/types.js";
import { T0, account, tx } from "./fixtures.js";

// 架空のカードと銀行。引き落とし日は毎月27日（休日の移動なし）。2026-10-27 は火曜
const bank = account("bank", { name: "テスト銀行", group: "bank", openingBalance: 50000 });
const card = account("card", { name: "テストカード", group: "card", openingBalance: 0, card: { paymentDay: 27, holidayShift: "none", paymentAccountId: "bank" } });
const accounts = [bank, card];
const statement = (id: string, paymentDate: string, actualAmount: number, extra: Partial<CardStatement> = {}): CardStatement => ({
  id, createdAt: T0, updatedAt: T0, deletedAt: null, cardAccountId: "card", paymentDate, actualAmount, diff: 0, ...extra,
});
const cardUse = (id: string, date: string, amount: number) => tx(id, { accountId: "card", date, amount });
const debit = (id: string, date: string, amount: number) => tx(id, { type: "transfer", accountId: "bank", toAccountId: "card", date, amount, content: "カード引き落とし" });

test("引き落とし予定：確定した請求（支払日が今日以降）が元。14日以内だけ", () => {
  const data = { accounts, transactions: [cardUse("u1", "2026-10-05", 124974)], cardStatements: [statement("s1", "2026-10-27", 124974)] };
  const list = upcomingCardDebits(data, "2026-10-20");
  assert.equal(list.length, 1);
  assert.equal(list[0].source, "statement");
  assert.equal(list[0].date, "2026-10-27");
  assert.equal(list[0].amount, 124974);
  assert.equal(list[0].paymentAccountName, "テスト銀行");
  // 14日より先は出さない
  assert.deepEqual(upcomingCardDebits(data, "2026-10-10"), []);
  assert.equal(upcomingCardDebits(data, "2026-10-13").length, 1, "ちょうど14日先は出す");
});

test("引き落とし予定：確定した請求がなければ、先の日付の振替。どちらもなければ未照合の明細の合計を見込みで", () => {
  const withTransfer = { accounts, transactions: [cardUse("u1", "2026-10-05", 30000), debit("d1", "2026-10-27", 28000)], cardStatements: [] };
  const a = upcomingCardDebits(withTransfer, "2026-10-20");
  assert.deepEqual(a.map((d) => [d.source, d.amount]), [["transfer", 28000]]);

  const estimateOnly = { accounts, transactions: [cardUse("u1", "2026-10-05", 30000), cardUse("u2", "2026-10-10", 4500)], cardStatements: [] };
  const b = upcomingCardDebits(estimateOnly, "2026-10-20");
  assert.deepEqual(b.map((d) => [d.source, d.amount, d.date]), [["estimate", 34500, "2026-10-27"]]);

  // 確定した請求と同じ日の振替があっても1行（請求が優先）
  const both = { accounts, transactions: [cardUse("u1", "2026-10-05", 30000), debit("d1", "2026-10-27", 30000)], cardStatements: [statement("s1", "2026-10-27", 30000)] };
  assert.deepEqual(upcomingCardDebits(both, "2026-10-20").map((d) => d.source), ["statement"]);
});

test("見込み：照合済みの明細は数えない。前回の引き落とし以降の明細だけ。なければ出さない", () => {
  const txs = [cardUse("old", "2026-08-30", 99999), debit("d0", "2026-09-27", 99999), cardUse("r", "2026-10-02", 1000, ), { ...cardUse("rec", "2026-10-03", 2000), reconciledStatementId: "x" }, cardUse("n", "2026-10-04", 3000)];
  assert.equal(estimatedCardAmount(card, txs, "2026-10-20"), 4000);
  assert.equal(estimatedCardAmount(card, [], "2026-10-20"), null);
});

test("引き落とし口座の今日の残高が足りなければ、足りない額を出す（同じ口座の先の引き落としは続けて引く）", () => {
  const data = { accounts, transactions: [cardUse("u1", "2026-10-05", 124974)], cardStatements: [statement("s1", "2026-10-27", 124974)] };
  assert.equal(upcomingCardDebits(data, "2026-10-20")[0].shortfall, 124974 - 50000);
  const enough = { ...data, accounts: [{ ...bank, openingBalance: 200000 }, card] };
  assert.equal(upcomingCardDebits(enough, "2026-10-20")[0].shortfall, 0);
  // 2枚目のカード（同じ口座・翌日）は、1枚目の分を引いた残りで足りるか見る
  const card2 = account("card2", { name: "テスト第二カード", group: "card", openingBalance: 0, card: { paymentDay: 28, holidayShift: "none", paymentAccountId: "bank" } });
  const two = {
    accounts: [{ ...bank, openingBalance: 150000 }, card, card2],
    transactions: [cardUse("u1", "2026-10-05", 124974)],
    cardStatements: [statement("s1", "2026-10-27", 124974), statement("s2", "2026-10-28", 30000, { cardAccountId: "card2" })],
  };
  const list = upcomingCardDebits(two, "2026-10-20");
  assert.deepEqual(list.map((d) => d.shortfall), [0, 30000 - (150000 - 124974)]);
});

test("振替が今日までの日付で記録済みなら、その請求は出さない", () => {
  const data = { accounts, transactions: [cardUse("u1", "2026-10-05", 30000), debit("d1", "2026-10-27", 30000)], cardStatements: [statement("s1", "2026-10-27", 30000)] };
  assert.deepEqual(upcomingCardDebits(data, "2026-10-27"), []);
});

test("引き落とし日のお知らせ：当日以降で、その月の振替がまだなければ。確定した請求額を使う。記録済みなら出さない", () => {
  const base = { accounts, transactions: [cardUse("u1", "2026-10-05", 30000)], cardStatements: [statement("s1", "2026-10-27", 30000)] };
  const n = debitDueNotices(base, "2026-10-27");
  assert.equal(n.length, 1);
  assert.deepEqual([n[0].cardName, n[0].date, n[0].amount, n[0].amountSource], ["テストカード", "2026-10-27", 30000, "statement"]);
  assert.equal(debitDueNotices(base, "2026-10-29").length, 1, "引き落とし日の翌日以降も、記録するまで出す");
  assert.deepEqual(debitDueNotices(base, "2026-10-26"), [], "当日より前は出さない");
  assert.deepEqual(debitDueNotices(base, "2026-11-10"), [], "7日をすぎたら出さない");
  const recorded = { ...base, transactions: [...base.transactions, debit("d1", "2026-10-27", 30000)] };
  assert.deepEqual(debitDueNotices(recorded, "2026-10-27"), []);
  // 請求が未確定なら、金額は見込み
  const noStatement = { ...base, cardStatements: [] };
  assert.deepEqual(debitDueNotices(noStatement, "2026-10-27").map((x) => [x.amount, x.amountSource]), [[30000, "estimate"]]);
});

test("「引き落としを記録」：日付は引き落とし日、金額は確定した請求額、出金は引き落とし口座", () => {
  const r = prepareCardDebitOn(card, accounts, 30000, "2026-10-27");
  assert.equal(r.draft.fromId, "bank");
  assert.equal(r.draft.toId, "card");
  assert.equal(r.draft.amount, 30000);
  assert.equal(r.draft.date, "2026-10-27");
  assert.equal(prepareCardDebitOn(card, accounts, null, "2026-10-27").draft.amount, null);
});

test("今日までの残高と、予定を含めた残高（先の日付の明細）", () => {
  const txs = [tx("past", { accountId: "bank", date: "2026-10-20", amount: 1000 }), debit("fut", "2026-10-27", 30000), tx("fut2", { accountId: "bank", date: "2026-11-02", amount: 500 })];
  const until = computeBalancesUntil(accounts, txs, "2026-10-26");
  assert.equal(until.get("bank"), 49000);
  assert.equal(until.get("card"), 0);
  const eff = plannedEffects(accounts, txs, "2026-10-26");
  assert.deepEqual(eff.get("bank"), { delta: -30500, count: 2 });
  assert.deepEqual(eff.get("card"), { delta: 30000, count: 1 });
  assert.equal(plannedBalanceNote(49000, eff.get("bank")), "予定を含めると 18,500円（2件）");
  assert.equal(plannedBalanceNote(49000, undefined), null);
  // 削除済みの明細は予定に数えない
  assert.equal(plannedEffects(accounts, [{ ...txs[1], deletedAt: T0 }], "2026-10-26").size, 0);
});
