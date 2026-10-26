// 見通しの表のロジック（画面から切り離した純粋なロジック）。
// 給料日ごとの区切りで、3か月・6か月・1年（12列）先までの「期のはじめの使える資産 → 期末の見込み」を出す。
// 正本：172_家計簿_実装指示_段階6 §8、初期仕様 §6（その区切りの給料でその区切りをまかなえるか。前借りの見え方にしない）
import { computeBalancesUntil, summarizeAccounts } from "./accountLogic.js";
import { upcomingCardDebits } from "./cardDebitLogic.js";
import { addDays, addMonths } from "./dateUtils.js";
import { inflowOf, nextPaydayAfter, outflowOf, paydayOnOrBefore, recurringFlows, usableAccountIds, variableSpent } from "./budgetLogic.js";
import type { BudgetSettings, CommittedItem, DateSpan } from "./budgetLogic.js";
import { openPlannedIncomes, plannedStatuses, sortPlanned } from "./plannedLogic.js";
import { reserveBalances, spendByTx } from "./reserveLogic.js";
import { payrollForecast } from "./scheduleLogic.js";
import type { CardStatement, DataSet, PlannedExpense, PlannedIncome, Transaction } from "./types.js";

export type OutlookData = Pick<DataSet, "accounts" | "categories" | "transactions" | "recurrings" | "reserves" | "reserveMoves" | "plannedExpenses" | "payrolls"> & {
  /** 予定収入（省略は無し） */
  plannedIncomes?: PlannedIncome[];
  /** カードの請求（引き落とし予定の参考行に使う。省略は無し） */
  cardStatements?: CardStatement[];
};

/** 見通しの長さ（給料日ごとの区切りの数）。3か月・6か月・1年 */
export type OutlookMonths = 3 | 6 | 12;
export const OUTLOOK_LENGTHS: readonly OutlookMonths[] = [3, 6, 12];

export interface OutlookPlanned {
  planned: PlannedExpense;
  /** 取り置き済み（結んだ取り置きの残高から充てた額） */
  covered: number;
}

export interface OutlookColumn {
  /** 見出しに使う区切り（今の区切りは給料日から） */
  start: string;
  end: string;
  /** 期のはじめの使える資産（今の区切りは今日の使える資産、次からは前の列の期末の見込み） */
  openAssets: number;
  income: number;
  fixed: number;
  planned: number;
  /** 予定出費のうち取り置き済みの額（薄く併記する） */
  plannedReserved: number;
  /** 変動費の見込み（直近の終わった区切りの平均。1区切りもなければ null） */
  variable: number | null;
  /** 期末の見込み = はじめ + 収入 + 予定収入（見込み） − 決まった出費 − 予定出費 − 変動費の見込み */
  closing: number;
  /** 収入（予定収入を含む） − 出費（決まった出費 + 予定出費 + 変動費の見込み） */
  net: number;
  /** 生活防衛資金を下回る見込み */
  belowFund: boolean;
  fixedItems: CommittedItem[];
  plannedItems: OutlookPlanned[];
  /** 予定収入（見込み）。期末の見込みに足す（使える額・予算には入れない） */
  plannedIncome: number;
  plannedIncomeItems: PlannedIncome[];
  /** カードの引き落とし（参考。使える額・期末の見込みには影響しない。カードで使った時点で引いているため） */
  cardDebit: number;
}

export interface Outlook {
  columns: OutlookColumn[];
  /** 変動費の見込みに使った終わった区切りの数（0〜3） */
  averagedPeriods: number;
  /** 今の区切りで、もう使った変動費（今の列の変動費の見込みから引いている） */
  currentSpent: number;
}

