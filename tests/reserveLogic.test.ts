import assert from "node:assert/strict";
import test from "node:test";
import {
  assignWarning,
  balanceOf,
  moveHistory,
  netPayAmount,
  overflowOf,
  planSpendSync,
  reserveBalances,
  spendByTx,
  splitReserves,
  targetNote,
  totalReserveBalance,
  validateAssign,
  validateReserveDraft,
  validateRelease,
} from "../src/reserveLogic.js";
import type { Reserve, ReserveMove } from "../src/types.js";
import { T0, T1, tx } from "./fixtures.js";

const reserve = (id: string, extra: Partial<Reserve> = {}): Reserve => ({ id, createdAt: T0, updatedAt: T0, deletedAt: null, name: `テスト取り置き${id}`, ...extra });
const move = (id: string, reserveId: string, kind: ReserveMove["kind"], amount: number, date = "2026-10-05", txId?: string, extra: Partial<ReserveMove> = {}): ReserveMove => ({
  id, createdAt: T0, updatedAt: T0, deletedAt: null, reserveId, kind, amount, date, ...(txId ? { txId } : {}), ...extra,
});
let seq = 0;
const makeBase = () => ({ id: `n${++seq}`, createdAt: T1, updatedAt: T1, deletedAt: null });

test("取り置きの残高 = 入れた − 戻した − 使った(削除済みは除く)", () => {
  const moves = [
    move("a", "r1", "assign", 30000),
    move("b", "r1", "release", 5000),
    move("c", "r1", "spend", 8000, "2026-10-10", "t1"),
    move("d", "r1", "assign", 99999, "2026-10-11", undefined, { deletedAt: T1 }),
    move("e", "r2", "assign", 4000),
  ];
  const balances = reserveBalances(moves);
  assert.equal(balances.get("r1"), 17000);
  assert.equal(balances.get("r2"), 4000);
  assert.equal(balanceOf("r1", moves), 17000);
  assert.equal(balanceOf("r1", moves, "t1"), 25000); // その支出の分を無かったことにする
  assert.equal(balanceOf("r9", moves), 0);
  // 合計：削除した取り置きは数えない。閉じていても残高があれば数える
  const reserves = [reserve("r1", { closedAt: T1 }), reserve("r2"), reserve("r3", { deletedAt: T1 })];
  assert.equal(totalReserveBalance(reserves, [...moves, move("f", "r3", "assign", 1000)]), 21000);
  assert.deepEqual([...spendByTx(moves)], [["t1", 8000]]);
});

test("残高が0未満にならない数え方(取り置きごとに0未満は0)", () => {
  const moves = [move("a", "r1", "assign", 1000), move("b", "r1", "spend", 3000, "2026-10-05", "t1"), move("c", "r2", "assign", 500)];
  assert.equal(balanceOf("r1", moves), 0);
  assert.equal(totalReserveBalance([reserve("r1"), reserve("r2")], moves), 500);
});

test("入れる・戻すの入力チェック", () => {
  assert.equal(validateAssign(1), null);
  assert.ok(validateAssign(0));
  assert.ok(validateAssign(null));
  assert.equal(validateRelease(5000, 5000), null);
  assert.ok(validateRelease(5001, 5000));
  assert.ok(validateRelease(0, 5000));
  // 使える額より多く入れるときは案内を出す(入れることはできる)
  assert.equal(assignWarning(5000, 8000), null);
  assert.equal(assignWarning(12000, 8000), "入れると、使える額が−4,000円になります");
  assert.equal(assignWarning(12000, null), null);
});

test("取り置きの作成のチェック(名前・重複・目標額・使う月)", () => {
  const list = [reserve("r1", { name: "テスト旅行" }), reserve("r2", { name: "削除済み", deletedAt: T1 })];
  assert.equal(validateReserveDraft({ name: "車検", targetAmount: null, targetMonth: "" }, list), null);
  assert.equal(validateReserveDraft({ name: "車検", targetAmount: 80000, targetMonth: "2027-03" }, list), null);
  assert.ok(validateReserveDraft({ name: " ", targetAmount: null, targetMonth: "" }, list));
  assert.ok(validateReserveDraft({ name: "テスト旅行", targetAmount: null, targetMonth: "" }, list));
  assert.equal(validateReserveDraft({ name: "テスト旅行", targetAmount: null, targetMonth: "" }, list, "r1"), null);
  assert.equal(validateReserveDraft({ name: "削除済み", targetAmount: null, targetMonth: "" }, list), null);
  assert.ok(validateReserveDraft({ name: "車検", targetAmount: 0, targetMonth: "" }, list));
  assert.ok(validateReserveDraft({ name: "車検", targetAmount: null, targetMonth: "2027-13" }, list));
});

