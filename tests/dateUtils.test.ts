import assert from "node:assert/strict";
import test from "node:test";
import { addMonths, daysInMonth, formatDateJa, formatMonthDayWeekday, isIsoDateTime, isLocalDate, isMonthKey, nowIso, toDateKey } from "../src/dateUtils.js";

test("暦日の検証（実在する日付だけ）", () => {
  assert.equal(isLocalDate("2026-10-25"), true);
  assert.equal(isLocalDate("2028-02-29"), true); // うるう年
  assert.equal(isLocalDate("2026-02-29"), false);
  assert.equal(isLocalDate("2026-02-30"), false);
  assert.equal(isLocalDate("2026-13-01"), false);
  assert.equal(isLocalDate("2026-1-1"), false);
  assert.equal(isLocalDate("2026/10/25"), false);
  assert.equal(isLocalDate(20261025), false);
});

test("月・ISO時刻の検証", () => {
  assert.equal(isMonthKey("2026-10"), true);
  assert.equal(isMonthKey("2026-00"), false);
  assert.equal(isMonthKey("2026-13"), false);
  assert.equal(isIsoDateTime("2026-10-25T09:00:00.000Z"), true);
  assert.equal(isIsoDateTime("2026-10-25T18:00:00+09:00"), true);
  assert.equal(isIsoDateTime("2026-10-25"), false);
  assert.equal(isIsoDateTime("2026-10-25T09:00"), false);
  assert.equal(isIsoDateTime("2026-13-25T09:00:00Z"), false);
  assert.equal(isIsoDateTime(nowIso()), true);
});

test("端末のローカル日付で日付キーを作る（深夜でも前日にしない）", () => {
  assert.equal(toDateKey(new Date(2026, 9, 25, 0, 5)), "2026-10-25");
  assert.equal(toDateKey(new Date(2026, 9, 25, 23, 59)), "2026-10-25");
});

test("日付の表示：今年は年なし、今年以外は年あり", () => {
  const today = new Date(2026, 9, 25);
  assert.equal(formatDateJa("2026-10-12", today), "10月12日（月）");
  assert.equal(formatDateJa("2025-12-31", today), "2025年12月31日（水）");
});

test("月の日数・年月の加減・月日と曜日の表示", () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.equal(daysInMonth(2026, 12), 31);
  assert.equal(addMonths("2026-10", 1), "2026-11");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-10", 14), "2027-12");
  assert.equal(formatMonthDayWeekday("2026-11-27"), "11/27(金)");
  assert.equal(formatMonthDayWeekday("2026-10-04"), "10/4(日)");
});
