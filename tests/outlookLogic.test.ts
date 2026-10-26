import assert from "node:assert/strict";
import test from "node:test";
import type { BudgetSettings } from "../src/budgetLogic.js";
import { OUTLOOK_LENGTHS, averageVariable, buildOutlook, futurePeriods, pastPeriods, payrollIncomeBetween, periodLabel, summarizeOutlook } from "../src/outlookLogic.js";
import type { OutlookData } from "../src/outlookLogic.js";
import type { Payroll, PlannedExpense, Recurring, ReserveMove } from "../src/types.js";
import { T0, account, emptyData, tx } from "./fixtures.js";

const S: BudgetSettings = { payday: 25, paydayHolidayShift: "before", defenseFund: 100000, budgetMonthBoundary: "payday" };

const payroll: Payroll = {
  id: "p1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト給与", accountId: "a1", day: 25, holidayShift: "before",
  lines: [
    { lineId: "l1", kind: "pay", categoryId: "c1", label: "基本給", amount: 300000 },
    { lineId: "l2", kind: "deduction", categoryId: "c1", label: "控除", amount: 60000 },
  ],
};
const rent: Recurring = {
  id: "r1", createdAt: T0, updatedAt: T0, deletedAt: null,
  template: { type: "expense", amount: 80000, accountId: "a1", categoryId: "c1", content: "テスト家賃", memo: "" },
  rule: { every: "month", day: 27 }, startDate: "2026-09-27", generatedThrough: "2026-09-27", holidayShift: "none", estimated: false,
};
const plan = (id: string, month: string, amount: number, extra: Partial<PlannedExpense> = {}): PlannedExpense => ({
  id, createdAt: T0, updatedAt: T0, deletedAt: null, name: `テスト予定${id}`, month, amount, ...extra,
});

function sample(): OutlookData {
  const d = emptyData();
  const reserveMove: ReserveMove = { id: "m1", createdAt: T0, updatedAt: T0, deletedAt: null, reserveId: "rs1", kind: "assign", amount: 10000, date: "2026-10-05" };
  return {
    ...d,
    accounts: [account("a1", { group: "bank", openingBalance: 500000 }), account("a3", { group: "investment", includeInUsable: false, openingBalance: 200000 })],
    transactions: [
      tx("first", { date: "2026-07-01", amount: 1000 }), // いちばん古い明細(タグなし)
      tx("v1", { date: "2026-07-30", amount: 10000, tag: "regret" }),
      tx("v2", { date: "2026-08-30", amount: 20000, tag: "satisfied" }),
      tx("v3", { date: "2026-09-26", amount: 30000, tag: "daily" }),
      tx("cur", { date: "2026-10-24", amount: 4000, tag: "daily" }), // 今の区切りでもう使った分
    ],
    recurrings: [rent],
    payrolls: [payroll],
    reserves: [{ id: "rs1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト取り置き" }],
    reserveMoves: [reserveMove],
    plannedExpenses: [
      plan("old", "2026-09", 3000), // 過ぎてしまった月 → 今の区切り
      plan("nov", "2026-11", 30000),
      plan("dec", "2026-12", 20000, { reserveId: "rs1" }), // 取り置き 10,000 済み
      plan("jan", "2027-01", 15000),
      plan("done", "2026-11", 99999, { doneAt: T0 }),
    ],
  };
}

test("区切りの列：今の区切りから3か月・6か月、見出し", () => {
  const three = futurePeriods("2026-10-26", S, 3);
  assert.deepEqual(three, [
    { start: "2026-10-23", end: "2026-11-24" },
    { start: "2026-11-25", end: "2026-12-24" },
    { start: "2026-12-25", end: "2027-01-24" }, // 2027-01-25 は月曜で給料日
  ]);
  assert.equal(futurePeriods("2026-10-26", S, 6).length, 6);
  assert.equal(periodLabel("2026-10-23", "2026-11-24"), "10/23〜11/24");
  assert.deepEqual(pastPeriods("2026-10-26", S, 3), [
    { start: "2026-09-25", end: "2026-10-22" },
    { start: "2026-08-25", end: "2026-09-24" },
    { start: "2026-07-24", end: "2026-08-24" },
  ]);
});

test("変動費の見込み：直近3区切りの平均。区切りが足りなければある分、無ければ null", () => {
  const d = sample();
  assert.deepEqual(averageVariable(d, "2026-10-26", S), { average: 20000, periods: 3 });
  // いちばん古い明細が 8/30 → 8/25 始まりの区切りは途中からなので数えず、直近の1区切りだけ
  const short = { ...d, transactions: d.transactions.filter((t) => t.date >= "2026-08-30") };
  assert.deepEqual(averageVariable(short, "2026-10-26", S), { average: 30000, periods: 1 });
  assert.deepEqual(averageVariable({ ...d, transactions: [] }, "2026-10-26", S), { average: null, periods: 0 });
});

