import assert from "node:assert/strict";
import test from "node:test";
import { aiFileName, buildAiMarkdown, escapeCell } from "../src/aiMarkdown.js";
import type { AiMarkdownInput } from "../src/aiMarkdown.js";
import { SETTLE_CATEGORY_ID } from "../src/reimburseLogic.js";
import type { BudgetSnapshot, Category, Transaction } from "../src/types.js";
import { T0, account, category, emptyData, tx } from "./fixtures.js";

const cats: Category[] = [
  category("p1", { name: "食費" }),
  category("c1", { parentId: "p1", name: "ごはん", tagMode: "defaultDaily" }),
  category("p2", { name: "趣味", order: 1 }),
  category("c2", { parentId: "p2", name: "本", tagMode: "mustChoose" }),
  category("p3", { name: "固定費", order: 2 }),
  category("c3", { parentId: "p3", name: "通信" }),
  category("ip", { kind: "income", name: "一時収入" }),
  category(SETTLE_CATEGORY_ID, { kind: "income", parentId: "ip", name: "立替返金" }),
];
const accounts = [account("a1", { name: "テスト財布" }), account("a2", { name: "テスト銀行", group: "bank" })];

function input(txs: Transaction[], extra: Partial<AiMarkdownInput> = {}): AiMarkdownInput {
  const d = emptyData();
  return {
    range: { start: "2026-10-01", end: "2026-10-31" },
    exportedAt: "2026-10-26T09:00:00.000Z",
    exportedLabel: "2026-10-26 18:00",
    appVersion: "0.8.0",
    accounts,
    categories: cats,
    transactions: txs,
    reserves: d.reserves,
    reserveMoves: d.reserveMoves,
    plannedExpenses: d.plannedExpenses,
    budgetSnapshots: d.budgetSnapshots,
    ...extra,
  };
}

const sample: Transaction[] = [
  tx("t1", { categoryId: "c1", amount: 1200, tag: "daily", content: "テスト食堂", memo: "ランチ", date: "2026-10-02" }),
  tx("t2", { categoryId: "c2", amount: 3000, tag: "satisfied", content: "テスト書店", memo: "テスト漫画 12巻", date: "2026-10-03" }),
  tx("t3", { categoryId: "c3", amount: 5000, content: "テスト通信", date: "2026-10-04", recurringId: "r1" }),
  tx("t4", { categoryId: "c1", amount: 4000, tag: "regret", content: "テスト居酒屋", date: "2026-10-05", reimbursement: { counterparty: "さくらさん", amount: 1500 }, estimated: true }),
  tx("t5", { type: "income", categoryId: SETTLE_CATEGORY_ID, amount: 1000, content: "返金", date: "2026-10-10", settles: { txId: "t4" } }),
  tx("t6", { type: "transfer", categoryId: undefined, accountId: "a2", toAccountId: "a1", amount: 5000, fee: 110, content: "引き出し", date: "2026-10-11" }),
  tx("t7", { type: "adjustment", categoryId: undefined, amount: -300, content: "残高修正", memo: "", date: "2026-10-12" }),
  tx("t8", { categoryId: "c1", amount: 999, tag: "daily", date: "2026-09-30", content: "期間の外" }),
];

test("ファイル名：kakeibo-ai-開始日_終了日.md", () => {
  assert.equal(aiFileName({ start: "2026-10-01", end: "2026-10-31" }), "kakeibo-ai-2026-10-01_2026-10-31.md");
});

test("表のセル：`|` はエスケープし、改行は <br> にする", () => {
  assert.equal(escapeCell("a|b"), "a\\|b");
  assert.equal(escapeCell("1行目\n2行目\r\n3行目"), "1行目<br>2行目<br>3行目");
  assert.equal(escapeCell("  前後の空白  "), "前後の空白");
});

