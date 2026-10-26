// 使える額と、週・月の予算のロジック（画面から切り離した純粋なロジック）。
// 正本：05_開発・Webアプリ/17_家計簿/171_家計簿_初期仕様.md §6、172_家計簿_実装指示_段階6 §3・§4
//   使える額 ＝ 使える資産 − 生活防衛資金 − 取り置き残高 − 決まった出費（期限は次の給料日。給料日より前の収入は足さない）
import { computeBalances, summarizeAccounts } from "./accountLogic.js";
import { nextPayday, paydayOf } from "./businessDay.js";
import { addDays, addMonths, daysInMonth, isLocalDate, toDateKey } from "./dateUtils.js";
import { plannedCommitted, plannedStatuses } from "./plannedLogic.js";
import { countedExpense, inRange, monthRange, weekRange } from "./periodLogic.js";
import { reserveBalances, spendByTx, totalReserveBalance } from "./reserveLogic.js";
import { paydaysBetween, recurringOccurrencesBetween } from "./scheduleLogic.js";
import type { Account, Base, BudgetSnapshot, Category, DataSet, HolidayShift, Id, Recurring, Settings, Transaction, TransactionTemplate, WeekStart } from "./types.js";

export type BudgetData = Pick<DataSet, "accounts" | "categories" | "transactions" | "recurrings" | "reserves" | "reserveMoves" | "plannedExpenses">;
/** weekStart は省略すると月曜始まり */
export type BudgetSettings = Pick<Settings, "payday" | "paydayHolidayShift" | "defenseFund" | "budgetMonthBoundary"> & { weekStart?: WeekStart };
type PaydaySettings = { payday: number; paydayHolidayShift: HolidayShift };

export interface DateSpan {
  start: string;
  end: string;
}

// ---- 日付 ----

/** a から b までの日数（b が後なら正） */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** その日より後（その日を含まない）で最初の給料日。給料日の当日は、次の区切りの始まりなので次の給料日を返す */
export function nextPaydayAfter(date: string, s: PaydaySettings): string {
  return nextPayday(addDays(date, 1), s);
}

/** その日以前で最後の給料日（その日が給料日ならその日） */
export function paydayOnOrBefore(date: string, s: PaydaySettings): string {
  const ym = date.slice(0, 7);
  let best = "";
  for (const k of [-2, -1, 0, 1]) {
    const d = paydayOf(addMonths(ym, k), s);
    if (d <= date && d > best) best = d;
  }
  return best;
}

/** その日を含む、給料日から次の給料日の前日までの区切り */
export function paydayPeriodOf(date: string, s: PaydaySettings): DateSpan {
  return { start: paydayOnOrBefore(date, s), end: addDays(nextPaydayAfter(date, s), -1) };
}

/** 今日を含めて、次の給料日の前日までの日数（残り日数） */
export function daysLeftUntilPayday(today: string, s: PaydaySettings): number {
  return daysBetween(today, nextPaydayAfter(today, s));
}

// ---- 週 ----