test("見通しの表：期末の見込みを前の列から引き継ぎ、手計算と合わせる", () => {
  const o = buildOutlook(sample(), S, "2026-10-26", 3);
  assert.equal(o.columns.length, 3);
  const [c0, c1, c2] = o.columns;
  // 今の区切り：はじめ = 今日の使える資産 = 500,000 − 1,000 − 10,000 − 20,000 − 30,000 − 4,000(投資 200,000 は含めない)
  assert.equal(c0.openAssets, 435000);
  assert.equal(c0.income, 0); // 今の区切りでは今日より後の給料日の分は入れない(10/23 は今日より前、11/25 は次の区切り)
  assert.equal(c0.fixed, 80000); // 家賃 10/27
  assert.equal(c0.planned, 33000); // 過ぎた月 3,000 + 11月 30,000
  assert.equal(c0.variable, 16000); // 平均 20,000 − 今の区切りでもう使った 4,000
  assert.equal(o.currentSpent, 4000);
  assert.equal(c0.net, -129000);
  assert.equal(c0.closing, 306000);
  // 次の区切り：はじめ = 前の列の期末の見込み
  assert.equal(c1.openAssets, 306000);
  assert.equal(c1.income, 240000); // 給料明細のひな形の手取り(300,000 − 60,000)、11/25
  assert.equal(c1.fixed, 80000); // 11/27
  assert.equal(c1.planned, 20000);
  assert.equal(c1.plannedReserved, 10000); // 取り置き済みの額
  assert.equal(c1.variable, 20000);
  assert.equal(c1.net, 120000);
  assert.equal(c1.closing, 426000);
  assert.equal(c2.openAssets, 426000);
  assert.equal(c2.planned, 15000);
  assert.equal(c2.net, 240000 - 80000 - 15000 - 20000);
  assert.equal(c2.closing, 551000);
  assert.equal(c0.belowFund, false);
  assert.deepEqual(c1.plannedItems.map((p) => [p.planned.id, p.covered]), [["dec", 10000]]);
  assert.deepEqual(c0.fixedItems.map((i) => `${i.date}:${i.amount}`), ["2026-10-27:80000"]);
});

test("見通しの表：生活防衛資金を下回る列、6か月", () => {
  const o = buildOutlook(sample(), { ...S, defenseFund: 500000 }, "2026-10-26", 6);
  assert.equal(o.columns.length, 6);
  assert.deepEqual(o.columns.slice(0, 3).map((c) => c.belowFund), [true, true, false]);
});

test("見通しの表：変動費のデータがなければ見込みは null で 0 として数える", () => {
  const d = { ...sample(), transactions: [] };
  const o = buildOutlook(d, S, "2026-10-26", 3);
  assert.equal(o.columns[0].variable, null);
  assert.equal(o.columns[0].net, -80000 - 33000);
});

test("給料明細の手取りの見込み：その日の給料明細をすでに入れていれば数えない", () => {
  const d = sample();
  const items = payrollIncomeBetween(d, "2026-11-01", "2026-12-31");
  assert.deepEqual(items.map((i) => `${i.date}:${i.amount}`), ["2026-11-25:240000", "2026-12-25:240000"]);
  const entered = { ...d, transactions: [...d.transactions, tx("pay", { type: "income", date: "2026-11-25", amount: 240000, payrollId: "p1" })] };
  assert.deepEqual(payrollIncomeBetween(entered, "2026-11-01", "2026-12-31").map((i) => i.date), ["2026-12-25"]);
  // 前回の金額が手取りの見込みになる
  const updated = { ...d, payrolls: [{ ...payroll, lastAmounts: { l1: 310000 } }] };
  assert.equal(payrollIncomeBetween(updated, "2026-11-01", "2026-11-30")[0].amount, 250000);
});

test("見通しの長さ：3か月・6か月・1年(12列)", () => {
  assert.deepEqual(OUTLOOK_LENGTHS, [3, 6, 12]);
  assert.equal(futurePeriods("2026-10-26", S, 12).length, 12);
  const o = buildOutlook(sample(), S, "2026-10-26", 12);
  assert.equal(o.columns.length, 12);
  // 区切りは給料日ごとに途切れず続き、期末の見込みは次の列の期のはじめになる
  for (let i = 1; i < 12; i++) {
    assert.equal(o.columns[i].openAssets, o.columns[i - 1].closing);
    const prevEnd = o.columns[i - 1].end;
    const next = new Date(`${prevEnd}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    assert.equal(o.columns[i].start, next.toISOString().slice(0, 10));
  }
  assert.equal(o.columns[11].start, "2027-09-24"); // 2027-09-25 は土曜 → 前の平日
  // 3か月・6か月の最初の3・6列は、1年の最初の列と同じ
  assert.deepEqual(buildOutlook(sample(), S, "2026-10-26", 3).columns, o.columns.slice(0, 3));
  assert.deepEqual(buildOutlook(sample(), S, "2026-10-26", 6).columns, o.columns.slice(0, 6));
});

test("まとめ：収入−出費の合計・期末の見込みが一番低い区切り・生活防衛資金を下回る区切りの数", () => {
  const o = buildOutlook(sample(), { ...S, defenseFund: 500000 }, "2026-10-26", 12);
  const sm = summarizeOutlook(o.columns);
  assert.equal(sm.net, o.columns.reduce((a, c) => a + c.net, 0));
  const lowest = o.columns.reduce((m, c) => (c.closing < m.closing ? c : m));
  assert.deepEqual(sm.lowest, { start: lowest.start, end: lowest.end, closing: lowest.closing });
  assert.equal(sm.belowCount, o.columns.filter((c) => c.belowFund).length);
  assert.ok(sm.belowCount >= 2);
  // 手計算できる小さな例：期末 100, 50, 50, 200 → 一番低いのは早い方の 50
  const col = (start: string, closing: number, net: number, belowFund: boolean) => ({ start, end: start, closing, net, belowFund }) as never;
  const small = summarizeOutlook([col("2026-10-23", 100, 10, false), col("2026-11-25", 50, -50, true), col("2026-12-25", 50, 0, true), col("2027-01-25", 200, 150, false)]);
  assert.deepEqual(small, { net: 110, lowest: { start: "2026-11-25", end: "2026-11-25", closing: 50 }, belowCount: 2 });
  assert.deepEqual(summarizeOutlook([]), { net: 0, lowest: null, belowCount: 0 });
});
