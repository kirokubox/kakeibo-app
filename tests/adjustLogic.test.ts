import assert from "node:assert/strict";
import test from "node:test";
import { computeBalances, txEffect } from "../src/accountLogic.js";
import {
  ADJUST_CONTENT,
  actualToBalance,
  adjustmentDiff,
  balanceAsOf,
  checkAdjustDiff,
  describeDiff,
  initialMonthCount,
  makeAdjustment,
  monthBlocks,
  runningBalances,
} from "../src/adjustLogic.js";
import { account, T0, T1, tx } from "./fixtures.js";

const base = { id: "adj1", createdAt: T0, updatedAt: T0, deletedAt: null };
const bank = account("bank", { name: "テスト銀行", group: "bank", openingBalance: 10000 });
const card = account("card", { name: "テストカード", group: "card", openingBalance: -2000 });

const list = [
  tx("t1", { type: "income", amount: 5000, accountId: "bank", date: "2026-10-01", createdAt: "2026-10-01T01:00:00.000Z" }),
  tx("t2", { type: "expense", amount: 3000, accountId: "bank", date: "2026-10-10", createdAt: "2026-10-10T01:00:00.000Z" }),
  tx("t3", { type: "transfer", amount: 4000, fee: 110, accountId: "bank", toAccountId: "card", date: "2026-10-15", createdAt: "2026-10-15T01:00:00.000Z" }),
  tx("t4", { type: "expense", amount: 1000, accountId: "card", date: "2026-10-20", createdAt: "2026-10-20T01:00:00.000Z" }),
  tx("t5", { type: "expense", amount: 999, accountId: "bank", date: "2026-10-12", deletedAt: T1 }), // 削除済みは数えない
];

test("選んだ日までの残高：後の日付の明細は入れず、その日の分は入れる", () => {
  assert.equal(balanceAsOf(bank, list, "2026-09-30"), 10000);
  assert.equal(balanceAsOf(bank, list, "2026-10-01"), 15000);
  assert.equal(balanceAsOf(bank, list, "2026-10-10"), 12000);
  assert.equal(balanceAsOf(bank, list, "2026-10-14"), 12000); // 10/15 の振替はまだ
  assert.equal(balanceAsOf(bank, list, "2026-10-15"), 12000 - 4110); // 手数料は出金側から
  assert.equal(balanceAsOf(bank, list, "2026-12-31"), 12000 - 4110);
  // 全部入れた残高は computeBalances と同じ
  assert.equal(balanceAsOf(bank, list, "2099-01-01"), computeBalances([bank, card], list).get("bank"));
  assert.equal(balanceAsOf(card, list, "2099-01-01"), computeBalances([bank, card], list).get("card"));
  assert.equal(balanceAsOf(card, list, "2026-10-15"), -2000 + 4000); // 入金側
});

test("差額 = 実際の残高 − その日までの残高（後の日付の明細があっても、その日までで計算する）", () => {
  const app = balanceAsOf(bank, list, "2026-10-10"); // 12,000
  assert.equal(adjustmentDiff(app, 12655), 655);
  assert.equal(adjustmentDiff(app, 11700), -300);
  assert.equal(adjustmentDiff(app, 12000), 0);
  // 10/10 の終わりを 12,655 に合わせる → その修正を入れると、10/10 の終わりが 12,655 になる
  const adj = makeAdjustment("bank", "2026-10-10", 655, "", base);
  assert.equal(balanceAsOf(bank, [...list, adj], "2026-10-10"), 12655);
  // 後の日付の明細（10/15 の振替）はそのまま乗る
  assert.equal(balanceAsOf(bank, [...list, adj], "2026-10-15"), 12655 - 4110);
});

test("カードは「実際の未払い額」（正の数）から差額を出す。残高はマイナスで持つ", () => {
  assert.equal(actualToBalance(card, 8000), -8000);
  assert.equal(actualToBalance(card, 0), 0);
  assert.equal(actualToBalance(bank, 12345), 12345);
  assert.equal(actualToBalance(bank, -300), -300);
  const app = balanceAsOf(card, list, "2026-10-20"); // -2000 + 4000 - 1000 = 1000（過払い）
  assert.equal(app, 1000);
  // 未払いが 2,500 だったと分かった → 残高 -2,500 に合わせる差額は -3,500（符号つき）
  assert.equal(adjustmentDiff(app, actualToBalance(card, 2500)), -3500);
  const adj = makeAdjustment("card", "2026-10-20", -3500, "", base);
  assert.equal(balanceAsOf(card, [...list, adj], "2026-10-20"), -2500);
});

