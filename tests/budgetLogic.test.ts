import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings } from "../src/constants.js";
import {
  backupNotice,
  calcUsable,
  daysLeftUntilPayday,
  isFirstUse,
  isSalaryIncome,
  nextPaydayAfter,
  paydayOnOrBefore,
  paydayPeriodOf,
  planBudgets,
  planRecalcMonth,
  planRecalcWeek,
  salaryEntered,
  summarizeHome,
  variableByDay,
  variableSpent,
  weekBudgetPlan,
  weekTailPlan,
} from "../src/budgetLogic.js";
import type { BudgetData, BudgetSettings } from "../src/budgetLogic.js";
import { spendByTx } from "../src/reserveLogic.js";
import type { BudgetSnapshot, Recurring, Reserve, ReserveMove } from "../src/types.js";
import { T0, account, category, emptyData, tx } from "./fixtures.js";

const S: BudgetSettings = { payday: 25, paydayHolidayShift: "before", defenseFund: 100000, budgetMonthBoundary: "payday" };

function data(extra: Partial<BudgetData> = {}): BudgetData {
  const d = emptyData();
  return {
    accounts: d.accounts,
    categories: d.categories,
    transactions: d.transactions,
    recurrings: d.recurrings,
    reserves: d.reserves,
    reserveMoves: d.reserveMoves,
    plannedExpenses: d.plannedExpenses,
    ...extra,
  };
}

const template = { type: "expense" as const, amount: 1000, accountId: "a1", categoryId: "c1", content: "テスト定期", memo: "" };
function rec(id: string, extra: Partial<Recurring> = {}, tpl: Partial<Recurring["template"]> = {}): Recurring {
  return {
    id, createdAt: T0, updatedAt: T0, deletedAt: null,
    template: { ...template, ...tpl },
    rule: { every: "month", day: 27 }, startDate: "2026-09-27", generatedThrough: "2026-09-27", holidayShift: "none", estimated: false,
    ...extra,
  };
}
const reserve = (id: string): Reserve => ({ id, createdAt: T0, updatedAt: T0, deletedAt: null, name: `テスト取り置き${id}` });
const move = (id: string, reserveId: string, kind: ReserveMove["kind"], amount: number, date: string, txId?: string): ReserveMove => ({
  id, createdAt: T0, updatedAt: T0, deletedAt: null, reserveId, kind, amount, date, ...(txId ? { txId } : {}),
});
function snap(id: string, period: "week" | "month", start: string, end: string, amount: number, basis: Record<string, number> = {}): BudgetSnapshot {
  return { id, createdAt: T0, updatedAt: T0, deletedAt: null, period, start, end, amount, basis };
}
let seq = 0;
const makeBase = () => ({ id: `new${++seq}`, createdAt: T0, updatedAt: T0, deletedAt: null });

