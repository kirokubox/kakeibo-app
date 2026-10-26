import assert from "node:assert/strict";
import test from "node:test";
import {
  calcUsable,
  currentMonthSpan,
  isManualBudget,
  monthBudgetPlanPayday,
  planBudgets,
  planRecalcMonth,
  planRecalcWeek,
  salaryBatchIn,
  salaryEntered,
  summarizeHome,
  weekBudgetPlanManual,
  weekWithTail,
} from "../src/budgetLogic.js";
import type { BudgetContext, BudgetData, BudgetSettings } from "../src/budgetLogic.js";
import { backupNotice } from "../src/budgetLogic.js";
import type { BudgetSnapshot } from "../src/types.js";
import { T0, account, category, emptyData, tx } from "./fixtures.js";

// 架空のデータだけを使う。給料日25日（日曜なら前の平日）→ 区切りは 2026-10-23〜11-24
const AUTO: BudgetSettings = { payday: 25, paydayHolidayShift: "before", defenseFund: 0, budgetMonthBoundary: "payday" };
const MANUAL: BudgetSettings = { ...AUTO, budgetMode: "manual", monthlyBudget: 100000 };

function data(extra: Partial<BudgetData> = {}): BudgetData {
  const d = emptyData();
  return {
    accounts: [account("a1", { group: "bank", openingBalance: 500000 })],
    categories: d.categories,
    transactions: d.transactions,
    recurrings: d.recurrings,
    reserves: d.reserves,
    reserveMoves: d.reserveMoves,
    plannedExpenses: d.plannedExpenses,
    ...extra,
  };
}

let seq = 0;
const makeBase = () => ({ id: `new${++seq}`, createdAt: T0, updatedAt: T0, deletedAt: null });
function ctx(d: BudgetData, s: BudgetSettings, today: string, snapshots: BudgetSnapshot[] = []): BudgetContext {
  return { data: d, snapshots, settings: s, today, makeBase, nowMs: 1_800_000_000_000 };
}
function snap(id: string, period: "week" | "month", start: string, end: string, amount: number, basis: BudgetSnapshot["basis"] = {}): BudgetSnapshot {
  return { id, createdAt: T0, updatedAt: T0, deletedAt: null, period, start, end, amount, basis };
}
const salParent = category("seed:income:給与", { kind: "income" });
/** 変動費（日常タグ） */
const daily = (id: string, date: string, amount: number) => tx(id, { date, amount, tag: "daily" });

// ---- 月の予算（自分で決める） ----

test("自分で決める：金額が1円以上のときだけ有効", () => {
  assert.equal(isManualBudget(MANUAL), true);
  assert.equal(isManualBudget({ ...MANUAL, monthlyBudget: null }), false);
  assert.equal(isManualBudget({ ...MANUAL, monthlyBudget: 0 }), false);
  assert.equal(isManualBudget({ ...MANUAL, budgetMode: "auto" }), false);
  assert.equal(isManualBudget(AUTO), false);
});

test("週の予算：（月の予算 − 週の初日の前日までに使った額）÷ 残り日数 × 7。例 16,076円", () => {
  // 区切り 10/23〜11/24、週の初日 10/26(月)、それまでに 31,100円使った、残り30日
  const d = data({ transactions: [daily("v1", "2026-10-24", 20000), daily("v2", "2026-10-25", 11100)] });
  const plan = weekBudgetPlanManual(d, MANUAL, [], "2026-10-26", "2026-11-01");
  assert.equal(plan.amount, 16076);
  assert.equal(plan.basis.mode, "manual");
  assert.equal(plan.basis.used, 31100);
  assert.equal(plan.basis.remainingDays, 30);
});

test("使った額の数え方：変動費（日常・満足・反省のタグ）だけ。タグなし・収入・区切りの前は入らない", () => {
  const d = data({
    transactions: [
      daily("v1", "2026-10-24", 10000),
      tx("fixed", { date: "2026-10-24", amount: 50000 }), // タグなし（家賃など）
      tx("inc", { type: "income", date: "2026-10-24", amount: 80000 }),
      daily("before", "2026-10-22", 40000), // 前の区切り
      daily("same", "2026-10-26", 9000), // 週の初日の分はまだ使っていない扱い
    ],
  });
  const plan = weekBudgetPlanManual(d, MANUAL, [], "2026-10-26", "2026-11-01");
  assert.equal(plan.basis.used, 10000);
  assert.equal(plan.amount, Math.floor((90000 * 7) / 30));
});

