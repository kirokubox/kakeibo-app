import assert from "node:assert/strict";
import test from "node:test";
import { computeBalances } from "../src/accountLogic.js";
import {
  SETTLE_CATEGORY_ID,
  applyReimbFields,
  checkReimbWithin,
  computeAllocation,
  counterpartySuggestions,
  outstandingGroups,
  outstandingSummary,
  overReturn,
  remainingFor,
  validateReimb,
} from "../src/reimburseLogic.js";
import { calendarCells, groupByDay, summarize, weekExpenseBars } from "../src/periodLogic.js";
import type { Transaction } from "../src/types.js";
import { account, T0, T1, T2, tx } from "./fixtures.js";

/** 立て替えた支出（5,000円のうち 2,000円） */
function lent(id: string, extra: Partial<Transaction> = {}): Transaction {
  return tx(id, { amount: 5000, reimbursement: { counterparty: "たなかさん", amount: 2000 }, ...extra });
}

/** 返金の収入 */
function back(id: string, expenseId: string, amount: number, extra: Partial<Transaction> = {}): Transaction {
  return tx(id, { type: "income", amount, categoryId: SETTLE_CATEGORY_ID, settles: { txId: expenseId }, ...extra });
}

test("立替の入力チェック：相手は必須、金額は1円以上で支出以下", () => {
  assert.equal(validateReimb("たなかさん", 2000, 5000), null);
  assert.equal(validateReimb("たなかさん", 5000, 5000), null); // 全額
  assert.match(validateReimb("  ", 2000, 5000) ?? "", /相手/);
  assert.match(validateReimb("たなかさん", null, 5000) ?? "", /金額/);
  assert.match(validateReimb("たなかさん", 0, 5000) ?? "", /金額/);
  assert.match(validateReimb("たなかさん", 5001, 5000) ?? "", /支出の金額以下/);
  assert.equal(validateReimb("たなかさん", 9999, null), null); // 支出の金額がまだ無いときは上限なし
});

test("支出をあとで立替より小さくしたら保存させない", () => {
  assert.equal(checkReimbWithin(5000, { counterparty: "たなかさん", amount: 2000 }), null);
  assert.equal(checkReimbWithin(5000, { counterparty: "たなかさん", amount: 5000 }), null);
  assert.equal(checkReimbWithin(1500, { counterparty: "たなかさん", amount: 2000 }), "立替の金額が支出より大きくなっています");
  assert.equal(checkReimbWithin(1500, null), null);
});

test("立替の残り：返金なし・一部・全額・多すぎ", () => {
  const e = lent("e1");
  assert.equal(computeAllocation([e]).remaining.get("e1"), 2000);
  assert.equal(computeAllocation([e, back("r1", "e1", 1000)]).remaining.get("e1"), 1000);
  assert.equal(computeAllocation([e, back("r1", "e1", 1000), back("r2", "e1", 1000)]).remaining.get("e1"), 0);
  assert.equal(computeAllocation([e, back("r1", "e1", 3000)]).remaining.get("e1"), 0); // 0未満は0
  assert.equal(remainingFor("e1", [e, back("r1", "e1", 1000)]), 1000);
  assert.equal(remainingFor("e1", [e, back("r1", "e1", 1000)], "r1"), 2000); // 編集中の返金自身は数えない
  assert.equal(remainingFor("nothing", [e]), null);
  assert.equal(overReturn(3000, 2000), 1000);
  assert.equal(overReturn(1000, 2000), 0);
  assert.equal(overReturn(null, 2000), 0);
});

test("返金に充てた額：複数の返金は日付の古い順に残りへ充てる（多い分は充てない）", () => {
  const e = lent("e1");
  const r1 = back("r1", "e1", 1500, { date: "2026-10-05" });
  const r2 = back("r2", "e1", 1500, { date: "2026-10-03" }); // こちらが先に充たる
  const { applied, remaining } = computeAllocation([e, r1, r2]);
  assert.equal(applied.get("r2"), 1500);
  assert.equal(applied.get("r1"), 500);
  assert.equal(remaining.get("e1"), 0);
});

test("返金を削除したら未回収に戻る（論理削除済みは数えない）", () => {
  const e = lent("e1");
  const r = back("r1", "e1", 2000);
  assert.equal(outstandingGroups([e, r]).length, 0);
  assert.equal(outstandingGroups([e, { ...r, deletedAt: T1 }]).length, 1);
  assert.equal(outstandingGroups([e, { ...r, deletedAt: T1 }])[0].remaining, 2000);
});

test("返金の分類を別のものに変えたら settles を外す（未回収に戻る）。支出に変えても外す", () => {
  const r = back("r1", "e1", 2000);
  const kept = applyReimbFields(r, null, "e1");
  assert.deepEqual(kept.settles, { txId: "e1" });
  const changed = applyReimbFields({ ...r, categoryId: "other" }, null, "e1");
  assert.equal(changed.settles, undefined);
  assert.equal(outstandingGroups([lent("e1"), changed]).length, 1);
  assert.equal(applyReimbFields({ ...r, type: "expense" }, null, "e1").settles, undefined);
  // 立替は支出だけ
  const e = applyReimbFields(tx("e2", { amount: 5000 }), { counterparty: " たなかさん ", amount: 2000 }, null);
  assert.deepEqual(e.reimbursement, { counterparty: "たなかさん", amount: 2000 });
  assert.equal(applyReimbFields({ ...e, type: "income" }, { counterparty: "x", amount: 1 }, null).reimbursement, undefined);
  assert.equal(applyReimbFields(e, null, null).reimbursement, undefined); // 立替をやめる
});