/** 週の予算の記録（論理削除済みは除く） */
function weekSnapshots(snapshots: readonly BudgetSnapshot[]): BudgetSnapshot[] {
  return snapshots.filter((b) => b.deletedAt === null && b.period === "week").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** その日を含む週の予算の記録（なければ undefined） */
export function findWeekContaining(snapshots: readonly BudgetSnapshot[], date: string): BudgetSnapshot | undefined {
  return weekSnapshots(snapshots).find((b) => b.start <= date && date <= b.end);
}

/**
 * 今日の週の期間（予算を決める単位）。
 *  ・今日を含む予算の記録があれば、その記録の期間（週の始まりを切り替えても、今週の予算は残す）
 *  ・なければ、設定の週の始まりで数えた週。ただし、すでに決めた週の終わりより前には広げない
 *    （週の始まりを切り替えた直後にできる短い週は、その残りの日数だけになる）
 */
export function weekSpanOf(today: string, s: { weekStart?: WeekStart }, snapshots: readonly BudgetSnapshot[]): DateSpan {
  const containing = findWeekContaining(snapshots, today);
  if (containing) return { start: containing.start, end: containing.end };
  const natural = weekRange(today, s.weekStart ?? "monday");
  let start = natural.start;
  for (const b of weekSnapshots(snapshots)) {
    if (b.end < today && b.end >= start) start = addDays(b.end, 1);
  }
  return { start, end: natural.end };
}

/** 期間の日数（初日と最終日を含む） */
function spanDays(span: DateSpan): number {
  return daysBetween(span.start, span.end) + 1;
}

// ---- 変動費 ----

/** 週・月の「使った額」に数える支出か：タグが日常・満足・反省 */
export function isVariableExpense(t: Transaction): boolean {
  return t.deletedAt === null && t.type === "expense" && (t.tag === "daily" || t.tag === "satisfied" || t.tag === "regret");
}

/** 変動費の額：立替分を除き、取り置きから払った分を除く（枠から減るので使える額は減らない）。取り置きをこえた分は数える */
export function variableAmount(t: Transaction, spent: ReadonlyMap<Id, number>): number {
  if (!isVariableExpense(t)) return 0;
  return Math.max(0, countedExpense(t) - (spent.get(t.id) ?? 0));
}

/** 期間の変動費の合計 */
export function variableSpent(txs: readonly Transaction[], span: DateSpan, spent: ReadonlyMap<Id, number>): number {
  let sum = 0;
  for (const t of txs) if (inRange(t.date, span)) sum += variableAmount(t, spent);
  return sum;
}

/** 日ごとの変動費（start から days 日分） */
export function variableByDay(txs: readonly Transaction[], start: string, days: number, spent: ReadonlyMap<Id, number>): Array<{ date: string; amount: number }> {
  const map = new Map<string, number>();
  for (const t of txs) {
    const a = variableAmount(t, spent);
    if (a > 0) map.set(t.date, (map.get(t.date) ?? 0) + a);
  }
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    return { date, amount: map.get(date) ?? 0 };
  });
}

// ---- 給料 ----

/** 初期分類「給与」（大分類）の ID。この下の分類の収入、または給料明細から入れた収入を「給料」とみなす */
export const SALARY_PARENT_ID = "seed:income:給与";

export function isSalaryIncome(t: Transaction, categories: ReadonlyMap<Id, Category>): boolean {
  if (t.deletedAt !== null || t.type !== "income") return false;
  if (t.payrollId) return true;
  const c = t.categoryId ? categories.get(t.categoryId) : undefined;
  return !!c && (c.id === SALARY_PARENT_ID || c.parentId === SALARY_PARENT_ID);
}

/** 期間の中に給料（給与の収入・給料明細）が入っているか */
export function salaryEntered(data: Pick<BudgetData, "categories" | "transactions">, span: DateSpan): boolean {
  const cats = new Map(data.categories.map((c) => [c.id, c]));
  return data.transactions.some((t) => inRange(t.date, span) && isSalaryIncome(t, cats));
}

// ---- 決まった出費 ----

export interface CommittedItem {
  kind: "recurring" | "planned";
  date: string;
  label: string;
  amount: number;
}

/** 使える資産に含まれる資産の ID（削除済みは除く。非表示は含む） */
export function usableAccountIds(accounts: readonly Account[]): Set<Id> {
  return new Set(accounts.filter((a) => a.deletedAt === null && a.includeInUsable).map((a) => a.id));
}

/**
 * 繰り返しのひな形が使える資産から出ていく額。
 *  支出（使える資産から）＝金額、振替（使える資産 → 含めない資産）＝金額＋手数料。使える資産どうしの振替・収入は 0
 */
export function outflowOf(tpl: TransactionTemplate, usable: ReadonlySet<Id>): number {
  if (tpl.type === "expense") return usable.has(tpl.accountId) ? Math.max(0, tpl.amount) : 0;
  if (tpl.type === "transfer") {
    if (!usable.has(tpl.accountId)) return 0;
    if (tpl.toAccountId && usable.has(tpl.toAccountId)) return 0;
    return Math.max(0, tpl.amount) + Math.max(0, tpl.fee ?? 0);
  }
  return 0;
}

/** 繰り返しのひな形が使える資産へ入る額（収入のみ） */
export function inflowOf(tpl: TransactionTemplate, usable: ReadonlySet<Id>): number {
  return tpl.type === "income" && usable.has(tpl.accountId) ? Math.max(0, tpl.amount) : 0;
}

/** 見込み額の繰り返しは、前回作った明細の金額（なければひな形の金額）で数える */
export function expectedTemplate(rec: Recurring, lastAmounts: ReadonlyMap<Id, number>): TransactionTemplate {
  if (!rec.estimated) return rec.template;
  const last = lastAmounts.get(rec.id);
  return last === undefined ? rec.template : { ...rec.template, amount: last };
}

