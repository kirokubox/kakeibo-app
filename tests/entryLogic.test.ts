import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHint,
  checkDraft,
  continueDraft,
  copyDraft,
  draftFromTransaction,
  draftToTemplate,
  draftToTransaction,
  emptyDraft,
  favoriteProblems,
  isFavoriteCallable,
  nextFavoriteOrder,
  recallFavorite,
  selectableAccounts,
  selectableCategoryGroups,
  tagAfterCategoryChange,
  tagOptions,
  usageHint,
} from "../src/entryLogic.js";
import type { EntryDraft } from "../src/entryLogic.js";
import type { Category } from "../src/types.js";
import { account, category, T0, T1, tx } from "./fixtures.js";

// 架空の分類：食費（日常が初期値）・趣味（満足か反省を選ぶ）・固定費（タグなし）・給与（収入）
const categories: Category[] = [
  category("pF", { name: "食費", order: 0 }),
  category("cMeal", { parentId: "pF", name: "ごはん", tagMode: "defaultDaily", order: 0 }),
  category("pH", { name: "趣味", order: 1 }),
  category("cGame", { parentId: "pH", name: "ゲーム", tagMode: "mustChoose", order: 0 }),
  category("pX", { name: "固定費", order: 2 }),
  category("cRent", { parentId: "pX", name: "家賃", tagMode: "none", order: 0 }),
  category("pI", { kind: "income", name: "給与", order: 0 }),
  category("cSalary", { kind: "income", parentId: "pI", name: "給料", tagMode: "none", order: 0 }),
];
const accounts = [account("a1", { name: "財布", order: 0 }), account("a2", { name: "銀行", group: "bank", order: 0 })];

function draft(extra: Partial<EntryDraft> = {}): EntryDraft {
  return { ...emptyDraft("expense", "2026-10-25"), accountId: "a1", categoryId: "cMeal", amount: 800, tag: "daily", ...extra };
}

test("タグの選択肢：日常が初期値＝3つ、満足か反省＝2つ、タグなし・収入＝なし", () => {
  const meal = categories.find((c) => c.id === "cMeal")!;
  const game = categories.find((c) => c.id === "cGame")!;
  const rent = categories.find((c) => c.id === "cRent")!;
  assert.deepEqual(tagOptions("expense", meal), ["daily", "satisfied", "regret"]);
  assert.deepEqual(tagOptions("expense", game), ["satisfied", "regret"]);
  assert.deepEqual(tagOptions("expense", rent), []);
  assert.deepEqual(tagOptions("income", meal), []);
  assert.deepEqual(tagOptions("expense", undefined), []);
});

test("分類を選んだときのタグ：日常が初期値なら日常、満足か反省を選ぶなら未選択、タグなしなら消す", () => {
  const [meal, game, rent] = ["cMeal", "cGame", "cRent"].map((id) => categories.find((c) => c.id === id)!);
  assert.equal(tagAfterCategoryChange(null, "expense", meal), "daily");
  assert.equal(tagAfterCategoryChange(null, "expense", game), null);
  assert.equal(tagAfterCategoryChange("daily", "expense", game), null); // 日常は満足か反省を選ぶ分類では選べない
  assert.equal(tagAfterCategoryChange("satisfied", "expense", rent), null); // タグなしに替えたら消す
  assert.equal(tagAfterCategoryChange("regret", "expense", meal), "regret"); // 選べるなら残す
  assert.equal(tagAfterCategoryChange("regret", "expense", game), "regret");
  assert.equal(tagAfterCategoryChange("daily", "expense", meal), "daily");
});

