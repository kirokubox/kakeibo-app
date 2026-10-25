// 日本の国民の祝日（純粋ロジック）。出どころ：09_開発/01_自分用アプリ/calendar-app/src/holidays.ts（キロクカレンダー）を、
// このアプリの dateUtils に合わせて写したもの（共通コードの標準でコードのコピーを認めている）。元のファイルは変更していない。
// 祝日法のルールで計算するので、年ごとのデータ更新は要らない。
// 対象は2020年以降（現行の祝日法。2020・2021年の五輪特例を含む）。それより前の年は祝日なしとして扱う。
// 春分・秋分は近似式（1980〜2099年で実際の日付と一致）。正式な日付は前年2月の官報で決まる。
// 法改正で祝日が新設・移動されたら、ここを直す。
import { addDays, weekdayOf } from "./dateUtils.js";

export const HOLIDAY_FIRST_YEAR = 2020;
export const HOLIDAY_LAST_YEAR = 2099;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** その月の第n月曜日（日） */
function nthMonday(year: number, month: number, n: number): number {
  const first = weekdayOf(key(year, month, 1));
  const firstMonday = 1 + ((8 - first) % 7);
  return firstMonday + (n - 1) * 7;
}

function springEquinox(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnEquinox(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function key(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

const cache = new Map<number, Map<string, string>>();

/** その年の祝日（日付キー → 名前）。振替休日・国民の休日を含む */
export function holidaysOfYear(year: number): Map<string, string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const map = new Map<string, string>();
  if (year < HOLIDAY_FIRST_YEAR || year > HOLIDAY_LAST_YEAR) {
    cache.set(year, map);
    return map;
  }
  const add = (m: number, d: number, name: string) => map.set(key(year, m, d), name);
  add(1, 1, "元日");
  add(1, nthMonday(year, 1, 2), "成人の日");
  add(2, 11, "建国記念の日");
  add(2, 23, "天皇誕生日");
  add(3, springEquinox(year), "春分の日");
  add(4, 29, "昭和の日");
  add(5, 3, "憲法記念日");
  add(5, 4, "みどりの日");
  add(5, 5, "こどもの日");
  if (year === 2020) {
    add(7, 23, "海の日");
    add(7, 24, "スポーツの日");
    add(8, 10, "山の日");
  } else if (year === 2021) {
    add(7, 22, "海の日");
    add(7, 23, "スポーツの日");
    add(8, 8, "山の日");
  } else {
    add(7, nthMonday(year, 7, 3), "海の日");
    add(8, 11, "山の日");
    add(10, nthMonday(year, 10, 2), "スポーツの日");
  }
  add(9, nthMonday(year, 9, 3), "敬老の日");
  add(9, autumnEquinox(year), "秋分の日");
  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");

  // 国民の休日：前日と翌日が祝日で、その日自体は祝日でない日
  const base = [...map.keys()].sort();
  for (const k of base) {
    const between = addDays(k, 1);
    if (!map.has(between) && map.has(addDays(k, 2)) && weekdayOf(between) !== 0) map.set(between, "国民の休日");
  }
  // 振替休日：祝日が日曜なら、その後の最初の祝日でない日
  for (const k of [...map.keys()].sort()) {
    if (weekdayOf(k) !== 0) continue;
    let d = addDays(k, 1);
    while (map.has(d)) d = addDays(d, 1);
    if (d.startsWith(String(year))) map.set(d, "振替休日");
  }
  const sorted = new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  cache.set(year, sorted);
  return sorted;
}

/** 祝日なら名前、そうでなければ null */
export function holidayName(dateKey: string): string | null {
  return holidaysOfYear(Number(dateKey.slice(0, 4))).get(dateKey) ?? null;
}

export function isHoliday(dateKey: string): boolean {
  return holidayName(dateKey) !== null;
}
