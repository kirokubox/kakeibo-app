import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSuggestIndex,
  currentWord,
  lastUsageOf,
  replaceCurrentWord,
  splitMemo,
  suggestContents,
  suggestMemoWords,
  updateSuggestIndex,
} from "../src/suggestLogic.js";
import { T0, T1, T2, tx } from "./fixtures.js";

const TODAY = "2026-10-25";

/** 内容 content の支出を、日付 dates の分だけ作る */
function uses(content: string, dates: string[], extra: Partial<Parameters<typeof tx>[1]> = {}) {
  return dates.map((date, i) => tx(`${content}-${date}-${i}`, { content, date, ...extra }));
}

test("内容の候補：打った文字で始まるもの → 含むもの", () => {
  const index = buildSuggestIndex([...uses("カフェ松", ["2026-10-20"]), ...uses("松屋", ["2026-10-24"]), ...uses("松", ["2026-10-01"]), ...uses("バー", ["2026-10-24"])]);
  // 「松」で始まる：松屋・松（直近の回数は同じ → 最後に使った日が新しい松屋が先）。含む：カフェ松
  assert.deepEqual(suggestContents(index, "expense", "松", TODAY), ["松屋", "松", "カフェ松"]);
  assert.deepEqual(suggestContents(index, "expense", "ばー", TODAY), []); // ひらがなは別の文字
});

test("内容の候補：直近90日の回数の多い順 → 最後に使った日の新しい順", () => {
  const index = buildSuggestIndex([
    ...uses("店A", ["2026-10-01", "2026-10-02", "2026-10-03"]), // 3回
    ...uses("店B", ["2026-10-24", "2026-10-23"]), // 2回
    ...uses("店C", ["2026-10-10", "2026-10-11"]), // 2回
    ...uses("店D", ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]), // 90日より前（4回だが直近は0回）
  ]);
  assert.deepEqual(suggestContents(index, "expense", "店", TODAY), ["店A", "店B", "店C", "店D"]);
  // 90日の境目：2026-07-28 は含む（25日から数えて90日目）、2026-07-27 は含まない
  const edge = buildSuggestIndex([...uses("端1", ["2026-07-28"]), ...uses("端2", ["2026-07-27"]), ...uses("端2", ["2026-07-26"])]);
  assert.deepEqual(suggestContents(edge, "expense", "端", TODAY), ["端1", "端2"]);
});

test("内容の候補：前後の空白を除いて同じ文字なら1つにまとめる", () => {
  const index = buildSuggestIndex([tx("1", { content: "店E", date: "2026-10-01" }), tx("2", { content: " 店E ", date: "2026-10-02" }), tx("3", { content: "店E　", date: "2026-10-03" })]);
  const list = suggestContents(index, "expense", "店", TODAY);
  assert.equal(list.filter((c) => c === "店E").length, 1);
});

test("内容の候補：収入と支出を区別し、論理削除と振替は除く、空の内容は出ない", () => {
  const index = buildSuggestIndex([
    tx("1", { content: "給与元", type: "income", date: "2026-10-01" }),
    tx("2", { content: "給与店", type: "expense", date: "2026-10-01" }),
    tx("3", { content: "給与消す", deletedAt: T1, date: "2026-10-01" }),
    tx("4", { content: "給与振替", type: "transfer", toAccountId: "a2", date: "2026-10-01" }),
    tx("5", { content: "", date: "2026-10-01" }),
  ]);
  assert.deepEqual(suggestContents(index, "income", "給与", TODAY), ["給与元"]);
  assert.deepEqual(suggestContents(index, "expense", "給与", TODAY), ["給与店"]);
});

test("内容の候補：何も打っていないときは、選んだ小分類で直近によく使った内容", () => {
  const index = buildSuggestIndex([
    ...uses("昼A", ["2026-10-20", "2026-10-21"], { categoryId: "cMeal" }),
    ...uses("昼B", ["2026-10-22"], { categoryId: "cMeal" }),
    ...uses("別分類", ["2026-10-22", "2026-10-23", "2026-10-24"], { categoryId: "cOther" }),
    ...uses("昔の昼", ["2026-01-01"], { categoryId: "cMeal" }),
  ]);
  assert.deepEqual(suggestContents(index, "expense", "", TODAY, "cMeal"), ["昼A", "昼B"]);
  assert.deepEqual(suggestContents(index, "expense", "", TODAY, null), []);
  assert.deepEqual(suggestContents(index, "expense", "", TODAY, "cNone"), []);
});

test("内容の候補：最大8件", () => {
  const list = Array.from({ length: 12 }, (_, i) => tx(`t${i}`, { content: `店${i}`, date: "2026-10-01" }));
  assert.equal(suggestContents(buildSuggestIndex(list), "expense", "店", TODAY).length, 8);
});

