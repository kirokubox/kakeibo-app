import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustmentStats,
  assetTrend,
  categoryBreakdown,
  categoryColors,
  categoryTransactions,
  categoryTrend,
  incomeExpenseTrend,
  lastMonths,
  monthBudgetBars,
  periodAround,
  pieSlices,
  shiftSummaryPeriod,
  summaryRange,
  switchDay,
  tagBreakdown,
  tagTrend,
  weekBudgetBars,
} from "../src/summaryLogic.js";
import type { BudgetSnapshot, Category, Transaction } from "../src/types.js";
import { T0, account, category, tx } from "./fixtures.js";

const cats: Category[] = [
  category("p1", { name: "食費", order: 0 }),
  category("c1", { parentId: "p1", name: "ごはん" }),
  category("c2", { parentId: "p1", name: "外食", order: 1 }),
  category("p2", { name: "趣味", order: 1 }),
  category("c3", { parentId: "p2", name: "本" }),
  category("i1", { kind: "income", name: "給与" }),
  category("i2", { kind: "income", parentId: "i1", name: "給与" }),
];
const OCT = { start: "2026-10-01", end: "2026-10-31" };

test("期間：週は月曜〜日曜、月・年は暦月・暦年、任意は向きを直す", () => {
  assert.deepEqual(summaryRange(periodAround("week", "2026-10-28")), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(summaryRange(periodAround("month", "2026-02-10")), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(summaryRange(periodAround("year", "2026-10-26")), { start: "2026-01-01", end: "2026-12-31" });
  const custom = { kind: "custom" as const, anchor: "2026-10-26", customStart: "2026-10-20", customEnd: "2026-10-10" };
  assert.deepEqual(summaryRange(custom), { start: "2026-10-10", end: "2026-10-20" });
});

test("期間の種類を切り替えるときの基準：今日が期間に入っていれば今日、なければ期間の初め", () => {
  const month = periodAround("month", "2026-10-26");
  assert.equal(switchDay(month, "2026-10-26"), "2026-10-26");
  assert.deepEqual(summaryRange(periodAround("week", switchDay(month, "2026-10-26"))), { start: "2026-10-26", end: "2026-11-01" });
  const lastMonth = shiftSummaryPeriod(month, -1);
  assert.equal(switchDay(lastMonth, "2026-10-26"), "2026-09-01");
});

test("期間のずらし：週・月（年またぎ）・年・任意（同じ長さ）", () => {
  assert.equal(shiftSummaryPeriod(periodAround("week", "2026-10-26"), -1).anchor, "2026-10-19");
  assert.equal(shiftSummaryPeriod(periodAround("month", "2026-01-15"), -1).anchor, "2025-12-01");
  assert.equal(shiftSummaryPeriod(periodAround("year", "2026-10-26"), 1).anchor, "2027-01-01");
  const c = { kind: "custom" as const, anchor: "", customStart: "2026-10-01", customEnd: "2026-10-10" };
  const next = shiftSummaryPeriod(c, 1);
  assert.deepEqual([next.customStart, next.customEnd], ["2026-10-11", "2026-10-20"]);
});

test("分類別：大分類→小分類、大きい順、割合。立替は除き、期間外・振替・削除済みは数えない", () => {
  const list = [
    tx("a", { categoryId: "c1", amount: 3000 }),
    tx("b", { categoryId: "c2", amount: 1000, reimbursement: { counterparty: "テスト", amount: 400 } }), // 600
    tx("c", { categoryId: "c3", amount: 2000 }),
    tx("d", { categoryId: "c1", amount: 9999, date: "2026-09-30" }),
    tx("e", { type: "transfer", categoryId: undefined, amount: 5000 }),
    tx("f", { categoryId: "c1", amount: 100, deletedAt: T0 }),
    tx("g", { categoryId: "zzz", amount: 500 }), // 分類が見つからない
  ];
  const b = categoryBreakdown(list, cats, "expense", OCT);
  assert.equal(b.total, 6100);
  assert.deepEqual(
    b.rows.map((r) => [r.name, r.amount]),
    [["食費", 3600], ["趣味", 2000], ["分類なし", 500]],
  );
  assert.deepEqual(
    b.rows[0].children!.map((c) => [c.name, c.amount]),
    [["ごはん", 3000], ["外食", 600]],
  );
  assert.ok(Math.abs(b.rows[0].ratio - 3600 / 6100) < 1e-9);
});

test("分類別（収入）：返金は充てた額を除く", () => {
  const list = [tx("r", { type: "income", categoryId: "i2", amount: 2500, settles: { txId: "x" } }), tx("s", { type: "income", categoryId: "i2", amount: 1000 })];
  const b = categoryBreakdown(list, cats, "income", OCT, new Map([["r", 2000]]));
  assert.equal(b.total, 1500);
});

test("円グラフ：上位8つ＋その他にまとめる。色は大分類の並び順で一貫", () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, name: `分類${i}`, amount: 1000 - i * 10, ratio: 0, color: "#000" }));
  const slices = pieSlices(rows, 8);
  assert.equal(slices.length, 9);
  assert.equal(slices[8].name, "その他");
  assert.equal(slices[8].amount, rows.slice(8).reduce((s, r) => s + r.amount, 0));
  assert.equal(pieSlices(rows.slice(0, 5), 8).length, 5);
  const colors = categoryColors(cats, "expense");
  assert.notEqual(colors.get("p1"), colors.get("p2"));
  assert.equal(colors.get("p1"), categoryColors([...cats].reverse(), "expense").get("p1")); // 入力の順に左右されない
});

