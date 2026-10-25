import assert from "node:assert/strict";
import test from "node:test";
import {
  accountUsage,
  cardNextNote,
  cardNote,
  nextDebitText,
  cardOpeningToStored,
  computeBalances,
  defaultIncludeInUsable,
  groupSections,
  isDuplicateAccountName,
  summarizeAccounts,
  validateAccountDraft,
} from "../src/accountLogic.js";
import { moveInOrder } from "../src/orderUtils.js";
import { account, emptyData, T1, tx } from "./fixtures.js";

const cardAcc = { paymentDay: 27, holidayShift: "after" as const, paymentAccountId: "bank" };

test("残高：初期残高に収入・支出を足し引きする", () => {
  const accs = [account("a1", { openingBalance: 1000 })];
  const b = computeBalances(accs, [tx("t1", { type: "income", amount: 500 }), tx("t2", { type: "expense", amount: 300 })]);
  assert.equal(b.get("a1"), 1200);
});

test("残高：振替は元から金額＋手数料、先へ金額", () => {
  const accs = [account("a1", { openingBalance: 5000 }), account("a2", { openingBalance: 0 })];
  const t = tx("t1", { type: "transfer", amount: 1000, fee: 110, toAccountId: "a2" });
  const b = computeBalances(accs, [t]);
  assert.equal(b.get("a1"), 5000 - 1110);
  assert.equal(b.get("a2"), 1000);
});

test("残高：残高修正は符号つき（増えたら正、減ったら負）", () => {
  const accs = [account("a1", { openingBalance: 1000 })];
  assert.equal(computeBalances(accs, [tx("t1", { type: "adjustment", amount: 250 })]).get("a1"), 1250);
  assert.equal(computeBalances(accs, [tx("t1", { type: "adjustment", amount: -400 })]).get("a1"), 600);
});

test("残高：論理削除済みの取引と立替の扱い", () => {
  const accs = [account("a1", { openingBalance: 1000 })];
  const deleted = tx("t1", { type: "expense", amount: 300, deletedAt: T1 });
  const reimb = tx("t2", { type: "expense", amount: 200, reimbursement: { counterparty: "テスト太郎", amount: 200 } });
  const b = computeBalances(accs, [deleted, reimb]);
  assert.equal(b.get("a1"), 800); // 削除済みは除く。立替でも払った全額が出る
});

test("残高：カードは使うとマイナス、引き落とし（銀行→カードの振替）で戻る", () => {
  const accs = [
    account("bank", { group: "bank", openingBalance: 100000 }),
    account("card", { group: "card", openingBalance: -10000, card: cardAcc }),
  ];
  const use = tx("t1", { type: "expense", amount: 5000, accountId: "card" });
  assert.equal(computeBalances(accs, [use]).get("card"), -15000);
  const pay = tx("t2", { type: "transfer", amount: 15000, accountId: "bank", toAccountId: "card" });
  const b = computeBalances(accs, [use, pay]);
  assert.equal(b.get("card"), 0);
  assert.equal(b.get("bank"), 85000);
});

test("合計：使える資産・資産・負債・含めない資産（カードの未払いはマイナス、非表示も入る）", () => {
  const accs = [
    account("cash", { openingBalance: 3000 }),
    account("bank", { group: "bank", openingBalance: 50000 }),
    account("card", { group: "card", openingBalance: -12000, card: cardAcc }),
    account("inv", { group: "investment", includeInUsable: false, openingBalance: 80000 }),
    account("hid", { openingBalance: 700, hidden: true }),
    account("gone", { openingBalance: 99999, deletedAt: T1 }),
  ];
  const s = summarizeAccounts(accs, computeBalances(accs, []));
  assert.equal(s.usable, 3000 + 50000 - 12000 + 700);
  assert.equal(s.assets, 3000 + 50000 + 80000 + 700);
  assert.equal(s.liabilities, 12000);
  assert.equal(s.total, s.assets - s.liabilities);
  assert.equal(s.excluded, 80000);
});

test("種類ごとの小計：種類の順、0件の種類は出さない、非表示は一覧に出さない", () => {
  const accs = [
    account("b1", { group: "bank", openingBalance: 100 }),
    account("c1", { group: "cash", openingBalance: 10, order: 1 }),
    account("c2", { group: "cash", openingBalance: 20, order: 0 }),
    account("c3", { group: "cash", openingBalance: 5, hidden: true }),
  ];
  const sections = groupSections(accs, computeBalances(accs, []));
  assert.deepEqual(sections.map((s) => s.group), ["cash", "bank"]);
  assert.deepEqual(sections[0].items.map((a) => a.id), ["c2", "c1"]);
  assert.equal(sections[0].subtotal, 30);
});

test("削除できるか：取引・繰り返し・よく使う入力・給料明細・カードの引き落とし口座から使われていると不可", () => {
  const d = emptyData();
  d.accounts = [account("a1", { group: "bank" }), account("c", { group: "card", card: { ...cardAcc, paymentAccountId: "a1" } })];
  assert.equal(accountUsage("a1", d).cardPayments, 1);
  d.accounts = [account("a1")];
  assert.equal(accountUsage("a1", d).total, 0);

  d.transactions = [tx("t1", { toAccountId: "a1", accountId: "x" })];
  assert.equal(accountUsage("a1", d).transactions, 1);

  const template = { type: "expense" as const, amount: 1, accountId: "a1", content: "", memo: "" };
  d.recurrings = [{ id: "r", createdAt: "", updatedAt: "", deletedAt: null, template, rule: { every: "month", day: 1 }, startDate: "2026-10-01", holidayShift: "none", estimated: false }];
  d.favorites = [{ id: "f", createdAt: "", updatedAt: "", deletedAt: null, template, order: 0 }];
  d.payrolls = [{ id: "p", createdAt: "", updatedAt: "", deletedAt: null, name: "給与", accountId: "z", day: 25, holidayShift: "none", lines: [{ lineId: "l1", kind: "settlement", accountId: "a1", label: "精算", amount: 1 }] }];
  const u = accountUsage("a1", d);
  assert.deepEqual([u.transactions, u.recurrings, u.favorites, u.payrolls, u.total], [1, 1, 1, 1, 4]);
});

