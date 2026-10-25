import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/periodLogic.js";
import { computeAllocation } from "../src/reimburseLogic.js";
import {
  buildSearchIndex,
  emptyFilter,
  filterChips,
  hasAnyCondition,
  normalizeText,
  removeFilter,
  searchTerms,
  searchTotals,
  searchTransactions,
} from "../src/searchLogic.js";
import type { SearchFilter } from "../src/searchLogic.js";
import type { Category, Transaction } from "../src/types.js";
import { account, category, tx } from "./fixtures.js";

const TODAY = "2026-10-26";
const cats: Category[] = [
  category("p1", { name: "食費" }),
  category("c1", { parentId: "p1", name: "ごはん" }),
  category("c2", { parentId: "p1", name: "外食" }),
  category("p2", { name: "趣味", order: 1 }),
  category("c3", { parentId: "p2", name: "本" }),
];

function search(list: Transaction[], patch: Partial<SearchFilter>): string[] {
  const f = { ...emptyFilter(), ...patch };
  return searchTransactions(buildSearchIndex(list), f, cats, TODAY)
    .map((t) => t.id)
    .sort();
}

test("正規化：全角半角の英数字・大文字小文字・カタカナとひらがな・半角カナを区別しない", () => {
  assert.equal(normalizeText("ＡＢＣ１２３"), normalizeText("abc123"));
  assert.equal(normalizeText("テストマンガ"), normalizeText("てすとまんが"));
  assert.equal(normalizeText("ｶﾀｶﾅ"), "かたかな");
  assert.equal(normalizeText("ＤＶＤ　ｂｏｘ"), "dvd box");
});

test("語の分け方：空白（全角も）で区切り、空は無視", () => {
  assert.deepEqual(searchTerms("  てすと　12  "), ["てすと", "12"]);
  assert.deepEqual(searchTerms("   "), []);
});

test("文字の検索：内容・メモ・立替の相手を対象に、空白区切りはすべて含む", () => {
  const list = [
    tx("a", { content: "テスト書店", memo: "テストマンガ 12巻" }),
    tx("b", { content: "テスト書店", memo: "テストマンガ 13巻" }),
    tx("c", { content: "別の店", memo: "", reimbursement: { counterparty: "さくらさん", amount: 100 } }),
  ];
  assert.deepEqual(search(list, { text: "てすとまんが １２" }), ["a"]); // かな・全角半角の違いを区別しない
  assert.deepEqual(search(list, { text: "ＴＥＳＴ" }), []); // 英字は含まれない
  assert.deepEqual(search(list, { text: "テスト書店" }), ["a", "b"]);
  assert.deepEqual(search(list, { text: "サクラ" }), ["c"]); // 立替の相手
  assert.deepEqual(search(list, { text: "" }), ["a", "b", "c"]); // 文字が空なら絞らない
});

test("論理削除済みは検索に出ない", () => {
  const list = [tx("a"), tx("b", { deletedAt: "2026-10-02T00:00:00.000Z" })];
  assert.deepEqual(search(list, {}), ["a"]);
});

test("期間：今年・去年・任意（片方だけでもよい）", () => {
  const list = [tx("a", { date: "2026-03-01" }), tx("b", { date: "2025-12-31" }), tx("c", { date: "2024-05-05" })];
  assert.deepEqual(search(list, { period: "thisYear" }), ["a"]);
  assert.deepEqual(search(list, { period: "lastYear" }), ["b"]);
  assert.deepEqual(search(list, { period: "custom", customStart: "2025-01-01", customEnd: "" }), ["a", "b"]);
  assert.deepEqual(search(list, { period: "custom", customStart: "2024-01-01", customEnd: "2024-12-31" }), ["c"]);
});

test("資産：出金側にも入金側にも当たる（複数選べる）", () => {
  const list = [
    tx("a", { accountId: "a1" }),
    tx("b", { accountId: "a2" }),
    tx("t", { type: "transfer", accountId: "a1", toAccountId: "a3", categoryId: undefined }),
  ];
  assert.deepEqual(search(list, { accountIds: ["a3"] }), ["t"]);
  assert.deepEqual(search(list, { accountIds: ["a2", "a3"] }), ["b", "t"]);
});

test("分類：大分類を選ぶと下の小分類すべて、小分類だけも選べる", () => {
  const list = [tx("a", { categoryId: "c1" }), tx("b", { categoryId: "c2" }), tx("c", { categoryId: "c3" }), tx("d", { type: "transfer", categoryId: undefined })];
  assert.deepEqual(search(list, { categoryIds: ["p1"] }), ["a", "b"]);
  assert.deepEqual(search(list, { categoryIds: ["c2"] }), ["b"]);
  assert.deepEqual(search(list, { categoryIds: ["c1", "p2"] }), ["a", "c"]);
});

