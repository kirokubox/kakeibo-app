// 集計タブのロジック（画面から切り離した純粋なロジック）。
// 合計の数え方は明細タブと同じ（periodLogic）：立替・返金の除き方、振替・残高修正は収入・支出に数えない。
import { txEffect } from "./accountLogic.js";
import { variableSpent } from "./budgetLogic.js";
import type { DateSpan } from "./budgetLogic.js";
import { addDays } from "./dateUtils.js";
import { addMonths, countedExpense, countedIncome, inRange, monthKeyOf, monthRange, weekRange } from "./periodLogic.js";
import type { AppliedReturns, DateRange } from "./periodLogic.js";
import type { Account, BudgetSnapshot, Category, CategoryKind, Id, Tag, Transaction, WeekStart } from "./types.js";

// ---- 期間（週・月・年・任意） ----

export type SummaryPeriodKind = "week" | "month" | "year" | "custom";

export interface SummaryPeriod {
  kind: SummaryPeriodKind;
  /** week：その週の初日（設定の週の始まりの曜日）／month：その月の1日／year：その年の1月1日。custom では使わない */
  anchor: string;
  customStart: string;
  customEnd: string;
}

/** 期間の日付の範囲。月・年は暦月・暦年（予算の区切りの設定に関係ない）。任意は開始と終了が逆でも正しい向きにする */
export function summaryRange(p: SummaryPeriod, weekStart: WeekStart = "monday"): DateRange {
  if (p.kind === "week") return weekRange(p.anchor, weekStart);
  if (p.kind === "month") return monthRange(p.anchor.slice(0, 7));
  if (p.kind === "year") {
    const y = p.anchor.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  const a = p.customStart || p.customEnd;
  const b = p.customEnd || p.customStart;
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** 期間を n 期間ずらす（任意は同じ長さずつずらす） */
export function shiftSummaryPeriod(p: SummaryPeriod, n: number): SummaryPeriod {
  if (p.kind === "week") return { ...p, anchor: addDays(p.anchor, 7 * n) };
  if (p.kind === "month") return { ...p, anchor: `${addMonths(p.anchor.slice(0, 7), n)}-01` };
  if (p.kind === "year") return { ...p, anchor: `${Number(p.anchor.slice(0, 4)) + n}-01-01` };
  const r = summaryRange(p);
  const days = Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000) + 1;
  return { ...p, customStart: addDays(r.start, days * n), customEnd: addDays(r.end, days * n) };
}

/** 期間の種類を切り替えるときの基準の日：今の期間に今日が入っていれば今日、なければ今の期間の初め */
export function switchDay(p: SummaryPeriod, today: string, weekStart: WeekStart = "monday"): string {
  const r = summaryRange(p, weekStart);
  return inRange(today, r) ? today : r.start;
}

/** 期間の切り替え：同じ日を含む週・月・年に合わせる。任意は前の任意の範囲（なければ今月初めから今日） */
export function periodAround(kind: SummaryPeriodKind, day: string, prev?: SummaryPeriod, weekStart: WeekStart = "monday"): SummaryPeriod {
  const custom = { customStart: prev?.customStart ?? monthRange(day.slice(0, 7)).start, customEnd: prev?.customEnd ?? day };
  if (kind === "week") return { kind, anchor: weekRange(day, weekStart).start, ...custom };
  if (kind === "month") return { kind, anchor: `${day.slice(0, 7)}-01`, ...custom };
  if (kind === "year") return { kind, anchor: `${day.slice(0, 4)}-01-01`, ...custom };
  return { kind, anchor: day, ...custom };
}

// ---- 分類別 ----

export const PALETTE = ["#5a5fb0", "#c2570c", "#2f8f6b", "#b3487a", "#2f7fb0", "#a8861e", "#7a4fb0", "#4c8f2f"] as const;
export const OTHER_COLOR = "#9aa5ab";

/** 分類ごとに一貫した色：大分類の並び順（kind ごと）で決める */
export function categoryColors(categories: readonly Category[], kind: CategoryKind): Map<Id, string> {
  const parents = categories
    .filter((c) => c.kind === kind && c.parentId === null)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const map = new Map<Id, string>();
  parents.forEach((c, i) => map.set(c.id, PALETTE[i % PALETTE.length]));
  return map;
}

export interface CategoryRow {
  id: Id | null; // null＝分類なし／その他
  name: string;
  amount: number;
  ratio: number; // 0〜1
  color: string;
  children?: CategoryRow[];
}

export interface CategoryBreakdown {
  total: number;
  rows: CategoryRow[];
}

function amountOf(t: Transaction, kind: CategoryKind, applied?: AppliedReturns): number {
  return kind === "expense" ? countedExpense(t) : countedIncome(t, applied);
}

/** 期間の分類別の合計（大分類→小分類）。大きい順 */
export function categoryBreakdown(txs: readonly Transaction[], categories: readonly Category[], kind: CategoryKind, range: DateRange, applied?: AppliedReturns): CategoryBreakdown {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const colors = categoryColors(categories, kind);
  const parentTotals = new Map<string, number>();
  const childTotals = new Map<string, Map<string, number>>();
  let total = 0;
  for (const t of txs) {
    if (t.deletedAt !== null || t.type !== kind || !inRange(t.date, range)) continue;
    const a = amountOf(t, kind, applied);
    if (a <= 0) continue;
    const leaf = t.categoryId ? byId.get(t.categoryId) : undefined;
    const parentId = leaf ? (leaf.parentId ?? leaf.id) : "";
    const leafId = leaf ? leaf.id : "";
    total += a;
    parentTotals.set(parentId, (parentTotals.get(parentId) ?? 0) + a);
    let m = childTotals.get(parentId);
    if (!m) childTotals.set(parentId, (m = new Map()));
    m.set(leafId, (m.get(leafId) ?? 0) + a);
  }
  const rows: CategoryRow[] = [...parentTotals.entries()]
    .map(([pid, amount]) => {
      const parent = pid === "" ? undefined : byId.get(pid);
      const children = [...(childTotals.get(pid) ?? new Map<string, number>()).entries()]
        .map(
          ([cid, ca]): CategoryRow => ({
            id: cid === "" ? null : cid,
            name: cid === "" ? "分類なし" : (byId.get(cid)?.name ?? "分類不明"),
            amount: ca,
            ratio: amount > 0 ? ca / amount : 0,
            color: colors.get(pid) ?? OTHER_COLOR,
          }),
        )
        .sort((a, b) => b.amount - a.amount);
      return {
        id: pid === "" ? null : pid,
        name: pid === "" ? "分類なし" : (parent?.name ?? "分類不明"),
        amount,
        ratio: total > 0 ? amount / total : 0,
        color: colors.get(pid) ?? OTHER_COLOR,
        children,
      };
    })
    .sort((a, b) => b.amount - a.amount);
  return { total, rows };
}

/** 円グラフの切り分け：上位 max 個＋その他。割合は全体に対して */
export function pieSlices(rows: readonly CategoryRow[], max = 8): CategoryRow[] {
  if (rows.length <= max) return [...rows];
  const top = rows.slice(0, max);
  const rest = rows.slice(max);
  const amount = rest.reduce((s, r) => s + r.amount, 0);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return [...top, { id: null, name: "その他", amount, ratio: total > 0 ? amount / total : 0, color: OTHER_COLOR }];
}

/** 小分類の円グラフ用：順に色を変える（同じ大分類の中なので、大分類の色ではなく順番の色） */
export function childPalette(rows: readonly CategoryRow[]): CategoryRow[] {
  return rows.map((r, i) => ({ ...r, color: PALETTE[i % PALETTE.length] }));
}

// ---- 月ごとの推移 ----

/** 終わりの月を含む直近 n か月（古い順） */
export function lastMonths(endMonth: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addMonths(endMonth, i - (n - 1)));
}