test("保存の判定：資産・小分類・金額が必須", () => {
  assert.deepEqual(checkDraft(draft(), categories), { ok: true });
  const noAccount = checkDraft(draft({ accountId: null }), categories);
  assert.equal(noAccount.ok === false && noAccount.field, "account");
  const noCategory = checkDraft(draft({ categoryId: null }), categories);
  assert.equal(noCategory.ok === false && noCategory.field, "category");
  const parentOnly = checkDraft(draft({ categoryId: "pF" }), categories); // 大分類だけは不可
  assert.equal(parentOnly.ok === false && parentOnly.field, "category");
  const wrongKind = checkDraft(draft({ categoryId: "cSalary" }), categories); // 支出に収入の分類は不可
  assert.equal(wrongKind.ok === false && wrongKind.field, "category");
  const noAmount = checkDraft(draft({ amount: null }), categories);
  assert.equal(noAmount.ok === false && noAmount.field, "amount");
  assert.equal(checkDraft(draft({ amount: 0 }), categories).ok, false);
  assert.equal(checkDraft(draft({ amount: 1.5 }), categories).ok, false);
  assert.equal(checkDraft(draft({ amount: 1_000_000_000_000 }), categories).ok, false);
  assert.equal(checkDraft(draft({ content: "", memo: "" }), categories).ok, true); // 内容は空でも保存できる
});

test("保存の判定：満足か反省を選ぶ分類は、タグなしで保存できない", () => {
  const noTag = checkDraft(draft({ categoryId: "cGame", tag: null }), categories);
  assert.equal(noTag.ok === false && noTag.field, "tag");
  assert.equal(noTag.ok === false && noTag.message, "満足か反省を選んでください");
  assert.equal(checkDraft(draft({ categoryId: "cGame", tag: "regret" }), categories).ok, true);
  assert.equal(checkDraft(draft({ categoryId: "cMeal", tag: null }), categories).ok, true); // 日常が初期値の分類はいつでも保存できる
  assert.equal(checkDraft(draft({ categoryId: "cRent", tag: null }), categories).ok, true);
});

test("保存の判定：取り込んだ明細を直すときは、タグが空でも保存できる", () => {
  const d = draft({ categoryId: "cGame", tag: null });
  assert.equal(checkDraft(d, categories, "manual").ok, false);
  assert.equal(checkDraft(d, categories, "import").ok, true);
  assert.equal(checkDraft(d, categories, "recurring").ok, true);
});

test("収入はタグを付けない", () => {
  const d = draft({ type: "income", categoryId: "cSalary", tag: null, amount: 250000 });
  assert.equal(checkDraft(d, categories).ok, true);
  const t = draftToTransaction({ ...d, tag: "daily" }, categories, { id: "n1", createdAt: T0, updatedAt: T0, deletedAt: null });
  assert.equal("tag" in t, false);
});

test("下書き → 取引：空白を除き、source は manual、タグなしの分類ではタグを消す", () => {
  const base = { id: "n1", createdAt: T0, updatedAt: T0, deletedAt: null };
  const t = draftToTransaction(draft({ content: "  テスト店  ", memo: " 友人 / 新宿 " }), categories, base);
  assert.equal(t.id, "n1");
  assert.equal(t.source, "manual");
  assert.equal(t.content, "テスト店");
  assert.equal(t.memo, "友人 / 新宿");
  assert.equal(t.tag, "daily");
  assert.equal(t.type, "expense");
  const rent = draftToTransaction(draft({ categoryId: "cRent", tag: "daily" }), categories, base);
  assert.equal("tag" in rent, false);
});

test("編集：作成日時・取り込み元・見込みなどは残して上書き、タグを外せる", () => {
  const original = tx("t1", { source: "import", tag: "satisfied", estimated: true, createdAt: T0, categoryId: "cMeal", accountId: "a1" });
  const d = draftFromTransaction(original)!;
  assert.equal(d.tag, "satisfied");
  const edited = draftToTransaction({ ...d, amount: 999, tag: null }, categories, { id: "ignored", createdAt: T1, updatedAt: T1, deletedAt: null }, original);
  assert.equal(edited.id, "t1");
  assert.equal(edited.createdAt, T0);
  assert.equal(edited.source, "import");
  assert.equal(edited.estimated, true);
  assert.equal(edited.amount, 999);
  assert.equal("tag" in edited, false);
});

test("振替・残高修正は入力画面の下書きにならない", () => {
  assert.equal(draftFromTransaction(tx("t", { type: "transfer", toAccountId: "a2" })), null);
  assert.equal(draftFromTransaction(tx("t", { type: "adjustment" })), null);
});

test("続ける：種類・日付・資産が残り、ほかが空になる", () => {
  const next = continueDraft(draft({ type: "income", date: "2026-10-20", accountId: "a2", categoryId: "cSalary", amount: 5, content: "x", memo: "y", tag: "daily" }));
  assert.deepEqual(next, { type: "income", date: "2026-10-20", accountId: "a2", categoryId: null, amount: null, content: "", memo: "", tag: null });
});

