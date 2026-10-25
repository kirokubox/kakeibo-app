// 繰り返しのロジック（画面から切り離した純粋なロジック）。
// 予定日（scheduled）は休日の移動をする前の日付。明細の日付（date）は休日の移動をしたあと。
import { dateInMonth, shiftForHoliday } from "./businessDay.js";
import { addDays, addMonths, isLocalDate, weekdayOf } from "./dateUtils.js";
import type { Base, HolidayShift, Recurring, RecurringEvery, Transaction, TransactionTemplate } from "./types.js";

export interface Occurrence {
  /** 予定日（休日の移動をする前） */
  scheduled: string;
  /** 明細の日付（休日の移動をしたあと） */
  date: string;
}

const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

/** 毎週の day は 1（月）〜7（日）。JavaScript の曜日（0=日〜6=土）に直す */
function ruleDayToWeekday(day: number): number {
  return day === 7 ? 0 : day;
}
export function weekdayToRuleDay(jsWeekday: number): number {
  return jsWeekday === 0 ? 7 : jsWeekday;
}

const GUARD = 3000;

/** 予定日（休日の移動前）を、from〜to（両端を含む）の範囲で古い順に返す。開始日より前は含めない */
export function scheduledDates(rec: Pick<Recurring, "rule" | "startDate">, from: string, to: string): string[] {
  const { rule, startDate } = rec;
  const lower = from > startDate ? from : startDate;
  if (lower > to) return [];
  const out: string[] = [];
  if (rule.every === "week") {
    const target = ruleDayToWeekday(typeof rule.day === "number" ? rule.day : 1);
    let d = lower;
    while (weekdayOf(d) !== target) d = addDays(d, 1);
    for (let i = 0; i < GUARD && d <= to; i++) {
      out.push(d);
      d = addDays(d, 7);
    }
    return out;
  }
  if (rule.every === "year") {
    const month = rule.month ?? Number(startDate.slice(5, 7));
    const y0 = Number(lower.slice(0, 4));
    const y1 = Number(to.slice(0, 4));
    for (let y = y0; y <= y1 && out.length < GUARD; y++) {
      const d = dateInMonth(`${y}-${String(month).padStart(2, "0")}`, rule.day);
      if (d >= lower && d <= to) out.push(d);
    }
    return out;
  }
  // 毎月・◯か月ごと：開始日の月を起点に n か月ずつ
  const n = rule.every === "nMonths" ? Math.max(1, rule.n ?? 1) : 1;
  const anchor = startDate.slice(0, 7);
  const [ay, am] = anchor.split("-").map(Number);
  const [ly, lm] = lower.slice(0, 7).split("-").map(Number);
  const diff = ly * 12 + lm - (ay * 12 + am);
  let k = diff > 0 ? Math.max(0, Math.floor(diff / n) - 1) : 0;
  for (let i = 0; i < GUARD; i++, k++) {
    const ym = addMonths(anchor, k * n);
    if (ym > to.slice(0, 7)) break;
    const d = dateInMonth(ym, rule.day);
    if (d >= lower && d <= to) out.push(d);
  }
  return out;
}

/** 作り済み（generatedThrough）の次の日から。まだ作っていなければ開始日から */
function lowerBoundOf(rec: Pick<Recurring, "generatedThrough" | "startDate">): string {
  return rec.generatedThrough ? addDays(rec.generatedThrough, 1) : rec.startDate;
}

/**
 * 休日の移動をしたあとの日付が from〜to に入る予定を返す。
 * 開始日より前、終わりの日より後（予定日で比べる）、作り済み（generatedThrough まで）は含めない。論理削除した繰り返しは空。
 */
export function occurrencesBetween(rec: Recurring, from: string, to: string): Occurrence[] {
  if (rec.deletedAt !== null) return [];
  const MARGIN = 10; // 休日の移動で動く日数の余裕
  const lowerBound = lowerBoundOf(rec);
  const lo = addDays(from, -MARGIN);
  const searchFrom = lo > lowerBound ? lo : lowerBound;
  const hi = addDays(to, MARGIN);
  const searchTo = rec.endDate && hi > rec.endDate ? rec.endDate : hi;
  const result: Occurrence[] = [];
  for (const scheduled of scheduledDates(rec, searchFrom, searchTo)) {
    const date = shiftForHoliday(scheduled, rec.holidayShift);
    if (date >= from && date <= to) result.push({ scheduled, date });
  }
  return result;
}

