import assert from "node:assert/strict";
import test from "node:test";
import {
  doneCandidates,
  isPlannedDone,
  linkedOpenReserve,
  markPlannedDone,
  planSetAside,
  plannedCommitted,
  plannedNotesByReserve,
  plannedStartsBy,
  plannedStatuses,
  reopenPlanned,
  reserveNameForPlanned,
  sortPlanned,
  validatePlannedDraft,
} from "../src/plannedLogic.js";
import { validateReserveDraft } from "../src/reserveLogic.js";
import type { PlannedExpense, Reserve } from "../src/types.js";
import { T0, T1, tx } from "./fixtures.js";

function planned(id: string, month: string, amount: number, extra: Partial<PlannedExpense> = {}): PlannedExpense {
  return { id, createdAt: T0, updatedAt: T0, deletedAt: null, name: `テスト予定${id}`, month, amount, ...extra };
}

test("予定出費の入力チェック", () => {
  assert.equal(validatePlannedDraft({ name: "車検", month: "2027-03", amount: 90000 }), null);
  assert.ok(validatePlannedDraft({ name: "", month: "2027-03", amount: 90000 }));
  assert.ok(validatePlannedDraft({ name: "車検", month: "2027-3", amount: 90000 }));
  assert.ok(validatePlannedDraft({ name: "車検", month: "2027-03", amount: 0 }));
  assert.ok(validatePlannedDraft({ name: "車検", month: "2027-03", amount: null }));
});

test("取り置き済み・足りない額(結んだ取り置きの残高まで)", () => {
  const list = [planned("p1", "2026-11", 40000, { reserveId: "r1" }), planned("p2", "2026-12", 10000), planned("p3", "2026-11", 5000, { reserveId: "r9" })];
  const st = plannedStatuses(list, new Map([["r1", 15000]]));
  assert.deepEqual(st.get("p1"), { covered: 15000, shortfall: 25000 });
  assert.deepEqual(st.get("p2"), { covered: 0, shortfall: 10000 }); // 取り置きなし
  assert.deepEqual(st.get("p3"), { covered: 0, shortfall: 5000 }); // 残高のない取り置き
  // 残高が予定より多ければ足りない額は 0
  assert.deepEqual(plannedStatuses([planned("p1", "2026-11", 8000, { reserveId: "r1" })], new Map([["r1", 15000]])).get("p1"), { covered: 8000, shortfall: 0 });
});

test("同じ取り置きに結んだ予定出費は、月の古い順に残高を充てる(二重に数えない)", () => {
  const list = [planned("late", "2026-12", 10000, { reserveId: "r1" }), planned("early", "2026-11", 10000, { reserveId: "r1" })];
  const st = plannedStatuses(list, new Map([["r1", 15000]]));
  assert.deepEqual(st.get("early"), { covered: 10000, shortfall: 0 });
  assert.deepEqual(st.get("late"), { covered: 5000, shortfall: 5000 });
});

test("済みは数えない・削除したものも数えない", () => {
  const list = [planned("p1", "2026-11", 40000, { doneAt: T1 }), planned("p2", "2026-11", 6000, { deletedAt: T1 }), planned("p3", "2026-11", 7000)];
  const st = plannedStatuses(list, new Map());
  assert.equal(st.has("p1"), false);
  assert.equal(st.has("p2"), false);
  assert.equal(isPlannedDone(list[0]), true);
  assert.equal(isPlannedDone(list[2]), false);
  assert.equal(plannedCommitted(list, st, "2026-11-24"), 7000);
});

test("決まった出費に入れる月：月の1日が給料日の前日以前(過ぎてしまった月も入る)", () => {
  const list = [planned("oct", "2026-10", 1000), planned("nov", "2026-11", 2000), planned("dec", "2026-12", 4000)];
  const st = plannedStatuses(list, new Map());
  // 次の給料日が 11/25 → 前日 11/24 まで
  assert.equal(plannedStartsBy(list[1], "2026-11-24"), true);
  assert.equal(plannedStartsBy(list[2], "2026-11-24"), false);
  assert.equal(plannedCommitted(list, st, "2026-11-24"), 3000);
  assert.equal(plannedCommitted(list, st, "2026-12-24"), 7000);
  // 取り置き済みの分は引く
  const linked = [planned("nov", "2026-11", 2000, { reserveId: "r1" })];
  assert.equal(plannedCommitted(linked, plannedStatuses(linked, new Map([["r1", 1500]])), "2026-11-24"), 500);
});

test("済みにする：明細を選ぶ・明細なし・取り消し。候補はその月の支出で、同じ取り置きで払ったものが先頭", () => {
  const p = planned("p1", "2026-11", 40000, { reserveId: "r1" });
  const other = planned("p2", "2026-11", 5000, { doneTxId: "used" });
  const txs = [
    tx("a", { date: "2026-11-02" }),
    tx("b", { date: "2026-11-20", reserveId: "r1" }),
    tx("c", { date: "2026-10-30" }), // 別の月
    tx("d", { date: "2026-11-05", type: "income" }), // 収入は候補にしない
    tx("used", { date: "2026-11-03" }), // ほかの予定出費で使い済み
    tx("e", { date: "2026-11-09", deletedAt: T1 }),
  ];
  assert.deepEqual(doneCandidates(p, txs, [p, other]).map((t) => t.id), ["b", "a"]);
  const done = markPlannedDone(p, "b", T1);
  assert.equal(done.doneAt, T1);
  assert.equal(done.doneTxId, "b");
  const noTx = markPlannedDone(done, null, T1);
  assert.equal(noTx.doneAt, T1);
  assert.equal(noTx.doneTxId, undefined);
  assert.equal("doneTxId" in noTx, false);
  const reopened = reopenPlanned(done);
  assert.equal(isPlannedDone(reopened), false);
  assert.equal("doneTxId" in reopened, false);
});

