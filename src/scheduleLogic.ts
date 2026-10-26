// 先の予定の日付（段階6の見通しが使う材料）。画面は段階6で作る。
import { cardPaymentDateOf, paydayOf } from "./businessDay.js";
import type { CardSchedule } from "./businessDay.js";
import { addMonths } from "./dateUtils.js";
import { lineInitialAmount, payrollDateOf, payrollTotals } from "./payrollLogic.js";
import { nextOccurrence, occurrencesBetween } from "./recurrence.js";
import type { Occurrence } from "./recurrence.js";
import type { Payroll, Recurring, Settings } from "./types.js";

export { nextOccurrence, occurrencesBetween };
export { nextCardPayment, nextPayday } from "./businessDay.js";

export interface RecurringOccurrence extends Occurrence {
  recurring: Recurring;
}

/** 期間内（休日の移動後の日付が from〜to）の、すべての繰り返しの予定。日付順 */
export function recurringOccurrencesBetween(recurrings: readonly Recurring[], from: string, to: string): RecurringOccurrence[] {
  const out: RecurringOccurrence[] = [];
  for (const rec of recurrings) for (const o of occurrencesBetween(rec, from, to)) out.push({ ...o, recurring: rec });
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.recurring.id.localeCompare(b.recurring.id));
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  // 「後の平日」の移動で月をまたぐ日を落とさないよう、前後1か月ずつ広く見て、あとで日付で絞る
  let ym = addMonths(from.slice(0, 7), -1);
  const last = addMonths(to.slice(0, 7), 1);
  while (ym <= last && out.length < 1200) {
    out.push(ym);
    ym = addMonths(ym, 1);
  }
  return out;
}

/** 期間内（from〜to）の給料日（休日の移動後）。日付順 */
export function paydaysBetween(settings: Pick<Settings, "payday" | "paydayHolidayShift">, from: string, to: string): string[] {
  return monthsBetween(from, to)
    .map((ym) => paydayOf(ym, settings))
    .filter((d) => d >= from && d <= to);
}

/** 期間内（from〜to）のカードの引き落とし日（休日の移動後）。日付順 */
export function cardPaymentsBetween(card: CardSchedule, from: string, to: string): string[] {
  return monthsBetween(from, to)
    .map((ym) => cardPaymentDateOf(card, ym))
    .filter((d) => d >= from && d <= to);
}

/**
 * 給料明細のひな形から、その月（YYYY-MM）の支給日と手取りの見込み（前回の金額で計算）。
 * 「毎月変わる」行（残業代など）は除く（前回の金額を毎月入る前提にしない）。
 */
export function payrollForecast(p: Payroll, ym: string): { date: string; takeHome: number } {
  const totals = payrollTotals(p.lines.filter((l) => !l.variable).map((l) => ({ kind: l.kind, amount: lineInitialAmount(p, l) })));
  return { date: payrollDateOf(p, ym), takeHome: totals.takeHome };
}