export interface MonthValue {
  month: string;
  amount: number;
}

/** 分類（大分類か小分類）に入る明細か。categoryId が null なら「分類なし」 */
function inCategory(t: Transaction, categoryId: Id | null, categories: readonly Category[]): boolean {
  if (categoryId === null) return t.categoryId === undefined || !categories.some((c) => c.id === t.categoryId);
  if (t.categoryId === undefined) return false;
  if (t.categoryId === categoryId) return true;
  const leaf = categories.find((c) => c.id === t.categoryId);
  return !!leaf && leaf.parentId === categoryId;
}

/** ある分類（大分類か小分類）の、直近 n か月の合計。期間に関係ない */
export function categoryTrend(
  txs: readonly Transaction[],
  categories: readonly Category[],
  categoryId: Id | null,
  kind: CategoryKind,
  endMonth: string,
  n = 12,
  applied?: AppliedReturns,
): MonthValue[] {
  const months = lastMonths(endMonth, n);
  const sums = new Map(months.map((m) => [m, 0]));
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  for (const t of txs) {
    if (t.deletedAt !== null || t.type !== kind) continue;
    const m = monthKeyOf(t.date);
    if (!sums.has(m)) continue;
    let match: boolean;
    if (categoryId === null) match = t.categoryId === undefined || !parentOf.has(t.categoryId);
    else match = t.categoryId !== undefined && (t.categoryId === categoryId || parentOf.get(t.categoryId) === categoryId);
    if (!match) continue;
    const a = amountOf(t, kind, applied);
    if (a > 0) sums.set(m, (sums.get(m) ?? 0) + a);
  }
  return months.map((month) => ({ month, amount: sums.get(month) ?? 0 }));
}