/** 今日以降で最初の（まだ作っていない）予定。もう予定がなければ null */
export function nextOccurrence(rec: Recurring, today: string): Occurrence | null {
  if (rec.deletedAt !== null) return null;
  let from = today;
  for (let i = 0; i < 12; i++) {
    const to = addDays(from, i === 0 ? 400 : 1500);
    const list = occurrencesBetween(rec, from, to);
    if (list.length > 0) return list[0];
    if (rec.endDate && addDays(to, 10) >= rec.endDate) return null;
    from = addDays(to, 1);
  }
  return null;
}

/** 終わった繰り返しか（終わりの日があり、これから作る予定がもうない） */
export function isEnded(rec: Recurring, today: string): boolean {
  if (rec.endDate === undefined) return false;
  return nextOccurrence(rec, today) === null;
}

/** 今日までに来ていて、まだ作っていない予定（古い順） */
export function dueOccurrences(rec: Recurring, today: string): Occurrence[] {
  if (rec.deletedAt !== null) return [];
  return occurrencesBetween(rec, "1900-01-01", today);
}

/** 繰り返しのひな形と日付から、自動で作る明細を作る */
export function transactionFromRecurring(rec: Recurring, occurrence: Occurrence, base: Base): Transaction {
  const t: Transaction = {
    ...base,
    ...rec.template,
    date: occurrence.date,
    source: "recurring",
    recurringId: rec.id,
  };
  delete t.payrollId;
  delete t.payrollBatchId;
  delete t.reconciledStatementId;
  delete t.settles;
  if (rec.estimated) t.estimated = true;
  else delete t.estimated;
  return t;
}

export interface GenerationPlan {
  transactions: Transaction[];
  /** generatedThrough を進めた繰り返し（変わったものだけ） */
  recurrings: Recurring[];
}

/**
 * 今日までに来た予定のうち、まだ作っていない明細を作る計画。
 * generatedThrough を進めた繰り返しも一緒に返すので、明細と同時に保存する。保存したあとは同じ予定を二重に作らない。
 */
export function planGeneration(recurrings: readonly Recurring[], today: string, makeBase: () => Base): GenerationPlan {
  const transactions: Transaction[] = [];
  const changed: Recurring[] = [];
  for (const rec of recurrings) {
    const due = dueOccurrences(rec, today);
    if (due.length === 0) continue;
    for (const occ of due) transactions.push(transactionFromRecurring(rec, occ, makeBase()));
    changed.push({ ...rec, generatedThrough: due[due.length - 1].scheduled });
  }
  return { transactions, recurrings: changed };
}

// ---- 入力画面の「繰り返し」の設定 ----

/** 入力画面・編集で扱う繰り返しの設定 */
export interface RepeatDraft {
  every: RecurringEvery;
  /** ◯か月ごと（2〜12）。every が nMonths のときだけ使う */
  n: number;
  /** 毎月・◯か月ごと・毎年＝1〜31 か "last"。毎週＝1（月）〜7（日） */
  day: number | "last";
  /** 毎年の月（1〜12） */
  month: number;
  holidayShift: HolidayShift;
  endDate: string | null;
  estimated: boolean;
}

/** 日付に合わせた初期値：毎月・その日、休日はそのまま、終わりなし、見込みはオフ */
export function defaultRepeat(date: string): RepeatDraft {
  return {
    every: "month",
    n: 2,
    day: Number(date.slice(8, 10)),
    month: Number(date.slice(5, 7)),
    holidayShift: "none",
    endDate: null,
    estimated: false,
  };
}

/** 間隔を替える：日（毎週は曜日、毎年は月日、毎月系はその日）を日付に合わせ直す */
export function changeRepeatEvery(draft: RepeatDraft, every: RecurringEvery, date: string): RepeatDraft {
  const base = defaultRepeat(date);
  const day = every === "week" ? weekdayToRuleDay(weekdayOf(date)) : base.day;
  return { ...draft, every, day, month: base.month };
}

export function validateRepeat(draft: RepeatDraft, startDate: string): string | null {
  if (draft.every === "nMonths" && !(Number.isInteger(draft.n) && draft.n >= 2 && draft.n <= 12)) return "間隔は2〜12か月で入れてください";
  if (draft.every === "week") {
    if (!(typeof draft.day === "number" && Number.isInteger(draft.day) && draft.day >= 1 && draft.day <= 7)) return "曜日を選んでください";
  } else if (draft.day !== "last" && !(Number.isInteger(draft.day) && draft.day >= 1 && draft.day <= 31)) {
    return "日は1〜31日か末日で入れてください";
  }
  if (draft.every === "year" && !(Number.isInteger(draft.month) && draft.month >= 1 && draft.month <= 12)) return "月を選んでください";
  if (draft.endDate !== null) {
    if (!isLocalDate(draft.endDate)) return "終わりの日を正しく入れてください";
    if (draft.endDate < startDate) return "終わりの日は、始まりの日より後にしてください";
  }
  return null;
}