test("削除できるか：論理削除済みからの参照は数えない", () => {
  const d = emptyData();
  d.accounts = [account("a1"), account("c", { group: "card", deletedAt: T1, card: { ...cardAcc, paymentAccountId: "a1" } })];
  d.transactions = [tx("t1", { accountId: "a1", deletedAt: T1 })];
  const template = { type: "expense" as const, amount: 1, accountId: "a1", content: "", memo: "" };
  d.recurrings = [{ id: "r", createdAt: "", updatedAt: "", deletedAt: T1, template, rule: { every: "month", day: 1 }, startDate: "2026-10-01", holidayShift: "none", estimated: false }];
  d.favorites = [{ id: "f", createdAt: "", updatedAt: "", deletedAt: T1, template, order: 0 }];
  d.payrolls = [{ id: "p", createdAt: "", updatedAt: "", deletedAt: T1, name: "給与", accountId: "a1", day: 25, holidayShift: "none", lines: [] }];
  assert.equal(accountUsage("a1", d).total, 0);
});

test("名前の重複：前後の空白は無視、自分自身と削除済みは除く", () => {
  const accs = [account("a1", { name: "財布" }), account("a2", { name: "銀行A", hidden: true }), account("a3", { name: "旧", deletedAt: T1 })];
  assert.equal(isDuplicateAccountName(accs, " 財布 "), true);
  assert.equal(isDuplicateAccountName(accs, "銀行A"), true); // 非表示とも重複
  assert.equal(isDuplicateAccountName(accs, "財布", "a1"), false);
  assert.equal(isDuplicateAccountName(accs, "旧"), false);
});

test("初期値：投資だけ使える資産に含めない。カードの未払いはマイナスで保存", () => {
  assert.equal(defaultIncludeInUsable("investment"), false);
  assert.equal(defaultIncludeInUsable("cash"), true);
  assert.equal(cardOpeningToStored(10000), -10000);
  assert.equal(cardOpeningToStored(0), 0);
});

test("資産の入力チェック：カードは引き落とし日（1〜31）と銀行の口座が必須", () => {
  const accs = [account("bank", { group: "bank", name: "銀行" })];
  const base = { name: "カード", group: "card" as const, openingBalance: -100, card: { paymentDay: 27 as number | null, holidayShift: "after" as const, paymentAccountId: "bank" } };
  assert.equal(validateAccountDraft(base, accs), null);
  assert.match(validateAccountDraft({ ...base, name: "  " }, accs) ?? "", /名前/);
  assert.match(validateAccountDraft({ ...base, openingBalance: null }, accs) ?? "", /初期残高/);
  assert.match(validateAccountDraft({ ...base, card: { ...base.card, paymentDay: 0 } }, accs) ?? "", /引き落とし日/);
  assert.match(validateAccountDraft({ ...base, card: { ...base.card, paymentDay: 32 } }, accs) ?? "", /引き落とし日/);
  assert.match(validateAccountDraft({ ...base, card: { ...base.card, paymentAccountId: "" } }, accs) ?? "", /引き落とし口座/);
  assert.equal(validateAccountDraft({ name: "財布", group: "cash", openingBalance: 0 }, accs), null);
});

test("カードの説明文", () => {
  const accs = [account("bank", { group: "bank", name: "テスト銀行" }), account("c", { group: "card", card: cardAcc })];
  assert.equal(cardNote(accs[1], accs), "引き落とし 毎月27日・テスト銀行");
  assert.equal(cardNote(accs[0], accs), null);
});

test("並べ替え：order が 0 から振り直され、非表示は飛ばして入れ替える", () => {
  const list = [account("a", { order: 5 }), account("h", { order: 7, hidden: true }), account("b", { order: 9 })];
  const moved = moveInOrder(list, "b", "up", (x) => !x.hidden);
  assert.ok(moved);
  assert.deepEqual(moved.map((x) => [x.id, x.order]), [["b", 0], ["h", 1], ["a", 2]]);
  assert.equal(moveInOrder(list, "a", "up"), null);
  assert.equal(moveInOrder(list, "b", "down"), null);
});

test("カードの説明：資産タブは「次の引き落とし 11/27(金)・銀行」、資産の明細は毎月◯日と次の引き落とし", () => {
  const bank = account("b1", { name: "テスト銀行", group: "bank" });
  const card = account("c1", { name: "テストカード", group: "card", card: { paymentDay: 27, holidayShift: "after", paymentAccountId: "b1" } });
  assert.equal(cardNextNote(card, [bank, card], "2026-11-01"), "次の引き落とし 11/27(金)・テスト銀行");
  assert.equal(cardNextNote(card, [bank, card], "2026-12-01"), "次の引き落とし 12/28(月)・テスト銀行"); // 27日が日曜 → 28日
  assert.equal(cardNextNote(card, [card], "2026-11-01"), "次の引き落とし 11/27(金)・口座未設定");
  assert.equal(cardNextNote(bank, [bank, card], "2026-11-01"), null);
  assert.equal(nextDebitText(card, "2026-11-28"), "次の引き落とし 12/28(月)");
  assert.equal(nextDebitText(bank, "2026-11-28"), null);
  assert.equal(cardNote(card, [bank, card]), "引き落とし 毎月27日・テスト銀行"); // 毎月◯日は資産の明細の説明に残す
});
