// #26 賞与の支給周期：給料明細のひな形の「毎年（支給する月を選ぶ）」
import assert from "node:assert/strict";
import test from "node:test";
import { buildBackup, validateBackup } from "../src/backup.js";
import { defaultSettings } from "../src/constants.js";
import { payrollIncomeBetween } from "../src/outlookLogic.js";
import { entryMonthOf, isPayMonth, isValidPayMonths, newEntryDraft, normalizePayMonths, payScheduleText, validatePayroll } from "../src/payrollLogic.js";
import type { Payroll } from "../src/types.js";
import { T0, emptyData, tx } from "./fixtures.js";

const bonus: Payroll = {
  id: "b1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト賞与", accountId: "a1", day: 10, holidayShift: "before", months: [6, 12],
  lines: [
    { lineId: "l1", kind: "pay", categoryId: "c1", label: "賞与", amount: 400000 },
    { lineId: "l2", kind: "deduction", categoryId: "c2", label: "控除", amount: 80000 },
  ],
};
const monthly: Payroll = { ...bonus, id: "m1", name: "テスト給与", day: 25, months: undefined };

test("支給する月：無ければ毎月、あれば選んだ月だけ", () => {
  assert.equal(isPayMonth(monthly, "2026-11"), true);
  assert.equal(isPayMonth(bonus, "2026-06"), true);
  assert.equal(isPayMonth(bonus, "2026-12"), true);
  assert.equal(isPayMonth(bonus, "2026-11"), false);
});

test("支給する月の表示", () => {
  assert.equal(payScheduleText(monthly), "毎月25日");
  assert.equal(payScheduleText({ day: 31 }), "毎月末日");
  assert.equal(payScheduleText(bonus), "毎年6月・12月の10日");
});

test("支給する月のそろえ方：小さい順・重なりなし・12か月全部は毎月（保存しない）", () => {
  assert.deepEqual(normalizePayMonths([12, 6, 6]), [6, 12]);
  assert.equal(normalizePayMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), undefined);
  assert.equal(normalizePayMonths([]), undefined);
  assert.equal(normalizePayMonths(undefined), undefined);
  assert.equal(isValidPayMonths([6, 12]), true);
  assert.equal(isValidPayMonths([]), false);
  assert.equal(isValidPayMonths([0]), false);
  assert.equal(isValidPayMonths([13]), false);
  assert.equal(isValidPayMonths([6, 6]), false);
  assert.equal(isValidPayMonths([6.5]), false);
});

test("ひな形のチェック：毎年なのに月が無いときは止める", () => {
  assert.equal(validatePayroll(bonus), null);
  assert.equal(validatePayroll(monthly), null);
  assert.match(validatePayroll({ ...bonus, months: [] }) ?? "", /支給する月/);
});

test("入力の初期の日付：毎年のひな形は今日にいちばん近い支給月（同じ近さなら過ぎたほう）", () => {
  assert.equal(entryMonthOf(monthly, "2026-11-03"), "2026-11");
  assert.equal(entryMonthOf(bonus, "2026-12-20"), "2026-12");
  assert.equal(entryMonthOf(bonus, "2026-11-03"), "2026-12");
  assert.equal(entryMonthOf(bonus, "2026-07-15"), "2026-06");
  assert.equal(entryMonthOf(bonus, "2026-09-01"), "2026-06"); // 6月と12月から3か月ずつ → 過ぎたほう
  assert.equal(entryMonthOf(bonus, "2027-02-01"), "2026-12");
  assert.equal(entryMonthOf({ months: [7] }, "2026-01-10"), "2025-07"); // 半年ずつ → 過ぎたほう
  assert.equal(newEntryDraft(bonus, "2026-11-03").date, "2026-12-10");
  assert.equal(newEntryDraft(bonus, "2026-06-01").date, "2026-06-10");
});

test("見通しの手取りの見込み：毎年のひな形は支給する月だけ入る（毎月のひな形はこれまでどおり）", () => {
  const d = { ...emptyData(), payrolls: [monthly, bonus] };
  const items = payrollIncomeBetween(d, "2026-11-01", "2027-07-31");
  assert.deepEqual(
    items.filter((i) => i.label === "テスト賞与").map((i) => `${i.date}:${i.amount}`),
    ["2026-12-10:320000", "2027-06-10:320000"],
  );
  assert.equal(items.filter((i) => i.label === "テスト給与").length, 9);
  // その日の賞与をすでに入れていれば数えない
  const entered = { ...d, transactions: [tx("t1", { type: "income", date: "2026-12-10", amount: 400000, payrollId: "b1" })] };
  assert.deepEqual(payrollIncomeBetween(entered, "2026-11-01", "2027-07-31").filter((i) => i.label === "テスト賞与").map((i) => i.date), ["2027-06-10"]);
});

test("バックアップ：支給する月は無くても通り、あれば 1〜12 の配列だけ通る", () => {
  const check = (p: Payroll) => validateBackup(JSON.parse(JSON.stringify(buildBackup({ ...emptyData(), payrolls: [p] }, defaultSettings(), T0)))).ok;
  assert.equal(check(monthly), true);
  assert.equal(check(bonus), true);
  assert.equal(check({ ...bonus, months: [] }), false);
  assert.equal(check({ ...bonus, months: [13] }), false);
});
