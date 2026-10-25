// カード明細CSV（楽天e-NAVI）の読み込みと照合（画面から切り離した純粋なロジック）。
// CSVはアプリに保存しない。読んで照合に使うだけ。
import { addDays, isLocalDate } from "./dateUtils.js";
import { unpaidEffect } from "./reconcileLogic.js";
import type { Transaction } from "./types.js";

// ---- 文字コード ----

/** バイト列を文字にする。UTF-8（BOMあり・なし）として読めればUTF-8、だめなら Shift_JIS */
export function decodeCsvBytes(bytes: Uint8Array): string {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

// ---- CSVの読み込み ----

/** CSVを行と列にする（"..." の中の改行・カンマ・"" に対応。改行はCRLF・LF・CR） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let any = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      // 欄の先頭の " だけが引用の始まり（欄の途中の " はそのまま文字）
      quoted = true;
      any = true;
    } else if (ch === ",") {
      endCell();
      any = true;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      cell += ch;
      any = true;
    }
  }
  if (any || cell !== "" || row.length > 0) endRow();
  return rows;
}

// ---- 列の推定 ----

export interface ColumnMap {
  date: number | null;
  shop: number | null;
  /** 金額（支払総額があればそれ、なければ利用金額） */
  amount: number | null;
}

/** 見出しのある行を探す（「利用日」を含む行。なければ先頭行） */
export function findHeaderRow(rows: readonly string[][]): number {
  const i = rows.findIndex((r) => r.some((c) => c.includes("利用日")));
  return i >= 0 ? i : 0;
}

/** 見出しの名前から列を探す。見つからない列は null（画面で選んでもらう） */
export function detectColumns(header: readonly string[]): ColumnMap {
  const h = header.map((c) => c.trim());
  const find = (...names: string[]): number | null => {
    for (const n of names) {
      const i = h.findIndex((c) => c === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = h.findIndex((c) => c.includes(n));
      if (i >= 0) return i;
    }
    return null;
  };
  return {
    date: find("利用日", "ご利用日"),
    shop: find("利用店名・商品名", "利用店名", "利用先", "ご利用先"),
    amount: find("支払総額", "利用金額", "ご利用金額"),
  };
}

export function columnsReady(m: ColumnMap): boolean {
  return m.date !== null && m.amount !== null;
}

// ---- 値の読み取り ----

/** 日付：2026/10/5・2026-10-05・2026年10月5日 など。読めなければ null */
export function parseCsvDate(text: string): string | null {
  const m = /^\s*(\d{4})[/\-.年]\s*(\d{1,2})[/\-.月]\s*(\d{1,2})日?\s*$/.exec(text.normalize("NFKC"));
  if (!m) return null;
  const key = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return isLocalDate(key) ? key : null;
}

/** 金額：カンマ・円・空白を除く。−・▲・括弧は返金（負）。整数でなければ null */
export function parseCsvAmount(text: string): number | null {
  let s = text.normalize("NFKC").replace(/[,，\s円¥￥]/g, "");
  if (s === "") return null;
  let negative = false;
  if (/^[▲△−‐-]/.test(s) || /^\(.*\)$/.test(s)) {
    negative = true;
    s = s.replace(/^[▲△−‐-]/, "").replace(/^\((.*)\)$/, "$1");
  }
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? (negative ? -n : n) : null;
}

export interface CsvRow {
  /** CSVの何行目か（見出しの次が1） */
  index: number;
  date: string;
  shop: string;
  /** 請求の金額。返金は負 */
  amount: number;
}

export interface ParsedCsv {
  rows: CsvRow[];
  /** 日付か金額が読めずに飛ばした行の数 */
  skipped: number;
}

/** 見出しの次の行から明細を読む */
export function readRows(rows: readonly string[][], headerRow: number, map: ColumnMap): ParsedCsv {
  const out: CsvRow[] = [];
  let skipped = 0;
  if (map.date === null || map.amount === null) return { rows: out, skipped };
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseCsvDate(r[map.date] ?? "");
    const amount = parseCsvAmount(r[map.amount] ?? "");
    if (date === null || amount === null) {
      skipped++;
      continue;
    }
    out.push({ index: out.length + 1, date, shop: map.shop !== null ? (r[map.shop] ?? "").trim() : "", amount });
  }
  return { rows: out, skipped };
}

/** CSVの合計（請求額の初期値） */
export function csvTotal(rows: readonly CsvRow[]): number {
  return rows.reduce((s, r) => s + r.amount, 0);
}

// ---- 照合 ----

export const DATE_TOLERANCE_DAYS = 3;
export const MAX_GROUP = 5;
/** 組み合わせを探す候補の数の上限（時間がかかりすぎないように） */
const MAX_CANDIDATES = 16;

export interface OneToOne {
  row: CsvRow;
  tx: Transaction;
}
export interface Bundle {
  rows: CsvRow[];
  tx: Transaction;
}
export interface Split {
  row: CsvRow;
  txs: Transaction[];
}

export interface MatchResult {
  /** 金額が同じで日付が±3日のもの */
  pairs: OneToOne[];
  /** まとめて入れたもの：CSVの複数行の合計＝アプリの1件 */
  bundles: Bundle[];
  /** 分けて入れたもの：CSVの1行＝アプリの複数件の合計 */
  splits: Split[];
  /** 合わないCSVの行（入力漏れの候補） */
  leftoverRows: CsvRow[];
  /** 合わないアプリの明細（請求に載っていない・遅れて載る候補） */
  leftoverTxs: Transaction[];
}

