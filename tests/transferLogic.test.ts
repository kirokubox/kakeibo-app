import assert from "node:assert/strict";
import test from "node:test";
import { computeBalances } from "../src/accountLogic.js";
import { emptyDraft } from "../src/entryLogic.js";
import {
  CARD_DEBIT_CONTENT,
  CARD_PREPAY_CONTENT,
  applyTransferHint,
  cardTransferContents,
  checkTransferDraft,
  continueTransferDraft,
  copyTransferDraft,
  emptyTransferDraft,
  mergeTransferSuggestions,
  prepareCardDebit,
  recallTransferFavorite,
  swapTransferAccounts,
  toEntryDraftFromTransfer,
  toTransferDraft,
  totalOut,
  transferFromTransaction,
  transferToTemplate,
  transferToTransaction,
  transferUsageHint,
  unpaidAmount,
} from "../src/transferLogic.js";
import { buildSuggestIndex, lastUsageOf, suggestContents } from "../src/suggestLogic.js";
import { account, T0, tx } from "./fixtures.js";

const base = { id: "new", createdAt: T0, updatedAt: T0, deletedAt: null };
const bank = account("bank", { name: "テスト銀行", group: "bank", openingBalance: 100000 });
const wallet = account("wallet", { name: "テスト財布", openingBalance: 5000 });
const pasmo = account("pasmo", { name: "テストPasmo", group: "emoney", openingBalance: 0 });
const card = account("card", {
  name: "テストカード",
  group: "card",
  openingBalance: 0,
  card: { paymentDay: 27, holidayShift: "after", paymentAccountId: "bank" },
});
const accounts = [bank, wallet, pasmo, card];

function draft(extra = {}) {
  return { ...emptyTransferDraft("2026-10-25"), fromId: "wallet", toId: "pasmo", amount: 3000, ...extra };
}

test("保存の条件：出金・入金・金額がそろい、出金と入金が違う資産", () => {
  assert.equal(checkTransferDraft(draft()).ok, true);
  const noFrom = checkTransferDraft(draft({ fromId: null }));
  assert.equal(noFrom.ok === false && noFrom.field, "from");
  const noTo = checkTransferDraft(draft({ toId: null }));
  assert.equal(noTo.ok === false && noTo.field, "to");
  const noAmount = checkTransferDraft(draft({ amount: null }));
  assert.equal(noAmount.ok === false && noAmount.field, "amount");
  assert.equal(checkTransferDraft(draft({ amount: 0 })).ok, false);
});

test("出金と入金が同じ資産なら保存できない", () => {
  const r = checkTransferDraft(draft({ fromId: "wallet", toId: "wallet" }));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.field, "to");
});

test("入れ替え：出金と入金だけが入れ替わる", () => {
  const d = draft({ fee: 110, content: "テスト内容" });
  const s = swapTransferAccounts(d);
  assert.equal(s.fromId, "pasmo");
  assert.equal(s.toId, "wallet");
  assert.equal(s.amount, 3000);
  assert.equal(s.fee, 110);
  assert.equal(s.content, "テスト内容");
  assert.deepEqual(swapTransferAccounts(s), d);
});

test("手数料は出金の資産から引かれる（出金＝金額＋手数料、入金＝金額）", () => {
  const t = transferToTransaction(draft({ fromId: "bank", toId: "wallet", amount: 10000, fee: 110 }), base);
  assert.equal(t.type, "transfer");
  assert.equal(t.fee, 110);
  const b = computeBalances(accounts, [t]);
  assert.equal(b.get("bank"), 100000 - 10110);
  assert.equal(b.get("wallet"), 5000 + 10000);
  assert.equal(totalOut(draft({ amount: 10000, fee: 110 })), 10110);
});

test("手数料0・なしは保存しない（なしと同じ）", () => {
  assert.equal("fee" in transferToTransaction(draft({ fee: 0 }), base), false);
  assert.equal("fee" in transferToTransaction(draft({ fee: null }), base), false);
  // 手数料を付けた振替から手数料を外して編集すると、残高も戻る
  const withFee = transferToTransaction(draft({ fee: 110 }), base);
  const edited = transferToTransaction(draft({ fee: null }), base, withFee);
  assert.equal("fee" in edited, false);
  assert.equal(computeBalances(accounts, [edited]).get("wallet"), 5000 - 3000);
});