test("金額の範囲：下限・上限（含む）。残高修正は絶対値で見る", () => {
  const list = [tx("a", { amount: 100 }), tx("b", { amount: 500 }), tx("c", { amount: 900 }), tx("d", { type: "adjustment", amount: -500 })];
  assert.deepEqual(search(list, { amountMin: 500 }), ["b", "c", "d"]);
  assert.deepEqual(search(list, { amountMax: 500 }), ["a", "b", "d"]);
  assert.deepEqual(search(list, { amountMin: 200, amountMax: 600 }), ["b", "d"]);
});

test("タグ（日常・満足・反省・なし）と種類", () => {
  const list = [tx("a", { tag: "daily" }), tx("b", { tag: "satisfied" }), tx("c", { tag: "regret" }), tx("d"), tx("e", { type: "income" })];
  assert.deepEqual(search(list, { tags: ["satisfied", "regret"] }), ["b", "c"]);
  assert.deepEqual(search(list, { tags: ["none"], types: ["expense"] }), ["d"]);
  assert.deepEqual(search(list, { types: ["income"] }), ["e"]);
});

test("条件はすべて満たすものだけ（文字×期間×資産）", () => {
  const list = [
    tx("a", { content: "テスト喫茶", date: "2026-05-01", accountId: "a1" }),
    tx("b", { content: "テスト喫茶", date: "2025-05-01", accountId: "a1" }),
    tx("c", { content: "テスト喫茶", date: "2026-05-01", accountId: "a2" }),
  ];
  assert.deepEqual(search(list, { text: "喫茶", period: "thisYear", accountIds: ["a1"] }), ["a"]);
});

test("結果の合計：明細タブと同じ数え方（立替を除く・返金は充てた額を除く・振替と残高修正は数えない）", () => {
  const list: Transaction[] = [
    tx("e1", { amount: 5000, reimbursement: { counterparty: "テスト花子", amount: 2000 } }), // 支出 3,000
    tx("e2", { amount: 1000 }),
    tx("r1", { type: "income", amount: 2500, settles: { txId: "e1" } }), // 充てた 2,000 を除いて収入 500
    tx("i1", { type: "income", amount: 10000 }),
    tx("t1", { type: "transfer", categoryId: undefined, amount: 7000 }),
    tx("j1", { type: "adjustment", amount: -300 }),
  ];
  const { applied } = computeAllocation(list);
  const totals = searchTotals(list, applied);
  assert.equal(totals.count, 6);
  assert.equal(totals.expense, 4000);
  assert.equal(totals.income, 10500);
  assert.equal(totals.total, 6500);
  assert.deepEqual({ income: totals.income, expense: totals.expense, total: totals.total }, summarize(list, undefined, applied));
});

test("選んだ絞り込みの表示と、×で外す", () => {
  const accounts = [account("a1", { name: "テスト財布" })];
  let f: SearchFilter = { ...emptyFilter(), text: "x", period: "thisYear", accountIds: ["a1"], categoryIds: ["c1"], amountMin: 100, tags: ["none"], types: ["expense"] };
  const chips = filterChips(f, accounts, cats, TODAY);
  assert.deepEqual(
    chips.map((c) => c.label),
    ["今年", "テスト財布", "食費/ごはん", "100円以上", "タグなし", "支出"],
  );
  for (const c of chips) f = removeFilter(f, c.key);
  assert.deepEqual({ ...f, text: "" }, emptyFilter());
  assert.equal(hasAnyCondition({ ...emptyFilter(), text: "  " }), false);
  assert.equal(hasAnyCondition({ ...emptyFilter(), amountMax: 0 }), true);
});

test("速さ：架空の2万件で、元の作成と検索がそれぞれ十分に速い", () => {
  const list: Transaction[] = [];
  for (let i = 0; i < 20000; i++) {
    list.push(
      tx(`m${i}`, {
        content: `テスト店${i % 300}`,
        memo: i % 7 === 0 ? "テストマンガ 12巻" : "",
        amount: (i % 5000) + 1,
        date: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      }),
    );
  }
  const t0 = performance.now();
  const index = buildSearchIndex(list);
  const t1 = performance.now();
  const hits = searchTransactions(index, { ...emptyFilter(), text: "てすとまんが 12" }, cats, TODAY);
  const t2 = performance.now();
  assert.ok(hits.length > 2000);
  assert.ok(t1 - t0 < 3000, `元の作成 ${t1 - t0}ms`);
  assert.ok(t2 - t1 < 300, `検索 ${t2 - t1}ms`);
});
