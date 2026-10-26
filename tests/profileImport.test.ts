import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseBackup, buildBackup, validateBackup } from "../src/backup.js";
import { SEED_TIMESTAMP, defaultSettings } from "../src/constants.js";
import { defaultImportSettings, indexExisting, isProfileBackup, planImport, recordsToWrite, settingsAfterImport } from "../src/importPreview.js";
import { buildSeedCategories } from "../src/seedCategories.js";
import type { BackupFile, Settings } from "../src/types.js";
import { emptyData, sampleBackup, viaJson } from "./fixtures.js";

// 本人用の初期データ：make_profile.py が作るJSON。ここでは、架空の旧い初期分類から作った見本
//（tools/convert-mmbak/fixtures/profile.sample.json）で確かめる。実際の本人用のファイルは個人データなので、リポジトリにもテストにも入れない

const SAMPLE = path.resolve(process.cwd(), "tools/convert-mmbak/fixtures/profile.sample.json");

function loadProfile(): BackupFile {
  const r = parseBackup(readFileSync(SAMPLE, "utf-8"));
  if (!r.ok) throw new Error(r.reason);
  return r.backup;
}

/** 新しい端末：一般向けの初期分類だけが入っている */
function freshDevice() {
  const d = emptyData();
  d.categories = buildSeedCategories();
  return d;
}

test("本人用の初期データの見本は、バックアップの検証を通り、profile の印がある", () => {
  const p = loadProfile();
  assert.equal(isProfileBackup(p), true);
  assert.equal(p.profile?.label, "本人用の初期データ");
  assert.ok(p.categories.length > 0);
  // 分類と設定だけが入っていて、ほかのストアは空
  for (const name of ["accounts", "transactions", "recurrings", "favorites", "payrolls", "reserves", "reserveMoves", "plannedExpenses", "budgetSnapshots", "cardStatements", "subscriptionReviews"] as const) {
    assert.equal(p[name].length, 0, name);
  }
  assert.equal(p.settings.defenseFund, 100000);
  assert.equal(p.settings.weekStart, "monday");
  assert.equal(p.settings.lastBackupAt, null);
});

test("一般向けと同じIDの分類は、本人用で「更新する」になる（updatedAt が初期分類の固定値より新しい）", () => {
  const p = loadProfile();
  const general = new Map(buildSeedCategories().map((c) => [c.id, c]));
  assert.ok(p.categories.every((c) => c.updatedAt > SEED_TIMESTAMP), "本人用の分類は固定値より新しい");
  const plan = planImport(p, indexExisting(freshDevice())).categories;
  const sameIds = p.categories.filter((c) => general.has(c.id)).map((c) => c.id);
  assert.ok(sameIds.length > 0);
  assert.deepEqual(plan.update.map((c) => c.id).sort(), [...sameIds].sort());
  // 一般向けにない本人の分類は「足す」
  const onlyProfile = p.categories.filter((c) => !general.has(c.id)).map((c) => c.id);
  assert.ok(onlyProfile.length > 0);
  assert.deepEqual(plan.add.map((c) => c.id).sort(), [...onlyProfile].sort());
  assert.equal(plan.same + plan.older, 0);
  // 本人用の名前・タグの設定で上書きされる（見本では、食費＞外食 が「満足か反省を選ぶ」）
  const written = recordsToWrite(planImport(p, indexExisting(freshDevice())), { add: true, update: true }).categories;
  const gaishoku = written.find((c) => c.id === "seed:expense:食費/外食");
  assert.equal(gaishoku?.tagMode, "mustChoose");
  assert.equal(general.get("seed:expense:食費/外食")?.tagMode, "defaultDaily");
});

