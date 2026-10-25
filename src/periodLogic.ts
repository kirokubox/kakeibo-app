// 期間（暦月・月曜始まりの週）と、明細の集計（画面から切り離した純粋なロジック）
import { addDays, weekdayOf } from "./dateUtils.js";
import { reimbAmountOf } from "./reimburseLogic.js";
import type { Id, Transaction } from "./types.js";

/** 返金（収入）のid → 立替に充てた額。期間の合計から除く（reimburseLogic の computeAllocation の applied） */
export type AppliedReturns = ReadonlyMap<Id, number>;

/** 期間の合計に数える収入の額：返金は、立替に充てた額を除く（多い分だけ収入） */
export function countedIncome(t: Transaction, applied?: AppliedReturns): number {
  return t.amount - (t.settles ? (applied?.get(t.id) ?? 0) : 0);
}

/** 期間の合計に数える支出の額：立替のある支出は、立替の金額を除く */
export function countedExpense(t: Transaction): number {
  return t.amount - reimbAmountOf(t);
}

export interface DateRange {
  start: string; // YYYY-MM-DD（含む）
  end: string; // YYYY-MM-DD（含む）
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM から年と月を取り出す */
export function parseMonth(month: string): { year: number; month: number } {
  const [y, m] = month.split("-").map(Number);
  return { year: y, month: m };
}

export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/** 月を n か月ずらす */
export function addMonths(month: string, n: number): string {
  const { year, month: m } = parseMonth(month);
  const t = year * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

/** 暦月の範囲 */
export function monthRange(month: string): DateRange {
  const { year, month: m } = parseMonth(month);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${year}-${pad(m)}-${pad(last)}` };
}

/** その日を含む週の月曜日 */
export function weekStartOf(date: string): string {
  const wd = weekdayOf(date); // 0=日
  return addDays(date, -((wd + 6) % 7));
}

/** その日を含む週（月曜〜日曜） */
export function weekRange(date: string): DateRange {
  const start = weekStartOf(date);
  return { start, end: addDays(start, 6) };
}

export function inRange(date: string, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}

export interface PeriodTotals {
  income: number;
  expense: number;
  total: number; // 収入 − 支出
}

/** 収入・支出・合計。論理削除済み、振替、残高修正は含めない。立替分と、返金に充てた額は除く（残高は変えない） */
export function summarize(transactions: readonly Transaction[], range?: DateRange, applied?: AppliedReturns): PeriodTotals {
  let income = 0;
  let expense = 0;
  for (const t of transactions) {
    if (t.deletedAt !== null) continue;
    if (range && !inRange(t.date, range)) continue;
    if (t.type === "income") income += countedIncome(t, applied);
    else if (t.type === "expense") expense += countedExpense(t);
  }
  return { income, expense, total: income - expense };
}

export interface DayGroup {
  date: string;
  income: number;
  expense: number;
  items: Transaction[]; // 作った順の新しいものが上
}

/** 日ごとのまとまり（新しい日から）。論理削除済みは除く。振替・残高修正は行に入るが、日の収入・支出には入れない */
export function groupByDay(transactions: readonly Transaction[], range?: DateRange, applied?: AppliedReturns): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const t of transactions) {
    if (t.deletedAt !== null) continue;
    if (range && !inRange(t.date, range)) continue;
    let g = map.get(t.date);
    if (!g) {
      g = { date: t.date, income: 0, expense: 0, items: [] };
      map.set(t.date, g);
    }
    g.items.push(t);
    if (t.type === "income") g.income += countedIncome(t, applied);
    else if (t.type === "expense") g.expense += countedExpense(t);
  }
  const groups = [...map.values()];
  for (const g of groups) g.items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  return groups.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export interface CalendarCell {
  date: string;
  inMonth: boolean;
  income: number;
  expense: number;
  hasItems: boolean;
}

/** 月のカレンダーのマス（月曜始まり。前後の月の日も入れる）。4〜6週分 */
export function calendarCells(month: string, transactions: readonly Transaction[], applied?: AppliedReturns): CalendarCell[] {
  const range = monthRange(month);
  const first = weekStartOf(range.start);
  const lastWeekStart = weekStartOf(range.end);
  const end = addDays(lastWeekStart, 6);
  const byDate = new Map<string, DayGroup>();
  for (const g of groupByDay(transactions, undefined, applied)) byDate.set(g.date, g);
  const cells: CalendarCell[] = [];
  for (let d = first; d <= end; d = addDays(d, 1)) {
    const g = byDate.get(d);
    cells.push({ date: d, inMonth: inRange(d, range), income: g?.income ?? 0, expense: g?.expense ?? 0, hasItems: !!g });
  }
  return cells;
}

/** 週の7日分の支出（月曜から）。棒グラフ用 */
export function weekExpenseBars(transactions: readonly Transaction[], weekStart: string, applied?: AppliedReturns): Array<{ date: string; expense: number }> {
  const days = groupByDay(transactions, undefined, applied);
  const byDate = new Map(days.map((g) => [g.date, g.expense]));
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    return { date, expense: byDate.get(date) ?? 0 };
  });
}

const WEEKDAY_SHORT = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAY_LONG = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];

export function weekdayShort(date: string): string {
  return WEEKDAY_SHORT[weekdayOf(date)];
}

/** 日ごとの見出し：25 日曜日 2026.10 */
export function dayHeading(date: string): { day: number; weekday: string; yearMonth: string } {
  const [y, m, d] = date.split("-").map(Number);
  return { day: d, weekday: WEEKDAY_LONG[weekdayOf(date)], yearMonth: `${y}.${pad(m)}` };
}

/** 狭い場所用：10/12(月) */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}(${weekdayShort(date)})`;
}

/** 週の見出し：10/19(月)〜10/25(日) */
export function weekTitle(weekStart: string): string {
  return `${shortDate(weekStart)}〜${shortDate(addDays(weekStart, 6))}`;
}

/** 月の見出し：2026年10月 */
export function monthTitle(month: string): string {
  const { year, month: m } = parseMonth(month);
  return `${year}年${m}月`;
}