test("冒頭：対象期間・書き出し日時・アプリの版", () => {
  const md = buildAiMarkdown(input(sample));
  assert.match(md, /^# 家計簿 AI用書き出し/);
  assert.match(md, /対象期間：2026-10-01 〜 2026-10-31/);
  assert.match(md, /書き出し日時：2026-10-26 18:00/);
  assert.match(md, /アプリの版：0\.8\.0/);
});

test("期間のまとめ：収入・支出・変動費の内訳・タグのない支出と、立替・返金の注記", () => {
  const md = buildAiMarkdown(input(sample));
  // 支出 = 1,200 + 3,000 + 5,000 + (4,000 − 1,500 立替) = 11,700。収入は返金1,000のうち立替に充てた1,000を除いて0
  assert.match(md, /\| 支出 \| 11,700円 \|/);
  assert.match(md, /\| 収入 \| 0円 \|/);
  assert.match(md, /\| 変動費（日常・満足・反省） \| 6,700円 \|/);
  assert.match(md, /\| 変動費のうち日常 \| 1,200円 \|/);
  assert.match(md, /\| 変動費のうち満足 \| 3,000円 \|/);
  assert.match(md, /\| 変動費のうち反省 \| 2,500円 \|/);
  assert.match(md, /\| タグのない支出（固定費・税金・保険など） \| 5,000円 \|/);
  assert.match(md, /立替は、立て替えた額を支出から除く/);
  assert.doesNotMatch(md, /期間の外/); // 期間の外の明細は入れない
});

test("予算と実績：期間に重なる週・月の予算、使った額、あと", () => {
  const snaps: BudgetSnapshot[] = [
    { id: "b1", createdAt: T0, updatedAt: T0, deletedAt: null, period: "week", start: "2026-09-28", end: "2026-10-04", amount: 20000, basis: {} },
    { id: "b2", createdAt: T0, updatedAt: T0, deletedAt: null, period: "month", start: "2026-09-25", end: "2026-10-24", amount: 3000, basis: {} },
    { id: "b3", createdAt: T0, updatedAt: T0, deletedAt: null, period: "week", start: "2026-11-02", end: "2026-11-08", amount: 1, basis: {} }, // 重ならない
  ];
  const md = buildAiMarkdown(input(sample, { budgetSnapshots: snaps }));
  assert.match(md, /\| 週 \| 2026-09-28 〜 2026-10-04 \| 20,000円 \| 5,199円 \| 14,801円 \|/); // 9/30の999円も含む（週は9/28〜10/4）
  assert.match(md, /\| 月 \| 2026-09-25 〜 2026-10-24 \| 3,000円 \| 7,699円 \| /);
  assert.match(md, /こえている/);
  assert.doesNotMatch(md, /2026-11-02/);
  assert.match(buildAiMarkdown(input(sample)), /重なる予算の記録はありません/);
});

test("分類別の合計：大分類・小分類・割合・合計", () => {
  const md = buildAiMarkdown(input(sample));
  assert.match(md, /\| \*\*食費\*\* \|  \| 3,700円 \|/); // t1 + t4の自己負担
  assert.match(md, /\|  \| ごはん \| 3,700円 \|/);
  assert.match(md, /\| \*\*合計\*\* \|  \| 11,700円 \| 100% \|/);
});

test("明細：日付・種類・分類・内容・金額・タグ・メモ・資産と、補足（立替・返金・手数料・見込み・繰り返し）", () => {
  const md = buildAiMarkdown(input(sample));
  assert.match(md, /\| 日付 \| 種類 \| 分類 \| 内容 \| 金額 \| タグ \| メモ \| 資産 \| 補足 \|/);
  assert.match(md, /\| 2026-10-03 \| 支出 \| 趣味\/本 \| テスト書店 \| 3,000円 \| 満足 \| テスト漫画 12巻 \| テスト財布 \| {2}\|/);
  assert.match(md, /立替 さくらさんに 1,500円（自分の負担 2,500円）／見込み額/);
  assert.match(md, /立替の返金（10\/5\(月\) テスト居酒屋・さくらさん）/);
  assert.match(md, /\| 2026-10-11 \| 振替 \|  \| 引き出し \| 5,000円 \|  \|  \| テスト銀行 → テスト財布 \| 手数料 110円 \|/);
  assert.match(md, /\| 2026-10-12 \| 残高修正 \|  \| 残高修正 \| −300円 \|/);
  assert.match(md, /\| 繰り返し \|/);
});

test("明細：内容やメモの `|` で表が崩れない（セルの数が変わらない）", () => {
  const md = buildAiMarkdown(input([tx("p", { categoryId: "c1", content: "A|B", memo: "x | y\nz", date: "2026-10-02", tag: "daily" })]));
  const line = md.split("\n").find((l) => l.includes("A\\|B"))!;
  assert.ok(line.includes("x \\| y<br>z"));
  // エスケープした `|` を除いた区切りの数は、見出し行と同じ（9列＝10本）
  assert.equal(line.replace(/\\\|/g, "").split("|").length - 1, 10);
});

test("取り置き（名前・残高・目標）・予定出費・未回収の立替を渡す", () => {
  const d = emptyData();
  const reserves = [{ id: "rs1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト旅行", targetAmount: 50000, targetMonth: "2027-03" }];
  const moves = [
    { id: "m1", createdAt: T0, updatedAt: T0, deletedAt: null, reserveId: "rs1", date: "2026-10-05", amount: 10000, kind: "assign" as const },
    { id: "m2", createdAt: T0, updatedAt: T0, deletedAt: null, reserveId: "rs1", date: "2026-10-06", amount: 2500, kind: "spend" as const, txId: "t9" },
  ];
  const planned = [
    { id: "p1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト車検", month: "2026-12", amount: 80000, reserveId: "rs1" },
    { id: "p2", createdAt: T0, updatedAt: T0, deletedAt: null, name: "済んだ予定", month: "2026-10", amount: 1, doneAt: T0 },
    { id: "p3", createdAt: T0, updatedAt: T0, deletedAt: null, name: "昔の予定", month: "2026-05", amount: 1 },
  ];
  const txs = [...sample, tx("t9", { categoryId: "c2", amount: 2500, tag: "satisfied", content: "旅行の本", date: "2026-10-06", reserveId: "rs1" })];
  const md = buildAiMarkdown(input(txs, { reserves, reserveMoves: moves, plannedExpenses: planned, budgetSnapshots: d.budgetSnapshots }));
  assert.match(md, /取り置き「テスト旅行」から 2,500円/);
  assert.match(md, /\| テスト旅行 \| 7,500円 \| 50,000円 \| 2027-03 \|/);
  assert.match(md, /\| 2026-12 \| テスト車検 \| 80,000円 \| 取り置き「テスト旅行」 \|/);
  assert.doesNotMatch(md, /済んだ予定/);
  assert.doesNotMatch(md, /昔の予定/);
  // 立替の返金で全額戻っていない分（t4は1,500のうち1,000返金）が未回収に出る
  assert.match(md, /\| さくらさん \| 2026-10-05 \| テスト居酒屋 \| 1,500円 \| 1,000円 \| 500円 \|/);
});

test("何もない期間でも冒頭と注記が出る", () => {
  const md = buildAiMarkdown(input([], { range: { start: "2026-01-01", end: "2026-01-07" } }));
  assert.match(md, /対象期間：2026-01-01 〜 2026-01-07/);
  assert.match(md, /この期間の明細はありません/);
  assert.match(md, /未回収の立替はありません/);
});