test("符号：増えたら正、減ったら負。差額0は保存不可", () => {
  assert.equal(checkAdjustDiff(655).ok, true);
  assert.equal(checkAdjustDiff(-300).ok, true);
  const zero = checkAdjustDiff(0);
  assert.equal(zero.ok, false);
  assert.equal(zero.ok === false && zero.message, "合っています");
  assert.equal(checkAdjustDiff(null).ok, false);
  assert.equal(checkAdjustDiff(1.5).ok, false);
  assert.equal(describeDiff(655), "差額 ＋655円（アプリより多い）");
  assert.equal(describeDiff(-300), "差額 −300円（アプリより少ない）");
  assert.equal(describeDiff(0), "合っています");
  const up = makeAdjustment("bank", "2026-10-25", 655, "  メモ  ", base);
  assert.equal(up.type, "adjustment");
  assert.equal(up.amount, 655);
  assert.equal(up.content, ADJUST_CONTENT);
  assert.equal(up.source, "manual");
  assert.equal(up.memo, "メモ");
  assert.equal(up.accountId, "bank");
  assert.equal(computeBalances([bank], [up]).get("bank"), 10655);
  const down = makeAdjustment("bank", "2026-10-25", -300, "", base);
  assert.equal(computeBalances([bank], [down]).get("bank"), 9700);
});

test("残高修正の編集：差額・日付・メモだけ直る。残高修正を除いて数えられる", () => {
  const adj = makeAdjustment("bank", "2026-10-10", 655, "", base);
  const edited = makeAdjustment("bank", "2026-10-11", -100, "直した", base, adj);
  assert.equal(edited.id, "adj1");
  assert.equal(edited.amount, -100);
  assert.equal(edited.date, "2026-10-11");
  assert.equal(edited.memo, "直した");
  assert.equal(edited.type, "adjustment");
  // 自分自身を除いた残高
  assert.equal(balanceAsOf(bank, [...list, adj], "2026-10-10", "adj1"), 12000);
});

test("資産の明細：出金側・入金側の両方を拾い、削除済みと関係ない資産は除く", () => {
  const blocks = monthBlocks("card", list);
  const ids = blocks.flatMap((b) => b.items.map((t) => t.id)).sort();
  assert.deepEqual(ids, ["t3", "t4"]); // 振替の入金側と、カードの支出
  const bankIds = monthBlocks("bank", list).flatMap((b) => b.items.map((t) => t.id)).sort();
  assert.deepEqual(bankIds, ["t1", "t2", "t3"]); // 振替の出金側。t5 は削除済み
  assert.deepEqual(monthBlocks("nobody", list), []);
});

test("資産の明細：各明細のあとの残高（日付・作った順に積み上げ）", () => {
  const r = runningBalances(bank, list);
  assert.equal(r.get("t1"), 15000);
  assert.equal(r.get("t2"), 12000);
  assert.equal(r.get("t3"), 12000 - 4110);
  assert.equal(r.has("t5"), false);
  const rc = runningBalances(card, list);
  assert.equal(rc.get("t3"), 2000);
  assert.equal(rc.get("t4"), 1000);
  // 最後の残高は、資産タブの残高と同じ
  assert.equal(r.get("t3"), computeBalances([bank, card], list).get("bank"));
  // 1件ごとの動きの合計 = 残高
  assert.equal(txEffect("bank", list[2]), -4110);
  assert.equal(txEffect("card", list[2]), 4000);
  assert.equal(txEffect("other", list[2]), 0);
});

test("資産の明細：月ごとに新しい順。最初は今月と先月（明細がある月だけ）", () => {
  const many = [
    tx("a", { accountId: "bank", date: "2026-10-05", createdAt: "2026-10-05T01:00:00.000Z" }),
    tx("b", { accountId: "bank", date: "2026-10-05", createdAt: "2026-10-05T02:00:00.000Z" }),
    tx("c", { accountId: "bank", date: "2026-09-20" }),
    tx("d", { accountId: "bank", date: "2026-07-01" }),
    tx("e", { accountId: "bank", date: "2026-03-01" }),
  ];
  const blocks = monthBlocks("bank", many);
  assert.deepEqual(blocks.map((b) => b.month), ["2026-10", "2026-09", "2026-07", "2026-03"]);
  assert.deepEqual(blocks[0].items.map((t) => t.id), ["b", "a"]); // 同じ日は作った順の新しいものが上
  assert.equal(initialMonthCount(blocks, "2026-10"), 2);
  assert.equal(initialMonthCount(blocks, "2026-12"), 1); // 今月・先月に明細が無くても、最低1つ
  assert.equal(initialMonthCount(blocks, "2027-01"), 1);
  assert.equal(initialMonthCount([], "2026-10"), 0);
});
