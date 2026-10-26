import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYROLL_KIND_LABELS,
  SETTLEMENT_NOTE,
  addLineLabel,
  batchTransactions,
  blankLine,
  blankPayroll,
  entryDraftFromBatch,
  lineInitialAmount,
  moveLine,
  newEntryDraft,
  nextLastAmounts,
  payrollTotals,
  planPayrollSave,
  validateEntryDraft,
  validatePayroll,
} from "../src/payrollLogic.js";
import type { Base, Payroll } from "../src/types.js";
import { category, T0 } from "./fixtures.js";

const payroll: Payroll = {
  id: "p1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト商事", accountId: "bank", day: 25, holidayShift: "before",
  lines: [
    { lineId: "l1", kind: "pay", categoryId: "salary", label: "基本給", amount: 200000 },
    { lineId: "l2", kind: "pay", categoryId: "salary", label: "通勤費", amount: 10000 },
    { lineId: "l3", kind: "deduction", categoryId: "tax", label: "所得税", amount: 8000 },
    { lineId: "l4", kind: "deduction", categoryId: "fixed", label: "天引き", amount: 2000 },
    { lineId: "l5", kind: "settlement", accountId: "badge", label: "社員食堂", amount: 5000 },
  ],
};
const categories = [
  category("salary", { kind: "income", parentId: "inc", tagMode: "none" }),
  category("tax", { parentId: "exp", tagMode: "none" }),
  category("fixed", { parentId: "exp", tagMode: "defaultDaily" }),
];

let seq = 0;
const makeBase = (): Base => ({ id: `n${++seq}`, createdAt: T0, updatedAt: T0, deletedAt: null });
const NOW = "2026-10-26T00:00:00.000Z";

function plan(draft = newEntryDraft(payroll, "2026-10-26"), existing: Parameters<typeof planPayrollSave>[0]["existing"] = []) {
  return planPayrollSave({ payroll, draft, batchId: "b1", categories, existing, now: NOW, makeBase });
}

test("手取りの計算：支給 − 控除 − 精算", () => {
  const t = payrollTotals(payroll.lines);
  assert.deepEqual(t, { pay: 210000, deduction: 10000, settlement: 5000, takeHome: 195000 });
  // チェックを外した行は数えない
  const lines = payroll.lines.map((l) => ({ kind: l.kind, amount: l.amount, enabled: l.lineId !== "l2" }));
  assert.equal(payrollTotals(lines).takeHome, 185000);
  assert.deepEqual(payrollTotals([]), { pay: 0, deduction: 0, settlement: 0, takeHome: 0 });
});

test("毎月の入力の初期値：日付は今月の支給日（休日の移動後）、金額は前回の金額（なければひな形の金額）", () => {
  const first = newEntryDraft(payroll, "2026-10-26");
  assert.equal(first.date, "2026-10-23"); // 10/25 は日曜 → 前の平日
  assert.deepEqual(first.lines.map((l) => l.amount), [200000, 10000, 8000, 2000, 5000]);
  assert.equal(first.saveToTemplate, true);
  assert.ok(first.lines.every((l) => l.enabled && !l.extra));
  const withLast = { ...payroll, lastAmounts: { l2: 12500, l5: 6200 } };
  assert.deepEqual(newEntryDraft(withLast, "2026-11-10").lines.map((l) => l.amount), [200000, 12500, 8000, 2000, 6200]);
  assert.equal(newEntryDraft(withLast, "2026-11-10").date, "2026-11-25");
  assert.equal(lineInitialAmount(withLast, withLast.lines[0]), 200000);
});

test("明細への変換：支給→収入、控除→支出、精算→振替。全部に payrollId と同じ payrollBatchId", () => {
  const { creates, updates, deletes } = plan();
  assert.equal(creates.length, 5);
  assert.equal(updates.length, 0);
  assert.equal(deletes.length, 0);
  const [pay1, pay2, ded1, ded2, settle] = creates;
  assert.deepEqual([pay1.type, pay1.categoryId, pay1.amount, pay1.accountId, pay1.content, pay1.memo, pay1.date], ["income", "salary", 200000, "bank", "テスト商事", "基本給", "2026-10-23"]);
  assert.equal(pay2.memo, "通勤費");
  assert.deepEqual([ded1.type, ded1.categoryId, ded1.amount, ded1.accountId], ["expense", "tax", 8000, "bank"]);
  assert.equal(ded1.tag, undefined); // タグなしの分類は空
  assert.equal(ded2.tag, "daily"); // 日常が初期値の分類は日常
  assert.deepEqual([settle.type, settle.accountId, settle.toAccountId, settle.amount, settle.memo, settle.categoryId], ["transfer", "bank", "badge", 5000, "社員食堂", undefined]);
  for (const t of creates) {
    assert.equal(t.payrollId, "p1");
    assert.equal(t.payrollBatchId, "b1");
    assert.equal(t.source, "manual");
    assert.equal(t.deletedAt, null);
  }
  assert.equal(new Set(creates.map((t) => t.id)).size, 5);
});