test("コピーして新しく入力：日付は今日、ほかは同じ", () => {
  const d = copyDraft(tx("t1", { date: "2026-09-01", content: "テスト店", memo: "m", tag: "regret", amount: 321 }), "2026-10-25")!;
  assert.equal(d.date, "2026-10-25");
  assert.equal(d.content, "テスト店");
  assert.equal(d.amount, 321);
  assert.equal(d.tag, "regret");
});

test("資産パネル：表示中のものを種類の順に。選んでいる資産は非表示でも出す", () => {
  const list = [
    account("h", { name: "隠し", hidden: true }),
    account("b", { name: "銀行B", group: "bank", order: 1 }),
    account("c", { name: "財布C", group: "cash", order: 0 }),
    account("d", { name: "削除済み", deletedAt: T1 }),
    account("a", { name: "銀行A", group: "bank", order: 0 }),
  ];
  assert.deepEqual(selectableAccounts(list, null).map((a) => a.name), ["財布C", "銀行A", "銀行B"]);
  assert.deepEqual(selectableAccounts(list, "h").map((a) => a.name), ["財布C", "隠し", "銀行A", "銀行B"]);
  assert.equal(selectableAccounts(list, "h").some((a) => a.id === "h"), true);
  assert.equal(selectableAccounts(list, "d").some((a) => a.id === "d"), false); // 削除済みは出さない
});

test("分類パネル：種類に合う表示中のものだけ。小分類0件の大分類は出さない。選んでいる分類は非表示でも出す", () => {
  const list = [
    ...categories,
    category("pEmpty", { name: "空の大分類", order: 5 }),
    category("pHiddenKids", { name: "全部非表示", order: 6 }),
    category("cHidden", { parentId: "pHiddenKids", name: "非表示の小分類", hidden: true }),
    category("cHideOne", { parentId: "pF", name: "非表示のおやつ", hidden: true, order: 1 }),
  ];
  const groups = selectableCategoryGroups(list, "expense", null);
  assert.deepEqual(groups.map((g) => g.parent.name), ["食費", "趣味", "固定費"]);
  assert.deepEqual(groups[0].children.map((c) => c.name), ["ごはん"]);
  const withCurrent = selectableCategoryGroups(list, "expense", "cHidden");
  assert.deepEqual(withCurrent.map((g) => g.parent.name), ["食費", "趣味", "固定費", "全部非表示"]);
  assert.deepEqual(selectableCategoryGroups(list, "income", null).map((g) => g.parent.name), ["給与"]);
});

test("よく使う入力：下書き → ひな形 → 呼び出し", () => {
  const tpl = draftToTemplate(draft({ content: " テスト店 ", memo: "m", tag: "daily" }));
  assert.deepEqual(tpl, { type: "expense", amount: 800, accountId: "a1", content: "テスト店", memo: "m", categoryId: "cMeal", tag: "daily" });
  const current = draft({ date: "2026-10-01", accountId: "a2", categoryId: null, amount: null, content: "", tag: null });
  const r = recallFavorite(tpl, current, accounts, categories)!;
  assert.equal(r.focus, "amount"); // 金額のテンキーを開く
  assert.deepEqual(r.draft, { type: "expense", date: "2026-10-01", accountId: "a1", categoryId: "cMeal", amount: 800, content: "テスト店", memo: "m", tag: "daily" }); // 日付は今のまま
});

test("よく使う入力：金額が空のひな形は、呼び出すと金額が空", () => {
  const tpl = draftToTemplate(draft({ amount: null }));
  assert.equal(tpl.amount, 0);
  const r = recallFavorite(tpl, draft(), accounts, categories)!;
  assert.equal(r.draft.amount, null);
  assert.equal(r.focus, "amount");
});