test("使いすぎたら週の予算は0（マイナスにしない）。翌週の予算は小さくなる", () => {
  const d = data({ transactions: [daily("big", "2026-10-24", 130000)] });
  assert.equal(weekBudgetPlanManual(d, MANUAL, [], "2026-10-26", "2026-11-01").amount, 0);
  const d2 = data({ transactions: [daily("a", "2026-10-24", 10000)] });
  const w1 = weekBudgetPlanManual(d2, MANUAL, [], "2026-10-26", "2026-11-01").amount;
  const d3 = data({ transactions: [daily("a", "2026-10-24", 10000), daily("b", "2026-10-27", 30000)] });
  const w2 = weekBudgetPlanManual(d3, MANUAL, [], "2026-11-02", "2026-11-08").amount;
  assert.ok(w2 < w1, "使いすぎた週の分は、あとの週の予算が小さくなる");
});

test("区切りをまたぐ週：前半は前の区切りの分、後半は新しい区切りの分を足す", () => {
  // 区切り 10/23〜11/24。週 11/23(月)〜11/29(日)。それまでに 40,000円使った
  const d = data({ transactions: [daily("v1", "2026-10-30", 40000)] });
  const head = weekBudgetPlanManual(d, MANUAL, [], "2026-11-23", "2026-11-29");
  // 残り2日（11/23・11/24）、(100,000 − 40,000) ÷ 2 × 2
  assert.equal(head.amount, 60000);
  assert.equal(head.basis.headDays, 2);
  const week = snap("w1", "week", "2026-11-23", "2026-11-29", head.amount, head.basis);
  // 新しい区切り（11/25〜12/24 の30日）が始まる前は足さない
  assert.equal(weekWithTail(week, ctx(d, MANUAL, "2026-11-24", [week])), null);
  // 始まったら、新しい月の予算 ÷ 30 × 後半5日（11/25〜11/29）を足す。給料は待たない
  const withTail = weekWithTail(week, ctx(d, MANUAL, "2026-11-25", [week]));
  assert.ok(withTail);
  assert.equal(withTail.basis.tail, Math.floor((100000 * 5) / 30));
  assert.equal(withTail.amount, 60000 + 16666);
  // 二度は足さない
  assert.equal(weekWithTail(withTail, ctx(d, MANUAL, "2026-11-26", [withTail])), null);
});

test("暦月の区切り：月初から。残り日数で割る", () => {
  const cal: BudgetSettings = { ...MANUAL, budgetMonthBoundary: "calendar" };
  assert.deepEqual(currentMonthSpan(cal, "2026-10-26"), { start: "2026-10-01", end: "2026-10-31" });
  const d = data({ transactions: [daily("v1", "2026-10-10", 10000)] });
  // 週の初日 10/26、残り6日(10/26〜10/31)、週は11/1までだが区切りに入るのは6日 → （100,000 − 10,000）÷ 6 × 6
  const plan = weekBudgetPlanManual(d, cal, [], "2026-10-26", "2026-11-01");
  assert.equal(plan.amount, 90000);
  // 暦月をまたぐ週の後半は、11/1 に新しい月の予算 ÷ 30 × 1日
  const week = snap("w", "week", "2026-10-26", "2026-11-01", plan.amount, plan.basis);
  const t = weekWithTail(week, ctx(d, cal, "2026-11-01", [week]));
  assert.ok(t);
  assert.equal(t.basis.tail, Math.floor(100000 / 30));
});

test("決める：月の予算と今週の予算を作る。すでにあれば二重に作らない", () => {
  const d = data({ transactions: [daily("v1", "2026-10-24", 31100)] });
  const written = planBudgets(ctx(d, MANUAL, "2026-10-26"));
  const month = written.find((b) => b.period === "month");
  const week = written.find((b) => b.period === "week");
  assert.ok(month && week);
  assert.equal(month.amount, 100000);
  assert.equal(month.basis.mode, "manual");
  assert.deepEqual([month.start, month.end], ["2026-10-23", "2026-11-24"]);
  assert.equal(week.amount, 16076);
  assert.deepEqual([week.start, week.end], ["2026-10-26", "2026-11-01"]);
  assert.deepEqual(planBudgets(ctx(d, MANUAL, "2026-10-27", written)), []);
});

test("給料を待たずに決める（自分で決めた金額なので）", () => {
  const d = data({ transactions: [daily("v1", "2026-10-20", 1000)] });
  assert.equal(salaryEntered(d, { start: "2026-10-23", end: "2026-11-24" }), false);
  assert.equal(planBudgets(ctx(d, MANUAL, "2026-10-23")).find((b) => b.period === "month")?.amount, 100000);
});

