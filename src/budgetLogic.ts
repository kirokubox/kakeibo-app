// 使える額と、週・月の予算のロジック（画面から切り離した純粋なロジック）。
// 正本：05_開発・Webアプリ/17_家計簿/171_家計簿_初期仕様.md §6、172_家計簿_実装指示_段階6 §3・§4
//   使える額 ＝ 使える資産 − 生活防衛資金 − 取り置き残高 − 決まった出費（期限は次の給料日。給料日より前の収入は足さない）
import { computeBalances, summarizeAccounts } from "./accountLogic.js";
import { nextPayday, paydayOf } from "./businessDay.js";
import { addDays, addMonths, daysInMonth, isLocalDate, toDateKey } from "./dateUtils.js";
import { plannedCommitted, plannedStatuses } from "./plannedLogic.js";
import { isYen } from "./money.js";
import { countedExpense, inRange, monthRange, weekRange } from "./periodLogic.js";
import { reserveBalances, spendByTx, totalReserveBalance } from "./reserveLogic.js";
import { paydaysBetween, recurringOccurrencesBetween } from "./scheduleLogic.js";
import type { Account, Base, BudgetBasis, BudgetMode, BudgetSnapshot, Category, DataSet, HolidayShift, Id, Recurring, Settings, Transaction, TransactionTemplate, WeekStart } from "./types.js";

export type BudgetData = Pick<DataSet, "accounts" | "categories" | "transactions" | "recurrings" | "reserves" | "reserveMoves" | "plannedExpenses">;
/** weekStart は省略すると月曜始まり */
export type BudgetSettings = Pick<Settings, "payday" | "paydayHolidayShift" | "defenseFund" | "budgetMonthBoundary"> & {
  weekStart?: WeekStart;
  /** 予算の決め方（省略は自動）。manual は monthlyBudget が1円以上のときだけ効く */
  budgetMode?: BudgetMode;
  monthlyBudget?: number | null;
};
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
  if (t.payrollId || t.payrollBatchId) return true;
  const c = t.categoryId ? categories.get(t.categoryId) : undefined;
  return !!c && (c.id === SALARY_PARENT_ID || c.parentId === SALARY_PARENT_ID);
}

/** 期間の中に給料（給与の収入・給料明細）が入っているか */
export function salaryEntered(data: Pick<BudgetData, "categories" | "transactions">, span: DateSpan): boolean {
  const cats = new Map(data.categories.map((c) => [c.id, c]));
  return data.transactions.some((t) => inRange(t.date, span) && isSalaryIncome(t, cats));
}

/**
 * 区切りの中で入った給料の明細1枚分。自動の月の予算を「給料込み」で決めるための材料。
 *  ・最初に入った給料（給料明細から入れたもの＝payrollBatchId、または給与の分類の収入）を見つける
 *  ・給料明細から入れたものは payrollBatchId が同じ明細の全部（支給・控除・天引き）
 *  ・それ以外は、同じ日・同じ口座の給与の収入と、同じ日・同じ口座から出る控除（支出・振替）
 * 給料がまだ入っていなければ空。
 */
export function salaryBatchIn(data: Pick<BudgetData, "categories" | "transactions">, span: DateSpan): Transaction[] {
  const cats = new Map(data.categories.map((c) => [c.id, c]));
  const active = data.transactions.filter((t) => t.deletedAt === null);
  const firstSalary = active
    .filter((t) => inRange(t.date, span) && isSalaryIncome(t, cats))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (!firstSalary) return [];
  if (firstSalary.payrollBatchId) return active.filter((t) => t.payrollBatchId === firstSalary.payrollBatchId);
  return active.filter((t) => t.date === firstSalary.date && t.accountId === firstSalary.accountId && (t.type === "expense" || t.type === "transfer" || isSalaryIncome(t, cats)));
}

/** date が給料日（区切りの始まり）なら、その区切りで入った給料の明細1枚分のid。そうでなければ空 */
function salaryIdsAt(data: BudgetData, s: BudgetSettings, date: string): Set<Id> {
  if (paydayOnOrBefore(date, s) !== date) return new Set();
  return new Set(salaryBatchIn(data, paydayPeriodOf(date, s)).map((t) => t.id));
}

// ---- 決まった出費 ----

export interface CommittedItem {
  /** future＝先の日付の明細（使える資産から出るもの。改善2） */
  kind: "recurring" | "planned" | "future";
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
  /** 先の日付の明細（使える資産から出るもの。次の給料日の前日まで）の合計 */
  committedFuture: number;
  committed: number;
  usable: number;
  /** 1日あたり（円未満は切り捨て。使える額がマイナスなら 0） */
  perDay: number;
  items: CommittedItem[];
}