test("月ごとの推移：直近12か月（期間に関係なく）。大分類を選ぶと小分類を含む", () => {
  assert.deepEqual(lastMonths("2026-02", 3), ["2025-12", "2026-01", "2026-02"]);
  const list = [
    tx("a", { categoryId: "c1", amount: 100, date: "2026-10-05" }),
    tx("b", { categoryId: "c2", amount: 200, date: "2026-10-06" }),
    tx("c", { categoryId: "c1", amount: 50, date: "2026-08-06" }),
    tx("d", { categoryId: "c3", amount: 999, date: "2026-10-06" }),
    tx("e", { categoryId: "c1", amount: 7, date: "2025-09-30" }), // 12か月より前
  ];
  const parent = categoryTrend(list, cats, "p1", "expense", "2026-10");
  assert.equal(parent.length, 12);
  assert.equal(parent[11].amount, 300);
  assert.equal(parent[9].amount, 50);
  assert.equal(parent[0].month, "2025-11");
  assert.equal(parent.reduce((s, m) => s + m.amount, 0), 350);
  assert.equal(categoryTrend(list, cats, "c1", "expense", "2026-10")[11].amount, 100);
  assert.deepEqual(
    categoryTransactions(list, cats, "p1", "expense", OCT)
      .map((t) => t.id)
      .sort(),
    ["a", "b"],
  );
});

test("タグ別：日常・満足・反省・なし（立替を除く）と直近12か月の推移", () => {
  const list = [
    tx("a", { tag: "daily", amount: 1000 }),
    tx("b", { tag: "satisfied", amount: 2000 }),
    tx("c", { tag: "regret", amount: 500 }),
    tx("d", { amount: 4000, reimbursement: { counterparty: "テスト", amount: 1000 } }), // タグなし 3,000
    tx("e", { type: "income", amount: 99999 }),
    tx("f", { tag: "daily", amount: 300, date: "2026-09-10" }),
  ];
  const b = tagBreakdown(list, OCT);
  assert.equal(b.total, 6500);
  assert.deepEqual(
    b.rows.map((r) => [r.tag, r.amount]),
    [["daily", 1000], ["satisfied", 2000], ["regret", 500], ["none", 3000]],
  );
  const t = tagTrend(list, "2026-10");
  assert.equal(t.length, 12);
  assert.deepEqual(t[11].values, { daily: 1000, satisfied: 2000, regret: 500, none: 3000 });
  assert.equal(t[10].values.daily, 300);
});

test("月ごとの収入と支出：差額つき、返金は充てた額を除く", () => {
  const list = [
    tx("a", { type: "income", amount: 10000, date: "2026-10-25" }),
    tx("b", { amount: 4000, date: "2026-10-03" }),
    tx("c", { type: "income", amount: 700, date: "2026-09-02", settles: { txId: "x" } }),
    tx("d", { type: "transfer", amount: 123456, categoryId: undefined }),
  ];
  const r = incomeExpenseTrend(list, "2026-10", 12, new Map([["c", 500]]));
  assert.deepEqual(r[11], { month: "2026-10", income: 10000, expense: 4000, diff: 6000 });
  assert.equal(r[10].income, 200);
});

function snap(id: string, period: "week" | "month", start: string, end: string, amount: number): BudgetSnapshot {
  return { id, createdAt: T0, updatedAt: T0, deletedAt: null, period, start, end, amount, basis: {} };
}

test("予算と実績：直近12週。予算のない週は実績だけ。使った額は変動費（取り置き分を除く）", () => {
  const list = [
    tx("a", { tag: "daily", amount: 1000, date: "2026-10-26" }),
    tx("b", { tag: "regret", amount: 800, date: "2026-10-27" }),
    tx("c", { amount: 50000, date: "2026-10-27" }), // タグなし（固定費など）は数えない
    tx("d", { tag: "satisfied", amount: 700, date: "2026-10-19" }),
  ];
  const bars = weekBudgetBars([snap("s1", "week", "2026-10-26", "2026-11-01", 20000)], list, "2026-10-28", new Map([["b", 300]]));
  assert.equal(bars.length, 12);
  assert.deepEqual([bars[11].budget, bars[11].spent], [20000, 1500]);
  assert.deepEqual([bars[10].budget, bars[10].spent], [null, 700]);
  assert.equal(bars[11].start, "2026-10-26");
});

