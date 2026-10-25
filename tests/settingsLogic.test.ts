import assert from "node:assert/strict";
import test from "node:test";
import { isDayOfMonth, validateDefenseFund, validatePayday, validateReminderDays } from "../src/settingsLogic.js";

test("給料日・引き落とし日は 1〜31 の整数だけ", () => {
  for (const ok of [1, 15, 25, 31]) assert.equal(validatePayday(ok), null);
  for (const bad of [0, 32, -1, 1.5, NaN, "25", null, undefined]) {
    assert.notEqual(validatePayday(bad), null, String(bad));
    assert.equal(isDayOfMonth(bad), false);
  }
});

test("生活防衛資金は 0 以上の整数だけ", () => {
  assert.equal(validateDefenseFund(0), null);
  assert.equal(validateDefenseFund(100000), null);
  assert.notEqual(validateDefenseFund(-1), null);
  assert.notEqual(validateDefenseFund(100.5), null);
  assert.notEqual(validateDefenseFund("100"), null);
  assert.notEqual(validateDefenseFund(NaN), null);
});

test("お知らせ日数は 1〜90 の整数", () => {
  assert.equal(validateReminderDays(1), null);
  assert.equal(validateReminderDays(14), null);
  assert.equal(validateReminderDays(90), null);
  for (const bad of [0, 91, -3, 7.5, NaN, "14"]) assert.notEqual(validateReminderDays(bad), null, String(bad));
});
