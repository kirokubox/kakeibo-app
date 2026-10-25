import assert from "node:assert/strict";
import test from "node:test";
import {
  columnsReady,
  csvTotal,
  decodeCsvBytes,
  detectColumns,
  expenseFromRow,
  findHeaderRow,
  matchStatement,
  matchedTxIds,
  parseCsv,
  parseCsvAmount,
  parseCsvDate,
  readRows,
  splitLeftoverTxs,
} from "../src/csvImport.js";
import type { CsvRow } from "../src/csvImport.js";
import type { Transaction } from "../src/types.js";
import { tx } from "./fixtures.js";

// 架空の店名・金額だけを使う
const HEADER = "利用日,利用店名・商品名,利用者,支払方法,利用金額,支払手数料,支払総額,11月請求額,12月請求額,新規サイン";
const CSV = [
  HEADER,
  "2026/10/01,テスト食堂,本人,1回払い,\"1,200\",0,\"1,200\",\"1,200\",,",
  "2026/10/03,テスト書店,本人,1回払い,3000,0,3000,3000,,",
  "2026/10/05,テスト通信 \"月額\",本人,1回払い,5000,0,5000,5000,,",
  "2026/10/07,テスト返品,本人,1回払い,-800,0,-800,-800,,",
].join("\r\n");

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Shift_JIS のバイト列を、テストの中で作る（TextDecoder でしか読めないので、表にした文字だけ手で並べる） */
function sjisBytes(): Uint8Array {
  // 「利用日,利用金額\n2026/10/01,1200」の Shift_JIS
  const table: Record<string, number[]> = { 利: [0x97, 0x98], 用: [0x97, 0x70], 日: [0x93, 0xfa], 金: [0x8b, 0xe0], 額: [0x8a, 0x7a] };
  const out: number[] = [];
  for (const ch of "利用日,利用金額\n2026/10/01,1200\n") {
    if (table[ch]) out.push(...table[ch]);
    else out.push(ch.charCodeAt(0));
  }
  return Uint8Array.from(out);
}

function app(id: string, amount: number, date: string, extra: Partial<Transaction> = {}): Transaction {
  return tx(id, { accountId: "card", amount, date, ...extra });
}

test("文字コード：UTF-8（BOMあり・なし）と Shift_JIS の両方を読む", () => {
  assert.equal(decodeCsvBytes(bytesOf("利用日,利用金額")), "利用日,利用金額");
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytesOf("利用日")]);
  assert.equal(decodeCsvBytes(bom), "利用日");
  const text = decodeCsvBytes(sjisBytes());
  assert.equal(text, "利用日,利用金額\n2026/10/01,1200\n");
});

test("CSVの読み込み：引用符の中のカンマ・改行・二重引用符、CRLF", () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 5);
  assert.equal(rows[1][4], "1,200");
  assert.equal(rows[3][1], "テスト通信 \"月額\"");
  const multi = parseCsv("a,\"b\nc\",d\r\n1,2,3\n");
  assert.deepEqual(multi, [["a", "b\nc", "d"], ["1", "2", "3"]]);
});

test("列の推定：見出しの名前から。金額は支払総額（なければ利用金額）", () => {
  const rows = parseCsv(CSV);
  const map = detectColumns(rows[findHeaderRow(rows)]);
  assert.deepEqual(map, { date: 0, shop: 1, amount: 6 });
  assert.equal(columnsReady(map), true);
  const noTotal = detectColumns(["利用日", "利用店名・商品名", "利用金額"]);
  assert.deepEqual(noTotal, { date: 0, shop: 1, amount: 2 });
  const unknown = detectColumns(["日にち", "お店", "ねだん"]);
  assert.equal(columnsReady(unknown), false); // 画面で列を選んでもらう
  // 見出しの前に説明の行があっても、「利用日」の行を見出しにする
  assert.equal(findHeaderRow([["お客様向けの説明"], ["利用日", "利用金額"]]), 1);
});

