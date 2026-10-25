import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRepeatEdit,
  buildRecurring,
  changeRepeatEvery,
  defaultRepeat,
  dueOccurrences,
  endRecurringToday,
  estimatedTransactions,
  isEnded,
  nextOccurrence,
  occurrencesBetween,
  planGeneration,
  recurringToRepeat,
  repeatLabel,
  ruleLabel,
  ruleShortLabel,
  scheduledDates,
  shouldClearEstimated,
  transactionFromRecurring,
  validateRepeat,
} from "../src/recurrence.js";
import type { Base, Recurring } from "../src/types.js";
import { T0, tx } from "./fixtures.js";

const template = { type: "expense" as const, amount: 80000, accountId: "a1", categoryId: "c1", content: "テスト家賃", memo: "" };

function rec(extra: Partial<Recurring> = {}): Recurring {
  return {
    id: "r1",
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    template,
    rule: { every: "month", day: 25 },
    startDate: "2026-08-25",
    holidayShift: "none",
    estimated: false,
    ...extra,
  };
}

let seq = 0;
const makeBase = (): Base => ({ id: `g${++seq}`, createdAt: T0, updatedAt: T0, deletedAt: null });
const dates = (list: Array<{ date: string }>) => list.map((o) => o.date);

test("毎月：開始日の月から、今日までに来た分", () => {
  const due = dueOccurrences(rec(), "2026-10-26");
  assert.deepEqual(dates(due), ["2026-08-25", "2026-09-25", "2026-10-25"]);
  assert.deepEqual(due.map((o) => o.scheduled), ["2026-08-25", "2026-09-25", "2026-10-25"]);
});

test("毎月：開始日より前は作らない（日が開始日より前の月は次の月から）", () => {
  const r = rec({ startDate: "2026-09-26" });
  assert.deepEqual(dates(dueOccurrences(r, "2026-11-30")), ["2026-10-25", "2026-11-25"]);
  assert.deepEqual(dates(dueOccurrences(rec({ startDate: "2026-10-25" }), "2026-10-25")), ["2026-10-25"]);
});