test("金額0の行・チェックを外した行は明細を作らない", () => {
  const d = newEntryDraft(payroll, "2026-10-26");
  d.lines[1].amount = 0;
  d.lines[3].enabled = false;
  const { creates } = plan(d);
  assert.deepEqual(creates.map((t) => t.memo), ["基本給", "所得税", "社員食堂"]);
});

test("入金額：入金する資産は手取り分だけ増え、精算の資産の残高が戻る", () => {
  const { creates } = plan();
  // 収入 +210000、支出 −10000、振替 −5000（bank）→ bank は手取り分
  let bank = 0;
  let badge = 0;
  for (const t of creates) {
    if (t.type === "income") bank += t.amount;
    else if (t.type === "expense") bank -= t.amount;
    else {
      bank -= t.amount;
      badge += t.amount;
    }
  }
  assert.equal(bank, payrollTotals(payroll.lines).takeHome);
  assert.equal(badge, 5000);
});

test("前回の金額をひな形に残す：チェックがあれば残す、その月だけの行は残さない", () => {
  const d = newEntryDraft(payroll, "2026-10-26");
  d.lines[1].amount = 11111;
  d.lines.push({ lineId: "x1", kind: "pay", categoryId: "salary", accountId: null, label: "臨時手当", amount: 30000, enabled: true, extra: true });
  const next = nextLastAmounts(payroll, d);
  assert.equal(next.l2, 11111);
  assert.equal("x1" in next, false);
  assert.equal(next.l1, 200000);
  const off = { ...d, saveToTemplate: false };
  assert.deepEqual(nextLastAmounts({ ...payroll, lastAmounts: { l1: 1 } }, off), { l1: 1 });
  // チェックを外した行の前回の金額は残る
  const disabled = newEntryDraft({ ...payroll, lastAmounts: { l2: 9000 } }, "2026-10-26");
  disabled.lines[1].enabled = false;
  assert.equal(nextLastAmounts({ ...payroll, lastAmounts: { l2: 9000 } }, disabled).l2, 9000);
});

test("あとから直す：1枚の明細から入力を作り直せる（消した行はチェックを外した行になる）", () => {
  const d = newEntryDraft(payroll, "2026-10-26");
  d.lines[3].amount = 0; // 天引きは0円 → 明細なし
  const saved = plan(d).creates;
  assert.equal(saved.length, 4);
  const back = entryDraftFromBatch(payroll, saved, () => "extra-id", "2026-10-26");
  assert.equal(back.date, "2026-10-23");
  assert.deepEqual(back.lines.map((l) => [l.lineId, l.enabled, l.amount]), [
    ["l1", true, 200000],
    ["l2", true, 10000],
    ["l3", true, 8000],
    ["l4", false, 2000],
    ["l5", true, 5000],
  ]);
  assert.deepEqual(back.lines.map((l) => l.txId === undefined), [false, false, false, true, false]);
  assert.equal(back.saveToTemplate, false);
});

test("まとめて直したときの差分：変更→更新、足した→作成、消した・0円→論理削除、変えない行は触らない", () => {
  const original = plan().creates;
  const draft = entryDraftFromBatch(payroll, original, () => "extra-id", "2026-10-26");
  // 変更：通勤費 10000 → 12000
  draft.lines[1].amount = 12000;
  // 削除：所得税のチェックを外す
  draft.lines[2].enabled = false;
  // 削除：天引きを0円にする
  draft.lines[3].amount = 0;
  // 追加：その月だけの手当
  draft.lines.push({ lineId: "x1", kind: "pay", categoryId: "salary", accountId: null, label: "臨時手当", amount: 30000, enabled: true, extra: true });
  const diff = planPayrollSave({ payroll, draft, batchId: "b1", categories, existing: original, now: NOW, makeBase });
  assert.deepEqual(diff.updates.map((t) => [t.memo, t.amount]), [["通勤費", 12000]]);
  assert.equal(diff.updates[0].id, original[1].id); // 同じ明細を更新
  assert.equal(diff.updates[0].createdAt, original[1].createdAt);
  assert.deepEqual(diff.creates.map((t) => [t.memo, t.amount, t.type]), [["臨時手当", 30000, "income"]]);
  assert.equal(diff.creates[0].payrollBatchId, "b1");
  assert.deepEqual(diff.deletes.map((t) => t.memo).sort(), ["天引き", "所得税"]);
  assert.ok(diff.deletes.every((t) => t.deletedAt === NOW && t.updatedAt === NOW));
  // 基本給・社員食堂は変えていないので触らない
  const touched = new Set([...diff.updates, ...diff.deletes].map((t) => t.id));
  assert.equal(touched.has(original[0].id), false);
  assert.equal(touched.has(original[4].id), false);
});

