import assert from "node:assert/strict";
import test from "node:test";
import { backupFileName, buildBackup, parseBackup, validateBackup } from "../src/backup.js";
import { defaultSettings } from "../src/constants.js";
import { DATA_STORE_NAMES } from "../src/types.js";
import { emptyData, sampleBackup, sampleData, viaJson } from "./fixtures.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const reason = (v: unknown): string => {
  const r = validateBackup(v);
  return r.ok ? "" : r.reason;
};

test("初期設定の値（給料日25・前の平日・生活防衛資金100,000円・月の区切り＝給料日・今週あと◯円・月曜）", () => {
  const s = defaultSettings();
  assert.equal(s.payday, 25);
  assert.equal(s.paydayHolidayShift, "before");
  assert.equal(s.defenseFund, 100000);
  assert.equal(s.budgetMonthBoundary, "payday");
  assert.equal(s.homeMainFigure, "remaining");
  assert.equal(s.weekStart, "monday");
  assert.ok(s.backupReminderDays > 0);
  assert.equal(s.lastBackupAt, null);
});

test("ファイル名は kakeibo-backup-YYYY-MM-DD.json", () => {
  assert.equal(backupFileName("2026-10-25"), "kakeibo-backup-2026-10-25.json");
});

test("正しいバックアップは検証を通る（全ストアに1件以上、論理削除も含む）", () => {
  const b = sampleBackup();
  for (const name of DATA_STORE_NAMES) assert.ok(b[name].length > 0, `${name} にサンプルがある`);
  const r = validateBackup(viaJson(b));
  assert.equal(r.ok, true);
});

test("書き出し→読み込みで中身が変わらない（論理削除したものも含む）", () => {
  const b = sampleBackup();
  const text = JSON.stringify(b);
  const r = parseBackup(text);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.backup, b);
    assert.equal(r.backup.transactions.find((t) => t.id === "t3")?.deletedAt, "2026-10-02T00:00:00.000Z");
  }
});

test("空のデータでも書き出し→読み込みできる", () => {
  const r = parseBackup(JSON.stringify(buildBackup(emptyData(), defaultSettings(), "2026-10-25T09:00:00.000Z")));
  assert.equal(r.ok, true);
});

test("壊れたファイル・別アプリ・版違いは理由つきで拒否", () => {
  assert.match(parseBackup("{ this is not json").ok ? "" : (parseBackup("{ this is not json") as { reason: string }).reason, /JSON/);
  assert.match(reason(null), /オブジェクト/);
  assert.match(reason([]), /オブジェクト/);
  assert.match(reason({ ...viaJson(sampleBackup()), app: "calendar-app" }), /バックアップではありません/);
  assert.match(reason({ ...viaJson(sampleBackup()), schemaVersion: 2 }), /schemaVersion/);
  assert.match(reason({ ...viaJson(sampleBackup()), exportedAt: "昨日" }), /exportedAt/);
  const noStore: Any = viaJson(sampleBackup());
  delete noStore.transactions;
  assert.match(reason(noStore), /transactions が配列/);
  const noSettings: Any = viaJson(sampleBackup());
  delete noSettings.settings;
  assert.match(reason(noSettings), /settings/);
});

test("金額が小数・文字列・NaN相当のファイルは拒否（取引）", () => {
  const cases: Array<[string, unknown]> = [
    ["小数", 100.5],
    ["文字列", "500"],
    ["null", null],
    ["桁あふれ", 1e300],
  ];
  for (const [label, bad] of cases) {
    const b: Any = viaJson(sampleBackup());
    b.transactions[0].amount = bad;
    assert.match(reason(b), /transactions\[0\]\.amount/, label);
  }
  const fee: Any = viaJson(sampleBackup());
  fee.transactions[1].fee = 110.5;
  assert.match(reason(fee), /transactions\[1\]\.fee/);
});