test("日付と金額の読み取り", () => {
  assert.equal(parseCsvDate("2026/10/5"), "2026-10-05");
  assert.equal(parseCsvDate("2026-10-05"), "2026-10-05");
  assert.equal(parseCsvDate("2026年10月5日"), "2026-10-05");
  assert.equal(parseCsvDate("2026/02/30"), null);
  assert.equal(parseCsvDate("合計"), null);
  assert.equal(parseCsvAmount("1,200"), 1200);
  assert.equal(parseCsvAmount("¥3,000"), 3000);
  assert.equal(parseCsvAmount("-800"), -800);
  assert.equal(parseCsvAmount("▲800"), -800);
  assert.equal(parseCsvAmount("12.5"), null);
  assert.equal(parseCsvAmount(""), null);
});

test("行の読み取り：読めない行は数えて飛ばし、合計を出す", () => {
  const rows = parseCsv(`${CSV}\r\n合計,,,,,,,\r\n`);
  const map = detectColumns(rows[0]);
  const parsed = readRows(rows, 0, map);
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.rows[0], { index: 1, date: "2026-10-01", shop: "テスト食堂", amount: 1200 });
  assert.equal(csvTotal(parsed.rows), 1200 + 3000 + 5000 - 800);
});

function rowsOf(list: Array<[string, number, string?]>): CsvRow[] {
  return list.map(([date, amount, shop], i) => ({ index: i + 1, date, amount, shop: shop ?? `テスト店${i + 1}` }));
}

test("1対1：金額が同じで日付が±3日。範囲外・金額違いは合わない", () => {
  const rows = rowsOf([["2026-10-01", 1200], ["2026-10-03", 3000], ["2026-10-10", 700]]);
  const txs = [app("a", 1200, "2026-10-02"), app("b", 3000, "2026-10-06"), app("c", 700, "2026-10-15"), app("d", 100, "2026-10-01")];
  const m = matchStatement(rows, txs);
  assert.deepEqual(m.pairs.map((p) => [p.row.index, p.tx.id]), [[1, "a"], [2, "b"]]); // ちょうど3日違いも合う
  assert.deepEqual(m.leftoverRows.map((r) => r.index), [3]); // 5日違いは合わない
  assert.deepEqual(m.leftoverTxs.map((t) => t.id).sort(), ["c", "d"]);
});

test("1対1：候補が複数なら日付の近いもの。同じ金額が2件あれば1件ずつ", () => {
  const rows = rowsOf([["2026-10-05", 500], ["2026-10-06", 500]]);
  const txs = [app("far", 500, "2026-10-02"), app("near", 500, "2026-10-05"), app("mid", 500, "2026-10-07")];
  const m = matchStatement(rows, txs);
  assert.deepEqual(m.pairs.map((p) => [p.row.index, p.tx.id]).sort(), [[1, "near"], [2, "mid"]]);
  assert.deepEqual(m.leftoverTxs.map((t) => t.id), ["far"]);
});

test("返金（CSVの負の金額）は、アプリの返金（収入）と合う", () => {
  const rows = rowsOf([["2026-10-07", -800]]);
  const m = matchStatement(rows, [app("r", 800, "2026-10-08", { type: "income" }), app("e", 800, "2026-10-07")]);
  assert.deepEqual(m.pairs.map((p) => p.tx.id), ["r"]);
});

test("まとめて入れたもの：CSVの複数行の合計＝アプリの1件（2〜5行、±3日）", () => {
  const rows = rowsOf([["2026-10-01", 1000], ["2026-10-02", 2000], ["2026-10-03", 500], ["2026-10-20", 777]]);
  const m = matchStatement(rows, [app("sum", 3000, "2026-10-02"), app("other", 777, "2026-10-20")]);
  assert.equal(m.bundles.length, 1);
  assert.equal(m.bundles[0].tx.id, "sum");
  assert.equal(m.bundles[0].rows.reduce((s, r) => s + r.amount, 0), 3000);
  assert.equal(m.pairs.length, 1);
  assert.equal(m.leftoverRows.length, 1); // 組み合わせて余った1行（500円か1,000円）
  assert.equal(matchedTxIds(m).length, 2);
});

