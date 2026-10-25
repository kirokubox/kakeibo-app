import assert from "node:assert/strict";
import test from "node:test";
import type { Payroll, Recurring } from "../src/types.js";
import {
  cardPaymentsBetween,
  nextCardPayment,
  nextOccurrence,
  nextPayday,
  occurrencesBetween,
  paydaysBetween,
  payrollForecast,
  recurringOccurrencesBetween,
} from "../src/scheduleLogic.js";
import { T0 } from "./fixtures.js";

const template = { type: "expense" as const, amount: 3000, accountId: "a1", categoryId: "c1", content: "テスト定期", memo: "" };
function rec(id: string, extra: Partial<Recurring> = {}): Recurring {
  return { id, createdAt: T0, updatedAt: T0, deletedAt: null, template, rule: { every: "month", day: 25 }, startDate: "2026-08-25", holidayShift: "none", estimated: false, ...extra };
}

test("期間内の予定：休日の移動後の日付で数える", () => {
  const r = rec("r1", { holidayShift: "before", generatedThrough: "2026-09-25" });
  // 2026-10-25 は日曜 → 10/23。11/25（水）、12/25（金）
  assert.deepEqual(
    occurrencesBetween(r, "2026-10-01", "2026-12-31").map((o) => o.date),
    ["2026-10-23", "2026-11-25", "2026-12-25"],
  );
  // 期間の端：移動後の日付で入る／入らない
  assert.deepEqual(occurrencesBetween(r, "2026-10-24", "2026-12-31").map((o) => o.date), ["2026-11-25", "2026-12-25"]);
  assert.deepEqual(occurrencesBetween(r, "2026-10-23", "2026-10-23").map((o) => o.date), ["2026-10-23"]);
  // 作り済み（generatedThrough まで）と、終わりの日より後は含めない
  assert.deepEqual(occurrencesBetween(rec("r2", { generatedThrough: "2026-10-25", endDate: "2026-12-25" }), "2026-10-01", "2027-03-31").map((o) => o.date), ["2026-11-25", "2026-12-25"]);
  assert.deepEqual(occurrencesBetween(rec("r3", { deletedAt: T0 }), "2026-10-01", "2026-12-31"), []);
});

test("次の予定", () => {
  const r = rec("r1", { generatedThrough: "2026-10-25" });
  assert.equal(nextOccurrence(r, "2026-10-26")?.date, "2026-11-25");
  assert.equal(nextOccurrence(rec("r4", { rule: { every: "year", month: 3, day: 1 }, startDate: "2026-03-01", generatedThrough: "2026-03-01" }), "2026-10-26")?.date, "2027-03-01");
});

test("複数の繰り返しを日付順に並べる", () => {
  const a = rec("a", { generatedThrough: "2026-09-25" });
  const b = rec("b", { rule: { every: "month", day: 5 }, startDate: "2026-09-05", generatedThrough: "2026-09-05" });
  const list = recurringOccurrencesBetween([a, b], "2026-10-01", "2026-11-30");
  assert.deepEqual(
    list.map((o) => `${o.date}:${o.recurring.id}`),
    ["2026-10-05:b", "2026-10-25:a", "2026-11-05:b", "2026-11-25:a"],
  );
});

test("期間内の給料日（25日が日曜・土曜のとき前の平日）", () => {
  const s = { payday: 25, paydayHolidayShift: "before" as const };
  assert.deepEqual(paydaysBetween(s, "2026-10-01", "2026-12-31"), ["2026-10-23", "2026-11-25", "2026-12-25"]);
  assert.deepEqual(paydaysBetween(s, "2026-07-01", "2026-07-31"), ["2026-07-24"]);
  assert.deepEqual(paydaysBetween(s, "2026-10-24", "2026-11-24"), []);
  assert.equal(nextPayday("2026-10-26", s), "2026-11-25");
});

test("期間内のカードの引き落とし日（27日が日曜なら28日）", () => {
  const card = { paymentDay: 27, holidayShift: "after" as const };
  assert.deepEqual(cardPaymentsBetween(card, "2026-11-01", "2027-01-31"), ["2026-11-27", "2026-12-28", "2027-01-27"]);
  // 「後の平日」で月をまたぐ引き落とし日（月末）も、期間で絞って拾う
  assert.deepEqual(cardPaymentsBetween({ paymentDay: 31, holidayShift: "after" }, "2026-08-01", "2026-09-05"), ["2026-08-31"]);
  assert.equal(nextCardPayment(card, "2026-10-26"), "2026-10-27");
});

test("給料明細のひな形から、その月の手取りの見込み（前回の金額で計算）", () => {
  const p: Payroll = {
    id: "p1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト商事", accountId: "a1", day: 25, holidayShift: "before",
    lines: [
      { lineId: "l1", kind: "pay", categoryId: "c1", label: "基本給", amount: 200000 },
      { lineId: "l2", kind: "pay", categoryId: "c1", label: "通勤費", amount: 10000 },
      { lineId: "l3", kind: "deduction", categoryId: "c2", label: "税", amount: 20000 },
      { lineId: "l4", kind: "settlement", accountId: "a2", label: "社員食堂", amount: 5000 },
    ],
  };
  assert.deepEqual(payrollForecast(p, "2026-10"), { date: "2026-10-23", takeHome: 185000 });
  const withLast = { ...p, lastAmounts: { l2: 12000, l4: 7000 } };
  assert.deepEqual(payrollForecast(withLast, "2026-11"), { date: "2026-11-25", takeHome: 200000 + 12000 - 20000 - 7000 });
});