test("振替の取引は分類・タグ・立替を持たない。編集しても作成日時などは残る", () => {
  const original = tx("x1", { type: "expense", tag: "daily", reimbursement: { counterparty: "テスト太郎", amount: 100 }, createdAt: "2026-09-01T00:00:00.000Z" });
  const t = transferToTransaction(draft(), base, original);
  assert.equal(t.id, "x1");
  assert.equal(t.createdAt, "2026-09-01T00:00:00.000Z");
  assert.equal(t.categoryId, undefined);
  assert.equal(t.tag, undefined);
  assert.equal(t.reimbursement, undefined);
  assert.equal(t.source, "manual");
  assert.equal(t.accountId, "wallet");
  assert.equal(t.toAccountId, "pasmo");
});

test("取引 → 下書き → 取引でそのまま戻る。コピーは日付だけ今日", () => {
  const t = transferToTransaction(draft({ fee: 110, content: "テスト内容", memo: "テストメモ" }), base);
  const d = transferFromTransaction(t)!;
  assert.deepEqual(d, draft({ fee: 110, content: "テスト内容", memo: "テストメモ" }));
  assert.equal(transferFromTransaction(tx("e1")), null);
  const copy = copyTransferDraft(t, "2026-11-01")!;
  assert.equal(copy.date, "2026-11-01");
  assert.equal(copy.amount, 3000);
});

test("収入・支出 ↔ 振替：日付・金額・内容・メモは残し、資産は出金へ。分類・タグ・入金は空", () => {
  const e = { ...emptyDraft("expense", "2026-10-20"), accountId: "wallet", categoryId: "c1", amount: 1200, content: "テスト店", memo: "テストメモ", tag: "daily" as const };
  const t = toTransferDraft(e);
  assert.deepEqual(t, { date: "2026-10-20", fromId: "wallet", toId: null, amount: 1200, fee: null, content: "テスト店", memo: "テストメモ" });
  const back = toEntryDraftFromTransfer({ ...t, toId: "pasmo", fee: 50 }, "income");
  assert.deepEqual(back, { type: "income", date: "2026-10-20", accountId: "wallet", categoryId: null, amount: 1200, content: "テスト店", memo: "テストメモ", tag: null });
});

test("続ける：日付と出金を残し、ほかは空", () => {
  const next = continueTransferDraft(draft({ fee: 110, content: "テスト内容", memo: "m" }));
  assert.deepEqual(next, { date: "2026-10-25", fromId: "wallet", toId: null, amount: null, fee: null, content: "", memo: "" });
});

test("カードの引き落としの用意：出金＝引き落とし口座、入金＝カード、金額＝未払い額、内容＝カード引き落とし", () => {
  const r = prepareCardDebit(card, accounts, -8000, "2026-10-27");
  assert.deepEqual(r.draft, { date: "2026-10-27", fromId: "bank", toId: "card", amount: 8000, fee: null, content: CARD_DEBIT_CONTENT, memo: "" });
  assert.equal(r.focus, "amount");
  assert.equal(CARD_DEBIT_CONTENT, "カード引き落とし");
  // 保存すると未払いが0になる
  const t = transferToTransaction(r.draft, base);
  assert.equal(computeBalances([bank, card], [tx("u1", { type: "expense", amount: 8000, accountId: "card" }), t]).get("card"), 0);
  assert.equal(unpaidAmount(-8000), 8000);
  assert.equal(unpaidAmount(300), 0);
});

test("カードの引き落とし：引き落とし口座が削除済み・非表示なら出金を空にして出金のパネルから", () => {
  const deleted = accounts.map((a) => (a.id === "bank" ? { ...a, deletedAt: T0 } : a));
  const r1 = prepareCardDebit(card, deleted, -8000, "2026-10-27");
  assert.equal(r1.draft.fromId, null);
  assert.equal(r1.draft.toId, "card");
  assert.equal(r1.draft.amount, 8000);
  assert.equal(r1.focus, "from");
  const hidden = accounts.map((a) => (a.id === "bank" ? { ...a, hidden: true } : a));
  assert.equal(prepareCardDebit(card, hidden, -8000, "2026-10-27").focus, "from");
});

test("カードの引き落とし：未払いが0なら金額は空", () => {
  const r = prepareCardDebit(card, accounts, 0, "2026-10-27");
  assert.equal(r.draft.amount, null);
  assert.equal(r.focus, "amount");
});