test("金額を変えても今の区切りは変わらず、次の区切りから効く。「今の金額で決め直す」で今の区切りにも効く", () => {
  const d = data({ transactions: [daily("v1", "2026-10-24", 31100)] });
  const made = planBudgets(ctx(d, MANUAL, "2026-10-26"));
  const changed: BudgetSettings = { ...MANUAL, monthlyBudget: 150000 };
  assert.deepEqual(planBudgets(ctx(d, changed, "2026-10-27", made)), [], "今の区切りは変わらない");
  // 次の区切り（11/25）では新しい金額で決まる
  const next = planBudgets(ctx(d, changed, "2026-11-25", made));
  assert.equal(next.find((b) => b.period === "month")?.amount, 150000);
  // 決め直し：同じ記録を直し、今週も新しい金額で計算しなおす
  const redo = planRecalcMonth(ctx(d, changed, "2026-10-27", made));
  const month = redo.find((b) => b.period === "month");
  assert.equal(month?.amount, 150000);
  assert.equal(month?.id, made.find((b) => b.period === "month")?.id);
  assert.equal(typeof month?.basis.recalculatedAt, "number");
  const week = redo.find((b) => b.period === "week");
  assert.ok(week && week.amount > made.find((b) => b.period === "week")!.amount);
  // 今週だけの決め直し
  const weekOnly = planRecalcWeek(ctx(d, changed, "2026-10-27", [...made.filter((b) => b.period === "week"), ...redo.filter((b) => b.period === "month")]));
  assert.equal(weekOnly.length, 1);
});

test("予算の決め方を切り替えると、今の区切りの記録が入れ替わる（自動→自分で決める→自動）", () => {
  const d = data({ categories: [salParent], transactions: [daily("v1", "2026-10-24", 31100), tx("sal", { type: "income", date: "2026-10-23", amount: 300000, categoryId: "seed:income:給与" })] });
  const auto = planBudgets(ctx(d, AUTO, "2026-10-26"));
  const autoMonth = auto.find((b) => b.period === "month")!;
  assert.notEqual(autoMonth.basis.mode, "manual");
  const toManual = planBudgets(ctx(d, MANUAL, "2026-10-26", auto));
  const m = toManual.find((b) => b.period === "month")!;
  assert.equal(m.id, autoMonth.id);
  assert.equal(m.amount, 100000);
  const back = planBudgets(ctx(d, AUTO, "2026-10-26", toManual));
  assert.equal(back.find((b) => b.period === "month")?.basis.mode, undefined);
});

test("ホーム：自分で決めた予算で出し、使い切れる上限（自動の計算）を併記する", () => {
  const d = data({ categories: [salParent], transactions: [daily("v1", "2026-10-24", 31100), tx("sal", { type: "income", date: "2026-10-23", amount: 300000, categoryId: "seed:income:給与" })] });
  const snaps = planBudgets(ctx(d, MANUAL, "2026-10-26"));
  const home = summarizeHome(d, snaps, MANUAL, "2026-10-26");
  assert.equal(home.manual, true);
  assert.equal(home.month.snapshot?.amount, 100000);
  assert.equal(home.week.remaining, 16076);
  assert.ok(home.limit);
  const u = calcUsable(d, MANUAL, "2026-10-26");
  assert.equal(home.limit.week, Math.floor((u.usable * 7) / u.days));
  assert.equal(typeof home.limit.month, "number");
  // 自動のときは併記しない
  assert.equal(summarizeHome(d, [], AUTO, "2026-10-26").limit, null);
  assert.equal(backupNotice({ lastBackupAt: null, backupReminderDays: 14 }, false, "2026-10-26"), null);
});

// ---- 自動の月の予算を給料込みで決める ----

const salaryCat = category("c_sal", { kind: "income", parentId: "seed:income:給与" });
const dedCat = category("c_ded");

function salaryData(extra: Partial<BudgetData> = {}): BudgetData {
  return data({
    accounts: [account("a1", { group: "bank", openingBalance: 300000 })],
    categories: [salaryCat, dedCat],
    // 区切りの始まり 10/23 より後（10/25）の日付で入った給料と、同じ日・同じ口座の控除
    transactions: [
      tx("sal", { type: "income", date: "2026-10-25", amount: 400000, categoryId: "c_sal", content: "テスト給与" }),
      tx("ded", { type: "expense", date: "2026-10-25", amount: 100000, categoryId: "c_ded", content: "テスト控除" }),
      tx("other", { type: "expense", date: "2026-10-28", amount: 7000, categoryId: "c_ded" }), // 別の日は給料の1枚に入らない
    ],
    ...extra,
  });
}

