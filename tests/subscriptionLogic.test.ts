import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_INTERVAL_DAYS,
  SUBSCRIPTION_CATEGORY_ID,
  continuedAfterCancel,
  isReviewDue,
  isStale,
  latestDecisions,
  lastReviewDate,
  monthlyTotal,
  recordDecision,
  subscriptionKey,
  summarizeSubscriptions,
  usageStartDate,
} from "../src/subscriptionLogic.js";
import type { SubscriptionReview, Transaction } from "../src/types.js";
import { T0, tx } from "./fixtures.js";

function sub(id: string, content: string, date: string, amount = 990, extra: Partial<Transaction> = {}): Transaction {
  return tx(id, { categoryId: SUBSCRIPTION_CATEGORY_ID, content, date, amount, ...extra });
}

function review(id: string, reviewedAt: string, items: SubscriptionReview["items"]): SubscriptionReview {
  return { id, createdAt: `${reviewedAt}T00:00:00.000Z`, updatedAt: T0, deletedAt: null, reviewedAt, items };
}

test("サブスクの分類ID：一般向けの初期分類のID。v0.8.0 までの初期分類のIDの明細も数える", () => {
  assert.equal(SUBSCRIPTION_CATEGORY_ID, "seed:expense:サブスク/サブスク");
  const legacy = tx("legacy", { categoryId: "seed:expense:固定費/サブスク", content: "テスト動画", date: "2026-08-01", amount: 500 });
  const other = tx("other", { categoryId: "seed:expense:その他/その他", content: "テスト動画", date: "2026-08-01", amount: 500 });
  const current = sub("current", "テスト動画", "2026-09-01", 500);
  const found = summarizeSubscriptions([legacy, other, current]);
  assert.equal(found.length, 1);
  assert.equal(found[0].count, 2);
});

test("まとめ：内容ごとに直近の金額・最後に払った日・回数。全角半角や空白の違いは同じ内容", () => {
  const list = [
    sub("a1", "テスト配信", "2026-08-05", 900),
    sub("a2", "テスト配信", "2026-09-05", 990),
    sub("a3", " ＴＥＳＴ ", "2026-10-05", 1100), // 別の内容
    sub("b1", "テスト音楽", "2026-10-02", 500),
    sub("b2", "テスト配信 ", "2026-10-05", 1000), // 前後の空白は同じ
    tx("x", { content: "別の分類", date: "2026-10-05" }), // サブスクではない
    sub("y", "テスト配信", "2026-10-06", 5, { deletedAt: T0 }), // 削除済み
    sub("z", "テスト配信", "2026-10-06", 5, { type: "income" }), // 支出ではない
  ];
  const s = summarizeSubscriptions(list);
  const haishin = s.find((x) => x.key === subscriptionKey("テスト配信"))!;
  assert.equal(haishin.count, 3);
  assert.equal(haishin.amount, 1000);
  assert.equal(haishin.lastDate, "2026-10-05");
  assert.equal(haishin.firstDate, "2026-08-05");
  assert.equal(haishin.monthly, true);
  assert.equal(s.length, 3);
  assert.equal(s[0].lastDate >= s[1].lastDate, true); // 最後に払った日が新しい順
});

test("毎月かどうか：直近の月がとぎれず続いているか（1回だけ・飛んでいるものは毎月ではない）", () => {
  const monthly = [sub("a", "月々", "2026-08-01"), sub("b", "月々", "2026-09-01"), sub("c", "月々", "2026-10-01")];
  const skipped = [sub("d", "とびとび", "2026-06-01"), sub("e", "とびとび", "2026-10-01")];
  const once = [sub("f", "一回", "2026-10-01")];
  const yearly = [sub("g", "年払い", "2025-10-01"), sub("h", "年払い", "2026-10-01")];
  const s = summarizeSubscriptions([...monthly, ...skipped, ...once, ...yearly]);
  const m = (name: string) => s.find((x) => x.key === subscriptionKey(name))!.monthly;
  assert.equal(m("月々"), true);
  assert.equal(m("とびとび"), false);
  assert.equal(m("一回"), false);
  assert.equal(m("年払い"), false);
});

