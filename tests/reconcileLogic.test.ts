import assert from "node:assert/strict";
import test from "node:test";
import { computeBalances } from "../src/accountLogic.js";
import {
  checkConfirm,
  checkedTotal,
  describeReconcileDiff,
  findCardTransferInMonth,
  paymentAccountOf,
  planConfirm,
  planUndo,
  reconcileDiff,
  statementHistory,
  statementItems,
  unpaidEffect,
  unreconciledOf,
} from "../src/reconcileLogic.js";
import type { Transaction } from "../src/types.js";
import { T0, account, tx } from "./fixtures.js";

const bank = account("bank", { name: "テスト銀行", group: "bank", openingBalance: 100000 });
const card = account("card", { name: "テストカード", group: "card", openingBalance: 0, card: { paymentDay: 27, holidayShift: "after", paymentAccountId: "bank" } });

let seq = 0;
const makeBase = () => ({ id: `new${++seq}`, createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z", deletedAt: null });

function spend(id: string, amount: number, date: string, extra: Partial<Transaction> = {}): Transaction {
  return tx(id, { accountId: "card", amount, date, ...extra });
}

test("未払いを動かす額：支出は＋、返金は−、残高修正は残高の逆", () => {
  assert.equal(unpaidEffect(spend("a", 1000, "2026-10-01")), 1000);
  assert.equal(unpaidEffect(spend("b", 300, "2026-10-01", { type: "income" })), -300);
  assert.equal(unpaidEffect(spend("c", -200, "2026-10-01", { type: "adjustment" })), 200); // 残高が200減る＝未払いが200増える
});

test("照合していない明細：そのカードの支出・返金・残高修正で未照合のものだけ、古い順", () => {
  const list = [
    spend("a", 100, "2026-10-05"),
    spend("b", 200, "2026-10-01"),
    spend("c", 300, "2026-10-02", { reconciledStatementId: "st0" }),
    spend("d", 400, "2026-10-03", { deletedAt: T0 }),
    tx("e", { accountId: "bank", amount: 500 }), // 別の資産
    spend("f", 600, "2026-10-04", { type: "transfer", toAccountId: "bank" }), // 振替は対象外
    spend("g", 50, "2026-10-06", { type: "income" }),
    spend("h", -70, "2026-10-07", { type: "adjustment" }),
  ];
  assert.deepEqual(unreconciledOf("card", list).map((t) => t.id), ["b", "a", "g", "h"]);
});

test("差額：請求額 − チェックした合計。0なら合っている", () => {
  const checked = [spend("a", 1000, "2026-10-01"), spend("b", 500, "2026-10-02"), spend("c", 200, "2026-10-03", { type: "income" })];
  assert.equal(checkedTotal(checked), 1300);
  assert.equal(reconcileDiff(1300, checked), 0);
  assert.equal(reconcileDiff(1500, checked), 200);
  assert.equal(describeReconcileDiff(0), "合っています");
  assert.match(describeReconcileDiff(200), /多い/);
  assert.match(describeReconcileDiff(-200), /少ない/);
});

test("確定できる条件：請求額が1円以上・明細にチェック・差額0（または残高修正にする）・引き落とし口座", () => {
  const checked = [spend("a", 1000, "2026-10-01")];
  const base = { requested: 1000, checked, adjustDiff: false, createDebit: true, paymentAccountId: "bank" };
  assert.equal(checkConfirm(base).ok, true);
  assert.equal(checkConfirm({ ...base, requested: 0 }).ok, false);
  assert.equal(checkConfirm({ ...base, checked: [] }).ok, false);
  const diff = checkConfirm({ ...base, requested: 1200 });
  assert.equal(diff.ok, false);
  assert.equal(checkConfirm({ ...base, requested: 1200, adjustDiff: true }).ok, true);
  assert.equal(checkConfirm({ ...base, paymentAccountId: null }).ok, false);
  assert.equal(checkConfirm({ ...base, paymentAccountId: null, createDebit: false }).ok, true);
});

test("確定：請求・照合済みの印・引き落としの振替を作る（差額0）", () => {
  const checked = [spend("a", 1000, "2026-10-01"), spend("b", 500, "2026-10-02")];
  const plan = planConfirm({ card, paymentDate: "2026-10-27", requested: 1500, checked, adjustDiff: false, createDebit: true, paymentAccountId: "bank", makeBase });
  assert.deepEqual(
    { c: plan.statement.cardAccountId, d: plan.statement.paymentDate, a: plan.statement.actualAmount, diff: plan.statement.diff },
    { c: "card", d: "2026-10-27", a: 1500, diff: 0 },
  );
  assert.deepEqual(plan.reconciled.map((t) => [t.id, t.reconciledStatementId === plan.statement.id]), [["a", true], ["b", true]]);
  assert.equal(plan.adjustment, undefined);
  assert.ok(plan.transfer);
  assert.deepEqual(
    { type: plan.transfer.type, from: plan.transfer.accountId, to: plan.transfer.toAccountId, amount: plan.transfer.amount, date: plan.transfer.date, content: plan.transfer.content },
    { type: "transfer", from: "bank", to: "card", amount: 1500, date: "2026-10-27", content: "カード引き落とし" },
  );
  // もとの明細は書き換えない
  assert.equal(checked[0].reconciledStatementId, undefined);
});

test("確定：振替を作らない選び（引き落としを先に記録してある場合）", () => {
  const plan = planConfirm({ card, paymentDate: "2026-10-27", requested: 1000, checked: [spend("a", 1000, "2026-10-01")], adjustDiff: false, createDebit: false, paymentAccountId: "bank", makeBase });
  assert.equal(plan.transfer, undefined);
  assert.equal(plan.statement.diff, 0);
});

test("確定：差額を残高修正にする（請求が多ければカードの残高が減る向き）と、残高が請求どおりになる", () => {
  const checked = [spend("a", 1000, "2026-10-01")];
  const plan = planConfirm({ card, paymentDate: "2026-10-27", requested: 1200, checked, adjustDiff: true, createDebit: true, paymentAccountId: "bank", makeBase });
  assert.equal(plan.statement.diff, 200);
  assert.ok(plan.adjustment);
  assert.deepEqual([plan.adjustment.type, plan.adjustment.amount, plan.adjustment.accountId, plan.adjustment.reconciledStatementId], ["adjustment", -200, "card", plan.statement.id]);
  // 残高：支出1,000 と残高修正 −200 で、カードの未払いは1,200。引き落としで銀行から1,200出て、カードは0に戻る
  const all = [...plan.reconciled, plan.adjustment, plan.transfer!];
  const balances = computeBalances([bank, card], all);
  assert.equal(balances.get("card"), 0);
  assert.equal(balances.get("bank"), 100000 - 1200);
  // 請求が少ないとき
  const less = planConfirm({ card, paymentDate: "2026-10-27", requested: 900, checked, adjustDiff: true, createDebit: false, paymentAccountId: null, makeBase });
  assert.equal(less.statement.diff, -100);
  assert.equal(less.adjustment!.amount, 100);
});

test("同じ月にカードへの振替があるか（すでにありますの表示用）", () => {
  const transfer = tx("t", { type: "transfer", accountId: "bank", toAccountId: "card", date: "2026-10-27", categoryId: undefined });
  assert.equal(findCardTransferInMonth("card", "2026-10-27", [transfer])?.id, "t");
  assert.equal(findCardTransferInMonth("card", "2026-11-27", [transfer]), undefined);
  assert.equal(findCardTransferInMonth("card", "2026-10-27", [{ ...transfer, deletedAt: T0 }]), undefined);
  assert.equal(findCardTransferInMonth("other", "2026-10-27", [transfer]), undefined);
});

test("引き落とし口座：削除済みなら使えない", () => {
  assert.equal(paymentAccountOf(card, [bank, card])?.id, "bank");
  assert.equal(paymentAccountOf(card, [{ ...bank, deletedAt: T0 }, card]), null);
});

test("履歴と取り消し：明細の印を外し、請求を論理削除する。振替は残す", () => {
  const checked = [spend("a", 1000, "2026-10-01")];
  const plan = planConfirm({ card, paymentDate: "2026-10-27", requested: 1000, checked, adjustDiff: false, createDebit: true, paymentAccountId: "bank", makeBase });
  const all = [...plan.reconciled, plan.transfer!, spend("z", 1, "2026-10-09")];
  const other = { ...plan.statement, id: "old", paymentDate: "2026-09-27" };
  const hist = statementHistory("card", [other, plan.statement, { ...plan.statement, id: "gone", deletedAt: T0 }]);
  assert.deepEqual(hist.map((s) => s.id), [plan.statement.id, "old"]); // 新しい請求日が上、取り消したものは出ない
  assert.deepEqual(statementItems(plan.statement.id, all).map((t) => t.id), ["a"]);

  const undo = planUndo(plan.statement, all, "2026-10-30T00:00:00.000Z");
  assert.equal(undo.statement.deletedAt, "2026-10-30T00:00:00.000Z");
  assert.deepEqual(undo.released.map((t) => t.id), ["a"]);
  assert.equal(undo.released[0].reconciledStatementId, undefined);
  assert.equal("reconciledStatementId" in undo.released[0], false);
  // 取り消すと、また未照合の一覧に戻る
  const after = all.map((t) => undo.released.find((r) => r.id === t.id) ?? t);
  assert.deepEqual(unreconciledOf("card", after).map((t) => t.id).sort(), ["a", "z"]);
  // 振替はそのまま
  assert.ok(after.some((t) => t.type === "transfer"));
});