test("日付を変えたら、残る明細すべてを更新。行ごと消した明細は論理削除", () => {
  const original = plan().creates;
  const draft = entryDraftFromBatch(payroll, original, () => "extra-id", "2026-10-26");
  draft.date = "2026-10-22";
  draft.lines = draft.lines.filter((l) => l.lineId !== "l5");
  const diff = planPayrollSave({ payroll, draft, batchId: "b1", categories, existing: original, now: NOW, makeBase });
  assert.equal(diff.updates.length, 4);
  assert.ok(diff.updates.every((t) => t.date === "2026-10-22"));
  assert.deepEqual(diff.deletes.map((t) => t.memo), ["社員食堂"]);
});

test("同じ1枚の明細を集める（論理削除は除く）", () => {
  const original = plan().creates;
  const other = { ...original[0], id: "zz", payrollBatchId: "b2" };
  const deleted = { ...original[1], deletedAt: NOW };
  assert.deepEqual(batchTransactions([original[0], deleted, ...original.slice(2), other], "b1").map((t) => t.id), [original[0].id, ...original.slice(2).map((t) => t.id)]);
});

test("ひな形の行の並べ替え（同じ種類の中で↑↓）", () => {
  const up = moveLine(payroll.lines, "l2", "up");
  assert.deepEqual(up?.map((l) => l.lineId), ["l2", "l1", "l3", "l4", "l5"]);
  assert.equal(moveLine(payroll.lines, "l1", "up"), null);
  // 支給の最後の行は、控除の行とは入れ替えない
  assert.equal(moveLine(payroll.lines, "l2", "down"), null);
  assert.deepEqual(moveLine(payroll.lines, "l3", "down")?.map((l) => l.lineId), ["l1", "l2", "l4", "l3", "l5"]);
});

test("入力チェック", () => {
  assert.equal(validatePayroll(payroll), null);
  assert.match(validatePayroll({ ...payroll, name: " " }) ?? "", /名前/);
  assert.match(validatePayroll({ ...payroll, accountId: "" }) ?? "", /入金する資産/);
  assert.match(validatePayroll({ ...payroll, day: 0 }) ?? "", /支給日/);
  assert.match(validatePayroll({ ...payroll, lines: [blankLine("pay", "z")] }) ?? "", /分類/);
  assert.match(validatePayroll({ ...payroll, lines: [blankLine("settlement", "z")] }) ?? "", /資産/);
  assert.match(validatePayroll({ ...payroll, lines: [{ lineId: "z", kind: "pay", categoryId: "salary", label: "", amount: -1 }] }) ?? "", /金額/);
  const blank = blankPayroll({ id: "p9", createdAt: T0, updatedAt: T0, deletedAt: null }, 25, "before");
  assert.deepEqual([blank.day, blank.holidayShift, blank.lines.length, blank.name], [25, "before", 0, ""]);

  const d = newEntryDraft(payroll, "2026-10-26");
  assert.equal(validateEntryDraft(d), null);
  d.lines.push({ lineId: "x1", kind: "deduction", categoryId: null, accountId: null, label: "その他", amount: 100, enabled: true, extra: true });
  assert.match(validateEntryDraft(d) ?? "", /分類/);
  d.lines[5].amount = 0; // 0円の行は作らないので、行き先が空でもよい
  assert.equal(validateEntryDraft(d), null);
});

test("画面の言葉：精算の行は「天引きで払う後払い」。内部の種類(settlement)は変えない", () => {
  assert.equal(PAYROLL_KIND_LABELS.settlement, "天引きで払う後払い");
  assert.equal(PAYROLL_KIND_LABELS.pay, "支給");
  assert.equal(PAYROLL_KIND_LABELS.deduction, "控除");
  assert.equal(addLineLabel("settlement"), "＋ 天引きで払う後払いを追加");
  assert.equal(addLineLabel("pay"), "＋ 支給の行を追加");
  assert.equal(addLineLabel("deduction"), "＋ 控除の行を追加");
  assert.match(SETTLEMENT_NOTE, /給料から天引きで払う分/);
  assert.match(SETTLEMENT_NOTE, /社員証の残高が戻ります/);
  assert.match(SETTLEMENT_NOTE, /支出には数えません/);
  // 保存の形は変わらない
  const line = blankLine("settlement", "x");
  assert.equal(line.kind, "settlement");
  // 入力チェックの文章にも新しい言葉が出る
  const p = blankPayroll({ id: "p", createdAt: T0, updatedAt: T0, deletedAt: null }, 25, "before");
  assert.equal(validatePayroll({ ...p, name: "テスト", accountId: "a", lines: [line] }), "天引きで払う後払いの資産を選んでください");
});