test("◯か月ごと：開始日の月を起点に3か月ごと", () => {
  const r = rec({ rule: { every: "nMonths", n: 3, day: 15 }, startDate: "2026-01-15" });
  assert.deepEqual(scheduledDates(r, "2026-01-01", "2026-12-31"), ["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  assert.deepEqual(scheduledDates(r, "2026-05-01", "2027-02-28"), ["2026-07-15", "2026-10-15", "2027-01-15"]);
});

test("毎年：月と日。2月29日は平年で28日", () => {
  const r = rec({ rule: { every: "year", month: 2, day: 29 }, startDate: "2024-02-29" });
  assert.deepEqual(scheduledDates(r, "2024-01-01", "2028-12-31"), ["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  const y = rec({ rule: { every: "year", month: 10, day: 5 }, startDate: "2025-10-06" });
  assert.deepEqual(scheduledDates(y, "2025-01-01", "2027-12-31"), ["2026-10-05", "2027-10-05"]);
});

test("毎週：曜日（1=月〜7=日）", () => {
  const r = rec({ rule: { every: "week", day: 1 }, startDate: "2026-10-07" }); // 水曜から始めて毎週月曜
  assert.deepEqual(scheduledDates(r, "2026-10-01", "2026-10-31"), ["2026-10-12", "2026-10-19", "2026-10-26"]);
  const sun = rec({ rule: { every: "week", day: 7 }, startDate: "2026-10-01" });
  assert.deepEqual(scheduledDates(sun, "2026-10-01", "2026-10-31"), ["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"]);
});

test("末日：短い月は月末、うるう年の2月は29日", () => {
  const r = rec({ rule: { every: "month", day: "last" }, startDate: "2027-12-31" });
  assert.deepEqual(scheduledDates(r, "2027-12-01", "2028-04-30"), ["2027-12-31", "2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]);
  const thirty = rec({ rule: { every: "month", day: 31 }, startDate: "2026-01-31" });
  assert.deepEqual(scheduledDates(thirty, "2026-01-01", "2026-04-30"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("終わりの日より後は作らない／論理削除した繰り返しは作らない", () => {
  const r = rec({ endDate: "2026-09-25" });
  assert.deepEqual(dates(dueOccurrences(r, "2026-12-31")), ["2026-08-25", "2026-09-25"]);
  assert.deepEqual(dates(dueOccurrences(rec({ endDate: "2026-09-24" }), "2026-12-31")), ["2026-08-25"]);
  assert.deepEqual(dueOccurrences(rec({ deletedAt: T0 }), "2026-12-31"), []);
  assert.equal(nextOccurrence(rec({ deletedAt: T0 }), "2026-10-26"), null);
});

test("休日の移動：明細の日付は移動後、予定日は移動前。移動後の日付が今日になるまで作らない", () => {
  const r = rec({ holidayShift: "before", startDate: "2026-10-25" }); // 10/25 は日曜 → 10/23（金）
  const occ = occurrencesBetween(r, "2026-10-01", "2026-10-31");
  assert.deepEqual(occ, [{ scheduled: "2026-10-25", date: "2026-10-23" }]);
  assert.deepEqual(dueOccurrences(r, "2026-10-22"), []);
  assert.deepEqual(dates(dueOccurrences(r, "2026-10-23")), ["2026-10-23"]);
  const after = rec({ holidayShift: "after", startDate: "2026-10-25" });
  assert.deepEqual(dates(dueOccurrences(after, "2026-10-25")), []);
  assert.deepEqual(dates(dueOccurrences(after, "2026-10-26")), ["2026-10-26"]);
});

test("generatedThrough で二重に作らない：作った分を保存し直したあとは、同じ予定を作らない", () => {
  const first = planGeneration([rec()], "2026-10-26", makeBase);
  assert.equal(first.transactions.length, 3);
  assert.equal(first.recurrings.length, 1);
  assert.equal(first.recurrings[0].generatedThrough, "2026-10-25");
  // 保存したものとして、もう一度（アプリを開き直す・画面に戻る）
  const again = planGeneration(first.recurrings, "2026-10-26", makeBase);
  assert.equal(again.transactions.length, 0);
  assert.equal(again.recurrings.length, 0);
});

test("作った明細を本人が消しても、もう一度は作らない（作り済みの記録は明細と別に持つ）", () => {
  const first = planGeneration([rec()], "2026-10-26", makeBase);
  // 明細はユーザーが消した（transactions から消えた）が、recurring の generatedThrough は残っている
  const afterDelete = planGeneration(first.recurrings, "2026-10-30", makeBase);
  assert.equal(afterDelete.transactions.length, 0);
  // 次の予定日が来たら、その分だけ作る
  const next = planGeneration(first.recurrings, "2026-11-25", makeBase);
  assert.deepEqual(dates(next.transactions), ["2026-11-25"]);
});

test("しばらく開かなかったときは、たまった分をまとめて作る／未来の日付は作らない", () => {
  const old = rec({ startDate: "2026-01-25", generatedThrough: "2026-06-25" });
  const plan = planGeneration([old], "2026-10-26", makeBase);
  assert.deepEqual(dates(plan.transactions), ["2026-07-25", "2026-08-25", "2026-09-25", "2026-10-25"]);
  assert.equal(plan.recurrings[0].generatedThrough, "2026-10-25");
  const future = planGeneration([rec({ startDate: "2026-11-25" })], "2026-10-26", makeBase);
  assert.equal(future.transactions.length, 0);
  assert.equal(future.recurrings.length, 0);
  assert.equal(planGeneration([rec({ deletedAt: T0 })], "2026-10-26", makeBase).transactions.length, 0);
});

test("作った明細：ひな形の内容、source=recurring、recurringId、見込み額なら estimated", () => {
  const r = rec({ estimated: true, holidayShift: "before", startDate: "2026-10-25" });
  const [t] = planGeneration([r], "2026-10-26", makeBase).transactions;
  assert.equal(t.source, "recurring");
  assert.equal(t.recurringId, "r1");
  assert.equal(t.estimated, true);
  assert.equal(t.date, "2026-10-23");
  assert.equal(t.type, "expense");
  assert.equal(t.amount, 80000);
  assert.equal(t.accountId, "a1");
  assert.equal(t.categoryId, "c1");
  assert.equal(t.content, "テスト家賃");
  assert.equal(t.deletedAt, null);
  const plain = transactionFromRecurring(rec(), { scheduled: "2026-10-25", date: "2026-10-25" }, makeBase());
  assert.equal("estimated" in plain, false);
});

test("次の予定：作り済みの分は数えない／終わった繰り返し", () => {
  const r = rec({ generatedThrough: "2026-10-25" });
  assert.deepEqual(nextOccurrence(r, "2026-10-26"), { scheduled: "2026-11-25", date: "2026-11-25" });
  // まだ作っていない今日の分は「次」
  assert.deepEqual(nextOccurrence(rec({ generatedThrough: "2026-09-25" }), "2026-10-25"), { scheduled: "2026-10-25", date: "2026-10-25" });
  const done = rec({ endDate: "2026-10-25", generatedThrough: "2026-10-25" });
  assert.equal(nextOccurrence(done, "2026-10-26"), null);
  assert.equal(isEnded(done, "2026-10-26"), true);
  assert.equal(isEnded(r, "2026-10-26"), false);
  assert.equal(isEnded(rec({ endDate: "2027-12-31" }), "2026-10-26"), false);
  assert.equal(endRecurringToday(r, "2026-10-26").endDate, "2026-10-26");
});

test("見込み額：金額を変えたら実額扱い（印を外す）", () => {
  assert.equal(shouldClearEstimated(12000, 12000, false), false);
  assert.equal(shouldClearEstimated(12000, 12500, false), true);
  assert.equal(shouldClearEstimated(12000, 12000, true), true);
  assert.equal(shouldClearEstimated(12000, null, false), false);
  const list = [tx("e1", { estimated: true, date: "2026-10-20" }), tx("e2", { estimated: true, date: "2026-09-20" }), tx("n1"), tx("d1", { estimated: true, deletedAt: T0 })];
  assert.deepEqual(estimatedTransactions(list).map((t) => t.id), ["e2", "e1"]);
});

test("入力の初期値と表示：毎月25日・末日・◯か月ごと・毎年・毎週", () => {
  const d = defaultRepeat("2026-10-25");
  assert.deepEqual({ every: d.every, day: d.day, shift: d.holidayShift, end: d.endDate, estimated: d.estimated }, { every: "month", day: 25, shift: "none", end: null, estimated: false });
  assert.equal(repeatLabel(d), "毎月25日");
  assert.equal(ruleLabel({ every: "month", day: "last" }), "毎月末日");
  assert.equal(ruleLabel({ every: "nMonths", n: 3, day: 5 }), "3か月ごと5日");
  assert.equal(ruleLabel({ every: "year", month: 10, day: 25 }), "毎年10月25日");
  assert.equal(ruleLabel({ every: "week", day: 1 }), "毎週月曜");
  assert.equal(ruleLabel({ every: "week", day: 7 }), "毎週日曜");
  assert.equal(ruleShortLabel({ every: "month", day: 1 }), "毎月");
  // 毎週に替えると、入力中の日付の曜日（2026-10-25 は日曜 → 7）
  assert.equal(changeRepeatEvery(d, "week", "2026-10-25").day, 7);
  assert.equal(changeRepeatEvery(d, "year", "2026-10-25").month, 10);
  assert.equal(changeRepeatEvery({ ...d, every: "week", day: 3 }, "month", "2026-10-25").day, 25);
});

test("入力の検証", () => {
  const d = defaultRepeat("2026-10-25");
  assert.equal(validateRepeat(d, "2026-10-25"), null);
  assert.match(validateRepeat({ ...d, every: "nMonths", n: 1 }, "2026-10-25") ?? "", /2〜12/);
  assert.match(validateRepeat({ ...d, every: "nMonths", n: 13 }, "2026-10-25") ?? "", /2〜12/);
  assert.equal(validateRepeat({ ...d, every: "nMonths", n: 12 }, "2026-10-25"), null);
  assert.match(validateRepeat({ ...d, day: 32 }, "2026-10-25") ?? "", /1〜31/);
  assert.equal(validateRepeat({ ...d, day: "last" }, "2026-10-25"), null);
  assert.match(validateRepeat({ ...d, every: "week", day: 8 }, "2026-10-25") ?? "", /曜日/);
  assert.match(validateRepeat({ ...d, endDate: "2026-10-24" }, "2026-10-25") ?? "", /終わりの日/);
  assert.equal(validateRepeat({ ...d, endDate: "2026-10-25" }, "2026-10-25"), null);
});

test("繰り返しの作成・編集：開始日、1回目を保存したら generatedThrough、編集は作り済みの記録を残す", () => {
  const draft = { ...defaultRepeat("2026-10-25"), holidayShift: "before" as const, endDate: "2027-03-31", estimated: true };
  const base = makeBase();
  const saved = buildRecurring(draft, { ...template, recurringId: "x", estimated: true }, "2026-10-25", base, true);
  assert.equal(saved.startDate, "2026-10-25");
  assert.equal(saved.generatedThrough, "2026-10-25");
  assert.equal(saved.endDate, "2027-03-31");
  assert.equal(saved.holidayShift, "before");
  assert.equal(saved.estimated, true);
  assert.deepEqual(saved.rule, { every: "month", day: 25 });
  assert.equal("recurringId" in saved.template, false);
  assert.equal("estimated" in saved.template, false);
  const future = buildRecurring(draft, template, "2026-12-25", makeBase(), false);
  assert.equal("generatedThrough" in future, false);
  // 編集：ルールとひな形だけ変わる
  const edited = applyRepeatEdit(saved, { ...recurringToRepeat(saved), every: "nMonths", n: 2, endDate: null }, { ...template, amount: 90000 });
  assert.deepEqual(edited.rule, { every: "nMonths", n: 2, day: 25 });
  assert.equal(edited.template.amount, 90000);
  assert.equal(edited.startDate, "2026-10-25");
  assert.equal(edited.generatedThrough, "2026-10-25");
  assert.equal("endDate" in edited, false);
});