/** ある分類の、期間内の明細 */
export function categoryTransactions(txs: readonly Transaction[], categories: readonly Category[], categoryId: Id | null, kind: CategoryKind, range: DateRange): Transaction[] {
  return txs.filter((t) => t.deletedAt === null && t.type === kind && inRange(t.date, range) && inCategory(t, categoryId, categories));
}

// ---- タグ別 ----

export type TagKey = Tag | "none";
export const TAG_KEYS: readonly TagKey[] = ["daily", "satisfied", "regret", "none"];
export const TAG_KEY_LABELS: Record<TagKey, string> = { daily: "日常", satisfied: "満足", regret: "反省", none: "タグなし" };

export interface TagRow {
  tag: TagKey;
  amount: number;
  ratio: number;
}

/** 期間の支出のタグ別（立替分を除く）。なし＝タグのない支出（固定費など） */
export function tagBreakdown(txs: readonly Transaction[], range: DateRange): { total: number; rows: TagRow[] } {
  const sums: Record<TagKey, number> = { daily: 0, satisfied: 0, regret: 0, none: 0 };
  let total = 0;
  for (const t of txs) {
    if (t.deletedAt !== null || t.type !== "expense" || !inRange(t.date, range)) continue;
    const a = countedExpense(t);
    sums[t.tag ?? "none"] += a;
    total += a;
  }
  return { total, rows: TAG_KEYS.map((tag) => ({ tag, amount: sums[tag], ratio: total > 0 ? sums[tag] / total : 0 })) };
}

export interface TagMonth {
  month: string;
  values: Record<TagKey, number>;
}

/** 直近 n か月のタグ別の推移（積み上げ棒用） */
export function tagTrend(txs: readonly Transaction[], endMonth: string, n = 12): TagMonth[] {
  const months = lastMonths(endMonth, n);
  const map = new Map<string, Record<TagKey, number>>(months.map((m) => [m, { daily: 0, satisfied: 0, regret: 0, none: 0 }]));
  for (const t of txs) {
    if (t.deletedAt !== null || t.type !== "expense") continue;
    const v = map.get(monthKeyOf(t.date));
    if (v) v[t.tag ?? "none"] += countedExpense(t);
  }
  return months.map((month) => ({ month, values: map.get(month)! }));
}

// ---- 月ごとの収入と支出 ----

export interface IncomeExpenseMonth {
  month: string;
  income: number;
  expense: number;
  diff: number;
}

export function incomeExpenseTrend(txs: readonly Transaction[], endMonth: string, n = 12, applied?: AppliedReturns): IncomeExpenseMonth[] {
  const months = lastMonths(endMonth, n);
  const map = new Map<string, IncomeExpenseMonth>(months.map((m) => [m, { month: m, income: 0, expense: 0, diff: 0 }]));
  for (const t of txs) {
    if (t.deletedAt !== null) continue;
    const row = map.get(monthKeyOf(t.date));
    if (!row) continue;
    if (t.type === "income") row.income += countedIncome(t, applied);
    else if (t.type === "expense") row.expense += countedExpense(t);
  }
  return months.map((m) => {
    const r = map.get(m)!;
    return { ...r, diff: r.income - r.expense };
  });
}

// ---- 予算と実績 ----

export interface BudgetBar {
  label: string;
  start: string;
  end: string;
  /** 予算（決めていない期間は null＝実績だけ） */
  budget: number | null;
  spent: number;
}

/**
 * 直近 n 週の予算と実績（今日を含む週まで）。使った額は変動費（ホームと同じ数え方）。
 * 週は設定の週の始まりで数える。予算の記録は、その週の初日から6日以内に始まるものを使う
 * （週の始まりを切り替えた前後は、記録の期間が7日と違うことがあるため。期間は記録のものをそのまま使う）
 */