/** 手計算の見本：2026-10-26(月) 時点の使える額 */
function sampleData(): BudgetData {
  return data({
    accounts: [
      account("a1", { group: "bank", openingBalance: 500000 }),
      account("a2", { group: "card", openingBalance: -30000, card: { paymentDay: 27, holidayShift: "after", paymentAccountId: "a1" } }),
      account("a3", { group: "investment", includeInUsable: false, openingBalance: 200000 }),
      account("a4", { group: "cash", hidden: true, openingBalance: 20000 }),
    ],
    transactions: [tx("last", { date: "2026-09-29", amount: 2500, recurringId: "r_est" })], // 見込み額の前回の明細（a1 から 2,500円）
    recurrings: [
      rec("r_rent", {}, { amount: 80000 }), // 10/27 に 80,000円（使える資産から出る）
      rec("r_nisa", { rule: { every: "month", day: 28 }, startDate: "2026-09-28", generatedThrough: "2026-09-28" }, { type: "transfer", toAccountId: "a3", amount: 30000, fee: 0 }), // 含めない資産への振替は入る
      rec("r_card", {}, { type: "transfer", toAccountId: "a2", amount: 30000 }), // 使える資産どうしの振替は入らない
      rec("r_in", { rule: { every: "month", day: 30 }, startDate: "2026-09-30", generatedThrough: "2026-09-30" }, { type: "income", amount: 5000 }), // 収入は入らない
      rec("r_done", { generatedThrough: "2026-10-27" }), // 10/27 分は作り済み → 入らない（次は 11/27 で期間外）
      rec("r_est", { rule: { every: "month", day: 29 }, startDate: "2026-09-29", generatedThrough: "2026-09-29", estimated: true }, { amount: 1000 }), // 前回の金額 2,500円で数える
    ],
    reserves: [reserve("rs1")],
    reserveMoves: [move("m1", "rs1", "assign", 20000, "2026-10-05"), move("m2", "rs1", "spend", 3000, "2026-10-10", "x"), move("m3", "rs1", "release", 2000, "2026-10-12")],
    plannedExpenses: [
      { id: "p_nov", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト旅行", month: "2026-11", amount: 40000, reserveId: "rs1" },
      { id: "p_oct", createdAt: T0, updatedAt: T0, deletedAt: null, name: "過ぎた月の分", month: "2026-10", amount: 5000 },
      { id: "p_dec", createdAt: T0, updatedAt: T0, deletedAt: null, name: "来月の区切り", month: "2026-12", amount: 9000 },
      { id: "p_done", createdAt: T0, updatedAt: T0, deletedAt: null, name: "済み", month: "2026-11", amount: 7000, doneAt: T0 },
    ],
  });
}

test("給料日・区切り・残り日数（給料日の休日の移動、当日は次の区切り）", () => {
  // 2026-10-25 は日曜 → 10/23(金)
  assert.equal(paydayOnOrBefore("2026-10-26", S), "2026-10-23");
  assert.equal(paydayOnOrBefore("2026-10-23", S), "2026-10-23");
  assert.equal(paydayOnOrBefore("2026-10-22", S), "2026-09-25");
  assert.equal(nextPaydayAfter("2026-10-26", S), "2026-11-25");
  assert.equal(nextPaydayAfter("2026-10-22", S), "2026-10-23");
  assert.equal(nextPaydayAfter("2026-10-23", S), "2026-11-25"); // 給料日の当日は次の区切りの始まり
  assert.deepEqual(paydayPeriodOf("2026-10-26", S), { start: "2026-10-23", end: "2026-11-24" });
  // 今日を含めて給料日の前日まで
  assert.equal(daysLeftUntilPayday("2026-10-26", S), 30);
  assert.equal(daysLeftUntilPayday("2026-11-24", S), 1);
  assert.equal(daysLeftUntilPayday("2026-11-25", S), 30);
  assert.equal(daysLeftUntilPayday("2026-10-22", S), 1);
  assert.equal(daysLeftUntilPayday("2026-10-23", S), 33);
});

test("使える額：資産・生活防衛資金・取り置き・決まった出費を手計算と合わせる", () => {
  const r = calcUsable(sampleData(), S, "2026-10-26");
  // 使える資産 = 500,000(銀行) − 2,500(前回の明細) − 30,000(カードの未払い) + 20,000(非表示の現金)。投資 200,000 は含めない
  assert.equal(r.usableAssets, 487500);
  assert.equal(r.defenseFund, 100000);
  // 取り置き残高 = 20,000 − 2,000 − 3,000
  assert.equal(r.reserveTotal, 15000);
  // 決まった出費(繰り返し) = 家賃 80,000 + つみたて 30,000 + 見込み額(前回 2,500)。カードへの振替・収入・作り済みは入らない
  assert.equal(r.committedRecurring, 112500);
  // 予定出費 = 11月 40,000 − 取り置き 15,000 = 25,000 ＋ 過ぎた月 5,000。12月は期間外、済みは入らない
  assert.equal(r.committedPlanned, 30000);
  assert.equal(r.committed, 142500);
  assert.equal(r.usable, 487500 - 100000 - 15000 - 142500);
  assert.equal(r.usable, 230000);
  assert.equal(r.deadline, "2026-11-25");
  assert.equal(r.days, 30);
  assert.equal(r.perDay, 7666); // 230,000 ÷ 30 の切り捨て
  assert.deepEqual(
    r.items.map((i) => `${i.date}:${i.label}:${i.amount}`),
    ["2026-10-01:過ぎた月の分:5000", "2026-10-27:テスト定期:80000", "2026-10-28:テスト定期:30000", "2026-10-29:テスト定期:2500", "2026-11-01:テスト旅行:25000"],
  );
});

test("使える額：マイナスなら 1日あたりは 0、振替の手数料は含めない資産への振替に足す", () => {
  const d = data({ accounts: [account("a1", { openingBalance: 50000 }), account("a3", { includeInUsable: false })], recurrings: [rec("r1", { rule: { every: "month", day: 28 }, startDate: "2026-09-28", generatedThrough: "2026-09-28" }, { type: "transfer", toAccountId: "a3", amount: 10000, fee: 110 })] });
  const r = calcUsable(d, S, "2026-10-26");
  assert.equal(r.committed, 10110);
  assert.equal(r.usable, 50000 - 100000 - 10110);
  assert.equal(r.perDay, 0);
});

test("使える額：削除済みの資産・明細・取り置き・予定出費は数えない", () => {
  const d = data({
    accounts: [account("a1", { openingBalance: 300000 }), account("a9", { openingBalance: 999999, deletedAt: T0 })],
    transactions: [tx("t1", { amount: 777, deletedAt: T0 })],
    reserves: [{ ...reserve("rs9"), deletedAt: T0 }],
    reserveMoves: [move("m1", "rs9", "assign", 5000, "2026-10-01"), { ...move("m2", "rs1", "assign", 4000, "2026-10-01"), deletedAt: T0 }],
    plannedExpenses: [{ id: "p1", createdAt: T0, updatedAt: T0, deletedAt: T0, name: "削除", month: "2026-11", amount: 5000 }],
  });
  assert.equal(calcUsable(d, S, "2026-10-26").usable, 200000);
});

test("ある日の時点の使える額：その日より前の明細と、その日の収入だけで計算する", () => {
  const d = data({
    accounts: [account("a1", { openingBalance: 100000 })],
    transactions: [
      tx("e1", { date: "2026-10-25", amount: 3000 }),
      tx("e2", { date: "2026-10-26", amount: 700 }), // その日の支出は入れない
      tx("i1", { type: "income", date: "2026-10-26", amount: 20000 }), // その日の収入(給料など)は入れる
      tx("i2", { type: "income", date: "2026-10-27", amount: 5000 }),
    ],
  });
  const s0 = { ...S, defenseFund: 0 };
  assert.equal(calcUsable(d, s0, "2026-10-26", { asOf: true }).usable, 100000 - 3000 + 20000);
  // 今日の計算は「今日までの明細」だけ。先の日付の収入(10/27)は残高に入れない（改善2）
  assert.equal(calcUsable(d, s0, "2026-10-26").usable, 100000 - 3000 - 700 + 20000);
});

test("ある日の時点の使える額：繰り返しは作り済みかどうかによらず期間の予定を数える", () => {
  const d = data({ accounts: [account("a1", { openingBalance: 400000 })], recurrings: [rec("r_rent", { generatedThrough: "2026-10-27" }, { amount: 80000 })] });
  // 今日の計算では作り済み(10/27)は入らない。月曜の時点の計算では、その日にまだ明細が無かったものとして入れる
  assert.equal(calcUsable(d, S, "2026-10-26").committed, 0);
  assert.equal(calcUsable(d, S, "2026-10-26", { asOf: true }).committed, 80000);
});

test("変動費：タグあり・立替を除く・取り置きから払った分を除く・タグなしは入らない", () => {
  const txs = [
    tx("v1", { date: "2026-10-26", amount: 1000, tag: "daily" }),
    tx("v2", { date: "2026-10-26", amount: 2000, tag: "satisfied", reimbursement: { counterparty: "テスト花子", amount: 500 } }), // 1,500
    tx("v3", { date: "2026-10-26", amount: 3000, tag: "regret", reserveId: "rs1" }), // 取り置きから 2,000 払った → 1,000
    tx("v4", { date: "2026-10-26", amount: 9000 }), // タグなし(固定費など)
    tx("v5", { date: "2026-10-26", amount: 4000, tag: "daily", deletedAt: T0 }),
    tx("v6", { type: "income", date: "2026-10-26", amount: 6000 }),
    tx("v7", { date: "2026-10-27", amount: 800, tag: "satisfied" }),
  ];
  const spent = spendByTx([move("m1", "rs1", "spend", 2000, "2026-10-26", "v3")]);
  assert.equal(variableSpent(txs, { start: "2026-10-26", end: "2026-10-26" }, spent), 1000 + 1500 + 1000);
  assert.equal(variableSpent(txs, { start: "2026-10-26", end: "2026-10-27" }, spent), 4300);
  const bars = variableByDay(txs, "2026-10-26", 7, spent);
  assert.equal(bars.length, 7);
  assert.deepEqual(bars.slice(0, 3).map((b) => b.amount), [3500, 800, 0]);
});

test("給料の判定：給与の分類・給料明細から入れた収入。削除済み・ほかの収入は違う", () => {
  const cats = new Map([
    ["seed:income:給与", category("seed:income:給与", { kind: "income" })],
    ["c_pay", category("c_pay", { kind: "income", parentId: "seed:income:給与" })],
    ["c_other", category("c_other", { kind: "income" })],
  ]);
  assert.equal(isSalaryIncome(tx("a", { type: "income", categoryId: "c_pay" }), cats), true);
  assert.equal(isSalaryIncome(tx("b", { type: "income", categoryId: "c_other", payrollId: "p1" }), cats), true);
  assert.equal(isSalaryIncome(tx("c", { type: "income", categoryId: "c_other" }), cats), false);
  assert.equal(isSalaryIncome(tx("d", { type: "income", categoryId: "c_pay", deletedAt: T0 }), cats), false);
  assert.equal(isSalaryIncome(tx("e", { type: "expense", categoryId: "c_pay" }), cats), false);
  const d = data({ categories: [...cats.values()], transactions: [tx("a", { type: "income", categoryId: "c_pay", date: "2026-10-23" })] });
  assert.equal(salaryEntered(d, { start: "2026-10-23", end: "2026-11-24" }), true);
  assert.equal(salaryEntered(d, { start: "2026-09-25", end: "2026-10-22" }), false);
});

test("週の予算：月曜の時点の1日あたり × 7日、給料日をまたぐ週は前半だけ", () => {
  const d = data({ accounts: [account("a1", { openingBalance: 400000 })] });
  // 月曜 10/26：使える額 300,000、残り30日 → 1日 10,000 → 7日で 70,000
  const w = weekBudgetPlan(d, S, "2026-10-26");
  assert.equal(w.amount, 70000);
  assert.equal(w.end, "2026-11-01");
  assert.equal(w.basis.perDay, 10000);
  assert.equal(w.basis.days, 30);
  assert.equal(w.basis.headDays, 7);
  // 月曜 11/23：給料日 11/25 の前日までの2日分だけ（1日 150,000 × 2）
  const cross = weekBudgetPlan(d, S, "2026-11-23");
  assert.equal(cross.basis.headDays, 2);
  assert.equal(cross.amount, 300000);
});

test("給料日をまたぐ週の後半：給料日の時点の1日あたり × 給料日から日曜までの日数", () => {
  const d = data({
    accounts: [account("a1", { openingBalance: 400000 })],
    transactions: [tx("pay", { type: "income", date: "2026-11-25", amount: 250000, payrollId: "p1" })],
  });
  // 11/25 の時点：400,000 + 250,000 − 100,000 = 550,000、残り30日 → 18,333/日。11/25〜11/29 の5日
  assert.deepEqual(weekTailPlan(d, S, "2026-11-25", "2026-11-29"), { tail: 18333 * 5, tailDays: 5, tailPerDay: 18333 });
});

test("予算を決める：給料が入るまで月の予算は決めない。入ったら決める。2回作らない", () => {
  const base = data({ accounts: [account("a1", { openingBalance: 400000 })], transactions: [tx("s0", { type: "income", amount: 0, date: "2026-01-01" })] });
  // 明細が1件もないうちは何も決めない
  assert.deepEqual(planBudgets({ data: data({ accounts: base.accounts }), snapshots: [], settings: S, today: "2026-10-26", makeBase, nowMs: 0 }), []);
  // 給料なし：今週の予算だけ
  const first = planBudgets({ data: base, snapshots: [], settings: S, today: "2026-10-26", makeBase, nowMs: 1 });
  assert.deepEqual(first.map((b) => b.period), ["week"]);
  assert.equal(first[0].start, "2026-10-26");
  assert.equal(first[0].amount, 70000);
  // 給料(10/23)が入った：月の予算 = 給料日の時点の使える額
  const withSalary = data({
    accounts: base.accounts,
    transactions: [...base.transactions, tx("pay", { type: "income", date: "2026-10-23", amount: 250000, payrollId: "p1" })],
  });
  const second = planBudgets({ data: withSalary, snapshots: first, settings: S, today: "2026-10-26", makeBase, nowMs: 2 });
  assert.deepEqual(second.map((b) => b.period), ["month"]);
  // 10/23 の時点：400,000 + 250,000 − 100,000 = 550,000
  assert.equal(second[0].amount, 550000);
  assert.equal(second[0].start, "2026-10-23");
  assert.equal(second[0].end, "2026-11-24");
  assert.equal(second[0].basis.usable, 550000);
  assert.equal(second[0].basis.days, 33);
  // 決まったあとは何も作らない
  assert.deepEqual(planBudgets({ data: withSalary, snapshots: [...first, ...second], settings: S, today: "2026-10-27", makeBase, nowMs: 3 }), []);
});

test("予算を決める：給料日をまたぐ週は、給料が入ってから後半を足す", () => {
  const accounts = [account("a1", { openingBalance: 400000 })];
  const old0 = tx("s0", { type: "income", amount: 0, date: "2026-01-01" });
  const noSalary = data({ accounts, transactions: [old0] });
  const made = planBudgets({ data: noSalary, snapshots: [], settings: S, today: "2026-11-24", makeBase, nowMs: 1 });
  assert.equal(made.length, 1);
  assert.equal(made[0].start, "2026-11-23");
  assert.equal(made[0].amount, 300000); // 11/23・11/24 の2日分
  assert.equal(made[0].basis.tail, undefined);
  const withSalary = data({ accounts, transactions: [old0, tx("pay", { type: "income", date: "2026-11-25", amount: 250000, payrollId: "p1" })] });
  // 給料日 11/25 に給料を入れると、同じ週の予算へ後半が足される
  const next = planBudgets({ data: withSalary, snapshots: made, settings: S, today: "2026-11-25", makeBase, nowMs: 2 });
  const week = next.find((b) => b.period === "week");
  assert.ok(week);
  assert.equal(week.id, made[0].id); // 同じ週の予算を更新(新しく作らない)
  assert.equal(week.basis.head, 300000);
  assert.equal(week.basis.tail, 18333 * 5);
  assert.equal(week.amount, 300000 + 18333 * 5);
  assert.ok(next.some((b) => b.period === "month" && b.start === "2026-11-25" && b.amount === 550000));
  // もう一度開いても足しなおさない
  assert.deepEqual(planBudgets({ data: withSalary, snapshots: next, settings: S, today: "2026-11-26", makeBase, nowMs: 3 }), []);
});

test("予算を決める：月曜が給料日なら、給料が入るまで今週の予算も決めない", () => {
  const accounts = [account("a1", { openingBalance: 400000 })];
  // 2027-01-25 は月曜で給料日
  const old0 = tx("s0", { type: "income", amount: 0, date: "2026-01-01" });
  assert.deepEqual(planBudgets({ data: data({ accounts, transactions: [old0] }), snapshots: [], settings: S, today: "2027-01-26", makeBase, nowMs: 1 }), []);
  const withSalary = data({ accounts, transactions: [old0, tx("pay", { type: "income", date: "2027-01-25", amount: 250000, payrollId: "p1" })] });
  const made = planBudgets({ data: withSalary, snapshots: [], settings: S, today: "2027-01-26", makeBase, nowMs: 2 });
  assert.deepEqual(made.map((b) => b.period).sort(), ["month", "week"]);
  assert.equal(made.find((b) => b.period === "week")!.start, "2027-01-25");
});

test("予算を決める：区切りが暦月なら1日の時点で自動で決める(使える額を超えない)", () => {
  const cal: BudgetSettings = { ...S, budgetMonthBoundary: "calendar" };
  const d = data({ accounts: [account("a1", { openingBalance: 400000 })], transactions: [tx("s0", { type: "income", amount: 0, date: "2026-01-01" })] });
  const made = planBudgets({ data: d, snapshots: [], settings: cal, today: "2026-10-26", makeBase, nowMs: 1 });
  const month = made.find((b) => b.period === "month");
  assert.ok(month);
  assert.equal(month.start, "2026-10-01");
  assert.equal(month.end, "2026-10-31");
  // 10/01 の時点：使える額 300,000、次の給料日 10/23 まで22日 → 13,636/日。×31日 = 422,716 → 使える額 300,000 まで
  assert.equal(month.amount, 300000);
  assert.equal(month.basis.perDay, 13636);
  assert.equal(month.basis.monthDays, 31);
});

test("決め直し：同じ予算を上書きして recalculatedAt を残す。給料の前でも決められる", () => {
  const d = data({ accounts: [account("a1", { openingBalance: 400000 })] });
  const old = snap("m1", "month", "2026-10-23", "2026-11-24", 1234, { usable: 1 });
  const out = planRecalcMonth({ data: d, snapshots: [old], settings: S, today: "2026-10-26", makeBase, nowMs: 99 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "m1");
  assert.equal(out[0].amount, 300000 + 0); // 10/23 の時点の使える額(給料なし)
  assert.equal(out[0].basis.recalculatedAt, 99);
  // 決まっていなければ新しく決める(recalculatedAt は付けない)
  const fresh = planRecalcMonth({ data: d, snapshots: [], settings: S, today: "2026-10-26", makeBase, nowMs: 99 });
  assert.equal(fresh[0].basis.recalculatedAt, undefined);
  assert.equal(fresh[0].period, "month");
  // 週
  const wOld = snap("w1", "week", "2026-10-26", "2026-11-01", 5, {});
  const w = planRecalcWeek({ data: d, snapshots: [wOld], settings: S, today: "2026-10-28", makeBase, nowMs: 7 });
  assert.equal(w[0].id, "w1");
  assert.equal(w[0].amount, 70000);
  assert.equal(w[0].basis.recalculatedAt, 7);
});

test("ホームの数字：今週・今月の使った額とあと◯円、取り置き", () => {
  const d = data({
    accounts: [account("a1", { openingBalance: 500000 })],
    transactions: [
      tx("w1", { date: "2026-10-26", amount: 1000, tag: "daily" }),
      tx("m1", { date: "2026-10-24", amount: 2000, tag: "satisfied" }), // 今月だけ(先週)
      tx("fx", { date: "2026-10-26", amount: 50000 }), // タグなしは使った額に入らない
    ],
    reserves: [reserve("rs1")],
    reserveMoves: [move("a", "rs1", "assign", 10000, "2026-10-20")],
  });
  const snapshots = [snap("w", "week", "2026-10-26", "2026-11-01", 70000), snap("m", "month", "2026-10-23", "2026-11-24", 200000)];
  const h = summarizeHome(d, snapshots, S, "2026-10-27");
  assert.equal(h.week.spent, 1000);
  assert.equal(h.week.remaining, 69000);
  assert.equal(h.month.spent, 3000);
  assert.equal(h.month.remaining, 197000);
  assert.equal(h.reserveTotal, 10000);
  assert.equal(h.hasTransactions, true);
  assert.equal(h.week.bars[0].amount, 1000);
  assert.equal(h.salaryPending, "2026-10-23"); // 給料の入っていない給料日
  // 予算が決まっていなければ null(給料待ち)
  const none = summarizeHome(d, [], S, "2026-10-27");
  assert.equal(none.week.remaining, null);
  assert.equal(none.month.waiting, true);
  assert.equal(none.week.waiting, false);
});

test("バックアップのお知らせ", () => {
  const base = defaultSettings();
  assert.equal(backupNotice({ ...base, lastBackupAt: null }, false, "2026-10-26"), null);
  assert.equal(backupNotice({ ...base, lastBackupAt: null }, true, "2026-10-26"), "まだバックアップを保存していません");
  assert.equal(backupNotice({ ...base, lastBackupAt: "2026-10-20T03:00:00.000Z", backupReminderDays: 14 }, true, "2026-10-26"), null);
  assert.match(backupNotice({ ...base, lastBackupAt: "2026-10-01T03:00:00.000Z", backupReminderDays: 14 }, true, "2026-10-26")!, /25日たちました/);
});

test("はじめて使う状態：資産も明細もない（削除済みは数えない）。どちらかがあれば違う", () => {
  assert.equal(isFirstUse(data()), true);
  assert.equal(isFirstUse(data({ accounts: [account("a1")] })), false);
  assert.equal(isFirstUse(data({ transactions: [tx("t1")] })), false);
  assert.equal(isFirstUse(data({ accounts: [account("a1", { deletedAt: T0 })], transactions: [tx("t1", { deletedAt: T0 })] })), true);
});

test("はじめて使う状態のホーム：内訳にマイナスを出さないための印(firstUse)。資産ができたら外れる", () => {
  const empty = summarizeHome(data(), [], { ...S, defenseFund: 100000 }, "2026-10-26");
  assert.equal(empty.firstUse, true);
  assert.equal(empty.hasTransactions, false);
  // 生活防衛資金を入れていても、資産がなければ使える額はマイナスになる。だから画面は数字を出さない(firstUse で隠す)
  assert.ok(empty.usable.usable < 0);
  const withAccount = summarizeHome(data({ accounts: [account("a1", { openingBalance: 0 })] }), [], S, "2026-10-26");
  assert.equal(withAccount.firstUse, false);
  assert.equal(withAccount.hasTransactions, false); // 資産はあるが明細がない：「明細を入れると…」の案内のまま
});