/**
 * 使える額。asOf が true のときは「その日の時点」の額：その日より前の明細と、その日の日付の収入だけで残高を計算する
 * （週の予算を月曜の時点で決める・給料日の時点で月の予算を決めるため）。include に明細のidを渡すと、日付にかかわらず残高に足す
 * （区切りの始まりより後の日付で入った給料の明細1枚分を足して、給料込みで決めるため）。
 * asOf でないときは「今日までの明細」で残高を計算し、先の日付の明細は含めない。
 * 先の日付の支出（使える資産から出るもの）で次の給料日の前日までのものは、決まった出費に入れる（使える資産どうしの振替は入れない）。
 */
export function calcUsable(data: BudgetData, s: BudgetSettings, date: string, opts: { asOf?: boolean; include?: ReadonlySet<Id> } = {}): UsableResult {
  const asOf = opts.asOf === true;
  const include = opts.include;
  const accounts = data.accounts.filter((a) => a.deletedAt === null);
  const txs = data.transactions.filter(
    (t) => t.deletedAt === null && (asOf ? t.date < date || (t.type === "income" && t.date === date) || (include?.has(t.id) ?? false) : t.date <= date),
  );
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
  let committedFuture = 0;
  if (!asOf) {
    const usable = usableAccountIds(accounts);
    const spentMap = spendByTx(data.reserveMoves);
    for (const t of data.transactions) {
      if (t.deletedAt !== null || t.date <= date || t.date > through || (t.type !== "expense" && t.type !== "transfer")) continue;
      const out = Math.max(0, outflowOf(t, usable) - (spentMap.get(t.id) ?? 0));
      if (out <= 0) continue;
      committedFuture += out;
      items.push({ kind: "future", date: t.date, label: t.content || "（内容なし）", amount: out });
    }
  }
  for (const p of planned) {
    if (p.doneAt !== undefined || `${p.month}-01` > through) continue;
    const shortfall = statuses.get(p.id)?.shortfall ?? 0;
    if (shortfall > 0) items.push({ kind: "planned", date: `${p.month}-01`, label: p.name, amount: shortfall });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));

  const committed = committedRecurring + committedPlanned + committedFuture;
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
    committedFuture,
    committed,
    usable,
    perDay: usable > 0 ? Math.floor(usable / days) : 0,
    items,
  };
}

/** 画面に出す「基準にした数字」（BudgetSnapshot.basis） */
function basisOf(r: UsableResult): BudgetBasis {
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
  basis: BudgetBasis;
}

/** basis の数字（数字でなければ undefined） */
function basisNum(basis: BudgetBasis, key: string): number | undefined {
  const v = basis[key];
  return typeof v === "number" ? v : undefined;
}

/** 自分で決める月の予算が使えるか（予算の決め方が manual で、金額が1円以上） */
export function isManualBudget(s: BudgetSettings): boolean {
  return s.budgetMode === "manual" && isYen(s.monthlyBudget) && s.monthlyBudget > 0;
}

/** 予算の記録が「自分で決めた」ものか */
export function isManualSnapshot(b: BudgetSnapshot): boolean {
  return b.basis.mode === "manual";
}

/**
 * 週の予算：週の初日の時点の1日あたり × その週のうち次の給料日の前日までの日数（最大でその週の日数。通常7日）。
 * 給料日からの分は tail で足す。end を渡さなければ初日から7日間。週の始まりを切り替えた直後の短い週は、end でその残りの日数にする。
 */
export function weekBudgetPlan(data: BudgetData, s: BudgetSettings, first: string, end: string = addDays(first, 6)): BudgetPlan {
  // 週の初日が給料日なら、その区切りで入った給料の明細1枚分を足して決める
  const r = calcUsable(data, s, first, { asOf: true, include: salaryIdsAt(data, s, first) });
  const headDays = Math.min(spanDays({ start: first, end }), r.days);
  const head = r.perDay * headDays;
  return { amount: head, end, basis: { ...basisOf(r), headDays, head } };
}

/** 給料日をまたぐ週の、給料日から週の最終日までの分：給料日の時点の1日あたり × 給料日から最終日までの日数 */
export function weekTailPlan(data: BudgetData, s: BudgetSettings, payday: string, last: string): { tail: number; tailDays: number; tailPerDay: number } {
  const r = calcUsable(data, s, payday, { asOf: true, include: salaryIdsAt(data, s, payday) });
  const tailDays = daysBetween(payday, last) + 1;
  return { tail: r.perDay * tailDays, tailDays, tailPerDay: r.perDay };
}