/** 繰り返しごとの、いちばん新しい明細の金額 */
export function lastRecurringAmounts(txs: readonly Transaction[]): Map<Id, number> {
  const latest = new Map<Id, Transaction>();
  for (const t of txs) {
    if (t.deletedAt !== null || !t.recurringId) continue;
    const cur = latest.get(t.recurringId);
    if (!cur || t.date > cur.date || (t.date === cur.date && t.createdAt > cur.createdAt)) latest.set(t.recurringId, t);
  }
  return new Map([...latest].map(([id, t]) => [id, t.amount]));
}

/** 期間の繰り返しのうち、まだ明細になっていない予定の「出ていくお金」と「入るお金」 */
export function recurringFlows(
  recurrings: readonly Recurring[],
  accounts: readonly Account[],
  txs: readonly Transaction[],
  from: string,
  to: string,
  opts: { ignoreGenerated?: boolean } = {},
): { out: CommittedItem[]; in: CommittedItem[] } {
  const usable = usableAccountIds(accounts);
  const lastAmounts = lastRecurringAmounts(txs);
  const recs = opts.ignoreGenerated ? recurrings.map((r) => ({ ...r, generatedThrough: undefined })) : recurrings;
  const result = { out: [] as CommittedItem[], in: [] as CommittedItem[] };
  for (const o of recurringOccurrencesBetween(recs, from, to)) {
    const tpl = expectedTemplate(o.recurring, lastAmounts);
    const label = tpl.content || "（内容なし）";
    const out = outflowOf(tpl, usable);
    if (out > 0) result.out.push({ kind: "recurring", date: o.date, label, amount: out });
    const inflow = inflowOf(tpl, usable);
    if (inflow > 0) result.in.push({ kind: "recurring", date: o.date, label, amount: inflow });
  }
  return result;
}

// ---- 使える額 ----

export interface UsableResult {
  /** 計算した日（今日、またはある日の時点） */
  date: string;
  /** 次の給料日（この日の前日までが期限） */
  deadline: string;
  /** 残り日数（計算した日を含む。deadline − date） */
  days: number;
  usableAssets: number;
  defenseFund: number;
  reserveTotal: number;
  committedRecurring: number;
  committedPlanned: number;
  committed: number;
  usable: number;
  /** 1日あたり（円未満は切り捨て。使える額がマイナスなら 0） */
  perDay: number;
  items: CommittedItem[];
}

/**
 * 使える額。asOf が true のときは「その日の時点」の額：その日より前の明細と、その日の日付の収入だけで残高を計算する
 * （週の予算を月曜の時点で決める・給料日の時点で月の予算を決めるため）。
 */
export function calcUsable(data: BudgetData, s: BudgetSettings, date: string, opts: { asOf?: boolean } = {}): UsableResult {
  const asOf = opts.asOf === true;
  const accounts = data.accounts.filter((a) => a.deletedAt === null);
  const txs = data.transactions.filter((t) => t.deletedAt === null && (!asOf || t.date < date || (t.type === "income" && t.date === date)));
  const moves = data.reserveMoves.filter((m) => m.deletedAt === null && (!asOf || m.date < date));
  const totals = summarizeAccounts(accounts, computeBalances(accounts, txs));
  const reserveTotal = totalReserveBalance(data.reserves, moves);

  const deadline = nextPaydayAfter(date, s);
  const through = addDays(deadline, -1);
  const flows = recurringFlows(data.recurrings, accounts, txs, date, through, { ignoreGenerated: asOf });
  const committedRecurring = flows.out.reduce((sum, i) => sum + i.amount, 0);
  const planned = data.plannedExpenses.filter((p) => p.deletedAt === null);
  const statuses = plannedStatuses(planned, reserveBalances(moves));
  const committedPlanned = plannedCommitted(planned, statuses, through);
  const items: CommittedItem[] = [...flows.out];
  for (const p of planned) {
    if (p.doneAt !== undefined || `${p.month}-01` > through) continue;
    const shortfall = statuses.get(p.id)?.shortfall ?? 0;
    if (shortfall > 0) items.push({ kind: "planned", date: `${p.month}-01`, label: p.name, amount: shortfall });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));

  const committed = committedRecurring + committedPlanned;
  const usable = totals.usable - s.defenseFund - reserveTotal - committed;
  const days = Math.max(1, daysBetween(date, deadline));
  return {
    date,
    deadline,
    days,
    usableAssets: totals.usable,
    defenseFund: s.defenseFund,
    reserveTotal,
    committedRecurring,
    committedPlanned,
    committed,
    usable,
    perDay: usable > 0 ? Math.floor(usable / days) : 0,
    items,
  };
}