test("よく使う入力：削除・非表示の資産や分類が含まれるとき、その項目を空にして選び直しへ", () => {
  const tpl = draftToTemplate(draft());
  const hiddenAccounts = [account("a1", { hidden: true }), account("a2")];
  assert.deepEqual(favoriteProblems(tpl, hiddenAccounts, categories), { account: true, category: false });
  const r1 = recallFavorite(tpl, draft(), hiddenAccounts, categories)!;
  assert.equal(r1.draft.accountId, null);
  assert.equal(r1.draft.categoryId, "cMeal");
  assert.equal(r1.focus, "account");

  const deletedCats = categories.map((c) => (c.id === "cMeal" ? { ...c, deletedAt: T1 } : c));
  const r2 = recallFavorite(tpl, draft(), accounts, deletedCats)!;
  assert.equal(r2.draft.categoryId, null);
  assert.equal(r2.draft.tag, null);
  assert.equal(r2.focus, "category");

  const hiddenCats = categories.map((c) => (c.id === "pF" ? { ...c, hidden: true } : c)); // 親が非表示
  assert.equal(favoriteProblems(tpl, accounts, hiddenCats).category, true);

  const missing = recallFavorite({ ...tpl, accountId: "" }, draft(), accounts, categories)!; // 資産が空のひな形
  assert.equal(missing.draft.accountId, null);
  assert.equal(missing.focus, "account");
});

test("よく使う入力：振替のひな形は呼び出せない。並びは末尾に足す", () => {
  const transferTpl = { type: "transfer" as const, amount: 1000, accountId: "a1", toAccountId: "a2", content: "", memo: "" };
  assert.equal(isFavoriteCallable(transferTpl), false);
  assert.equal(recallFavorite(transferTpl, draft(), accounts, categories), null);
  const favs = [
    { id: "f1", createdAt: T0, updatedAt: T0, deletedAt: null, template: transferTpl, order: 0 },
    { id: "f2", createdAt: T0, updatedAt: T0, deletedAt: null, template: transferTpl, order: 4 },
    { id: "f3", createdAt: T0, updatedAt: T0, deletedAt: T1, template: transferTpl, order: 9 },
  ];
  assert.equal(nextFavoriteOrder(favs), 5);
  assert.equal(nextFavoriteOrder([]), 0);
});

test("前回の分類・資産・タグの提案：違うときだけ出し、合わせると替わる", () => {
  const current = draft({ accountId: "a1", categoryId: "cMeal", tag: "daily" });
  assert.equal(usageHint({ accountId: "a1", categoryId: "cMeal", tag: "daily" }, current, accounts, categories), null); // 同じ
  const hint = usageHint({ accountId: "a2", categoryId: "cGame", tag: "satisfied" }, current, accounts, categories)!;
  assert.deepEqual(hint, { accountId: "a2", categoryId: "cGame", tag: "satisfied" });
  const applied = applyHint(current, hint);
  assert.equal(applied.accountId, "a2");
  assert.equal(applied.categoryId, "cGame");
  assert.equal(applied.tag, "satisfied");
  assert.equal(applied.amount, current.amount); // 金額などは触らない
  // 資産だけ違う
  assert.deepEqual(usageHint({ accountId: "a2", categoryId: "cMeal", tag: "daily" }, current, accounts, categories), { accountId: "a2", categoryId: "cMeal", tag: "daily" });
  // 前回のタグが空（取り込み明細）で資産と分類が同じなら出さない
  assert.equal(usageHint({ accountId: "a1", categoryId: "cMeal" }, current, accounts, categories), null);
});

test("前回の分類・資産・タグの提案：いま選べない資産・分類は提案に含めない", () => {
  const current = draft({ accountId: "a1", categoryId: "cMeal", tag: "daily" });
  const hiddenCats = categories.map((c) => (c.id === "cGame" ? { ...c, hidden: true } : c));
  // 分類が選べない → 資産だけ提案
  assert.deepEqual(usageHint({ accountId: "a2", categoryId: "cGame", tag: "regret" }, current, accounts, hiddenCats), { accountId: "a2", categoryId: "cMeal", tag: "daily" });
  // 資産も分類も選べない → 提案なし
  const gone = accounts.map((a) => (a.id === "a2" ? { ...a, deletedAt: T1 } : a));
  assert.equal(usageHint({ accountId: "a2", categoryId: "cGame", tag: "regret" }, current, gone, hiddenCats), null);
  assert.equal(usageHint(null, current, accounts, categories), null);
});