/**
 * 月の予算（区切りが給料日）：区切りの始まり（給料日）の時点の使える額。マイナスなら 0。
 * 給料の明細が区切りの始まりより後の日付（例：25日が日曜で給料日が23日、明細は25日）でも、
 * 区切りの始まりの前日までの残高に「区切りの中で入った給料の明細1枚分」を足して、給料込みで決める。
 */
export function monthBudgetPlanPayday(data: BudgetData, s: BudgetSettings, start: string): BudgetPlan {
  const include = new Set(salaryBatchIn(data, paydayPeriodOf(start, s)).map((t) => t.id));
  const r = calcUsable(data, s, start, { asOf: true, include });
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

// ---- 自分で決める月の予算（改善2） ----

/** 月の予算（自分で決める）：設定の金額。区切りの始まりに決める */
export function monthBudgetPlanManual(s: BudgetSettings, span: DateSpan): BudgetPlan {
  const amount = s.monthlyBudget ?? 0;
  return { amount, end: span.end, basis: { mode: "manual", monthBudget: amount, days: spanDays(span) } };
}

/** その日を含む区切りの月の予算（記録があればその金額、なければ今の設定の金額） */
function manualMonthAmountFor(snapshots: readonly BudgetSnapshot[], s: BudgetSettings, span: DateSpan): number {
  const snap = findSnapshot(snapshots, "month", span.start);
  return snap && isManualSnapshot(snap) ? snap.amount : (s.monthlyBudget ?? 0);
}

/**
 * 週の予算（自分で決める）＝（月の予算 − この区切りで週の初日の前日までに使った額）÷ 区切りの残り日数（週の初日から区切りの最後まで）
 * × その週のうち区切りに入る日数。円未満は切り捨て、0未満は0。区切りをまたぐ週は、前半の分だけ（後半は weekWithTail で足す）。
 */
export function weekBudgetPlanManual(data: BudgetData, s: BudgetSettings, snapshots: readonly BudgetSnapshot[], first: string, end: string = addDays(first, 6)): BudgetPlan {
  const period = currentMonthSpan(s, first);
  const monthBudget = manualMonthAmountFor(snapshots, s, period);
  const txs = data.transactions.filter((t) => t.deletedAt === null);
  const used = first > period.start ? variableSpent(txs, { start: period.start, end: addDays(first, -1) }, spendByTx(data.reserveMoves)) : 0;
  const remainingDays = Math.max(1, daysBetween(first, period.end) + 1);
  const headDays = Math.min(spanDays({ start: first, end }), remainingDays);
  const head = Math.max(0, Math.floor((Math.max(0, monthBudget - used) * headDays) / remainingDays));
  return { amount: head, end, basis: { mode: "manual", monthBudget, used, remainingDays, headDays, head } };
}

/** 区切りの始まりの日（給料日の区切りなら給料日、暦月なら1日）が from〜to にあるもの */
function periodStartsBetween(s: BudgetSettings, from: string, to: string): string[] {
  if (s.budgetMonthBoundary !== "calendar") return paydaysBetween(s, from, to);
  const out: string[] = [];
  for (let ym = from.slice(0, 7); `${ym}-01` <= to; ym = addMonths(ym, 1)) {
    const d = `${ym}-01`;
    if (d >= from && d <= to) out.push(d);
  }
  return out;
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
 * 自分で決める月の予算のときは、新しい区切りの始まりが来たら（給料を待たず）、新しい月の予算 ÷ 新しい区切りの日数 × 後半の日数を足す。
 */
export function weekWithTail(week: BudgetSnapshot, ctx: BudgetContext, force = false): BudgetSnapshot | null {
  const last = week.end;
  if (isManualBudget(ctx.settings)) {
    const start = periodStartsBetween(ctx.settings, addDays(week.start, 1), last)[0];
    if (!start || start > ctx.today) return null;
    if (!force && basisNum(week.basis, "tail") !== undefined) return null;
    const span = currentMonthSpan(ctx.settings, start);
    const monthBudget = manualMonthAmountFor(ctx.snapshots, ctx.settings, span);
    const tailDays = daysBetween(start, last) + 1;
    const tail = Math.max(0, Math.floor((monthBudget * tailDays) / spanDays(span)));
    const head = basisNum(week.basis, "head") ?? week.amount - (basisNum(week.basis, "tail") ?? 0);
    return { ...week, amount: head + tail, basis: { ...week.basis, mode: "manual", head, tail, tailDays, tailMonthBudget: monthBudget } };
  }
  const payday = paydaysBetween(ctx.settings, addDays(week.start, 1), last)[0];
  if (!payday || payday > ctx.today) return null;
  if (!force) {
    if (week.basis.tail !== undefined) return null;
    if (!salaryEntered(ctx.data, paydayPeriodOf(payday, ctx.settings))) return null;
  }
  const t = weekTailPlan(ctx.data, ctx.settings, payday, last);
  const head = basisNum(week.basis, "head") ?? week.amount - (basisNum(week.basis, "tail") ?? 0);
  const basis: BudgetBasis = { ...week.basis, head, tail: t.tail, tailDays: t.tailDays, tailPerDay: t.tailPerDay };
  delete basis.mode;
  return { ...week, amount: head + t.tail, basis };
}

/** 予算の記録の入れ替え（同じidは新しいほうに）。あとの計算で、いま決めた分を見えるようにする */
function withSnapshots(snapshots: readonly BudgetSnapshot[], written: Iterable<BudgetSnapshot>): BudgetSnapshot[] {
  const map = new Map(snapshots.map((b) => [b.id, b]));
  for (const b of written) map.set(b.id, b);
  return [...map.values()];
}

/** 自分で決める月の予算のとき：まだ決まっていない（または決め方が違う）今月・今週の予算を決める */
function planBudgetsManual(ctx: BudgetContext): BudgetSnapshot[] {
  const { data, settings: s, today } = ctx;
  const out = new Map<Id, BudgetSnapshot>();
  const now = ctx.nowMs;

  const monthSpan = currentMonthSpan(s, today);
  const existingMonth = findSnapshot(ctx.snapshots, "month", monthSpan.start);
  if (!existingMonth) {
    const month = stamp(ctx.makeBase(), "month", monthSpan.start, monthBudgetPlanManual(s, monthSpan));
    out.set(month.id, month);
  } else if (!isManualSnapshot(existingMonth)) {
    // 予算の決め方を自動から切り替えた直後：今の区切りの記録を、自分で決めた月の予算に入れ替える
    const month = stamp(ctx.makeBase(), "month", monthSpan.start, monthBudgetPlanManual(s, monthSpan), existingMonth, now);
    out.set(month.id, month);
  }
  const snaps = withSnapshots(ctx.snapshots, out.values());

  const weekSpan = weekSpanOf(today, s, snaps);
  const existingWeek = findSnapshot(snaps, "week", weekSpan.start);
  let week: BudgetSnapshot | undefined = existingWeek;
  if (!existingWeek) {
    week = stamp(ctx.makeBase(), "week", weekSpan.start, weekBudgetPlanManual(data, s, snaps, weekSpan.start, weekSpan.end));
    out.set(week.id, week);
  } else if (!isManualSnapshot(existingWeek)) {
    week = stamp(ctx.makeBase(), "week", weekSpan.start, weekBudgetPlanManual(data, s, snaps, weekSpan.start, weekSpan.end), existingWeek, now);
    out.set(week.id, week);
  }
  if (week) {
    const withTail = weekWithTail(week, { ...ctx, snapshots: snaps });
    if (withTail) out.set(withTail.id, withTail);
  }
  return [...out.values()];
}

/**
 * 開いたとき・戻ったとき・日付が変わったときに、まだ決まっていない今週・今月の予算を決める。書き込む予算を返す。
 *  同じ期間の予算は2回作らない（すでにあれば何もしない）。
 */
export function planBudgets(ctx: BudgetContext): BudgetSnapshot[] {
  const { data, settings: s, today } = ctx;
  // 明細が1件もないうちは決めない(0円で決まってしまうため)
  if (!data.transactions.some((t) => t.deletedAt === null)) return [];
  if (isManualBudget(s)) return planBudgetsManual(ctx);
  const out = new Map<Id, BudgetSnapshot>();
  const span = weekSpanOf(today, s, ctx.snapshots);

  let week = findSnapshot(ctx.snapshots, "week", span.start);
  if (week && isManualSnapshot(week) && !weekWaitingForSalary(data, s, span.start)) {
    // 予算の決め方を「自分で決める」から自動に戻した直後：今週の記録を、自動の計算に入れ替える
    week = stamp(ctx.makeBase(), "week", span.start, weekBudgetPlan(data, s, span.start, span.end), week, ctx.nowMs);
    out.set(week.id, week);
  } else if (!week && !weekWaitingForSalary(data, s, span.start)) {
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
  const existingMonth = findSnapshot(ctx.snapshots, "month", monthSpan.start);
  if ((!existingMonth || isManualSnapshot(existingMonth)) && !monthWaitingForSalary(data, s, today)) {
    const plan = s.budgetMonthBoundary === "calendar" ? monthBudgetPlanCalendar(data, s, today.slice(0, 7)) : monthBudgetPlanPayday(data, s, monthSpan.start);
    const month = stamp(ctx.makeBase(), "month", monthSpan.start, plan, existingMonth, existingMonth ? ctx.nowMs : undefined);
    out.set(month.id, month);
  }
  return [...out.values()];
}

/** 今の額で決め直す（まだ決まっていなければ決める）。今週の予算。書き込む予算を返す */
export function planRecalcWeek(ctx: BudgetContext): BudgetSnapshot[] {
  const span = weekSpanOf(ctx.today, ctx.settings, ctx.snapshots);
  const existing = findSnapshot(ctx.snapshots, "week", span.start);
  const plan = isManualBudget(ctx.settings)
    ? weekBudgetPlanManual(ctx.data, ctx.settings, ctx.snapshots, span.start, span.end)
    : weekBudgetPlan(ctx.data, ctx.settings, span.start, span.end);
  let week = stamp(ctx.makeBase(), "week", span.start, plan, existing, existing ? ctx.nowMs : undefined);
  const withTail = weekWithTail(week, ctx, true);
  if (withTail) week = withTail;
  return [week];
}

/**
 * 今の額で決め直す（まだ決まっていなければ決める）。今月の予算。給料日の区切りのときは、またぐ週の分も合わせて直す。
 * 自分で決める月の予算のときは、今の設定の金額で決め直し、今週の予算も新しい金額から計算しなおす。
 */
export function planRecalcMonth(ctx: BudgetContext): BudgetSnapshot[] {
  const { data, settings: s, today } = ctx;
  const span = currentMonthSpan(s, today);
  const existing = findSnapshot(ctx.snapshots, "month", span.start);
  if (isManualBudget(s)) {
    const month = stamp(ctx.makeBase(), "month", span.start, monthBudgetPlanManual(s, span), existing, existing ? ctx.nowMs : undefined);
    const out: BudgetSnapshot[] = [month];
    const snaps = withSnapshots(ctx.snapshots, out);
    const weekCtx = { ...ctx, snapshots: snaps };
    for (const w of planRecalcWeek(weekCtx)) out.push(w);
    // 区切りをまたぐ週が今週と別なら、その週の後半（新しい区切りの分）も直す
    const crossing = findWeekContaining(snaps, span.start);
    if (crossing && !out.some((b) => b.id === crossing.id)) {
      const withTail = weekWithTail(crossing, weekCtx, true);
      if (withTail) out.push(withTail);
    }
    return out;
  }
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
  /** 予算を自分で決めているか（月の予算を設定の金額で決める） */
  manual: boolean;
  /**
   * 使い切れる上限（今の自動の計算）。自分で決めているときだけ。
   * 週＝給料日までに使える額 ÷ 残り日数 × 7、月＝自動の月の予算（給料込み）。使える額がマイナスなら 0
   */
  limit: { week: number; month: number | null } | null;
}

/** 使い切れる上限（今の自動の計算）：週と月 */
function autoLimits(data: BudgetData, s: BudgetSettings, today: string, usable: UsableResult, monthSpan: DateSpan): { week: number; month: number | null } {
  const week = usable.usable > 0 ? Math.floor((usable.usable * 7) / usable.days) : 0;
  // 月の自動の予算は、給料が入っていれば出せる（給料日の区切りで給料がまだなら null）
  let month: number | null = null;
  if (s.budgetMonthBoundary === "calendar") month = monthBudgetPlanCalendar(data, s, today.slice(0, 7)).amount;
  else if (salaryEntered(data, monthSpan)) month = monthBudgetPlanPayday(data, s, monthSpan.start).amount;
  return { week, month };
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

  const manual = isManualBudget(s);
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
      waiting: !manual && !weekSnap && weekWaitingForSalary(data, s, weekSpan.start),
      spent: weekSpent,
      remaining: weekSnap ? weekSnap.amount - weekSpent : null,
      bars: variableByDay(txs, weekSpan.start, spanDays(weekSpan), spentMap),
    },
    month: {
      start: monthRangeNow.start,
      end: monthRangeNow.end,
      snapshot: monthSnap,
      waiting: !manual && !monthSnap && monthWaitingForSalary(data, s, today),
      spent: monthSpent,
      remaining: monthSnap ? monthSnap.amount - monthSpent : null,
    },
    reserveTotal: usable.reserveTotal,
    salaryPending,
    manual,
    limit: manual ? autoLimits(data, s, today, usable, monthSpan) : null,
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