/** 画面に出す「基準にした数字」（BudgetSnapshot.basis） */
function basisOf(r: UsableResult): Record<string, number> {
  return {
    usableAssets: r.usableAssets,
    defenseFund: r.defenseFund,
    reserveTotal: r.reserveTotal,
    committed: r.committed,
    usable: r.usable,
    days: r.days,
    perDay: r.perDay,
  };
}

// ---- 予算の決め方 ----

export interface BudgetPlan {
  amount: number;
  end: string;
  basis: Record<string, number>;
}

/**
 * 週の予算：週の初日の時点の1日あたり × その週のうち次の給料日の前日までの日数（最大でその週の日数。通常7日）。
 * 給料日からの分は tail で足す。end を渡さなければ初日から7日間。週の始まりを切り替えた直後の短い週は、end でその残りの日数にする。
 */
export function weekBudgetPlan(data: BudgetData, s: BudgetSettings, first: string, end: string = addDays(first, 6)): BudgetPlan {
  const r = calcUsable(data, s, first, { asOf: true });
  const headDays = Math.min(spanDays({ start: first, end }), r.days);
  const head = r.perDay * headDays;
  return { amount: head, end, basis: { ...basisOf(r), headDays, head } };
}

/** 給料日をまたぐ週の、給料日から週の最終日までの分：給料日の時点の1日あたり × 給料日から最終日までの日数 */
export function weekTailPlan(data: BudgetData, s: BudgetSettings, payday: string, last: string): { tail: number; tailDays: number; tailPerDay: number } {
  const r = calcUsable(data, s, payday, { asOf: true });
  const tailDays = daysBetween(payday, last) + 1;
  return { tail: r.perDay * tailDays, tailDays, tailPerDay: r.perDay };
}

/** 月の予算（区切りが給料日）：区切りの始まり（給料日）の時点の使える額。マイナスなら 0 */
export function monthBudgetPlanPayday(data: BudgetData, s: BudgetSettings, start: string): BudgetPlan {
  const r = calcUsable(data, s, start, { asOf: true });
  return { amount: Math.max(0, r.usable), end: addDays(r.deadline, -1), basis: basisOf(r) };
}

/** 月の予算（区切りが暦月）：1日の時点の「1日あたり × その月の日数」。使える額を超えない */
export function monthBudgetPlanCalendar(data: BudgetData, s: BudgetSettings, month: string): BudgetPlan {
  const range = monthRange(month);
  const r = calcUsable(data, s, range.start, { asOf: true });
  const [y, m] = month.split("-").map(Number);
  const monthDays = daysInMonth(y, m);
  return { amount: Math.max(0, Math.min(r.usable, r.perDay * monthDays)), end: range.end, basis: { ...basisOf(r), monthDays } };
}

/** 今の月の区切り（設定による） */
export function currentMonthSpan(s: BudgetSettings, today: string): DateSpan {
  return s.budgetMonthBoundary === "calendar" ? monthRange(today.slice(0, 7)) : paydayPeriodOf(today, s);
}

export function findSnapshot(snapshots: readonly BudgetSnapshot[], period: "week" | "month", start: string): BudgetSnapshot | undefined {
  return snapshots
    .filter((b) => b.deletedAt === null && b.period === period && b.start === start)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
}

/** 週の初日が給料日（区切りの始まり）で、まだ給料が入っていないか。入っていない間は週の予算を決めない */
export function weekWaitingForSalary(data: BudgetData, s: BudgetSettings, first: string): boolean {
  return paydayOnOrBefore(first, s) === first && !salaryEntered(data, paydayPeriodOf(first, s));
}

/** 月の予算（区切りが給料日）が、給料の入るのを待っているか */
export function monthWaitingForSalary(data: BudgetData, s: BudgetSettings, today: string): boolean {
  return s.budgetMonthBoundary === "payday" && !salaryEntered(data, paydayPeriodOf(today, s));
}

export interface BudgetContext {
  data: BudgetData;
  snapshots: readonly BudgetSnapshot[];
  settings: BudgetSettings;
  today: string;
  makeBase: () => Base;
  /** 決め直した時刻（ミリ秒） */
  nowMs: number;
}