test("給料の明細1枚分：給与の収入と、同じ日・同じ口座の控除。別の日は入らない", () => {
  const ids = salaryBatchIn(salaryData(), { start: "2026-10-23", end: "2026-11-24" }).map((t) => t.id).sort();
  assert.deepEqual(ids, ["ded", "sal"]);
  assert.deepEqual(salaryBatchIn(data(), { start: "2026-10-23", end: "2026-11-24" }), []);
});

test("給料明細から入れたもの（payrollBatchId）は、同じ明細の全部が1枚分。給料の判定にも使う", () => {
  const d = salaryData({
    categories: [dedCat], // 給与の分類ではないが、給料明細から入れた
    transactions: [
      tx("sal", { type: "income", date: "2026-10-25", amount: 400000, categoryId: "c_ded", payrollBatchId: "b1" }),
      tx("ded", { type: "expense", date: "2026-10-25", amount: 100000, categoryId: "c_ded", payrollBatchId: "b1" }),
      tx("ded2", { type: "expense", date: "2026-10-25", amount: 5000, categoryId: "c_ded", payrollBatchId: "b2" }),
    ],
  });
  assert.equal(salaryEntered(d, { start: "2026-10-23", end: "2026-11-24" }), true);
  assert.deepEqual(salaryBatchIn(d, { start: "2026-10-23", end: "2026-11-24" }).map((t) => t.id).sort(), ["ded", "sal"]);
});

test("自動の月の予算：区切りの始まりの前日までの残高に、区切りの中の給料1枚分を足して決める", () => {
  // 300,000 + 400,000 − 100,000 = 600,000（防衛資金なし）。10/28 の別の支出は決まった出費ではない（繰り返しではない）
  const plan = monthBudgetPlanPayday(salaryData(), AUTO, "2026-10-23");
  assert.equal(plan.amount, 600000);
  const month = planBudgets(ctx(salaryData(), AUTO, "2026-10-26")).find((b) => b.period === "month");
  assert.equal(month?.amount, 600000);
});

test("給料がまだなら月の予算を決めない。入ったあとで決め直すと給料込みの額になる", () => {
  const before = salaryData({ transactions: [tx("other", { type: "expense", date: "2026-10-20", amount: 7000, categoryId: "c_ded" })] });
  assert.equal(planBudgets(ctx(before, AUTO, "2026-10-26")).find((b) => b.period === "month"), undefined);
  // 給料なしの残高で決めた記録（昔の動き）→ 給料が入ってから決め直すと給料込み
  const old = snap("m_old", "month", "2026-10-23", "2026-11-24", 92795);
  const redo = planRecalcMonth(ctx(salaryData(), AUTO, "2026-10-26", [old])).find((b) => b.period === "month");
  assert.equal(redo?.id, "m_old");
  assert.equal(redo?.amount, 600000);
});

// ---- 先の日付の明細（今日までの残高） ----

test("使える額：残高は今日までの明細。先の日付の支出は、次の給料日の前日まで決まった出費に入る", () => {
  const d = data({
    accounts: [account("a1", { group: "bank", openingBalance: 200000 }), account("a2", { group: "bank", openingBalance: 50000 }), account("a3", { group: "investment", includeInUsable: false, openingBalance: 0 })],
    transactions: [
      tx("past", { date: "2026-10-20", amount: 10000 }),
      tx("fut", { date: "2026-10-27", amount: 30000 }), // 先の日付の支出
      tx("fut_far", { date: "2026-12-01", amount: 99999 }), // 次の給料日の後 → 入れない
      tx("fut_inc", { type: "income", date: "2026-10-28", amount: 500000 }), // 先の収入は入れない
      tx("fut_tr", { type: "transfer", date: "2026-10-27", amount: 20000, toAccountId: "a2" }), // 使える資産どうし → 入れない
      tx("fut_inv", { type: "transfer", date: "2026-10-29", amount: 15000, toAccountId: "a3" }), // 使えない資産へ → 入る
    ],
  });
  const r = calcUsable(d, AUTO, "2026-10-26");
  assert.equal(r.usableAssets, 200000 - 10000 + 50000, "今日までの残高");
  assert.equal(r.committedFuture, 30000 + 15000);
  assert.equal(r.committed, 45000);
  assert.equal(r.usable, 240000 - 45000);
  assert.deepEqual(r.items.filter((i) => i.kind === "future").map((i) => `${i.date}:${i.amount}`), ["2026-10-27:30000", "2026-10-29:15000"]);
});