test("まとめて入れたもの：6行以上の組み合わせや、日付が離れた行は使わない", () => {
  const six = rowsOf([["2026-10-01", 100], ["2026-10-01", 100], ["2026-10-01", 100], ["2026-10-01", 100], ["2026-10-01", 100], ["2026-10-01", 100]]);
  const m = matchStatement(six, [app("x", 600, "2026-10-01")]);
  assert.equal(m.bundles.length, 0);
  const far = rowsOf([["2026-10-01", 1000], ["2026-10-20", 2000]]);
  assert.equal(matchStatement(far, [app("y", 3000, "2026-10-02")]).bundles.length, 0);
});

test("分けて入れたもの：CSVの1行＝アプリの複数件の合計（2〜5件、±3日）", () => {
  const rows = rowsOf([["2026-10-05", 9000]]);
  const txs = [app("p1", 4000, "2026-10-04"), app("p2", 3000, "2026-10-05"), app("p3", 2000, "2026-10-06"), app("z", 1, "2026-10-05")];
  const m = matchStatement(rows, txs);
  assert.equal(m.splits.length, 1);
  assert.deepEqual(m.splits[0].txs.map((t) => t.id), ["p1", "p2", "p3"]);
  assert.deepEqual(m.leftoverTxs.map((t) => t.id), ["z"]);
  assert.equal(m.leftoverRows.length, 0);
});

test("残り：CSV側だけ（入力漏れの候補）とアプリ側だけ（請求に載っていない候補）を分けて出す", () => {
  const rows = rowsOf([["2026-10-01", 1200], ["2026-10-02", 4321, "テスト未入力店"]]);
  const txs = [app("a", 1200, "2026-10-01"), app("late", 999, "2026-10-28")];
  const m = matchStatement(rows, txs);
  assert.deepEqual(m.leftoverRows.map((r) => r.shop), ["テスト未入力店"]);
  assert.deepEqual(m.leftoverTxs.map((t) => t.id), ["late"]);
  assert.deepEqual(expenseFromRow(m.leftoverRows[0]), { date: "2026-10-02", content: "テスト未入力店", amount: 4321 });
});

test("合わなかったアプリの明細：ファイルの期間（前後3日）の中・前・後に分ける", () => {
  const rows = rowsOf([["2026-10-05", 100], ["2026-10-20", 200]]);
  const left = [app("old", 1, "2026-09-01"), app("edge1", 1, "2026-10-02"), app("mid", 1, "2026-10-10"), app("edge2", 1, "2026-10-23"), app("next", 1, "2026-10-27")];
  const s = splitLeftoverTxs(rows, left);
  assert.deepEqual(s.before.map((t) => t.id), ["old"]);
  assert.deepEqual(s.within.map((t) => t.id), ["edge1", "mid", "edge2"]);
  assert.deepEqual(s.after.map((t) => t.id), ["next"]);
  assert.equal(splitLeftoverTxs([], left).before.length, 5);
});

test("速さ：CSV 300行 × アプリ 600件でも十分に速い", () => {
  const rows: CsvRow[] = [];
  const txs: Transaction[] = [];
  for (let i = 0; i < 300; i++) rows.push({ index: i + 1, date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, amount: 100 + (i % 97) * 7, shop: "テスト" });
  for (let i = 0; i < 600; i++) txs.push(app(`t${i}`, 100 + ((i * 3) % 101) * 7, `2026-10-${String((i % 28) + 1).padStart(2, "0")}`));
  const t0 = performance.now();
  matchStatement(rows, txs);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `照合 ${ms}ms`);
});
