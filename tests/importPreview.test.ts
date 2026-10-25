import assert from "node:assert/strict";
import test from "node:test";
import { buildBackup, parseBackup } from "../src/backup.js";
import { defaultSettings } from "../src/constants.js";
import { indexExisting, planImport, recordsToWrite, sourceNote, totalsOf } from "../src/importPreview.js";
import { T0, T1, T2, emptyData, manyTransactions, sampleBackup, sampleData, tx, viaJson } from "./fixtures.js";

function backupOf(transactions: ReturnType<typeof tx>[]) {
  const d = emptyData();
  d.transactions = transactions;
  return buildBackup(d, defaultSettings(), "2026-10-25T09:00:00.000Z");
}

test("差分：新規・新しい方・古い方・同じ・論理削除済みを分ける", () => {
  const existing = emptyData();
  existing.transactions = [
    tx("same", { updatedAt: T1 }),
    tx("incoming-newer", { updatedAt: T0 }),
    tx("existing-newer", { updatedAt: T2 }),
    tx("deleted-later", { updatedAt: T0 }),
  ];
  const incoming = backupOf([
    tx("new"), // 既存にない
    tx("same", { updatedAt: T1 }), // 同じ
    tx("incoming-newer", { updatedAt: T2, content: "新しい方" }), // 読み込む側が新しい
    tx("existing-newer", { updatedAt: T0 }), // 既存が新しい
    tx("deleted-later", { updatedAt: T1, deletedAt: T1 }), // 読み込む側で削除済み（新しい）
    tx("new-deleted", { updatedAt: T1, deletedAt: T1 }), // 削除済みで既存にない：足す（論理削除のまま）
  ]);
  const plan = planImport(incoming, indexExisting(existing));
  const p = plan.transactions;
  assert.deepEqual(p.add.map((t) => t.id).sort(), ["new", "new-deleted"]);
  assert.deepEqual(p.update.map((t) => t.id).sort(), ["deleted-later", "incoming-newer"]);
  assert.equal(p.same, 1);
  assert.equal(p.older, 1);
  assert.equal(p.total, 6);
  assert.equal(p.add.find((t) => t.id === "new-deleted")?.deletedAt, T1);

  const t = totalsOf(plan);
  assert.deepEqual(t, { total: 6, add: 2, update: 2, skipped: 2 });
});

test("updatedAt はタイムゾーン表記が違っても時刻として比べる", () => {
  const existing = emptyData();
  existing.transactions = [tx("x", { updatedAt: "2026-10-02T00:00:00.000Z" })];
  const incoming = backupOf([tx("x", { updatedAt: "2026-10-02T09:00:00.000+09:00" })]); // 同じ時刻
  const plan = planImport(incoming, indexExisting(existing));
  assert.equal(plan.transactions.same, 1);
  assert.equal(plan.transactions.update.length, 0);
});

test("選んだものだけを書き込む対象にする（足す／更新）。既存データは消さない", () => {
  const existing = emptyData();
  existing.transactions = [tx("keep-only-existing"), tx("u", { updatedAt: T0 })];
  const incoming = backupOf([tx("n"), tx("u", { updatedAt: T2 })]);
  const plan = planImport(incoming, indexExisting(existing));

  const both = recordsToWrite(plan, { add: true, update: true });
  assert.deepEqual(both.transactions.map((t) => t.id).sort(), ["n", "u"]);
  const addOnly = recordsToWrite(plan, { add: true, update: false });
  assert.deepEqual(addOnly.transactions.map((t) => t.id), ["n"]);
  const updateOnly = recordsToWrite(plan, { add: false, update: true });
  assert.deepEqual(updateOnly.transactions.map((t) => t.id), ["u"]);
  const none = recordsToWrite(plan, { add: false, update: false });
  assert.equal(none.transactions.length, 0);
  // 書き込み対象に「既存にだけあるもの」は含まれない＝削除する操作が存在しない
  assert.ok(!both.transactions.some((t) => t.id === "keep-only-existing"));
  // 読み込む側の updatedAt はそのまま
  assert.equal(both.transactions.find((t) => t.id === "u")?.updatedAt, T2);
});

test("全ストアで差分が出る（空の端末に全部足す）", () => {
  const b = buildBackup(sampleData(), defaultSettings(), "2026-10-25T09:00:00.000Z");
  const plan = planImport(b, indexExisting(emptyData()));
  const t = totalsOf(plan);
  assert.equal(t.update, 0);
  assert.equal(t.skipped, 0);
  assert.equal(t.add, t.total);
  assert.ok(t.total >= 11);
});

test("書き出したものを同じ端末へ読み込むと、全部「同じ」で飛ばされる", () => {
  const data = sampleData();
  const r = parseBackup(JSON.stringify(buildBackup(data, defaultSettings(), "2026-10-25T09:00:00.000Z")));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const plan = planImport(r.backup, indexExisting(viaJson(data)));
  const t = totalsOf(plan);
  assert.equal(t.add, 0);
  assert.equal(t.update, 0);
  assert.equal(t.skipped, t.total);
});

test("2万件の差分計算が実用的な時間で終わる（検証→差分→書き込み対象の選択）", () => {
  const n = 20000;
  const existing = emptyData();
  existing.transactions = manyTransactions(n, T0);
  const incomingData = emptyData();
  // 半分は既存より新しい、残りは同じ。さらに1万件は新規
  incomingData.transactions = [
    ...manyTransactions(n, T0).map((t, i) => (i % 2 === 0 ? { ...t, updatedAt: T2, memo: "更新" } : t)),
    ...manyTransactions(10000, T0).map((t) => ({ ...t, id: `new-${t.id}` })),
  ];
  const text = JSON.stringify(buildBackup(incomingData, defaultSettings(), "2026-10-25T09:00:00.000Z"));

  const start = Date.now();
  const parsed = parseBackup(text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const plan = planImport(parsed.backup, indexExisting(existing));
  const writes = recordsToWrite(plan, { add: true, update: true });
  const elapsed = Date.now() - start;

  assert.equal(plan.transactions.total, 30000);
  assert.equal(plan.transactions.add.length, 10000);
  assert.equal(plan.transactions.update.length, 10000);
  assert.equal(plan.transactions.same, 10000);
  assert.equal(writes.transactions.length, 20000);
  assert.ok(elapsed < 5000, `処理に ${elapsed}ms かかった（5秒未満であること）`);
});

test("プレビューの取り込み元：ラベルと明細の件数。取り込み元が無いファイルには出さない", () => {
  assert.equal(sourceNote(undefined, 10), null);
  const note = sourceNote({ type: "rakuna-kakeibo-mmbak", label: "らくな家計簿", importFrom: "2024-01-01" }, 13054);
  assert.equal(note, "取り込み元：らくな家計簿（2024-01-01以降）・明細 13,054件");
  assert.equal(sourceNote({ type: "x", label: "別のアプリ" }, 3), "取り込み元：別のアプリ・明細 3件");
});

test("subscriptionReviews も追加インポートの差分に入る", () => {
  const existing = emptyData();
  const incoming = sampleBackup();
  const plan = planImport(incoming, indexExisting(existing));
  assert.equal(plan.subscriptionReviews.add.length, 1);
  assert.equal(recordsToWrite(plan, { add: true, update: true }).subscriptionReviews.length, 1);
});