test("立て替えた支出を削除したとき：返金の settles は残り、未回収には出ず、返金は普通の収入として数える", () => {
  const e = lent("e1", { deletedAt: T1 });
  const r = back("r1", "e1", 1000);
  assert.deepEqual(r.settles, { txId: "e1" });
  assert.equal(outstandingGroups([e, r]).length, 0);
  assert.equal(computeAllocation([e, r]).applied.get("r1"), undefined);
  assert.equal(summarize([e, r]).income, 1000); // 全額が収入
});

test("未回収の一覧：相手ごと・古い順、返ってきた額と残り", () => {
  const list = [
    lent("e3", { date: "2026-10-12", content: "テスト店C", reimbursement: { counterparty: "さとうさん", amount: 700 } }),
    lent("e1", { date: "2026-10-05", content: "テスト店A" }),
    lent("e2", { date: "2026-10-10", content: "テスト店B", reimbursement: { counterparty: "たなかさん", amount: 3000 } }),
    back("r1", "e1", 500, { date: "2026-10-06" }),
    lent("e4", { date: "2026-10-01", reimbursement: { counterparty: "完了さん", amount: 100 } }),
    back("r2", "e4", 100),
    tx("plain", { date: "2026-10-02" }), // 立替ではない支出
  ];
  const groups = outstandingGroups(list);
  assert.deepEqual(groups.map((g) => g.counterparty), ["たなかさん", "さとうさん"]); // いちばん古い明細が古い順
  const tanaka = groups[0];
  assert.deepEqual(tanaka.items.map((i) => i.tx.id), ["e1", "e2"]); // 古い順
  assert.equal(tanaka.items[0].amount, 2000);
  assert.equal(tanaka.items[0].returned, 500);
  assert.equal(tanaka.items[0].remaining, 1500);
  assert.equal(tanaka.remaining, 1500 + 3000);
  assert.deepEqual(outstandingSummary(groups), { count: 3, total: 1500 + 3000 + 700 });
  // 編集中の返金は無かったことにして数える
  assert.equal(outstandingGroups(list, "r1")[0].items[0].remaining, 2000);
});

test("相手の候補：過去の立替の相手を回数の多い順（削除済みは除く）、打った文字で絞る", () => {
  const list = [
    lent("a", { reimbursement: { counterparty: "さとうさん", amount: 1 } }),
    lent("b", { reimbursement: { counterparty: "たなかさん", amount: 1 } }),
    lent("c", { reimbursement: { counterparty: "たなかさん", amount: 1 } }),
    lent("d", { reimbursement: { counterparty: "すずきさん", amount: 1 }, deletedAt: T2 }),
    tx("e"),
  ];
  assert.deepEqual(counterpartySuggestions(list), ["たなかさん", "さとうさん"]);
  assert.deepEqual(counterpartySuggestions(list, "さと"), ["さとうさん"]);
  assert.deepEqual(counterpartySuggestions(list, "たなかさん"), []); // 入力と同じものは出さない
});

test("期間の合計：立替のある支出は立替分を除く。残高は全額で動く", () => {
  const e = lent("e1");
  const plain = tx("p1", { amount: 1000 });
  const totals = summarize([e, plain]);
  assert.equal(totals.expense, 3000 + 1000);
  assert.equal(totals.total, -4000);
  const accs = [account("a1", { openingBalance: 10000 })];
  assert.equal(computeBalances(accs, [e, plain]).get("a1"), 10000 - 5000 - 1000);
});

test("期間の合計：返金は充てた額を除く（多い分だけ収入）。残高は全額で入る", () => {
  const e = lent("e1");
  const r1 = back("r1", "e1", 1000);
  const { applied } = computeAllocation([e, r1]);
  assert.equal(summarize([e, r1], undefined, applied).income, 0); // 全部が立替の返金
  const over = back("r2", "e1", 2500);
  const a2 = computeAllocation([e, over]).applied;
  assert.equal(summarize([e, over], undefined, a2).income, 500); // 多い分
  const accs = [account("a1", { openingBalance: 0 })];
  assert.equal(computeBalances(accs, [over]).get("a1"), 2500);
  // 立替と無関係の収入はそのまま
  assert.equal(summarize([tx("i1", { type: "income", amount: 700 })], undefined, a2).income, 700);
});

test("日の小計・カレンダー・週の棒にも同じ除き方が入る", () => {
  const e = lent("e1", { date: "2026-10-05" });
  const r = back("r1", "e1", 1000, { date: "2026-10-06" });
  const applied = computeAllocation([e, r]).applied;
  const days = groupByDay([e, r], undefined, applied);
  assert.equal(days.find((g) => g.date === "2026-10-05")?.expense, 3000);
  assert.equal(days.find((g) => g.date === "2026-10-06")?.income, 0);
  const cells = calendarCells("2026-10", [e, r], applied);
  assert.equal(cells.find((c) => c.date === "2026-10-05")?.expense, 3000);
  const bars = weekExpenseBars([e, r], "2026-10-05", applied);
  assert.equal(bars[0].expense, 3000);
  // 期間の外の返金・立替があっても、集まりから計算した充てた額で除ける
  const month = summarize([r], { start: "2026-10-01", end: "2026-10-31" }, applied);
  assert.equal(month.income, 0);
});

test("期間の合計：立替の金額が支出を超えるデータでも、支出はマイナスにならない", () => {
  const broken = tx("b1", { amount: 1000, reimbursement: { counterparty: "たなかさん", amount: 5000 } });
  assert.equal(summarize([broken]).expense, 0);
  assert.equal(computeAllocation([broken]).remaining.get("b1"), 0 + 1000);
  void T0;
});
