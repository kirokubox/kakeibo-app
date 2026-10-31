import assert from "node:assert/strict";
import test from "node:test";
import { canFinish, evaluate, formatExpr, hasOperator, padValue, pressKey, startPad } from "../src/calculator.js";
import type { PadKey, PadState } from "../src/calculator.js";

/** キーを順に押した後の状態 */
function press(keys: PadKey[], from: PadState = { expr: "", fresh: false }): PadState {
  return keys.reduce((s, k) => pressKey(s, k), from);
}
const val = (expr: string) => {
  const r = evaluate(expr);
  return r.ok ? r.value : r.reason;
};

test("足し算・引き算", () => {
  assert.equal(val("1280+540"), 1820);
  assert.equal(val("1000-300"), 700);
  assert.equal(val("100+200-50"), 250);
});

test("掛け算・割り算を先に計算する（優先順位）", () => {
  assert.equal(val("100+20*3"), 160);
  assert.equal(val("100-20*3"), 40);
  assert.equal(val("2*3+4*5"), 26);
  assert.equal(val("100+60/3"), 120);
  assert.equal(val("1000/4/5"), 50);
  assert.equal(val("10*10/4"), 25);
});

test("割り算の端数は四捨五入", () => {
  assert.equal(val("10/4"), 3); // 2.5 → 3
  assert.equal(val("10/3"), 3);
  assert.equal(val("11/3"), 4); // 3.67
  assert.equal(val("1000/3*3"), 1000);
  assert.equal(val("5/2"), 3);
});

test("0以下は拒む", () => {
  assert.equal(val("0"), "notPositive");
  assert.equal(val("500-500"), "notPositive");
  assert.equal(val("100-500"), "notPositive");
  assert.equal(val("1/3"), "notPositive"); // 0.33 → 0
});

test("0で割る・途中の式・空は拒む", () => {
  assert.equal(val("100/0"), "divideByZero");
  assert.equal(val("1280+"), "incomplete");
  assert.equal(val("1280*"), "incomplete");
  assert.equal(val(""), "empty");
  assert.equal(canFinish("1280+"), false);
  assert.equal(canFinish("1280+540"), true);
});

test("12桁を超える結果は拒む", () => {
  assert.equal(val("999999999999"), 999999999999);
  assert.equal(val("999999999999+1"), "tooLarge");
  assert.equal(val("1000000*1000000"), "tooLarge");
  assert.equal(canFinish("999999999999+1"), false);
});

test("数字キー：00 と桁数の上限", () => {
  assert.equal(press(["1", "2", "00"]).expr, "1200");
  assert.equal(press(["00"]).expr, ""); // 先頭の 00 は無視
  assert.equal(press(["0", "00"]).expr, "0");
  assert.equal(press(["5", "+", "00"]).expr, "5+"); // 演算子の直後の 00 も無視
  assert.equal(press(["0", "5"]).expr, "5"); // 先頭の 0 は置き換わる
  assert.equal(press(["1", "+", "0", "7"]).expr, "1+7");
  const nines = (n: number): PadKey[] => Array.from({ length: n }, () => "9" as PadKey);
  const twelve = press(nines(12));
  assert.equal(twelve.expr.length, 12);
  assert.equal(pressKey(twelve, "9").expr, twelve.expr); // 13桁目は入らない
  assert.equal(pressKey(press(nines(11)), "00").expr.length, 11); // 00 で13桁になるなら入らない
  assert.equal(press(["1", "+", ...nines(13)]).expr, "1+999999999999"); // 演算子のあとは新しく12桁まで
});

test("演算子キー：先頭は無視、続けて押すと置き換え", () => {
  assert.equal(press(["+"]).expr, "");
  assert.equal(press(["1", "+", "-"]).expr, "1-");
  assert.equal(press(["1", "*", "/", "+"]).expr, "1+");
  assert.equal(press(["1", "2", "+", "3", "back"]).expr, "12+");
  assert.equal(press(["1", "2", "+", "3", "back", "back"]).expr, "12");
  assert.equal(press(["back"]).expr, "");
});

test("編集で開いたとき：最初に数字を押すと置き換わり、演算子を押すと続けられる", () => {
  const s = startPad(1280);
  assert.deepEqual(s, { expr: "1280", fresh: true });
  assert.equal(press(["5"], s).expr, "5");
  assert.equal(press(["00"], s).expr, "1280"); // 00 では置き換わらない
  assert.equal(press(["+", "5"], s).expr, "1280+5");
  assert.equal(press(["back"], s).expr, "128");
  assert.equal(press(["back", "9"], s).expr, "1289"); // 消したあとは置き換えではなく続き
  assert.deepEqual(startPad(null), { expr: "", fresh: false });
});

test("式の表示と判定", () => {
  assert.equal(formatExpr("1280+540"), "1,280＋540");
  assert.equal(formatExpr("1000000*2-3/4"), "1,000,000×2−3÷4");
  assert.equal(formatExpr("100+"), "100＋");
  assert.equal(formatExpr(""), "");
  assert.equal(hasOperator("1280+540"), true);
  assert.equal(hasOperator("1280"), false);
});

test("金額の欄のテンキー（#29）：空は空欄、0円も入れられる、計算できない式は完了できない", () => {
  assert.equal(padValue(""), null);
  assert.equal(padValue("0"), 0);
  assert.equal(padValue("1200"), 1200);
  assert.equal(padValue("1000+250"), 1250);
  assert.equal(padValue("500-500"), 0);
  assert.equal(padValue("100-200"), undefined);
  assert.equal(padValue("100+"), undefined);
  assert.equal(padValue("10/0"), undefined);
  // 入力画面の金額（allowZero なし）はこれまでどおり1円以上
  assert.equal(evaluate("0").ok, false);
  assert.equal(evaluate("0", { allowZero: true }).ok, true);
  assert.equal(canFinish("500-500"), false);
  assert.equal(canFinish("500-500", { allowZero: true }), true);
});