test("一般向けにしかない分類は、本人の端末で非表示になる（消さない）", () => {
  const p = loadProfile();
  const visibleIds = new Set(p.categories.filter((c) => !c.hidden).map((c) => c.id));
  const general = buildSeedCategories();
  const generalOnly = general.filter((c) => !visibleIds.has(c.id));
  assert.ok(generalOnly.length > 0);
  const plan = planImport(p, indexExisting(freshDevice())).categories;
  const updated = new Map(plan.update.map((c) => [c.id, c]));
  for (const g of generalOnly) {
    const row = updated.get(g.id);
    assert.ok(row, `${g.name} を非表示にする行がある`);
    assert.equal(row.hidden, true, g.name);
    assert.equal(row.deletedAt, null, `${g.name} は消さない`);
  }
  // 非表示の行は、一般向けの分類のIDだけ
  const generalIds = new Set(general.map((c) => c.id));
  for (const c of p.categories.filter((x) => x.hidden)) assert.ok(generalIds.has(c.id), c.id);
  // 両方にある分類は表示のまま
  for (const g of general.filter((c) => visibleIds.has(c.id))) assert.equal(updated.get(g.id)?.hidden, false);
  // 大分類が非表示なら、その下の小分類も非表示
  const hiddenIds = new Set(p.categories.filter((c) => c.hidden).map((c) => c.id));
  for (const c of p.categories.filter((x) => x.parentId && hiddenIds.has(x.parentId))) assert.equal(c.hidden, true, c.name);
});

test("すでに本人の初期分類が入っている端末（旧い版の端末）では、非表示の行は足され、同じ分類は飛ばされる", () => {
  const p = loadProfile();
  // 旧い版の端末：本人用の分類が（本人用の初期データと同じ updatedAt で）入っている
  const device = emptyData();
  device.categories = p.categories.filter((c) => !c.hidden).map((c) => ({ ...c }));
  const plan = planImport(p, indexExisting(device)).categories;
  assert.equal(plan.update.length, 0);
  assert.equal(plan.add.length, p.categories.filter((c) => c.hidden).length); // 一般向けにしかない分類を非表示で足す
  assert.ok(plan.add.every((c) => c.hidden));
  assert.equal(plan.same, p.categories.filter((c) => !c.hidden).length);
});

test("「設定も読み込む」の初期値：profile があるときだけオン", () => {
  assert.equal(defaultImportSettings(loadProfile()), true);
  assert.equal(defaultImportSettings(sampleBackup()), false);
  assert.equal(isProfileBackup(sampleBackup()), false);
});

test("「設定も読み込む」：オフでは設定が変わらない。オンではファイルの設定に置き換わり、lastBackupAt は今の端末の値を残す", () => {
  const p = loadProfile();
  const current: Settings = { ...defaultSettings(), defenseFund: 0, lastBackupAt: "2026-10-20T00:00:00.000Z", backupReminderDays: 30 };
  assert.equal(settingsAfterImport(current, p, false), null); // 変えない（呼び出し側は何も保存しない）
  const next = settingsAfterImport(current, p, true);
  assert.ok(next);
  assert.equal(next.defenseFund, 100000); // ファイルの値
  assert.equal(next.backupReminderDays, 14);
  assert.equal(next.payday, 25);
  assert.equal(next.lastBackupAt, "2026-10-20T00:00:00.000Z"); // 今の端末の値
  // 今の設定を書き換えない
  assert.equal(current.defenseFund, 0);
  // 週の始まりもファイルの値で置き換わる
  const sunday: BackupFile = { ...sampleBackup(), settings: { ...defaultSettings(), weekStart: "sunday", payday: 10 } };
  const s2 = settingsAfterImport(current, sunday, true);
  assert.equal(s2?.weekStart, "sunday");
  assert.equal(s2?.payday, 10);
});

test("設定の読み込みと分類・明細の読み込みは別：設定だけをオンにしても、データの差分は変わらない", () => {
  const p = loadProfile();
  const plan = planImport(p, indexExisting(freshDevice()));
  const none = recordsToWrite(plan, { add: false, update: false });
  assert.equal(none.categories.length, 0);
  assert.ok(settingsAfterImport(defaultSettings(), p, true));
});

test("profile の印は書き出し→読み込みでも保たれる。ふつうのバックアップには付かない", () => {
  const p = loadProfile();
  const again = parseBackup(JSON.stringify(viaJson(p)));
  assert.equal(again.ok, true);
  if (again.ok) assert.deepEqual(again.backup.profile, p.profile);
  assert.equal("profile" in buildBackup(emptyData(), defaultSettings(), "2026-10-26T00:00:00.000Z"), false);
  const bad = viaJson(p) as unknown as Record<string, unknown>;
  bad.profile = { label: "x" }; // createdAt がない
  assert.equal(validateBackup(bad).ok, false);
});
