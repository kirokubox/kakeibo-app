import assert from "node:assert/strict";
import test from "node:test";
import { addDays, weekdayOf } from "../src/dateUtils.js";
import {
  addMonths,
  calendarCells,
  dayHeading,
  groupByDay,
  monthRange,
  summarize,
  weekExpenseBars,
  weekRange,
  weekStartOf,
  weekTitle,
} from "../src/periodLogic.js";
import { T0, T1, T2, tx } from "./fixtures.js";

test("日付の足し引きと曜日（月またぎ・年またぎ・うるう日）", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(weekdayOf("2026-10-25"), 0); // 日曜
  assert.equal(weekdayOf("2026-10-19"), 1); // 月曜
});

test("月曜始まりの週：日曜は前の月曜から、月曜はその日から", () => {
  assert.equal(weekStartOf("2026-10-25"), "2026-10-19"); // 日
  assert.equal(weekStartOf("2026-10-19"), "2026-10-19"); // 月
  assert.equal(weekStartOf("2026-10-21"), "2026-10-19"); // 水
  assert.deepEqual(weekRange("2026-10-25"), { start: "2026-10-19", end: "2026-10-25" });
  assert.equal(weekTitle("2026-10-19"), "10/19(月)〜10/25(日)");
});

test("月をまたぐ週・年をまたぐ週", () => {
  assert.deepEqual(weekRange("2026-11-01"), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(weekRange("2026-10-28"), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(weekRange("2027-01-01"), { start: "2026-12-28", end: "2027-01-03" });
});

test("暦月の範囲と月の移動", () => {
  assert.deepEqual(monthRange("2026-10"), { start: "2026-10-01", end: "2026-10-31" });
  assert.deepEqual(monthRange("2026-02"), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(monthRange("2028-02"), { start: "2028-02-01", end: "2028-02-29" });
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-10", -10), "2025-12");
});

test("収入・支出・合計：振替・残高修正・削除済みを含めない", () => {
  const list = [
    tx("a", { type: "income", amount: 300000 }),
    tx("b", { type: "expense", amount: 1200 }),
    tx("c", { type: "expense", amount: 800 }),
    tx("d", { type: "transfer", amount: 50000, toAccountId: "a2" }),
    tx("e", { type: "adjustment", amount: -300 }),
    tx("f", { type: "expense", amount: 9999, deletedAt: T1 }),
  ];
  assert.deepEqual(summarize(list), { income: 300000, expense: 2000, total: 298000 });
});

test("期間で絞って集計する（両端を含む）", () => {
  const list = [
    tx("a", { date: "2026-09-30", amount: 100 }),
    tx("b", { date: "2026-10-01", amount: 200 }),
    tx("c", { date: "2026-10-31", amount: 400 }),
    tx("d", { date: "2026-11-01", amount: 800 }),
  ];
  assert.equal(summarize(list, monthRange("2026-10")).expense, 600);
  assert.equal(summarize(list, weekRange("2026-10-28")).expense, 400 + 800); // 10/26〜11/01
});

test("日ごとのまとまり：新しい日から、同じ日は作った順の新しいものが上", () => {
  const list = [
    tx("a", { date: "2026-10-20", createdAt: T0 }),
    tx("b", { date: "2026-10-22", createdAt: T0, amount: 100 }),
    tx("c", { date: "2026-10-22", createdAt: T2, amount: 200 }),
    tx("d", { date: "2026-10-22", createdAt: T1, amount: 300, type: "income" }),
    tx("e", { date: "2026-10-22", createdAt: T1, amount: 50000, type: "transfer", toAccountId: "a2" }),
    tx("f", { date: "2026-10-22", deletedAt: T1 }),
  ];
  const groups = groupByDay(list);
  assert.deepEqual(groups.map((g) => g.date), ["2026-10-22", "2026-10-20"]);
  const items = groups[0].items;
  assert.equal(items.length, 4); // 削除済みは除く
  assert.equal(items[0].id, "c"); // 作成が最も新しい
  assert.equal(items[3].id, "b"); // 最も古い
  assert.deepEqual([items[1].createdAt, items[2].createdAt], [T1, T1]);
  assert.equal(groups[0].income, 300);
  assert.equal(groups[0].expense, 300); // 100 + 200。振替は含めない
});

test("カレンダーのマス：月曜始まりで前後の月の日が入る", () => {
  const cells = calendarCells("2026-10", [tx("a", { date: "2026-10-05", amount: 700 }), tx("b", { date: "2026-10-05", type: "income", amount: 90 })]);
  assert.equal(cells.length % 7, 0);
  assert.equal(cells[0].date, "2026-09-28"); // 2026-10-01 は木曜
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[3].date, "2026-10-01");
  assert.equal(cells[3].inMonth, true);
  assert.equal(cells[cells.length - 1].date, "2026-11-01"); // 10/31 は土曜 → 日曜まで
  assert.equal(cells[cells.length - 1].inMonth, false);
  assert.equal(cells.length, 35);
  const day5 = cells.find((c) => c.date === "2026-10-05")!;
  assert.deepEqual([day5.expense, day5.income, day5.hasItems], [700, 90, true]);
  assert.equal(cells.find((c) => c.date === "2026-10-06")!.hasItems, false);
});

test("カレンダーのマス：月曜始まりの月は前月の日が入らない・6週になる月もある", () => {
  const june = calendarCells("2026-06", []); // 2026-06-01 は月曜
  assert.equal(june[0].date, "2026-06-01");
  const aug = calendarCells("2026-08", []); // 8/1 土曜 … 8/31 月曜
  assert.equal(aug.length, 42);
  assert.equal(aug[0].date, "2026-07-27");
  assert.equal(aug[aug.length - 1].date, "2026-09-06");
});

test("週の支出の棒：7日分、月曜から", () => {
  const bars = weekExpenseBars(
    [tx("a", { date: "2026-10-19", amount: 100 }), tx("b", { date: "2026-10-19", amount: 50 }), tx("c", { date: "2026-10-25", amount: 7 }), tx("d", { date: "2026-10-26", amount: 9 })],
    "2026-10-19",
  );
  assert.equal(bars.length, 7);
  assert.equal(bars[0].date, "2026-10-19");
  assert.equal(bars[0].expense, 150);
  assert.equal(bars[6].date, "2026-10-25");
  assert.equal(bars[6].expense, 7);
  assert.equal(bars[3].expense, 0);
});

test("日の見出し", () => {
  assert.deepEqual(dayHeading("2026-10-25"), { day: 25, weekday: "日曜日", yearMonth: "2026.10" });
});