function stamp(base: Base, period: "week" | "month", start: string, plan: BudgetPlan, existing?: BudgetSnapshot, recalculatedAt?: number): BudgetSnapshot {
  const basis = { ...plan.basis };
  if (recalculatedAt !== undefined) basis.recalculatedAt = recalculatedAt;
  return existing ? { ...existing, end: plan.end, amount: plan.amount, basis } : { ...base, period, start, end: plan.end, amount: plan.amount, basis };
}

/**
 * 給料日をまたぐ週の、給料日から日曜までの分を足した週の予算（足すものがなければ null）。
 * 足すのは、給料日が来て、その区切りの給料が入ってから（force なら給料を待たない）。
 */
export function weekWithTail(week: BudgetSnapshot, ctx: BudgetContext, force = false): BudgetSnapshot | null {
  const last = week.end;
  const payday = paydaysBetween(ctx.settings, addDays(week.start, 1), last)[0];
  if (!payday || payday > ctx.today) return null;
  if (!force) {
    if (week.basis.tail !== undefined) return null;
    if (!salaryEntered(ctx.data, paydayPeriodOf(payday, ctx.settings))) return null;
  }
  const t = weekTailPlan(ctx.data, ctx.settings, payday, last);
  const head = week.basis.head ?? week.amount - (week.basis.tail ?? 0);
  return { ...week, amount: head + t.tail, basis: { ...week.basis, head, tail: t.tail, tailDays: t.tailDays, tailPerDay: t.tailPerDay } };
}

/**
 * 開いたとき・戻ったとき・日付が変わったときに、まだ決まっていない今週・今月の予算を決める。書き込む予算を返す。
 *  同じ期間の予算は2回作らない（すでにあれば何もしない）。
 */
export function planBudgets(ctx: BudgetContext): BudgetSnapshot[] {
  const { data, settings: s, today } = ctx;
  // 明細が1件もないうちは決めない(0円で決まってしまうため)
  if (!data.transactions.some((t) => t.deletedAt === null)) return [];
  const out = new Map<Id, BudgetSnapshot>();
  const span = weekSpanOf(today, s, ctx.snapshots);

  let week = findSnapshot(ctx.snapshots, "week", span.start);
  if (!week && !weekWaitingForSalary(data, s, span.start)) {
    week = stamp(ctx.makeBase(), "week", span.start, weekBudgetPlan(data, s, span.start, span.end));
    out.set(week.id, week);
  }
  if (week) {
    const withTail = weekWithTail(week, ctx);
    if (withTail) {
      week = withTail;
      out.set(week.id, week);
    }
  }

  const monthSpan = currentMonthSpan(s, today);
  if (!findSnapshot(ctx.snapshots, "month", monthSpan.start) && !monthWaitingForSalary(data, s, today)) {
    const plan = s.budgetMonthBoundary === "calendar" ? monthBudgetPlanCalendar(data, s, today.slice(0, 7)) : monthBudgetPlanPayday(data, s, monthSpan.start);
    const month = stamp(ctx.makeBase(), "month", monthSpan.start, plan);
    out.set(month.id, month);
  }
  return [...out.values()];
}

/** 今の額で決め直す（まだ決まっていなければ決める）。今週の予算。書き込む予算を返す */
export function planRecalcWeek(ctx: BudgetContext): BudgetSnapshot[] {
  const span = weekSpanOf(ctx.today, ctx.settings, ctx.snapshots);
  const existing = findSnapshot(ctx.snapshots, "week", span.start);
  let week = stamp(ctx.makeBase(), "week", span.start, weekBudgetPlan(ctx.data, ctx.settings, span.start, span.end), existing, existing ? ctx.nowMs : undefined);
  const withTail = weekWithTail(week, ctx, true);
  if (withTail) week = withTail;
  return [week];
}

