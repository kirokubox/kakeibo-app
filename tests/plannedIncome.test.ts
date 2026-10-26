import assert from "node:assert/strict";
import test from "node:test";
import { calcUsable, summarizeHome } from "../src/budgetLogic.js";
import type { BudgetSettings } from "../src/budgetLogic.js";
import { parseBackup, validateBackup } from "../src/backup.js";
import { buildOutlook } from "../src/outlookLogic.js";
import type { OutlookData } from "../src/outlookLogic.js";
import { incomeDoneCandidates, markIncomeDone, openPlannedIncomes, reopenIncome, validatePlannedIncomeDraft } from "../src/plannedLogic.js";
import { payrollForecast } from "../src/scheduleLogic.js";
import { DATA_STORE_NAMES } from "../src/types.js";
import type { Payroll, PlannedIncome } from "../src/types.js";
import { DB_VERSION } from "../src/constants.js";
import { planUpgrade } from "../src/dbMigration.js";
import { T0, account, emptyData, sampleBackup, sampleData, tx, viaJson } from "./fixtures.js";

const S: BudgetSettings = { payday: 25, paydayHolidayShift: "before", defenseFund: 0, budgetMonthBoundary: "payday" };
const income = (id: string, month: string, amount: number, extra: Partial<PlannedIncome> = {}): PlannedIncome => ({
  id, createdAt: T0, updatedAt: T0, deletedAt: null, name: `テスト賞与${id}`, month, amount, ...extra,
});

function outlookData(extra: Partial<OutlookData> = {}): OutlookData {
  const d = emptyData();
  return {
    accounts: [account("a1", { group: "bank", openingBalance: 1000000 })],
    categories: d.categories,
    transactions: [tx("t1", { date: "2026-10-01", amount: 1000 })],
    recurrings: d.recurrings,
    reserves: d.reserves,
    reserveMoves: d.reserveMoves,
    plannedExpenses: d.plannedExpenses,
    payrolls: d.payrolls,
    ...extra,
  };
}

test("予定収入の入力チェック：名前・月・1円以上の金額", () => {
  assert.equal(validatePlannedIncomeDraft({ name: "テスト賞与", month: "2027-06", amount: 300000 }), null);
  assert.ok(validatePlannedIncomeDraft({ name: " ", month: "2027-06", amount: 300000 }));
  assert.ok(validatePlannedIncomeDraft({ name: "a", month: "2027-6", amount: 300000 }));
  assert.ok(validatePlannedIncomeDraft({ name: "a", month: "2027-06", amount: 0 }));
  assert.ok(validatePlannedIncomeDraft({ name: "a", month: "2027-06", amount: null }));
});

test("見通し：予定収入は、入る月の区切りの期末の見込みに足す。使える額・予算には入らない", () => {
  const base = buildOutlook(outlookData(), S, "2026-10-26", 12);
  const withIncome = buildOutlook(outlookData({ plannedIncomes: [income("i1", "2027-06", 300000)] }), S, "2026-10-26", 12);
  const idx = withIncome.columns.findIndex((c) => c.plannedIncome > 0);
  assert.ok(idx > 0);
  assert.equal(withIncome.columns[idx].plannedIncome, 300000);
  assert.equal(withIncome.columns[idx].income, base.columns[idx].income, "収入の行には入れない");
  assert.equal(withIncome.columns[idx].closing, base.columns[idx].closing + 300000);
  assert.equal(withIncome.columns[idx].net, base.columns[idx].net + 300000);
  // それより後の列にも持ち越される。前の列は変わらない
  assert.equal(withIncome.columns[idx - 1].closing, base.columns[idx - 1].closing);
  assert.equal(withIncome.columns[withIncome.columns.length - 1].closing, base.columns[base.columns.length - 1].closing + 300000);
  // 使える額には影響しない（calcUsable・ホームは予定収入を読まない）
  const d = outlookData({ plannedIncomes: [income("i1", "2026-10", 300000)] });
  assert.equal(calcUsable(d, S, "2026-10-26").usable, calcUsable(outlookData(), S, "2026-10-26").usable);
  assert.equal(summarizeHome(d, [], S, "2026-10-26").usable.committed, 0);
});

test("予定収入：済み・削除は見通しに入れない。「入った」にする・取り消す・候補", () => {
  const list = [income("i1", "2027-06", 100), income("i2", "2027-07", 200, { doneAt: T0 }), income("i3", "2027-08", 300, { deletedAt: T0 })];
  assert.deepEqual(openPlannedIncomes(list).map((p) => p.id), ["i1"]);
  const txs = [tx("in1", { type: "income", date: "2027-06-10", amount: 310000 }), tx("in2", { type: "income", date: "2027-05-10", amount: 1 }), tx("ex", { date: "2027-06-11" })];
  assert.deepEqual(incomeDoneCandidates(list[0], txs, list).map((t) => t.id), ["in1"]);
  // ほかの予定収入で使い済みの明細は出さない
  const used = [list[0], income("i9", "2027-06", 5, { doneAt: T0, doneTxId: "in1" })];
  assert.deepEqual(incomeDoneCandidates(used[0], txs, used), []);
  const done = markIncomeDone(list[0], "in1", "2027-06-10T00:00:00.000Z");
  assert.equal(done.doneTxId, "in1");
  assert.deepEqual(openPlannedIncomes([done]), []);
  const none = markIncomeDone(list[0], null, "2027-06-10T00:00:00.000Z");
  assert.equal(none.doneTxId, undefined);
  assert.equal(none.doneAt, "2027-06-10T00:00:00.000Z");
  assert.equal(reopenIncome(done).doneAt, undefined);
  assert.equal("doneTxId" in reopenIncome(done), false);
});