test("金額が整数でないものは他のストアでも拒否", () => {
  const checks: Array<[string, (b: Any) => void, RegExp]> = [
    ["資産の初期残高", (b) => { b.accounts[0].openingBalance = 10.5; }, /accounts\[0\]\.openingBalance/],
    ["繰り返しのひな形", (b) => { b.recurrings[0].template.amount = "3000"; }, /recurrings\[0\]\.template\.amount/],
    ["給料明細の行", (b) => { b.payrolls[0].lines[1].amount = 0.1; }, /payrolls\[0\]\.lines\[1\]\.amount/],
    ["取り置きの目標額", (b) => { b.reserves[0].targetAmount = 1.5; }, /reserves\[0\]\.targetAmount/],
    ["予定出費", (b) => { b.plannedExpenses[0].amount = "8000"; }, /plannedExpenses\[0\]\.amount/],
    ["予算の根拠", (b) => { b.budgetSnapshots[0].basis.usable = 1.5; }, /budgetSnapshots\[0\]\.basis\.usable/],
    ["カード請求", (b) => { b.cardStatements[0].actualAmount = 12345.6; }, /cardStatements\[0\]\.actualAmount/],
    ["立替", (b) => { b.transactions[0].reimbursement.amount = "100"; }, /reimbursement\.amount/],
    ["生活防衛資金", (b) => { b.settings.defenseFund = 100000.5; }, /settings\.defenseFund/],
  ];
  for (const [label, mutate, re] of checks) {
    const b: Any = viaJson(sampleBackup());
    mutate(b);
    assert.match(reason(b), re, label);
  }
});

test("日付・種別・型の不正は拒否", () => {
  const checks: Array<[string, (b: Any) => void, RegExp]> = [
    ["存在しない日付", (b) => { b.transactions[0].date = "2026-02-30"; }, /transactions\[0\]\.date/],
    ["日付の書き方", (b) => { b.transactions[0].date = "2026/10/01"; }, /transactions\[0\]\.date/],
    ["種類", (b) => { b.transactions[0].type = "expence"; }, /transactions\[0\]\.type/],
    ["タグ", (b) => { b.transactions[0].tag = "good"; }, /transactions\[0\]\.tag/],
    ["取り込み元", (b) => { b.transactions[0].source = "web"; }, /transactions\[0\]\.source/],
    ["内容が文字列でない", (b) => { b.transactions[0].content = 5; }, /transactions\[0\]\.content/],
    ["IDが空", (b) => { b.transactions[0].id = ""; }, /transactions\[0\]\.id/],
    ["updatedAtが日時でない", (b) => { b.transactions[0].updatedAt = "2026-10-01"; }, /transactions\[0\]\.updatedAt/],
    ["deletedAtが不正", (b) => { b.transactions[0].deletedAt = 0; }, /transactions\[0\]\.deletedAt/],
    ["資産のグループ", (b) => { b.accounts[0].group = "bitcoin"; }, /accounts\[0\]\.group/],
    ["分類のタグ設定", (b) => { b.categories[0].tagMode = "always"; }, /categories\[0\]\.tagMode/],
    ["予定出費の月", (b) => { b.plannedExpenses[0].month = "2026-13"; }, /plannedExpenses\[0\]\.month/],
    ["給料日", (b) => { b.settings.payday = 32; }, /settings\.payday/],
    ["レコードがオブジェクトでない", (b) => { b.accounts[0] = "x"; }, /accounts\[0\]/],
  ];
  for (const [label, mutate, re] of checks) {
    const b: Any = viaJson(sampleBackup());
    mutate(b);
    assert.match(reason(b), re, label);
  }
});

test("同じストアの中でIDが重複しているファイルは拒否", () => {
  const b: Any = viaJson(sampleBackup());
  b.transactions[1].id = b.transactions[0].id;
  assert.match(reason(b), /重複/);
});

