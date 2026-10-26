import assert from "node:assert/strict";
import test from "node:test";
import { planBudgets, planRecalcWeek, summarizeHome, weekBudgetPlan, weekSpanOf } from "../src/budgetLogic.js";
import type { BudgetData, BudgetSettings } from "../src/budgetLogic.js";
import { aiFileName } from "../src/aiMarkdown.js";
import { calendarCells, weekExpenseBars, weekRange, weekStartOf, weekTitle, weekdayHeads } from "../src/periodLogic.js";
import { periodAround, shiftSummaryPeriod, summaryRange, switchDay, weekBudgetBars } from "../src/summaryLogic.js";
import type { BudgetSnapshot } from "../src/types.js";
import { T0, account, emptyData, tx } from "./fixtures.js";

// 週の始まり（月曜／日曜）。2026-10-25 は日曜、2026-10-26 は月曜

const MON: BudgetSettings = { payday: 25, paydayHolidayShift: "before", defenseFund: 100000, budgetMonthBoundary: "payday", weekStart: "monday" };
const SUN: BudgetSettings = { ...MON, weekStart: "sunday" };

function data(extra: Partial<BudgetData> = {}): BudgetData {
  const d = emptyData();
  return {
    accounts: [account("a1", { openingBalance: 400000 })],
    categories: d.categories,
    transactions: [tx("s0", { type: "income", amount: 0, date: "2026-01-01" })], // 明細が1件もないと予算を決めない
    recurrings: d.recurrings,
    reserves: d.reserves,
    reserveMoves: d.reserveMoves,
    plannedExpenses: d.plannedExpenses,
    ...extra,
  };
}

function snap(id: string, start: string, end: string, amount: number): BudgetSnapshot {
  return { id, createdAt: T0, updatedAt: T0, deletedAt: null, period: "week", start, end, amount, basis: {} };
}
let seq = 0;
const makeBase = () => ({ id: `new${++seq}`, createdAt: T0, updatedAt: T0, deletedAt: null });

