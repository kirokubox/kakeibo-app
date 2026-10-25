// 暦日（YYYY-MM-DD）とISO時刻の扱い。深夜を前日扱いにしない

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM-DD として実在する日付か（2026-02-30 などは false） */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** YYYY-MM として正しいか */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

/** 時刻つきISO文字列（タイムゾーン付き）として読めるか */
export function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** 端末のローカル日付を YYYY-MM-DD にする */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayKey(now: Date = new Date()): string {
  return toDateKey(now);
}

/** 保存用の現在時刻（ISO 8601, UTC） */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 画面表示用：10月12日（月）。今年以外は年を付ける */
export function formatDateJa(key: string, today: Date = new Date()): string {
  if (!isLocalDate(key)) return key;
  const [y, m, d] = key.split("-").map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  const year = y === today.getFullYear() ? "" : `${y}年`;
  return `${year}${m}月${d}日（${wd}）`;
}

/** 画面表示用：保存した時刻（ISO）を端末の日時にして 10月12日（月）13:05 の形にする */
export function formatDateTimeJa(iso: string, today: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return `${formatDateJa(toDateKey(t), today)} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** 暦日に日数を足す（負で引く）。端末のタイムゾーンに左右されない */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 曜日（0=日 … 6=土） */
export function weekdayOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 暦日の前後比較用：a が b より前なら負 */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** その月の日数（month は 1〜12） */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 画面表示用：11/27(金)。年は付けない */
export function formatMonthDayWeekday(key: string): string {
  if (!isLocalDate(key)) return key;
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}(${WEEKDAYS[weekdayOf(key)]})`;
}

/** 年月（YYYY-MM）に月を足す（負で引く） */
export function addMonths(ym: string, months: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}