test("見直しの記録：その日の見直しは1件にまとまり、同じ内容は選び直せる", () => {
  let n = 0;
  const makeBase = () => ({ id: `r${++n}`, createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z", deletedAt: null });
  const first = recordDecision([], "2026-10-26", { content: "テスト配信", decision: "keep", amount: 990 }, makeBase);
  assert.equal(first.reviewedAt, "2026-10-26");
  assert.deepEqual(first.items, [{ content: "テスト配信", decision: "keep", amount: 990 }]);
  const second = recordDecision([first], "2026-10-26", { content: "テスト音楽", decision: "cancel", amount: 500 }, makeBase);
  assert.equal(second.id, first.id); // 同じ日の見直しに足す
  assert.equal(second.items.length, 2);
  const redo = recordDecision([second], "2026-10-26", { content: "テスト配信", decision: "cancel", amount: 990 }, makeBase);
  assert.equal(redo.items.length, 2);
  assert.equal(redo.items.find((i) => i.content === "テスト配信")!.decision, "cancel");
  const nextDay = recordDecision([second], "2026-10-27", { content: "テスト配信", decision: "keep", amount: 990 }, makeBase);
  assert.notEqual(nextDay.id, second.id);
});

test("最新の選び：内容ごとにいちばん新しい見直し", () => {
  const reviews = [
    review("r1", "2026-04-01", [{ content: "テスト配信", decision: "cancel", amount: 990 }]),
    review("r2", "2026-07-01", [{ content: "テスト配信", decision: "keep", amount: 990 }]),
    { ...review("r3", "2026-10-01", [{ content: "テスト配信", decision: "cancel", amount: 990 }]), deletedAt: T0 }, // 削除済みは無視
  ];
  const d = latestDecisions(reviews).get(subscriptionKey("テスト配信"))!;
  assert.deepEqual([d.decision, d.reviewedAt], ["keep", "2026-07-01"]);
  assert.equal(lastReviewDate(reviews), "2026-07-01");
  assert.equal(lastReviewDate([]), null);
});

test("90日の判定：最後の見直しから90日。初回は使い始めて90日後。サブスクがなければ出さない", () => {
  assert.equal(REVIEW_INTERVAL_DAYS, 90);
  const subs = [sub("a", "テスト配信", "2026-10-05")];
  const reviews = [review("r1", "2026-07-28", [{ content: "テスト配信", decision: "keep", amount: 990 }])];
  assert.equal(isReviewDue(reviews, subs, "2026-10-25"), false); // 89日
  assert.equal(isReviewDue(reviews, subs, "2026-10-26"), true); // 90日
  assert.equal(isReviewDue(reviews, [], "2027-01-01"), false); // 見直す対象がない
  // 初回：自分で入れた明細の最初の作成日から
  const used = [sub("m1", "テスト配信", "2026-07-30", 990, { createdAt: "2026-07-30T03:00:00.000Z" })];
  assert.equal(usageStartDate(used), "2026-07-30");
  assert.equal(isReviewDue([], used, "2026-10-27"), false); // 89日
  assert.equal(isReviewDue([], used, "2026-10-28"), true); // 90日
  // 取り込んだ明細（古い作成日）だけでは使い始めたことにならない
  const imported = [sub("i1", "テスト配信", "2020-01-01", 990, { source: "import", createdAt: "2020-01-01T00:00:00.000Z" })];
  assert.equal(usageStartDate(imported), null);
  assert.equal(isReviewDue([], imported, "2026-10-26"), false);
});

test("やめると決めたのに続いている：その日より後に支払いがあれば出す。続けるにし直したら出さない", () => {
  const list = [sub("a", "テスト配信", "2026-09-05"), sub("b", "テスト配信", "2026-10-05"), sub("c", "テスト音楽", "2026-09-01"), sub("d", "テスト動画", "2026-10-10")];
  const reviews = [
    review("r1", "2026-09-20", [
      { content: "テスト配信", decision: "cancel", amount: 990 },
      { content: "テスト音楽", decision: "cancel", amount: 500 }, // その後の支払いなし
      { content: "テスト動画", decision: "keep", amount: 300 },
    ]),
  ];
  const c = continuedAfterCancel(reviews, list);
  assert.deepEqual(
    c.map((x) => [x.content, x.decidedAt, x.lastDate]),
    [["テスト配信", "2026-09-20", "2026-10-05"]],
  );
  const redo = [...reviews, review("r2", "2026-10-20", [{ content: "テスト配信", decision: "keep", amount: 990 }])];
  assert.equal(continuedAfterCancel(redo, list).length, 0);
});

test("払っていない期間の判定", () => {
  assert.equal(isStale("2026-09-11", "2026-10-26"), false); // 45日
  assert.equal(isStale("2026-09-10", "2026-10-26"), true); // 46日
});

test("毎月の合計の目安：やめる内容は除く", () => {
  const list = [sub("a", "月々A", "2026-09-01", 1000), sub("b", "月々A", "2026-10-01", 1000), sub("c", "月々B", "2026-09-01", 500), sub("d", "月々B", "2026-10-01", 500)];
  const s = summarizeSubscriptions(list);
  const d = latestDecisions([review("r", "2026-10-26", [{ content: "月々B", decision: "cancel", amount: 500 }])]);
  assert.equal(monthlyTotal(s, new Map(), "2026-10-26"), 1500);
  assert.equal(monthlyTotal(s, d, "2026-10-26"), 1000);
  assert.equal(monthlyTotal(s, new Map(), "2027-03-01"), 0); // 最近は払っていないものは数えない;
});