test("日曜始まりの週の範囲：日曜〜土曜。月曜始まり（初期値）は今までどおり", () => {
  assert.deepEqual(weekRange("2026-10-28", "sunday"), { start: "2026-10-25", end: "2026-10-31" });
  assert.equal(weekStartOf("2026-10-25", "sunday"), "2026-10-25"); // 日曜はその日から
  assert.equal(weekStartOf("2026-10-24", "sunday"), "2026-10-18"); // 土曜は前の日曜から
  assert.equal(weekStartOf("2026-10-31", "sunday"), "2026-10-25");
  assert.equal(weekStartOf("2026-12-31", "sunday"), "2026-12-27"); // 年またぎ
  assert.deepEqual(weekRange("2026-10-28"), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(weekRange("2026-10-28", "monday"), { start: "2026-10-26", end: "2026-11-01" });
  assert.equal(weekTitle("2026-10-25"), "10/25(日)〜10/31(土)");
});

test("カレンダーの並び：日曜始まりは日〜土の見出しで、前の月の日が日曜から入る", () => {
  assert.deepEqual(weekdayHeads("sunday"), ["日", "月", "火", "水", "木", "金", "土"]);
  assert.deepEqual(weekdayHeads("monday"), ["月", "火", "水", "木", "金", "土", "日"]);
  assert.deepEqual(weekdayHeads(), ["月", "火", "水", "木", "金", "土", "日"]);
  const cells = calendarCells("2026-10", [tx("a", { date: "2026-10-05", amount: 700 })], undefined, "sunday");
  assert.equal(cells[0].date, "2026-09-27"); // 2026-10-01 は木曜 → 前の日曜から
  assert.equal(cells[4].date, "2026-10-01");
  assert.equal(cells[cells.length - 1].date, "2026-10-31"); // 10/31 は土曜でちょうど終わる
  assert.equal(cells.length, 35);
  assert.equal(cells.length % 7, 0);
  assert.equal(cells[0].inMonth, false);
  // 月曜始まりは今までどおり
  const mon = calendarCells("2026-10", []);
  assert.equal(mon[0].date, "2026-09-28");
  assert.equal(mon[mon.length - 1].date, "2026-11-01");
  // 日曜始まりで6週になる月：2026-08（8/1 土曜）
  const aug = calendarCells("2026-08", [], undefined, "sunday");
  assert.equal(aug[0].date, "2026-07-26");
  assert.equal(aug.length, 42);
  assert.equal(aug[aug.length - 1].date, "2026-09-05");
});

test("週の支出の棒：週の初日から7日分（日曜始まりなら日曜から）", () => {
  const bars = weekExpenseBars([tx("a", { date: "2026-10-25", amount: 100 }), tx("b", { date: "2026-10-31", amount: 7 }), tx("c", { date: "2026-11-01", amount: 9 })], "2026-10-25");
  assert.equal(bars[0].date, "2026-10-25");
  assert.equal(bars[0].expense, 100);
  assert.equal(bars[6].date, "2026-10-31");
  assert.equal(bars[6].expense, 7);
});

test("週の予算：週の初日の時点の1日あたり × 日数。日曜始まりは日曜の時点で決める", () => {
  // 日曜 2026-11-01：給料日 11/25 まで24日、使える額 300,000 → 1日 12,500 × 7日
  const w = weekBudgetPlan(data(), SUN, "2026-11-01");
  assert.equal(w.amount, 87500);
  assert.equal(w.end, "2026-11-07");
  assert.equal(w.basis.headDays, 7);
  // 月曜 2026-10-26：使える額 300,000 / 30日 = 10,000/日 × 7日（今までどおり）
  assert.equal(weekBudgetPlan(data(), MON, "2026-10-26").amount, 70000);
  // 週の最終日を渡すと、その残りの日数だけで決める（切り替えの間の短い週）
  const short = weekBudgetPlan(data(), SUN, "2026-10-26", "2026-10-31");
  assert.equal(short.basis.headDays, 6);
  assert.equal(short.amount, 60000);
  assert.equal(short.end, "2026-10-31");
});

test("今日の週の期間：予算の記録があればその期間、なければ設定の週の始まり", () => {
  assert.deepEqual(weekSpanOf("2026-10-28", MON, []), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(weekSpanOf("2026-10-28", SUN, []), { start: "2026-10-25", end: "2026-10-31" });
  assert.deepEqual(weekSpanOf("2026-10-28", {}, []), { start: "2026-10-26", end: "2026-11-01" }); // 設定がなければ月曜始まり
  // 月曜始まりで決めた今週の予算は、日曜始まりに切り替えても今週のまま残る
  const mondayWeek = snap("w1", "2026-10-19", "2026-10-25", 70000);
  assert.deepEqual(weekSpanOf("2026-10-21", SUN, [mondayWeek]), { start: "2026-10-19", end: "2026-10-25" });
  assert.deepEqual(weekSpanOf("2026-10-25", SUN, [mondayWeek]), { start: "2026-10-19", end: "2026-10-25" });
  // 切り替えの間の短い週：月曜 10/26 は日曜始まりの週(10/25〜10/31)のうち、決め済みの10/25を除く月〜土の6日
  assert.deepEqual(weekSpanOf("2026-10-26", SUN, [mondayWeek]), { start: "2026-10-26", end: "2026-10-31" });
  assert.deepEqual(weekSpanOf("2026-10-30", SUN, [mondayWeek]), { start: "2026-10-26", end: "2026-10-31" });
  // そのあとは日曜始まりの7日
  const short = snap("w2", "2026-10-26", "2026-10-31", 60000);
  assert.deepEqual(weekSpanOf("2026-11-01", SUN, [mondayWeek, short]), { start: "2026-11-01", end: "2026-11-07" });
  // 日曜始まり → 月曜始まりでも同じ（日曜1日だけの週ができる）
  const sundayWeek = snap("w3", "2026-10-25", "2026-10-31", 70000);
  assert.deepEqual(weekSpanOf("2026-11-01", MON, [sundayWeek]), { start: "2026-11-01", end: "2026-11-01" });
  assert.deepEqual(weekSpanOf("2026-11-02", MON, [sundayWeek, snap("w4", "2026-11-01", "2026-11-01", 1)]), { start: "2026-11-02", end: "2026-11-08" });
  // 論理削除した記録は数えない
  assert.deepEqual(weekSpanOf("2026-10-26", SUN, [{ ...mondayWeek, deletedAt: T0 }]), { start: "2026-10-25", end: "2026-10-31" });
});

test("予算を決める：日曜始まりは日曜の時点で週の予算を決める", () => {
  const made = planBudgets({ data: data(), snapshots: [], settings: SUN, today: "2026-11-04", makeBase, nowMs: 1 });
  const week = made.find((b) => b.period === "week");
  assert.ok(week);
  assert.equal(week.start, "2026-11-01"); // 水曜でも、その週の日曜の時点
  assert.equal(week.end, "2026-11-07");
  assert.equal(week.amount, 87500);
  // 同じ週は2回作らない
  assert.deepEqual(planBudgets({ data: data(), snapshots: made, settings: SUN, today: "2026-11-05", makeBase, nowMs: 2 }).filter((b) => b.period === "week"), []);
});

test("週の始まりを切り替えたとき：今週の予算はそのまま、次の週から新しい始まり。間の短い週はその残りの日数で決める", () => {
  const mondayWeek = snap("w1", "2026-10-19", "2026-10-25", 70000);
  // 切り替えた当日（今週の途中）は、何も作り直さない
  assert.deepEqual(planBudgets({ data: data(), snapshots: [mondayWeek], settings: SUN, today: "2026-10-22", makeBase, nowMs: 1 }).filter((b) => b.period === "week"), []);
  // 次の週(月曜 10/26)：10/26〜10/31 の6日分
  const made = planBudgets({ data: data(), snapshots: [mondayWeek], settings: SUN, today: "2026-10-26", makeBase, nowMs: 2 });
  const week = made.find((b) => b.period === "week");
  assert.ok(week);
  assert.equal(week.id !== "w1", true); // 保存済みの予算の記録は書き換えない（新しく足す）
  assert.deepEqual([week.start, week.end], ["2026-10-26", "2026-10-31"]);
  assert.equal(week.basis.headDays, 6);
  assert.equal(week.amount, 60000);
  assert.equal(mondayWeek.amount, 70000);
  // その次の週(日曜 11/01)から7日
  const next = planBudgets({ data: data(), snapshots: [mondayWeek, week], settings: SUN, today: "2026-11-01", makeBase, nowMs: 3 }).find((b) => b.period === "week");
  assert.ok(next);
  assert.deepEqual([next.start, next.end], ["2026-11-01", "2026-11-07"]);
  // 今の額で決め直すときも、同じ期間(短い週)を使う
  const re = planRecalcWeek({ data: data(), snapshots: [mondayWeek, week], settings: SUN, today: "2026-10-28", makeBase, nowMs: 9 });
  assert.equal(re[0].id, week.id);
  assert.equal(re[0].end, "2026-10-31");
});

test("ホームの今週：日曜始まりの週の範囲と棒（短い週は日数分）", () => {
  const d = data({ transactions: [tx("s0", { type: "income", amount: 0, date: "2026-01-01" }), tx("w1", { date: "2026-10-25", amount: 1000, tag: "daily" }), tx("w2", { date: "2026-10-27", amount: 500, tag: "daily" })] });
  const h = summarizeHome(d, [], SUN, "2026-10-28");
  assert.deepEqual([h.week.start, h.week.end], ["2026-10-25", "2026-10-31"]);
  assert.equal(h.week.spent, 1500);
  assert.equal(h.week.bars.length, 7);
  assert.equal(h.week.bars[0].date, "2026-10-25");
  assert.equal(h.week.bars[0].amount, 1000);
  // 切り替えの短い週(10/26〜10/31)：6日分
  const mondayWeek = snap("w1", "2026-10-19", "2026-10-25", 70000);
  const sh = summarizeHome(d, [mondayWeek], SUN, "2026-10-28");
  assert.deepEqual([sh.week.start, sh.week.end], ["2026-10-26", "2026-10-31"]);
  assert.equal(sh.week.bars.length, 6);
  assert.equal(sh.week.spent, 500);
});

test("集計の週・AI用Markdownの週・検索の期間に使う範囲：日曜〜土曜", () => {
  const p = periodAround("week", "2026-10-28", undefined, "sunday");
  assert.equal(p.anchor, "2026-10-25");
  assert.deepEqual(summaryRange(p, "sunday"), { start: "2026-10-25", end: "2026-10-31" });
  assert.deepEqual(summaryRange(shiftSummaryPeriod(p, 1), "sunday"), { start: "2026-11-01", end: "2026-11-07" });
  assert.deepEqual(summaryRange(shiftSummaryPeriod(p, -1), "sunday"), { start: "2026-10-18", end: "2026-10-24" });
  // 月曜始まり（省略時）は今までどおり
  assert.deepEqual(summaryRange(periodAround("week", "2026-10-28")), { start: "2026-10-26", end: "2026-11-01" });
  // 期間の種類を切り替えるときの基準の日
  const month = periodAround("month", "2026-10-28", undefined, "sunday");
  assert.equal(switchDay(month, "2026-10-28", "sunday"), "2026-10-28");
  assert.deepEqual(summaryRange(periodAround("week", switchDay(month, "2026-10-28", "sunday"), month, "sunday"), "sunday"), { start: "2026-10-25", end: "2026-10-31" });
  // AI用Markdownのファイル名は書き出す範囲(日曜〜土曜)
  assert.equal(aiFileName(summaryRange(p, "sunday")), "kakeibo-ai-2026-10-25_2026-10-31.md");
});

test("予算と実績の棒：日曜始まりの週にそろえ、切り替えの前後の記録も使う", () => {
  const list = [tx("a", { tag: "daily", amount: 1000, date: "2026-10-27" }), tx("b", { tag: "daily", amount: 700, date: "2026-10-22" })];
  const snaps = [snap("w1", "2026-10-19", "2026-10-25", 70000), snap("w2", "2026-10-26", "2026-10-31", 60000)];
  const bars = weekBudgetBars(snaps, list, "2026-10-28", new Map(), 12, "sunday");
  assert.equal(bars.length, 12);
  // 今週(10/25〜10/31)は、短い週の記録(10/26〜10/31)
  assert.deepEqual([bars[11].start, bars[11].end, bars[11].budget, bars[11].spent], ["2026-10-26", "2026-10-31", 60000, 1000]);
  // 前の週(10/18〜10/24)は、月曜始まりで決めた記録(10/19〜10/25)
  assert.deepEqual([bars[10].start, bars[10].end, bars[10].budget, bars[10].spent], ["2026-10-19", "2026-10-25", 70000, 700]);
  // 月曜始まり(省略時)は今までどおり
  const mon = weekBudgetBars([snap("m", "2026-10-26", "2026-11-01", 20000)], list, "2026-10-28", new Map());
  assert.deepEqual([mon[11].start, mon[11].budget, mon[11].spent], ["2026-10-26", 20000, 1000]);
});
