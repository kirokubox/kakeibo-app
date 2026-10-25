import assert from "node:assert/strict";
import test from "node:test";
import { assertYen, formatYen, isYen } from "../src/money.js";

test("整数だけが金額として通る", () => {
  assert.equal(isYen(0), true);
  assert.equal(isYen(-1200), true);
  assert.equal(isYen(100.5), false);
  assert.equal(isYen("100"), false);
  assert.equal(isYen(NaN), false);
  assert.equal(isYen(Infinity), false);
  assert.equal(isYen(null), false);
  assert.equal(isYen(undefined), false);
  assert.equal(isYen(2 ** 60), false);
});

test("assertYen は整数以外で例外", () => {
  assert.equal(assertYen(500), 500);
  assert.throws(() => assertYen(0.1), /整数/);
  assert.throws(() => assertYen("5"), /整数/);
});

test("formatYen", () => {
  assert.equal(formatYen(100000), "100,000円");
  assert.equal(formatYen(-2500), "−2,500円");
  assert.equal(formatYen(0), "0円");
});