function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.abs(Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000));
}

/** items の中から、size 個の組み合わせで合計が target になるものを探す（日付が近い順に並べてあるものを先に試す） */
function findSubset<T>(items: readonly T[], target: number, minSize: number, maxSize: number, value: (t: T) => number): T[] | null {
  const n = items.length;
  for (let size = minSize; size <= Math.min(maxSize, n); size++) {
    const pick: number[] = [];
    const walk = (from: number, sum: number): boolean => {
      if (pick.length === size) return sum === target;
      for (let i = from; i < n; i++) {
        pick.push(i);
        if (walk(i + 1, sum + value(items[i]))) return true;
        pick.pop();
      }
      return false;
    };
    if (walk(0, 0)) return pick.map((i) => items[i]);
  }
  return null;
}

/**
 * CSVの行とアプリの明細（そのカードの照合していないもの）を合わせる。
 * 1) 1対1（金額が同じ・日付が±3日。同じなら日付の近いもの）
 * 2) まとめ（CSVの2〜5行の合計＝アプリの1件、同じ日±3日）
 * 3) 分け（CSVの1行＝アプリの2〜5件の合計、同じ日±3日）
 * 4) 残り
 * 金額は「未払いを動かす額」で比べる（支出は＋、返金は−）。
 */
export function matchStatement(rows: readonly CsvRow[], txs: readonly Transaction[]): MatchResult {
  const usedRows = new Set<number>();
  const usedTxs = new Set<string>();
  const pairs: OneToOne[] = [];
  const bundles: Bundle[] = [];
  const splits: Split[] = [];

  // 1) 1対1：日付の差が小さいものから順に決める
  for (let d = 0; d <= DATE_TOLERANCE_DAYS; d++) {
    for (const row of rows) {
      if (usedRows.has(row.index)) continue;
      const found = txs.find((t) => !usedTxs.has(t.id) && unpaidEffect(t) === row.amount && dayDiff(t.date, row.date) === d);
      if (found) {
        pairs.push({ row, tx: found });
        usedRows.add(row.index);
        usedTxs.add(found.id);
      }
    }
  }

  const near = (date: string, other: string) => dayDiff(date, other) <= DATE_TOLERANCE_DAYS;

  // 2) まとめて入れたもの
  for (const tx of txs) {
    if (usedTxs.has(tx.id)) continue;
    const cand = rows
      .filter((r) => !usedRows.has(r.index) && near(r.date, tx.date))
      .sort((a, b) => dayDiff(a.date, tx.date) - dayDiff(b.date, tx.date) || a.index - b.index)
      .slice(0, MAX_CANDIDATES);
    const hit = findSubset(cand, unpaidEffect(tx), 2, MAX_GROUP, (r) => r.amount);
    if (hit) {
      bundles.push({ rows: [...hit].sort((a, b) => a.index - b.index), tx });
      usedTxs.add(tx.id);
      for (const r of hit) usedRows.add(r.index);
    }
  }

  // 3) 分けて入れたもの
  for (const row of rows) {
    if (usedRows.has(row.index)) continue;
    const cand = txs
      .filter((t) => !usedTxs.has(t.id) && near(t.date, row.date))
      .sort((a, b) => dayDiff(a.date, row.date) - dayDiff(b.date, row.date) || (a.date < b.date ? -1 : 1))
      .slice(0, MAX_CANDIDATES);
    const hit = findSubset(cand, row.amount, 2, MAX_GROUP, unpaidEffect);
    if (hit) {
      splits.push({ row, txs: [...hit].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : 1)) });
      usedRows.add(row.index);
      for (const t of hit) usedTxs.add(t.id);
    }
  }

  return {
    pairs: pairs.sort((a, b) => a.row.index - b.row.index),
    bundles,
    splits,
    leftoverRows: rows.filter((r) => !usedRows.has(r.index)),
    leftoverTxs: txs.filter((t) => !usedTxs.has(t.id)),
  };
}

/** 照合できたアプリの明細のid（チェックに反映する） */
export function matchedTxIds(m: MatchResult): string[] {
  return [...m.pairs.map((p) => p.tx.id), ...m.bundles.map((b) => b.tx.id), ...m.splits.flatMap((s) => s.txs.map((t) => t.id))];
}

/** CSV側だけにある行を「支出として入れる」ときの入力画面の初期値 */
export function expenseFromRow(row: CsvRow): { date: string; content: string; amount: number } {
  return { date: row.date, content: row.shop, amount: Math.abs(row.amount) };
}

export interface LeftoverTxs {
  /** ファイルの期間（前後3日）の中の、合わなかった明細 */
  within: Transaction[];
  /** ファイルの期間より前の、照合していない明細（前の請求のぶん） */
  before: Transaction[];
  /** ファイルの期間より後の明細（次の請求に載る候補） */
  after: Transaction[];
}

/** 合わなかったアプリの明細を、ファイルの期間で分ける（ファイルが無い期間の明細まで「合わない」と並べないため） */
export function splitLeftoverTxs(rows: readonly CsvRow[], leftover: readonly Transaction[]): LeftoverTxs {
  if (rows.length === 0) return { within: [], before: [...leftover], after: [] };
  const min = addDays(rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date), -DATE_TOLERANCE_DAYS);
  const max = addDays(rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date), DATE_TOLERANCE_DAYS);
  const out: LeftoverTxs = { within: [], before: [], after: [] };
  for (const t of leftover) {
    if (t.date < min) out.before.push(t);
    else if (t.date > max) out.after.push(t);
    else out.within.push(t);
  }
  return out;
}