test("予算と実績：月は予算の記録の区切り。記録がなければ暦月で実績だけ", () => {
  const list = [tx("a", { tag: "daily", amount: 1000, date: "2026-10-26" }), tx("b", { tag: "daily", amount: 400, date: "2026-10-10" })];
  const snaps = [snap("m1", "month", "2026-09-25", "2026-10-24", 50000), snap("m2", "month", "2026-10-25", "2026-11-24", 60000)];
  const bars = monthBudgetBars(snaps, list, "2026-10-26", new Map());
  assert.deepEqual(
    bars.map((b) => [b.budget, b.spent]),
    [[50000, 400], [60000, 1000]],
  );
  const none = monthBudgetBars([], list, "2026-10-26", new Map());
  assert.equal(none.length, 12);
  assert.deepEqual([none[11].budget, none[11].spent], [null, 1400]);
});

test("資産の残高の推移：月末残高。使える資産の合計と資産ごと。月末より後の明細は入れない", () => {
  const accounts = [account("a1", { name: "テスト財布", openingBalance: 10000 }), account("a2", { name: "テスト投資", openingBalance: 5000, includeInUsable: false })];
  const list = [
    tx("a", { accountId: "a1", amount: 1000, date: "2026-08-10" }), // 支出
    tx("b", { type: "income", accountId: "a1", amount: 3000, date: "2026-09-25" }),
    tx("c", { type: "transfer", accountId: "a1", toAccountId: "a2", amount: 2000, fee: 100, categoryId: undefined, date: "2026-09-26" }),
    tx("d", { accountId: "a1", amount: 500, date: "2026-10-20" }),
    tx("e", { accountId: "a1", amount: 7777, date: "2025-01-01" }), // 3か月より前
    tx("f", { accountId: "a1", amount: 123, date: "2026-11-01" }), // 10月末より後
  ];
  const t = assetTrend(accounts, list, "2026-10", 3); // 8月・9月・10月
  const a1 = t.accounts.find((a) => a.id === "a1")!.values;
  const a2 = t.accounts.find((a) => a.id === "a2")!.values;
  assert.deepEqual(t.months, ["2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(a1, [10000 - 7777 - 1000, 10000 - 7777 - 1000 + 3000 - 2100, 10000 - 7777 - 1000 + 3000 - 2100 - 500]);
  assert.deepEqual(a2, [5000, 7000, 7000]);
  assert.deepEqual(t.usable, a1); // 投資は使える資産に含めない
});

test("残高修正：期間内の回数・増減・資産ごとの回数", () => {
  const accounts = [account("a1", { name: "テスト財布" }), account("a2", { name: "テスト電子マネー" })];
  const list = [
    tx("a", { type: "adjustment", accountId: "a1", amount: 300 }),
    tx("b", { type: "adjustment", accountId: "a1", amount: -100 }),
    tx("c", { type: "adjustment", accountId: "a2", amount: -50 }),
    tx("d", { type: "adjustment", accountId: "a2", amount: -50, date: "2026-09-01" }),
    tx("e", { type: "adjustment", accountId: "a2", amount: -50, deletedAt: T0 }),
  ];
  const s = adjustmentStats(list, accounts, OCT);
  assert.deepEqual([s.count, s.up, s.down], [3, 300, 150]);
  assert.deepEqual(s.byAccount, [
    { id: "a1", name: "テスト財布", count: 2 },
    { id: "a2", name: "テスト電子マネー", count: 1 },
  ]);
});

test("速さ：架空の2万件で、集計が十分に速い", () => {
  const list: Transaction[] = [];
  for (let i = 0; i < 20000; i++) {
    list.push(
      tx(`m${i}`, {
        categoryId: ["c1", "c2", "c3"][i % 3],
        tag: (["daily", "satisfied", "regret"] as const)[i % 3],
        amount: (i % 3000) + 1,
        date: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      }),
    );
  }
  const accounts = [account("a1")];
  const t0 = performance.now();
  categoryBreakdown(list, cats, "expense", { start: "2026-01-01", end: "2026-12-31" });
  tagBreakdown(list, OCT);
  tagTrend(list, "2026-10");
  incomeExpenseTrend(list, "2026-10");
  categoryTrend(list, cats, "p1", "expense", "2026-10");
  assetTrend(accounts, list, "2026-10");
  weekBudgetBars([], list, "2026-10-26", new Map());
  monthBudgetBars([], list, "2026-10-26", new Map());
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `集計 ${ms}ms`);
});