test("返金が指す立替（settles）の検証：文字列のidだけ通し、壊れた形は拒否", () => {
  const ok: Any = viaJson(sampleBackup());
  assert.equal(ok.transactions[3].settles.txId, "t1");
  assert.equal(validateBackup(ok).ok, true);
  const checks: Array<[string, (b: Any) => void]> = [
    ["txId が数値", (b) => { b.transactions[3].settles = { txId: 5 }; }],
    ["txId が空", (b) => { b.transactions[3].settles = { txId: "" }; }],
    ["txId が無い", (b) => { b.transactions[3].settles = {}; }],
    ["settles が文字列", (b) => { b.transactions[3].settles = "t1"; }],
    ["settles が配列でない形でnull", (b) => { b.transactions[3].settles = null; }],
  ];
  for (const [label, mutate] of checks) {
    const b: Any = viaJson(sampleBackup());
    mutate(b);
    assert.match(reason(b), /transactions\[3\]\.settles/, label);
  }
  // よく使う入力・繰り返しのひな形でも、壊れた settles は拒否
  const t: Any = viaJson(sampleBackup());
  t.favorites[0].template.settles = { txId: 1 };
  assert.match(reason(t), /favorites\[0\]\.template\.settles/);
});

test("オプション項目が無くても通る", () => {
  const d = sampleData();
  const b = viaJson(buildBackup(d, defaultSettings(), "2026-10-25T09:00:00.000Z")) as Any;
  delete b.transactions[0].tag;
  delete b.transactions[0].reimbursement;
  delete b.accounts[1].card;
  assert.equal(validateBackup(b).ok, true);
});

test("段階5で足した項目：正しい値は通り、不正な値は拒否", () => {
  const ok: Any = viaJson(sampleBackup());
  ok.transactions[0].payrollBatchId = "batch-1";
  ok.recurrings[0].generatedThrough = "2026-10-31";
  ok.recurrings.push({
    ...ok.recurrings[0], id: "r2", rule: { every: "year", month: 10, day: 25 }, template: { ...ok.recurrings[0].template, payrollBatchId: "b" },
  });
  ok.recurrings.push({ ...ok.recurrings[0], id: "r3", rule: { every: "week", day: 7 } });
  ok.recurrings.push({ ...ok.recurrings[0], id: "r4", rule: { every: "nMonths", n: 3, day: 5 } });
  ok.payrolls[0].lastAmounts = { pl1: 201000, pl2: 20000 };
  assert.equal(reason(ok), "");

  const checks: Array<[string, (b: Any) => void, RegExp]> = [
    ["payrollBatchId", (b) => { b.transactions[0].payrollBatchId = 5; }, /transactions\[0\]\.payrollBatchId/],
    ["ひな形の payrollBatchId", (b) => { b.recurrings[0].template.payrollBatchId = ""; }, /template\.payrollBatchId/],
    ["generatedThrough", (b) => { b.recurrings[0].generatedThrough = "2026-02-30"; }, /recurrings\[0\]\.generatedThrough/],
    ["rule.month（毎年）", (b) => { b.recurrings[0].rule = { every: "year", day: 5 }; }, /rule\.month/],
    ["rule.month の範囲", (b) => { b.recurrings[0].rule = { every: "year", month: 13, day: 5 }; }, /rule\.month/],
    ["rule.n（◯か月ごと）", (b) => { b.recurrings[0].rule = { every: "nMonths", day: 5 }; }, /rule\.n/],
    ["rule.day の範囲", (b) => { b.recurrings[0].rule = { every: "month", day: 32 }; }, /rule\.day/],
    ["毎週の曜日", (b) => { b.recurrings[0].rule = { every: "week", day: 8 }; }, /rule\.day/],
    ["lineId", (b) => { delete b.payrolls[0].lines[0].lineId; }, /payrolls\[0\]\.lines\[0\]\.lineId/],
    ["精算の行の lineId", (b) => { b.payrolls[0].lines[2].lineId = ""; }, /lines\[2\]\.lineId/],
    ["lastAmounts の金額", (b) => { b.payrolls[0].lastAmounts = { pl1: 1.5 }; }, /lastAmounts\.pl1/],
    ["lastAmounts の型", (b) => { b.payrolls[0].lastAmounts = [1]; }, /lastAmounts/],
    ["支給日", (b) => { b.payrolls[0].day = 0; }, /payrolls\[0\]\.day/],
  ];
  for (const [label, mutate, re] of checks) {
    const b: Any = viaJson(sampleBackup());
    mutate(b);
    assert.match(reason(b), re, label);
  }
});