export function weekBudgetBars(snapshots: readonly BudgetSnapshot[], txs: readonly Transaction[], today: string, spendByTx: ReadonlyMap<Id, number>, n = 12, weekStart: WeekStart = "monday"): BudgetBar[] {
  const active = txs.filter((t) => t.deletedAt === null);
  const lastFirst = weekRange(today, weekStart).start;
  const weekSnaps = snapshots.filter((s) => s.deletedAt === null && s.period === "week").sort((a, b) => a.start.localeCompare(b.start) || a.createdAt.localeCompare(b.createdAt));
  return Array.from({ length: n }, (_, i) => {
    const start = addDays(lastFirst, 7 * (i - (n - 1)));
    const lastDay = addDays(start, 6);
    const snap = weekSnaps.find((s) => s.start >= start && s.start <= lastDay);
    const span: DateSpan = snap ? { start: snap.start, end: snap.end } : { start, end: addDays(start, 6) };
    const [, m, d] = start.split("-").map(Number);
    return { label: `${m}/${d}`, start: span.start, end: span.end, budget: snap ? snap.amount : null, spent: variableSpent(active, span, spendByTx) };
  });
}

/**
 * 直近 n 区切りの月の予算と実績。予算の記録（BudgetSnapshot）の区切りを使い、
 * 記録が1件もなければ暦月で実績だけを出す。
 */
export function monthBudgetBars(snapshots: readonly BudgetSnapshot[], txs: readonly Transaction[], today: string, spendByTx: ReadonlyMap<Id, number>, n = 12): BudgetBar[] {
  const active = txs.filter((t) => t.deletedAt === null);
  const snaps = snapshots
    .filter((s) => s.deletedAt === null && s.period === "month" && s.start <= today)
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .slice(-n);
  if (snaps.length > 0) {
    return snaps.map((s) => ({
      label: `${Number(s.start.slice(5, 7))}月`,
      start: s.start,
      end: s.end,
      budget: s.amount,
      spent: variableSpent(active, { start: s.start, end: s.end }, spendByTx),
    }));
  }
  return lastMonths(monthKeyOf(today), n).map((m) => {
    const r = monthRange(m);
    return { label: `${Number(m.slice(5, 7))}月`, start: r.start, end: r.end, budget: null, spent: variableSpent(active, r, spendByTx) };
  });
}

// ---- 資産の残高の推移 ----

export interface AssetTrend {
  months: string[];
  /** 使える資産の合計（月末残高） */
  usable: number[];
  accounts: Array<{ id: Id; name: string; values: number[] }>;
}

/** 直近 n か月の月末残高。使える資産の合計と、資産ごと。月末より後の明細は入れない */
export function assetTrend(accounts: readonly Account[], txs: readonly Transaction[], endMonth: string, n = 12): AssetTrend {
  const months = lastMonths(endMonth, n);
  const firstMonth = months[0];
  const lastMonth = months[n - 1];
  const live = accounts.filter((a) => a.deletedAt === null);
  const idx = new Map(live.map((a, i) => [a.id, i]));
  const before = live.map(() => 0);
  const deltas = live.map(() => new Array<number>(n).fill(0));
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  for (const t of txs) {
    if (t.deletedAt !== null) continue;
    const m = monthKeyOf(t.date);
    if (m > lastMonth) continue;
    const ids = t.toAccountId !== undefined && t.toAccountId !== t.accountId ? [t.accountId, t.toAccountId] : [t.accountId];
    for (const id of ids) {
      const i = idx.get(id);
      if (i === undefined) continue;
      const e = txEffect(id, t);
      if (m < firstMonth) before[i] += e;
      else deltas[i][monthIndex.get(m)!] += e;
    }
  }
  const result = live.map((a, i) => {
    let bal = a.openingBalance + before[i];
    const values = deltas[i].map((d) => (bal += d));
    return { id: a.id, name: a.name, values, usable: a.includeInUsable };
  });
  const usable = months.map((_, k) => result.filter((r) => r.usable).reduce((s, r) => s + r.values[k], 0));
  return { months, usable, accounts: result.map(({ id, name, values }) => ({ id, name, values })) };
}

// ---- 残高修正 ----

export interface AdjustmentStats {
  count: number;
  up: number; // 増えた合計
  down: number; // 減った合計（正の数）
  byAccount: Array<{ id: Id; name: string; count: number }>;
}

/** 期間内の残高修正の回数と金額、資産ごとの回数（漏れやすい資産に気づくため） */
export function adjustmentStats(txs: readonly Transaction[], accounts: readonly Account[], range: DateRange): AdjustmentStats {
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const counts = new Map<Id, number>();
  let count = 0;
  let up = 0;
  let down = 0;
  for (const t of txs) {
    if (t.deletedAt !== null || t.type !== "adjustment" || !inRange(t.date, range)) continue;
    count++;
    if (t.amount > 0) up += t.amount;
    else down += -t.amount;
    counts.set(t.accountId, (counts.get(t.accountId) ?? 0) + 1);
  }
  const byAccount = [...counts.entries()]
    .map(([id, c]) => ({ id, name: names.get(id) ?? "資産不明", count: c }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  return { count, up, down, byAccount };
}