test("並び順は月、同じ月は作った順", () => {
  const list = [planned("z", "2026-12", 1), planned("b", "2026-11", 1, { createdAt: T1 }), planned("a", "2026-11", 1)];
  assert.deepEqual(sortPlanned(list).map((p) => p.id), ["a", "b", "z"]);
});

const reserve = (id: string, name: string, extra: Partial<Reserve> = {}): Reserve => ({ id, createdAt: T0, updatedAt: T0, deletedAt: null, name, ...extra });
const base = { id: "new-reserve", createdAt: T1, updatedAt: T1, deletedAt: null };

test("予定出費から取り置きを作る：名前＝予定の名前・目標額＝予定の金額・使う月＝予定の月。予定に結ぶ", () => {
  const p = { ...planned("p1", "2027-01", 60000), name: "テスト帰省" };
  const plan = planSetAside(p, [], base);
  assert.equal(plan.kind, "create");
  if (plan.kind !== "create") return;
  assert.equal(plan.reserve.id, "new-reserve");
  assert.equal(plan.reserve.name, "テスト帰省");
  assert.equal(plan.reserve.targetAmount, 60000);
  assert.equal(plan.reserve.targetMonth, "2027-01");
  assert.equal(plan.reserve.deletedAt, null);
  assert.equal(plan.planned.reserveId, "new-reserve");
  assert.equal(plan.planned.id, "p1");
  assert.equal(p.reserveId, undefined); // 元の予定出費は書き換えない
  // 作った取り置きは、取り置きの入力チェックを通る
  assert.equal(validateReserveDraft({ name: plan.reserve.name, targetAmount: plan.reserve.targetAmount ?? null, targetMonth: plan.reserve.targetMonth ?? "" }, []), null);
});

test("予定出費から取り置き：結んであれば、新しく作らずその取り置きの「入れる」を開くだけ", () => {
  const r = reserve("r1", "テスト旅行");
  const p = planned("p1", "2027-03", 90000, { reserveId: "r1" });
  const plan = planSetAside(p, [r], base);
  assert.equal(plan.kind, "existing");
  if (plan.kind === "existing") assert.equal(plan.reserve.id, "r1");
  assert.equal(linkedOpenReserve(p, [r])?.id, "r1");
  // 結び先が削除済み・閉じている・見つからないときは、新しく作って結び直す
  for (const gone of [reserve("r1", "x", { deletedAt: T1 }), reserve("r1", "x", { closedAt: T1 })]) {
    assert.equal(linkedOpenReserve(p, [gone]), undefined);
    assert.equal(planSetAside(p, [gone], base).kind, "create");
  }
  assert.equal(planSetAside(p, [], base).kind, "create");
  assert.equal(linkedOpenReserve(planned("p2", "2027-03", 1), [r]), undefined);
});

test("予定出費から取り置き：同じ名前の取り置きがあるときは名前を変える(取り置きの名前は重ならない)", () => {
  const p = { ...planned("p1", "2027-01", 60000), name: "テスト帰省" };
  assert.equal(reserveNameForPlanned(p, [reserve("r1", "別の名前")]), "テスト帰省");
  assert.equal(reserveNameForPlanned(p, [reserve("r1", "テスト帰省")]), "テスト帰省（2027-01）");
  assert.equal(reserveNameForPlanned(p, [reserve("r1", "テスト帰省"), reserve("r2", "テスト帰省（2027-01）")]), "テスト帰省（2027-01）2");
  assert.equal(reserveNameForPlanned(p, [reserve("r1", "テスト帰省", { deletedAt: T1 })]), "テスト帰省"); // 削除済みは数えない
  const plan = planSetAside(p, [reserve("r1", "テスト帰省")], base);
  assert.equal(plan.kind === "create" ? plan.reserve.name : "", "テスト帰省（2027-01）");
});

test("取り置きの一覧・詳細に出す「予定：帰省 2027-01」(結んでいる予定出費の名前と月)", () => {
  const list = [
    { ...planned("p1", "2027-03", 1, { reserveId: "r1" }), name: "テスト車検" },
    { ...planned("p2", "2027-01", 1, { reserveId: "r1" }), name: "テスト帰省" },
    { ...planned("p3", "2027-02", 1, { reserveId: "r2", doneAt: T0 }), name: "済み" }, // 済みは出さない
    { ...planned("p4", "2027-02", 1, { reserveId: "r2", deletedAt: T0 }), name: "削除済み" },
    { ...planned("p5", "2027-02", 1), name: "結んでいない" },
  ];
  const notes = plannedNotesByReserve(list);
  assert.equal(notes.get("r1"), "予定：テスト帰省 2027-01、テスト車検 2027-03"); // 月の順
  assert.equal(notes.has("r2"), false);
  assert.equal(notes.size, 1);
});
