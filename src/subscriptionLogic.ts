// サブスク見直しのロジック（画面から切り離した純粋なロジック）。
// 対象：固定費＞サブスクの支出。内容ごとにまとめ、3か月に1回「続ける／やめる」を記録する。
import { daysBetween } from "./budgetLogic.js";
import { toDateKey } from "./dateUtils.js";
import { addMonths } from "./periodLogic.js";
import { seedCategoryId } from "./seedCategories.js";
import { normalizeText } from "./searchLogic.js";
import type { Base, SubscriptionDecision, SubscriptionReview, Transaction } from "./types.js";

/** 初期分類「固定費＞サブスク」のID。本人が名前を変えても同じIDで判定する */
export const SUBSCRIPTION_CATEGORY_ID = seedCategoryId("expense", "固定費", "サブスク");
/** 最後の見直しから、お知らせまでの日数 */
export const REVIEW_INTERVAL_DAYS = 90;

/** 内容をまとめる鍵（全角半角・かなの違い・前後の空白は同じ扱い） */
export function subscriptionKey(content: string): string {
  return normalizeText(content.trim());
}

export interface SubscriptionSummary {
  key: string;
  /** 一覧に出す名前（いちばん新しい支払いの内容） */
  content: string;
  /** 直近の金額 */
  amount: number;
  lastDate: string;
  firstDate: string;
  count: number;
  /** 直近の支払いが毎月続いている */
  monthly: boolean;
}

function isSubscriptionTx(t: Transaction): boolean {
  return t.deletedAt === null && t.type === "expense" && t.categoryId === SUBSCRIPTION_CATEGORY_ID;
}

function byDateAsc(a: Transaction, b: Transaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
}

/** 直近の支払いの月が、とぎれず続いているか（直近3回まで見る。1回だけは毎月とは言えない） */
function isMonthly(dates: readonly string[]): boolean {
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].sort();
  const recent = months.slice(-3);
  if (recent.length < 2) return false;
  for (let i = 1; i < recent.length; i++) if (addMonths(recent[i - 1], 1) !== recent[i]) return false;
  return true;
}

/** 固定費＞サブスクの明細を内容ごとにまとめる。最後に払った日が新しい順 */
export function summarizeSubscriptions(txs: readonly Transaction[]): SubscriptionSummary[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (!isSubscriptionTx(t)) continue;
    const key = subscriptionKey(t.content);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  const out: SubscriptionSummary[] = [];
  for (const [key, list] of groups) {
    list.sort(byDateAsc);
    const last = list[list.length - 1];
    out.push({
      key,
      content: last.content.trim() || "（内容なし）",
      amount: last.amount,
      lastDate: last.date,
      firstDate: list[0].date,
      count: list.length,
      monthly: isMonthly(list.map((t) => t.date)),
    });
  }
  return out.sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : a.key < b.key ? -1 : 1));
}

// ---- 見直しの記録 ----

export interface LatestDecision {
  decision: SubscriptionDecision;
  reviewedAt: string;
  amount: number;
}

/** 内容ごとの、いちばん新しい「続ける／やめる」 */
export function latestDecisions(reviews: readonly SubscriptionReview[]): Map<string, LatestDecision> {
  const out = new Map<string, LatestDecision>();
  const sorted = reviews.filter((r) => r.deletedAt === null).sort((a, b) => (a.reviewedAt < b.reviewedAt ? -1 : a.reviewedAt > b.reviewedAt ? 1 : a.createdAt < b.createdAt ? -1 : 1));
  for (const r of sorted) for (const it of r.items) out.set(subscriptionKey(it.content), { decision: it.decision, reviewedAt: r.reviewedAt, amount: it.amount });
  return out;
}

/**
 * 「続ける／やめる」を押した記録。その日の見直しがすでにあれば、同じ内容の選びを入れ替えて足す（1日の見直しは1件にまとまる）。
 * 返すのは保存する1件。
 */
export function recordDecision(
  reviews: readonly SubscriptionReview[],
  today: string,
  item: { content: string; decision: SubscriptionDecision; amount: number },
  makeBase: () => Base,
): SubscriptionReview {
  const key = subscriptionKey(item.content);
  const same = reviews.find((r) => r.deletedAt === null && r.reviewedAt === today);
  if (same) {
    return { ...same, items: [...same.items.filter((i) => subscriptionKey(i.content) !== key), item] };
  }
  return { ...makeBase(), reviewedAt: today, items: [item] };
}

// ---- 時期の判定 ----

/** 最後に見直した日。まだなら null */
export function lastReviewDate(reviews: readonly SubscriptionReview[]): string | null {
  let last: string | null = null;
  for (const r of reviews) if (r.deletedAt === null && (last === null || r.reviewedAt > last)) last = r.reviewedAt;
  return last;
}

/**
 * アプリを使い始めた日：自分で入れた（取り込みではない）明細のうち、いちばん古い作成日。
 * 取り込んだ明細は昔の作成日を持つので数えない。まだなければ null。
 */
export function usageStartDate(txs: readonly Transaction[]): string | null {
  let first: string | null = null;
  for (const t of txs) {
    if (t.deletedAt !== null || t.source === "import") continue;
    if (first === null || t.createdAt < first) first = t.createdAt;
  }
  if (first === null) return null;
  const d = new Date(first);
  return Number.isNaN(d.getTime()) ? null : toDateKey(d);
}

/**
 * ホームのお知らせを出すか：最後の見直しから90日。初回は使い始めて90日後。
 * 見直す対象（サブスクの明細）がなければ出さない。
 */
export function isReviewDue(reviews: readonly SubscriptionReview[], txs: readonly Transaction[], today: string): boolean {
  if (!txs.some(isSubscriptionTx)) return false;
  const base = lastReviewDate(reviews) ?? usageStartDate(txs);
  if (base === null) return false;
  return daysBetween(base, today) >= REVIEW_INTERVAL_DAYS;
}

export interface ContinuedCancel {
  key: string;
  content: string;
  decidedAt: string;
  /** やめると決めたあとの、最後の支払いの日 */
  lastDate: string;
}

/** 「やめる」にしたのに、その日より後も支払いが出ている内容（解約忘れに気づくため） */
export function continuedAfterCancel(reviews: readonly SubscriptionReview[], txs: readonly Transaction[]): ContinuedCancel[] {
  const decisions = latestDecisions(reviews);
  const out: ContinuedCancel[] = [];
  for (const s of summarizeSubscriptions(txs)) {
    const d = decisions.get(s.key);
    if (d && d.decision === "cancel" && s.lastDate > d.reviewedAt) out.push({ key: s.key, content: s.content, decidedAt: d.reviewedAt, lastDate: s.lastDate });
  }
  return out;
}

/** 最近は払っていない（この日数より前が最後の支払い）。やめたあとなど */
export const STALE_DAYS = 45;
export function isStale(lastDate: string, today: string): boolean {
  return daysBetween(lastDate, today) > STALE_DAYS;
}

/** 毎月続いているものの金額の合計（やめると記録したもの・最近は払っていないものは除く）。一覧の上に出す目安 */
export function monthlyTotal(summaries: readonly SubscriptionSummary[], decisions: ReadonlyMap<string, LatestDecision>, today: string): number {
  let sum = 0;
  for (const s of summaries) {
    const d = decisions.get(s.key);
    if (s.monthly && !isStale(s.lastDate, today) && !(d && d.decision === "cancel")) sum += s.amount;
  }
  return sum;
}