test("取り置きから払う：支出に合わせて「使った」を作る(立替を除く、残高まで)", () => {
  const moves = [move("a", "r1", "assign", 10000)];
  // 立替 1,000円を除いた 5,000円
  const t = tx("t1", { amount: 6000, reserveId: "r1", reimbursement: { counterparty: "テスト花子", amount: 1000 }, date: "2026-10-12" });
  const created = planSpendSync(t, moves, T1, makeBase);
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, "spend");
  assert.equal(created[0].amount, 5000);
  assert.equal(created[0].txId, "t1");
  assert.equal(created[0].reserveId, "r1");
  assert.equal(created[0].date, "2026-10-12");
  assert.equal(netPayAmount(6000, { amount: 1000 }), 5000);
  // 払いすぎ：残高 10,000円まで(こえた分は普通の変動費)
  const over = planSpendSync(tx("t2", { amount: 14000, reserveId: "r1" }), moves, T1, makeBase);
  assert.equal(over[0].amount, 10000);
  assert.equal(overflowOf(14000, 10000), 4000);
  assert.equal(overflowOf(8000, 10000), 0);
});

test("取り置きから払う：明細を直したら合わせて直す・外したり消したりしたら消す", () => {
  const existing = move("s1", "r1", "spend", 5000, "2026-10-12", "t1");
  const moves = [move("a", "r1", "assign", 10000), existing];
  // 同じ内容なら何も書かない
  assert.deepEqual(planSpendSync(tx("t1", { amount: 5000, reserveId: "r1", date: "2026-10-12" }), moves, T1, makeBase), []);
  // 金額を変えた：同じ出し入れを更新(残高の計算では自分の分を除くので 10,000円まで使える)
  const changed = planSpendSync(tx("t1", { amount: 7000, reserveId: "r1", date: "2026-10-12" }), moves, T1, makeBase);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, "s1");
  assert.equal(changed[0].amount, 7000);
  // 日付を変えた
  assert.equal(planSpendSync(tx("t1", { amount: 5000, reserveId: "r1", date: "2026-10-13" }), moves, T1, makeBase)[0].date, "2026-10-13");
  // 取り置きを外した・収入に変えた・削除した：論理削除
  for (const t of [tx("t1", { amount: 5000, date: "2026-10-12" }), tx("t1", { type: "income", reserveId: "r1" }), tx("t1", { reserveId: "r1", deletedAt: T1 })]) {
    const removed = planSpendSync(t, moves, T1, makeBase);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].id, "s1");
    assert.equal(removed[0].deletedAt, T1);
  }
  // 別の取り置きに付け替えた
  const moved = planSpendSync(tx("t1", { amount: 5000, reserveId: "r2", date: "2026-10-12" }), [...moves, move("b", "r2", "assign", 6000)], T1, makeBase);
  assert.equal(moved[0].reserveId, "r2");
  // 無関係な支出は何もしない
  assert.deepEqual(planSpendSync(tx("zz", { amount: 100 }), moves, T1, makeBase), []);
});

test("閉じるときの戻し・一覧の並び・履歴・目標の言葉", () => {
  const list = [
    reserve("a", { name: "あ", targetMonth: "2027-05", createdAt: T0 }),
    reserve("b", { name: "い", createdAt: T0 }),
    reserve("c", { name: "う", targetMonth: "2027-03", createdAt: T1 }),
    reserve("d", { name: "え", closedAt: T1 }),
    reserve("e", { deletedAt: T1 }),
  ];
  const { open, closed } = splitReserves(list);
  assert.deepEqual(open.map((r) => r.id), ["c", "a", "b"]); // 使う月の近い順、月なしは後ろ
  assert.deepEqual(closed.map((r) => r.id), ["d"]);
  // 閉じるとき「戻す」を選ぶと、残高ぶんの release で 0 になる
  const moves = [move("m1", "a", "assign", 12000)];
  const release = move("m2", "a", "release", balanceOf("a", moves), "2026-10-26");
  assert.equal(balanceOf("a", [...moves, release]), 0);
  // 履歴は新しい順
  const history = moveHistory("a", [move("x1", "a", "assign", 1, "2026-10-01"), move("x2", "a", "assign", 1, "2026-10-09"), move("x3", "z", "assign", 1)]);
  assert.deepEqual(history.map((m) => m.id), ["x2", "x1"]);
  assert.equal(targetNote(reserve("t", { targetAmount: 50000 }), 20000), "目標 50,000円まであと30,000円");
  assert.equal(targetNote(reserve("t", { targetAmount: 50000 }), 50000), "目標 50,000円に届いています");
  assert.equal(targetNote(reserve("t"), 100), null);
});