test("前回の分類・資産・タグ：いちばん新しい日付のもの", () => {
  const index = buildSuggestIndex([
    tx("1", { content: "店F", date: "2026-10-01", categoryId: "c1", accountId: "a1", tag: "daily" }),
    tx("2", { content: "店F", date: "2026-10-10", categoryId: "c2", accountId: "a2", tag: "regret", createdAt: T0 }),
    tx("3", { content: "店F", date: "2026-10-10", categoryId: "c3", accountId: "a3", tag: "satisfied", createdAt: T2 }), // 同じ日は作成が新しい方
    tx("4", { content: "店F", date: "2026-10-05", categoryId: "c4", accountId: "a4" }),
  ]);
  assert.deepEqual(lastUsageOf(index, "expense", "店F"), { categoryId: "c3", accountId: "a3", tag: "satisfied" });
  assert.equal(lastUsageOf(index, "income", "店F"), null); // 種類が違う
  assert.equal(lastUsageOf(index, "expense", "ない店"), null);
  assert.equal(lastUsageOf(index, "expense", " 店F ")?.accountId, "a3"); // 前後の空白は無視
});

test("集計の更新：保存・編集・削除・元に戻すの分だけ直す", () => {
  const index = buildSuggestIndex([]);
  const t = tx("t1", { content: "新店", memo: "ともだち / 新宿", date: "2026-10-24" });
  updateSuggestIndex(index, t); // 保存
  assert.deepEqual(suggestContents(index, "expense", "新", TODAY), ["新店"]);
  assert.deepEqual(suggestMemoWords(index, "とも"), ["ともだち"]);
  updateSuggestIndex(index, { ...t, content: "改店", memo: "" }); // 編集（前の分を引く）
  assert.deepEqual(suggestContents(index, "expense", "新", TODAY), []);
  assert.deepEqual(suggestContents(index, "expense", "改", TODAY), ["改店"]);
  assert.deepEqual(suggestMemoWords(index, "とも"), []);
  updateSuggestIndex(index, { ...t, content: "改店", memo: "", deletedAt: T1 }); // 削除
  assert.deepEqual(suggestContents(index, "expense", "改", TODAY), []);
  updateSuggestIndex(index, { ...t, content: "改店", memo: "", deletedAt: null }); // 元に戻す
  assert.deepEqual(suggestContents(index, "expense", "改", TODAY), ["改店"]);
});

test("メモの語：区切り（` / `・`/`・`、`・`,`・`，`・全角半角の空白）", () => {
  assert.deepEqual(splitMemo("たなかさん / 新宿 / 飲み"), ["たなかさん", "新宿", "飲み"]);
  assert.deepEqual(splitMemo("A/B、C,D，E F　G"), ["A", "B", "C", "D", "E", "F", "G"]);
  assert.deepEqual(splitMemo(""), []);
  assert.equal(currentWord("たなかさん / 新"), "新");
  assert.equal(currentWord("たなかさん / "), "");
  assert.equal(currentWord("たな"), "たな");
  assert.equal(replaceCurrentWord("たなかさん / 新", "新宿"), "たなかさん / 新宿");
  assert.equal(replaceCurrentWord("たな", "たなかさん"), "たなかさん");
  assert.equal(replaceCurrentWord("A、B,新", "新宿"), "A、B,新宿");
});

test("メモの語の候補：始まる語だけ、回数の多い順、最大6件", () => {
  const memos = [
    "たなかさん / 新宿",
    "たなかさん",
    "たなかさん / 飲み",
    "たなべさん",
    "たなべさん",
    "新宿 / たなばた",
    "きたなさん", // 「たな」を含むが始まりではない
  ];
  const index = buildSuggestIndex(memos.map((memo, i) => tx(`m${i}`, { memo })));
  assert.deepEqual(suggestMemoWords(index, "たな"), ["たなかさん", "たなべさん", "たなばた"]);
  assert.deepEqual(suggestMemoWords(index, "たなかさん / たなべ"), ["たなべさん"]);
  assert.deepEqual(suggestMemoWords(index, "たなかさん / "), []); // 区切りの直後は候補なし
  assert.deepEqual(suggestMemoWords(index, "たなべさん"), []); // 同じ語しかない
  const many = buildSuggestIndex(Array.from({ length: 10 }, (_, i) => tx(`w${i}`, { memo: `作品${i}巻` })));
  assert.equal(suggestMemoWords(many, "作品").length, 6);
});

test("メモの語の候補：1文字の語と数字だけの語は出さない。種類は問わず、論理削除は除く", () => {
  const index = buildSuggestIndex([
    tx("1", { memo: "A / 12 / １２３ / ab" }),
    tx("2", { memo: "振替メモ語", type: "transfer", toAccountId: "a2" }),
    tx("3", { memo: "消した語", deletedAt: T1 }),
    tx("4", { memo: "収入の語", type: "income" }),
  ]);
  assert.deepEqual(suggestMemoWords(index, "A"), ["ab"]); // 1文字の「A」自体は候補にならない
  assert.deepEqual(suggestMemoWords(index, "1"), []);
  assert.deepEqual(suggestMemoWords(index, "１"), []);
  assert.deepEqual(suggestMemoWords(index, "振替"), ["振替メモ語"]);
  assert.deepEqual(suggestMemoWords(index, "消"), []);
  assert.deepEqual(suggestMemoWords(index, "収入"), ["収入の語"]);
});