export function repeatToRule(draft: RepeatDraft): Recurring["rule"] {
  switch (draft.every) {
    case "month":
      return { every: "month", day: draft.day };
    case "nMonths":
      return { every: "nMonths", n: draft.n, day: draft.day };
    case "year":
      return { every: "year", month: draft.month, day: draft.day };
    default:
      return { every: "week", day: draft.day };
  }
}

export function recurringToRepeat(rec: Recurring): RepeatDraft {
  const r = rec.rule;
  return {
    every: r.every,
    n: r.n ?? 2,
    day: r.day,
    month: r.month ?? Number(rec.startDate.slice(5, 7)),
    holidayShift: rec.holidayShift,
    endDate: rec.endDate ?? null,
    estimated: rec.estimated,
  };
}

/** 「毎月25日」「毎月末日」「3か月ごと25日」「毎年10月25日」「毎週月曜」 */
export function ruleLabel(rule: Recurring["rule"]): string {
  const dayText = (d: number | "last") => (d === "last" ? "末日" : `${d}日`);
  switch (rule.every) {
    case "month":
      return `毎月${dayText(rule.day)}`;
    case "nMonths":
      return `${rule.n ?? 2}か月ごと${dayText(rule.day)}`;
    case "year":
      return `毎年${rule.month ?? 1}月${dayText(rule.day)}`;
    default:
      return `毎週${WEEKDAY_NAMES[ruleDayToWeekday(typeof rule.day === "number" ? rule.day : 1)]}曜`;
  }
}

/** 明細の行に小さく出す「(毎月)」の中身 */
export function ruleShortLabel(rule: Recurring["rule"]): string {
  switch (rule.every) {
    case "month":
      return "毎月";
    case "nMonths":
      return `${rule.n ?? 2}か月ごと`;
    case "year":
      return "毎年";
    default:
      return "毎週";
  }
}

export function repeatLabel(draft: RepeatDraft): string {
  return ruleLabel(repeatToRule(draft));
}

/** ひな形に、明細としての印（繰り返し・給料明細・見込み・カード照合）は持たせない */
function cleanTemplate(template: TransactionTemplate): TransactionTemplate {
  const t = { ...template };
  delete t.recurringId;
  delete t.payrollId;
  delete t.payrollBatchId;
  delete t.estimated;
  delete t.reconciledStatementId;
  delete t.settles;
  return t;
}

/**
 * 入力画面で「繰り返し」を決めて保存するときの、繰り返しの記録。
 * 開始日 ≦ 今日で1回目の明細を保存するなら firstSaved=true（その日までを作り済みにする）。
 */
export function buildRecurring(draft: RepeatDraft, template: TransactionTemplate, startDate: string, base: Base, firstSaved: boolean): Recurring {
  const rec: Recurring = {
    ...base,
    template: cleanTemplate(template),
    rule: repeatToRule(draft),
    startDate,
    holidayShift: draft.holidayShift,
    estimated: draft.estimated,
  };
  if (draft.endDate) rec.endDate = draft.endDate;
  if (firstSaved) rec.generatedThrough = startDate;
  return rec;
}

/** 編集の保存：ひな形と設定だけ差し替える（開始日・作り済みの記録は残す） */
export function applyRepeatEdit(rec: Recurring, draft: RepeatDraft, template: TransactionTemplate): Recurring {
  const next: Recurring = { ...rec, template: cleanTemplate(template), rule: repeatToRule(draft), holidayShift: draft.holidayShift, estimated: draft.estimated };
  if (draft.endDate) next.endDate = draft.endDate;
  else delete next.endDate;
  return next;
}

/** ひな形から、入力画面の下書きに変換するための仮の取引 */
export function templateAsTransaction(template: TransactionTemplate, date: string, base: Base): Transaction {
  return { ...base, ...template, date, source: "manual" };
}

/** 「終わりにする」：終わりの日＝今日 */
export function endRecurringToday(rec: Recurring, today: string): Recurring {
  return { ...rec, endDate: today };
}

// ---- 見込み額 ----

/** 保存するときに「見込み」の印を外すか：「実額にした」にチェックが入っているか、金額を変えたとき */
export function shouldClearEstimated(originalAmount: number, newAmount: number | null, checked: boolean): boolean {
  return checked || (newAmount !== null && newAmount !== originalAmount);
}

/** 見込みのままの明細（日付の古い順） */
export function estimatedTransactions(txs: readonly Transaction[]): Transaction[] {
  return txs.filter((t) => t.deletedAt === null && t.estimated === true).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
