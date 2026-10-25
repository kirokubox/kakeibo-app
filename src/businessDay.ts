// 休日の判定と移動、給料日・カードの引き落とし日（画面から切り離した純粋なロジック）
import { addDays, addMonths, daysInMonth, weekdayOf } from "./dateUtils.js";
import { isHoliday } from "./holidays.js";
import type { HolidayShift, Settings } from "./types.js";

/** 休日＝土曜・日曜・祝日（振替休日・国民の休日を含む）。年末年始（12/31〜1/3）は休日にしない */
export function isNonBusinessDay(date: string): boolean {
  const wd = weekdayOf(date);
  return wd === 0 || wd === 6 || isHoliday(date);
}

/** 休日なら、前（before）か後（after）の休日でない日まで1日ずつ動かす。none はそのまま */
export function shiftForHoliday(date: string, shift: HolidayShift): string {
  if (shift === "none") return date;
  const step = shift === "before" ? -1 : 1;
  let d = date;
  // 念のための上限（連休は長くても1週間ほど）
  for (let i = 0; i < 31 && isNonBusinessDay(d); i++) d = addDays(d, step);
  return d;
}

/** 年月（YYYY-MM）の day 日。月にない日（31日など）や "last" はその月の末日にする */
export function dateInMonth(ym: string, day: number | "last"): string {
  const [y, m] = ym.split("-").map(Number);
  const last = daysInMonth(y, m);
  const d = day === "last" ? last : Math.min(Math.max(1, day), last);
  return `${ym}-${String(d).padStart(2, "0")}`;
}

/** 月にない日は先にその月の末日にしてから、休日の移動をする */
export function shiftedDateInMonth(ym: string, day: number | "last", shift: HolidayShift): string {
  return shiftForHoliday(dateInMonth(ym, day), shift);
}

/** その月（YYYY-MM）の給料日（休日の移動後） */
export function paydayOf(ym: string, settings: Pick<Settings, "payday" | "paydayHolidayShift">): string {
  return shiftedDateInMonth(ym, settings.payday, settings.paydayHolidayShift);
}

/** 今日以降で最初の給料日（今日が給料日なら今日） */
export function nextPayday(today: string, settings: Pick<Settings, "payday" | "paydayHolidayShift">): string {
  const start = addMonths(today.slice(0, 7), -1); // 「後の平日」で翌月へ越える日と、前月分を見落とさない
  for (let i = 0; i < 6; i++) {
    const d = paydayOf(addMonths(start, i), settings);
    if (d >= today) return d;
  }
  return paydayOf(addMonths(start, 6), settings);
}

export interface CardSchedule {
  paymentDay: number;
  holidayShift: HolidayShift;
}

/** カードのその月の引き落とし日（休日の移動後） */
export function cardPaymentDateOf(card: CardSchedule, ym: string): string {
  return shiftedDateInMonth(ym, card.paymentDay, card.holidayShift);
}

/** 今日以降で最初の引き落とし日 */
export function nextCardPayment(card: CardSchedule, today: string): string {
  const start = addMonths(today.slice(0, 7), -1);
  for (let i = 0; i < 6; i++) {
    const d = cardPaymentDateOf(card, addMonths(start, i));
    if (d >= today) return d;
  }
  return cardPaymentDateOf(card, addMonths(start, 6));
}
