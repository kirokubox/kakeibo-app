import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGroups,
  categoryUsage,
  checkCategoryDelete,
  defaultTagModeForNew,
  isDuplicateCategoryName,
  moveToParent,
} from "../src/categoryLogic.js";
import { changedOrders, moveInOrder } from "../src/orderUtils.js";
import { category, emptyData, T1, tx } from "./fixtures.js";

function sample() {
  return [
    category("p1", { name: "食費", order: 0 }),
    category("p2", { name: "生活費", order: 1 }),
    category("c1", { parentId: "p1", name: "ごはん", order: 0 }),
    category("c2", { parentId: "p1", name: "外食", order: 1 }),
    category("c3", { parentId: "p2", name: "日用品", order: 0 }),
    category("i1", { kind: "income", name: "給与", order: 0 }),
  ];
}

test("大分類ごとに小分類をまとめる（種類で分け、削除済みは除く）", () => {
  const cats = [...sample(), category("c9", { parentId: "p1", order: 2, deletedAt: T1 })];
  const groups = buildGroups(cats, "expense");
  assert.deepEqual(groups.map((g) => g.parent.id), ["p1", "p2"]);
  assert.deepEqual(groups[0].children.map((c) => c.id), ["c1", "c2"]);
  assert.equal(buildGroups(cats, "income").length, 1);
});

test("並べ替えで order が 0 から振り直される", () => {
  const cats = [category("a", { order: 3 }), category("b", { order: 8 }), category("c", { order: 20 })];
  const moved = moveInOrder(cats, "c", "up");
  assert.ok(moved);
  assert.deepEqual(moved.map((x) => [x.id, x.order]), [["a", 0], ["c", 1], ["b", 2]]);
  assert.deepEqual(changedOrders(cats, moved).map((x) => x.id).sort(), ["a", "b", "c"]);
});

test("小分類の移動：移した先の末尾に入る。種類違い・大分類は移せない", () => {
  const cats = sample();
  const moved = moveToParent(cats, "c1", "p2");
  assert.ok(moved);
  assert.equal(moved.parentId, "p2");
  assert.equal(moved.order, 1); // p2 には c3(order 0) がある
  assert.equal(moveToParent(cats, "c1", "i1"), null);
  assert.equal(moveToParent(cats, "p1", "p2"), null);
});

test("名前の重複：同じ大分類の中だけ拒む", () => {
  const cats = sample();
  assert.equal(isDuplicateCategoryName(cats, " ごはん ", "expense", "p1"), true);
  assert.equal(isDuplicateCategoryName(cats, "ごはん", "expense", "p2"), false);
  assert.equal(isDuplicateCategoryName(cats, "ごはん", "expense", "p1", "c1"), false);
  assert.equal(isDuplicateCategoryName(cats, "食費", "expense", null), true);
  assert.equal(isDuplicateCategoryName(cats, "食費", "income", null), false);
});

test("削除：表示中の小分類がある大分類は不可。使われている分類は不可で非表示を案内", () => {
  const d = emptyData();
  const cats = sample();
  const p1 = cats[0];
  const blocked = checkCategoryDelete(p1, cats, d);
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? "" : blocked.reason, /小分類/);

  // 小分類がすべて非表示でも、論理削除されていなければ大分類は消せない
  const allHidden = cats.map((c) => (c.parentId === "p1" ? { ...c, hidden: true } : c));
  const stillBlocked = checkCategoryDelete(p1, allHidden, d);
  assert.equal(stillBlocked.ok, false);
  assert.match(stillBlocked.ok ? "" : stillBlocked.reason, /非表示の小分類も含みます/);
  // 小分類がすべて論理削除済みなら消せる
  const allGone = cats.map((c) => (c.parentId === "p1" ? { ...c, deletedAt: T1 } : c));
  assert.equal(checkCategoryDelete(p1, allGone, d).ok, true);

  d.transactions = [tx("t1", { categoryId: "c1" })];
  const used = checkCategoryDelete(cats[2], cats, d);
  assert.equal(used.ok, false);
  assert.equal(used.ok ? false : used.suggestHide, true);
  assert.equal(checkCategoryDelete(cats[3], cats, d).ok, true);
});

test("使用中の数え方：取引・繰り返し・よく使う入力・給料明細。論理削除済みは数えない", () => {
  const d = emptyData();
  d.transactions = [tx("t1", { categoryId: "c1" }), tx("t2", { categoryId: "c1", deletedAt: T1 })];
  const template = { type: "expense" as const, amount: 1, accountId: "a1", categoryId: "c1", content: "", memo: "" };
  d.recurrings = [{ id: "r", createdAt: "", updatedAt: "", deletedAt: null, template, rule: { every: "month", day: 1 }, startDate: "2026-10-01", holidayShift: "none", estimated: false }];
  d.favorites = [{ id: "f", createdAt: "", updatedAt: "", deletedAt: T1, template, order: 0 }];
  d.payrolls = [{ id: "p", createdAt: "", updatedAt: "", deletedAt: null, name: "給与", accountId: "a1", day: 25, holidayShift: "none", lines: [{ lineId: "l1", kind: "pay", categoryId: "c1", label: "基本給", amount: 1 }] }];
  assert.equal(categoryUsage("c1", d), 3);
  assert.equal(categoryUsage("c2", d), 0);
});

test("新しい小分類のタグ：支出は日常が初期値、収入はなし", () => {
  assert.equal(defaultTagModeForNew("expense"), "defaultDaily");
  assert.equal(defaultTagModeForNew("income"), "none");
});