/** 今の額で決め直す（まだ決まっていなければ決める）。今月の予算。給料日の区切りのときは、またぐ週の分も合わせて直す */
export function planRecalcMonth(ctx: BudgetContext): BudgetSnapshot[] {
  const { data, settings: s, today } = ctx;
  const span = currentMonthSpan(s, today);
  const existing = findSnapshot(ctx.snapshots, "month", span.start);
  const plan = s.budgetMonthBoundary === "calendar" ? monthBudgetPlanCalendar(data, s, today.slice(0, 7)) : monthBudgetPlanPayday(data, s, span.start);
  const out: BudgetSnapshot[] = [stamp(ctx.makeBase(), "month", span.start, plan, existing, existing ? ctx.nowMs : undefined)];
  if (s.budgetMonthBoundary === "payday") {
    const week = findWeekContaining(ctx.snapshots, span.start);
    const withTail = week ? weekWithTail(week, ctx, true) : null;
    if (withTail) out.push(withTail);
  }
  return out;
}

// ---- ホームの数字 ----

export interface BudgetFigure {
  start: string;
  end: string;
  snapshot: BudgetSnapshot | undefined;
  /** 給料明細（給料）が入るのを待って、まだ決めていない */
  waiting: boolean;
  spent: number;
  /** 予算 − 使った額（予算が決まっていなければ null）。マイナスならこえている */
  remaining: number | null;
}

/** はじめて使う状態か：資産も明細もない（削除済みは数えない）。ホームの「はじめに」と、内訳・見通しの数字を隠すかの判定 */
export function isFirstUse(data: Pick<BudgetData, "accounts" | "transactions">): boolean {
  return !data.accounts.some((a) => a.deletedAt === null) && !data.transactions.some((t) => t.deletedAt === null);
}

export interface HomeSummary {
  usable: UsableResult;
  hasTransactions: boolean;
  /** 資産も明細もない（はじめて開いた人）。内訳の数字・見通しの表は出さず、「はじめに」を出す */
  firstUse: boolean;
  week: BudgetFigure & { bars: Array<{ date: string; amount: number }> };
  month: BudgetFigure;
  reserveTotal: number;
  /** 今の給料日が来ているのに給料がまだ入っていない（その給料日） */
  salaryPending: string | null;
}

/** ホームに出す数字を、まとめて計算する */
export function summarizeHome(data: BudgetData, snapshots: readonly BudgetSnapshot[], s: BudgetSettings, today: string): HomeSummary {
  const txs = data.transactions.filter((t) => t.deletedAt === null);
  const spentMap = spendByTx(data.reserveMoves);
  const usable = calcUsable(data, s, today);

  const weekSpan = weekSpanOf(today, s, snapshots);
  const weekSnap = findSnapshot(snapshots, "week", weekSpan.start);
  const weekSpent = variableSpent(txs, weekSpan, spentMap);

  const monthSpan = currentMonthSpan(s, today);
  const monthSnap = findSnapshot(snapshots, "month", monthSpan.start);
  const monthRangeNow = monthSnap ? { start: monthSnap.start, end: monthSnap.end } : monthSpan;
  const monthSpent = variableSpent(txs, monthRangeNow, spentMap);

  const period = paydayPeriodOf(today, s);
  const salaryPending = today >= period.start && !salaryEntered(data, period) && txs.length > 0 ? period.start : null;

  return {
    usable,
    hasTransactions: txs.length > 0,
    firstUse: isFirstUse(data),
    week: {
      start: weekSpan.start,
      end: weekSpan.end,
      snapshot: weekSnap,
      waiting: !weekSnap && weekWaitingForSalary(data, s, weekSpan.start),
      spent: weekSpent,
      remaining: weekSnap ? weekSnap.amount - weekSpent : null,
      bars: variableByDay(txs, weekSpan.start, spanDays(weekSpan), spentMap),
    },
    month: {
      start: monthRangeNow.start,
      end: monthRangeNow.end,
      snapshot: monthSnap,
      waiting: !monthSnap && monthWaitingForSalary(data, s, today),
      spent: monthSpent,
      remaining: monthSnap ? monthSnap.amount - monthSpent : null,
    },
    reserveTotal: usable.reserveTotal,
    salaryPending,
  };
}

/** バックアップのお知らせの文章（なければ null） */
export function backupNotice(s: Pick<Settings, "lastBackupAt" | "backupReminderDays">, hasTransactions: boolean, today: string): string | null {
  if (!hasTransactions) return null;
  if (s.lastBackupAt === null) return "まだバックアップを保存していません";
  const last = new Date(s.lastBackupAt);
  if (Number.isNaN(last.getTime())) return null;
  const lastDay = toDateKey(last);
  if (!isLocalDate(lastDay)) return null;
  const days = daysBetween(lastDay, today);
  return days >= s.backupReminderDays ? `最後のバックアップから${days}日たちました` : null;
}