/** 見出し：10/23〜11/24 */
export function periodLabel(start: string, end: string): string {
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${md(start)}〜${md(end)}`;
}

/** 今の区切りから count 個の区切り */
export function futurePeriods(today: string, s: BudgetSettings, count: number): DateSpan[] {
  const out: DateSpan[] = [];
  let start = paydayOnOrBefore(today, s);
  for (let i = 0; i < count; i++) {
    const next = nextPaydayAfter(start, s);
    out.push({ start, end: addDays(next, -1) });
    start = next;
  }
  return out;
}

/** 終わった区切りを新しいほうから count 個（今の区切りの前から） */
export function pastPeriods(today: string, s: BudgetSettings, count: number): DateSpan[] {
  const out: DateSpan[] = [];
  let end = addDays(paydayOnOrBefore(today, s), -1);
  for (let i = 0; i < count; i++) {
    const start = paydayOnOrBefore(end, s);
    out.push({ start, end });
    end = addDays(start, -1);
  }
  return out;
}

/** 直近の終わった3区切りの変動費の平均（3つなければある分で）。データが区切りの始まりより前から無い区切りは数えない */
export function averageVariable(data: Pick<OutlookData, "transactions" | "reserveMoves">, today: string, s: BudgetSettings): { average: number | null; periods: number } {
  const txs = data.transactions.filter((t) => t.deletedAt === null);
  if (txs.length === 0) return { average: null, periods: 0 };
  const first = txs.reduce((min, t) => (t.date < min ? t.date : min), txs[0].date);
  const spent = spendByTx(data.reserveMoves);
  const values: number[] = [];
  for (const p of pastPeriods(today, s, 3)) {
    if (first > p.start) break;
    values.push(variableSpent(txs, p, spent));
  }
  if (values.length === 0) return { average: null, periods: 0 };
  return { average: Math.round(values.reduce((a, b) => a + b, 0) / values.length), periods: values.length };
}

/** 給料明細のひな形から、期間の手取りの見込み（すでにその日の給料明細を入れていれば数えない） */
export function payrollIncomeBetween(data: Pick<OutlookData, "payrolls" | "transactions">, from: string, to: string): CommittedItem[] {
  const out: CommittedItem[] = [];
  const dates = new Set<string>();
  for (const p of data.payrolls) {
    if (p.deletedAt !== null) continue;
    for (let ym = addMonths(from.slice(0, 7), -1); ym <= addMonths(to.slice(0, 7), 1); ym = addMonths(ym, 1)) {
      const f = payrollForecast(p, ym);
      if (f.date < from || f.date > to || f.takeHome <= 0) continue;
      const key = `${p.id}:${f.date}`;
      if (dates.has(key)) continue;
      dates.add(key);
      // その日の給料明細がすでに入っているなら、資産に入っているので数えない
      if (data.transactions.some((t) => t.deletedAt === null && t.payrollId === p.id && t.date === f.date)) continue;
      out.push({ kind: "recurring", date: f.date, label: p.name || "給料", amount: f.takeHome });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 今日から見通しの最後の区切りの終わりまでの日数（カードの引き落とし予定を探す範囲） */
function daysUntil(today: string, months: OutlookMonths, s: BudgetSettings): number {
  const last = futurePeriods(today, s, months).pop();
  if (!last) return 0;
  const [ay, am, ad] = today.split("-").map(Number);
  const [by, bm, bd] = last.end.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 先の日付の明細（今日より後）のうち、from〜to の使える資産から出る額・入る額 */
export function futureTxFlows(
  futureTxs: readonly Transaction[],
  usable: ReadonlySet<string>,
  from: string,
  to: string,
): { out: CommittedItem[]; in: CommittedItem[] } {
  const result = { out: [] as CommittedItem[], in: [] as CommittedItem[] };
  for (const t of futureTxs) {
    if (t.date < from || t.date > to) continue;
    const label = t.content || "（内容なし）";
    const out = outflowOf(t, usable);
    if (out > 0) result.out.push({ kind: "future", date: t.date, label, amount: out });
    const inflow = inflowOf(t, usable);
    if (inflow > 0) result.in.push({ kind: "future", date: t.date, label, amount: inflow });
  }
  return result;
}

/** 見通しの表をつくる */
export function buildOutlook(data: OutlookData, s: BudgetSettings, today: string, months: OutlookMonths): Outlook {
  const accounts = data.accounts.filter((a) => a.deletedAt === null);
  const txs = data.transactions.filter((t) => t.deletedAt === null);
  // 今日までの明細で残高を出す。先の日付の明細は、その日の区切りの収入・決まった出費として数える
  const totals = summarizeAccounts(accounts, computeBalancesUntil(accounts, txs, today));
  const usableIds = usableAccountIds(accounts);
  const futureTxs = txs.filter((t) => t.date > today);
  const incomes = openPlannedIncomes(data.plannedIncomes ?? []);
  const debits = upcomingCardDebits({ accounts, transactions: txs, cardStatements: data.cardStatements ?? [] }, today, daysUntil(today, months, s));
  const planned = sortPlanned(data.plannedExpenses.filter((p) => p.deletedAt === null && p.doneAt === undefined));
  const statuses = plannedStatuses(planned, reserveBalances(data.reserveMoves.filter((m) => m.deletedAt === null)));
  const { average, periods } = averageVariable(data, today, s);
  const spentMap = spendByTx(data.reserveMoves);

  const spans = futurePeriods(today, s, months);
  const currentSpent = variableSpent(txs, spans[0], spentMap);
  const columns: OutlookColumn[] = [];
  let open = totals.usable;
  spans.forEach((span, i) => {
    const from = i === 0 ? today : span.start;
    const flows = recurringFlows(data.recurrings, accounts, txs, from, span.end);
    const payroll = payrollIncomeBetween(data, from, span.end);
    const future = futureTxFlows(futureTxs, usableIds, from, span.end);
    const income = flows.in.reduce((a, b) => a + b.amount, 0) + payroll.reduce((a, b) => a + b.amount, 0) + future.in.reduce((a, b) => a + b.amount, 0);
    const fixedItems = [...flows.out, ...future.out];
    const fixed = fixedItems.reduce((a, b) => a + b.amount, 0);
    // 予定収入：予定出費と同じ区切りの決め方（今の区切りは、過ぎてしまった月のものも入れる）
    const incomeItems = incomes.filter((p) => {
      const first = `${p.month}-01`;
      return first <= span.end && (i === 0 || first >= span.start);
    });
    const plannedIncome = incomeItems.reduce((a, p) => a + p.amount, 0);
    const cardDebit = debits.filter((d) => d.date >= from && d.date <= span.end).reduce((a, d) => a + d.amount, 0);
    // 予定出費：その区切りに入る月（月の1日が区切りの中）。今の区切りは、過ぎてしまった月のものも入れる
    const inPeriod = planned.filter((p) => {
      const first = `${p.month}-01`;
      return first <= span.end && (i === 0 || first >= span.start);
    });
    const plannedItems = inPeriod.map((p) => ({ planned: p, covered: statuses.get(p.id)?.covered ?? 0 }));
    const plannedSum = inPeriod.reduce((a, p) => a + p.amount, 0);
    const plannedReserved = plannedItems.reduce((a, p) => a + p.covered, 0);
    // 今の区切りは、平均から「もう使った分」を引いた残り（使った分はすでに資産から減っているため）
    const variable = average === null ? null : i === 0 ? Math.max(0, average - currentSpent) : average;
    const net = income + plannedIncome - fixed - plannedSum - (variable ?? 0);
    const closing = open + net;
    columns.push({
      start: span.start,
      end: span.end,
      openAssets: open,
      income,
      fixed,
      planned: plannedSum,
      plannedReserved,
      variable,
      closing,
      net,
      belowFund: closing < s.defenseFund,
      fixedItems,
      plannedItems,
      plannedIncome,
      plannedIncomeItems: incomeItems,
      cardDebit,
    });
    open = closing;
  });
  return { columns, averagedPeriods: periods, currentSpent };
}

export interface OutlookSummary {
  /** 期間の収入 − 出費（列の「収入−出費」の合計） */
  net: number;
  /** 期末の見込みが一番低い区切り（列がなければ null。同じ額なら早い区切り） */
  lowest: { start: string; end: string; closing: number } | null;
  /** 生活防衛資金を下回る見込みの区切りの数 */
  belowCount: number;
}

/** 6か月・1年の見通しの上に出す「まとめ」 */
export function summarizeOutlook(columns: readonly OutlookColumn[]): OutlookSummary {
  let lowest: OutlookSummary["lowest"] = null;
  let net = 0;
  let belowCount = 0;
  for (const c of columns) {
    net += c.net;
    if (c.belowFund) belowCount++;
    if (lowest === null || c.closing < lowest.closing) lowest = { start: c.start, end: c.end, closing: c.closing };
  }
  return { net, lowest, belowCount };
}