test("内容の候補：入金がカードで出金が引き落とし口座なら「カード引き落とし」「繰上返済」を先頭に", () => {
  assert.deepEqual(cardTransferContents(accounts, "bank", "card"), [CARD_DEBIT_CONTENT, CARD_PREPAY_CONTENT]);
  assert.deepEqual(cardTransferContents(accounts, "wallet", "card"), []); // 引き落とし口座ではない
  assert.deepEqual(cardTransferContents(accounts, "bank", "wallet"), []); // 入金がカードではない
  assert.deepEqual(cardTransferContents(accounts, null, "card"), []);
  assert.deepEqual(mergeTransferSuggestions([CARD_DEBIT_CONTENT, CARD_PREPAY_CONTENT], ["チャージ", CARD_DEBIT_CONTENT], 8), [CARD_DEBIT_CONTENT, CARD_PREPAY_CONTENT, "チャージ"]);
  assert.equal(mergeTransferSuggestions(["a", "b"], ["c", "d"], 3).length, 3);
});

test("振替の過去の内容から候補と前回（出金・入金）を出す", () => {
  const t1 = transferToTransaction(draft({ content: "テストチャージ" }), { ...base, id: "p1" });
  const t2 = transferToTransaction(draft({ fromId: "bank", toId: "wallet", content: "テストチャージ", date: "2026-10-26" }), { ...base, id: "p2", createdAt: "2026-10-26T00:00:00.000Z" });
  const index = buildSuggestIndex([t1, t2, tx("e1", { content: "テストチャ店" })]);
  assert.deepEqual(suggestContents(index, "transfer", "テスト", "2026-10-27"), ["テストチャージ"]); // 収入・支出の内容は混ざらない
  assert.deepEqual(suggestContents(index, "transfer", "", "2026-10-27"), ["テストチャージ"]);
  const last = lastUsageOf(index, "transfer", "テストチャージ");
  assert.equal(last?.accountId, "bank");
  assert.equal(last?.toAccountId, "wallet");
  const current = draft({ content: "テストチャージ" });
  const hint = transferUsageHint(last, current, accounts);
  assert.deepEqual(hint, { fromId: "bank", toId: "wallet" });
  assert.deepEqual(applyTransferHint(current, hint!), { ...current, fromId: "bank", toId: "wallet" });
  // 今と同じなら出さない／選べない資産が含まれるなら出さない
  assert.equal(transferUsageHint({ accountId: "wallet", toAccountId: "pasmo" }, current, accounts), null);
  assert.equal(transferUsageHint({ accountId: "bank", toAccountId: "gone" }, current, accounts), null);
  assert.equal(transferUsageHint(null, current, accounts), null);
});

test("よく使う入力：振替のひな形の登録と呼び出し（日付は今のまま）", () => {
  const tpl = transferToTemplate(draft({ fee: 110, content: "テスト内容", memo: "m" }));
  assert.equal(tpl.type, "transfer");
  assert.equal(tpl.accountId, "wallet");
  assert.equal(tpl.toAccountId, "pasmo");
  assert.equal(tpl.amount, 3000);
  assert.equal(tpl.fee, 110);
  const r = recallTransferFavorite(tpl, "2026-11-05", accounts)!;
  assert.equal(r.draft.date, "2026-11-05");
  assert.equal(r.draft.fromId, "wallet");
  assert.equal(r.draft.toId, "pasmo");
  assert.equal(r.draft.fee, 110);
  assert.equal(r.focus, "amount"); // 金額のテンキーが今の金額を選んだ状態で開く
  // 資産が使えなければ空にして、そのパネルへ
  const hiddenTo = accounts.map((a) => (a.id === "pasmo" ? { ...a, hidden: true } : a));
  const r2 = recallTransferFavorite(tpl, "2026-11-05", hiddenTo)!;
  assert.equal(r2.draft.toId, null);
  assert.equal(r2.focus, "to");
  const noFrom = recallTransferFavorite(tpl, "2026-11-05", accounts.filter((a) => a.id !== "wallet"))!;
  assert.equal(noFrom.draft.fromId, null);
  assert.equal(noFrom.focus, "from");
  assert.equal(recallTransferFavorite({ ...tpl, type: "expense" }, "2026-11-05", accounts), null);
});