test("給料明細の「毎月変わる」行：見通しの手取りの見込みから除く", () => {
  const p: Payroll = {
    id: "p1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト給与", accountId: "a1", day: 25, holidayShift: "before",
    lines: [
      { lineId: "l1", kind: "pay", categoryId: "c1", label: "基本給", amount: 300000 },
      { lineId: "l2", kind: "pay", categoryId: "c1", label: "残業代", amount: 50000, variable: true },
      { lineId: "l3", kind: "deduction", categoryId: "c1", label: "控除", amount: 60000 },
    ],
    lastAmounts: { l2: 42000 },
  };
  assert.equal(payrollForecast(p, "2026-11").takeHome, 240000, "残業代（前回の金額でも）は入れない");
  const fixed: Payroll = { ...p, lines: p.lines.map((l) => ({ ...l, variable: undefined })) };
  assert.equal(payrollForecast(fixed, "2026-11").takeHome, 240000 + 42000);
  // 見通しの収入にも出ない
  const o = buildOutlook(outlookData({ payrolls: [p] }), S, "2026-10-26", 3);
  assert.equal(o.columns[1].income, 240000);
});

test("バックアップ：予定収入を含めて書き出して読める。検証で形をチェックする", () => {
  const b = sampleBackup();
  assert.equal(b.plannedIncomes.length, 1);
  const read = parseBackup(JSON.stringify(b));
  assert.ok(read.ok);
  assert.deepEqual(read.ok && read.backup.plannedIncomes, b.plannedIncomes);
  const bad = viaJson(b);
  (bad.plannedIncomes[0] as unknown as { amount: string }).amount = "300000";
  assert.equal(validateBackup(bad).ok, false);
  const badMonth = viaJson(b);
  badMonth.plannedIncomes[0].month = "2027-6";
  assert.equal(validateBackup(badMonth).ok, false);
});

test("DB版2までのバックアップ（予定収入・予算の決め方がない）も読める：空・自動として読む。明細はそのまま", () => {
  const old = viaJson(sampleBackup()) as unknown as Record<string, unknown>;
  delete old.plannedIncomes;
  delete old.subscriptionReviews;
  const settings = old.settings as Record<string, unknown>;
  delete settings.budgetMode;
  delete settings.monthlyBudget;
  const r = validateBackup(old);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.backup.plannedIncomes, []);
    assert.equal(r.backup.settings.budgetMode, "auto");
    assert.equal(r.backup.settings.monthlyBudget, null);
    assert.equal(r.backup.transactions.length, sampleData().transactions.length);
  }
});

test("設定の検証：予算の決め方は auto / manual、月の予算は null か1円以上", () => {
  const ok = viaJson(sampleBackup());
  ok.settings.budgetMode = "manual";
  ok.settings.monthlyBudget = 100000;
  assert.ok(validateBackup(ok).ok);
  const badMode = viaJson(ok) as unknown as { settings: Record<string, unknown> };
  badMode.settings.budgetMode = "other";
  assert.equal(validateBackup(badMode).ok, false);
  const zero = viaJson(ok);
  zero.settings.monthlyBudget = 0;
  assert.equal(validateBackup(zero).ok, false);
});

test("予算の記録の basis.mode（自分で決めた印）は読み込める。数字以外の項目は mode だけ", () => {
  const b = viaJson(sampleBackup());
  b.budgetSnapshots[0].basis = { mode: "manual", monthBudget: 100000 };
  assert.ok(validateBackup(b).ok);
  b.budgetSnapshots[0].basis = { mode: "manual", memo: "x" } as never;
  assert.equal(validateBackup(b).ok, false);
});

test("DB版3：予定収入のストアを足すだけ。版2のDBの既存ストア（明細など）には触れない", () => {
  assert.equal(DB_VERSION, 3);
  assert.ok((DATA_STORE_NAMES as readonly string[]).includes("plannedIncomes"));
  const v2 = DATA_STORE_NAMES.filter((n) => n !== "plannedIncomes");
  const plan = planUpgrade([...v2, "settings"]);
  assert.deepEqual(plan.create, ["plannedIncomes"]);
  assert.equal(plan.createSettings, false);
  assert.ok(!(plan.create as string[]).includes("transactions"));
});
