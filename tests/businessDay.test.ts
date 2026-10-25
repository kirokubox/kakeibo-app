import assert from "node:assert/strict";
import test from "node:test";
import {
  cardPaymentDateOf,
  dateInMonth,
  isNonBusinessDay,
  nextCardPayment,
  nextPayday,
  paydayOf,
  shiftForHoliday,
  shiftedDateInMonth,
} from "../src/businessDay.js";
import { holidayName, holidaysOfYear, isHoliday } from "../src/holidays.js";

const settings = { payday: 25, paydayHolidayShift: "before" as const };

test("祝日：2026年11月の文化の日・勤労感謝の日、春分・秋分、成人の日などの月曜", () => {
  assert.equal(holidayName("2026-11-03"), "文化の日");
  assert.equal(holidayName("2026-11-23"), "勤労感謝の日");
  assert.equal(holidayName("2026-03-20"), "春分の日");
  assert.equal(holidayName("2026-09-23"), "秋分の日");
  assert.equal(holidayName("2026-01-12"), "成人の日"); // 1月の第2月曜
  assert.equal(holidayName("2026-07-20"), "海の日"); // 7月の第3月曜
  assert.equal(holidayName("2026-10-12"), "スポーツの日"); // 10月の第2月曜
  assert.equal(isHoliday("2026-11-04"), false);
});

test("祝日：振替休日と国民の休日", () => {
  // 2026-05-03（日）の憲法記念日は、5/4・5/5も祝日なので、5/6が振替休日
  assert.equal(holidayName("2026-05-06"), "振替休日");
  // 2026-09-21（敬老の日）と 9/23（秋分の日）にはさまれた 9/22 は国民の休日
  assert.equal(holidayName("2026-09-22"), "国民の休日");
  // 2027-02-23 は火曜の天皇誕生日。振替は出ない
  assert.equal(holidaysOfYear(2027).get("2027-02-23"), "天皇誕生日");
  // 2019年以前は祝日なしとして扱う
  assert.equal(holidaysOfYear(2019).size, 0);
});

test("休日の判定：土日と祝日。年末年始（12/31〜1/3）は休日にしない", () => {
  assert.equal(isNonBusinessDay("2026-10-24"), true); // 土
  assert.equal(isNonBusinessDay("2026-10-25"), true); // 日
  assert.equal(isNonBusinessDay("2026-10-26"), false); // 月
  assert.equal(isNonBusinessDay("2026-11-03"), true); // 文化の日（火）
  assert.equal(isNonBusinessDay("2026-12-31"), false); // 木。年末年始は休日にしない
  assert.equal(isNonBusinessDay("2027-01-02"), true); // 土
  assert.equal(isNonBusinessDay("2027-01-01"), true); // 元日（祝日）
});

test("休日の移動：前の平日／後の平日／そのまま", () => {
  assert.equal(shiftForHoliday("2026-10-25", "before"), "2026-10-23"); // 日 → 金
  assert.equal(shiftForHoliday("2026-10-25", "after"), "2026-10-26"); // 日 → 月
  assert.equal(shiftForHoliday("2026-10-25", "none"), "2026-10-25");
  assert.equal(shiftForHoliday("2026-10-23", "before"), "2026-10-23"); // 平日は動かさない
  // 連休：2026年のゴールデンウィーク（5/2 土〜5/6 振替休日）
  assert.equal(shiftForHoliday("2026-05-04", "before"), "2026-05-01");
  assert.equal(shiftForHoliday("2026-05-03", "after"), "2026-05-07");
  // 祝日（平日）
  assert.equal(shiftForHoliday("2026-11-03", "before"), "2026-11-02");
  assert.equal(shiftForHoliday("2026-11-23", "after"), "2026-11-24");
});

test("月にない日は月末にしてから休日の移動：2月30日→28日、うるう年は29日", () => {
  assert.equal(dateInMonth("2026-02", 30), "2026-02-28");
  assert.equal(dateInMonth("2028-02", 31), "2028-02-29");
  assert.equal(dateInMonth("2026-04", 31), "2026-04-30");
  assert.equal(dateInMonth("2026-06", "last"), "2026-06-30");
  assert.equal(dateInMonth("2026-10", 5), "2026-10-05");
  // 2026-02-28 は土曜：月末にしてから「前の平日」で 2/27
  assert.equal(shiftedDateInMonth("2026-02", 30, "before"), "2026-02-27");
  // 2026-08-31 は月曜：動かさない
  assert.equal(shiftedDateInMonth("2026-08", 31, "before"), "2026-08-31");
});

test("給料日：25日が土曜なら24日（金）、日曜なら23日（金）。月ごとに決まる", () => {
  assert.equal(paydayOf("2026-07", settings), "2026-07-24"); // 7/25 は土
  assert.equal(paydayOf("2026-10", settings), "2026-10-23"); // 10/25 は日
  assert.equal(paydayOf("2026-11", settings), "2026-11-25"); // 水
  assert.equal(paydayOf("2026-12", settings), "2026-12-25"); // 金
  assert.equal(paydayOf("2026-07", { payday: 25, paydayHolidayShift: "after" }), "2026-07-27");
  assert.equal(paydayOf("2026-07", { payday: 25, paydayHolidayShift: "none" }), "2026-07-25");
});

test("次の給料日：今日以降で最初（今日が給料日なら今日）", () => {
  assert.equal(nextPayday("2026-10-20", settings), "2026-10-23");
  assert.equal(nextPayday("2026-10-23", settings), "2026-10-23");
  assert.equal(nextPayday("2026-10-24", settings), "2026-11-25");
  assert.equal(nextPayday("2026-12-26", settings), "2027-01-25");
  // 「後の平日」で翌月に入る場合（月末が土日）も正しく拾う
  assert.equal(nextPayday("2026-08-30", { payday: 31, paydayHolidayShift: "after" }), "2026-08-31");
  assert.equal(nextPayday("2026-09-01", { payday: 30, paydayHolidayShift: "after" }), "2026-09-30");
});

test("カードの引き落とし：27日が日曜なら28日（後の平日）", () => {
  const card = { paymentDay: 27, holidayShift: "after" as const };
  assert.equal(cardPaymentDateOf(card, "2026-12"), "2026-12-28"); // 12/27 は日
  assert.equal(cardPaymentDateOf(card, "2026-11"), "2026-11-27"); // 金
  assert.equal(cardPaymentDateOf(card, "2026-06"), "2026-06-29"); // 6/27 は土 → 月
  assert.equal(nextCardPayment(card, "2026-11-01"), "2026-11-27");
  assert.equal(nextCardPayment(card, "2026-11-28"), "2026-12-28");
  assert.equal(nextCardPayment(card, "2026-12-28"), "2026-12-28");
  assert.equal(nextCardPayment(card, "2026-12-29"), "2027-01-27");
  // 月末の引き落とし日（31日）は短い月で月末
  assert.equal(cardPaymentDateOf({ paymentDay: 31, holidayShift: "none" }, "2026-04"), "2026-04-30");
});
