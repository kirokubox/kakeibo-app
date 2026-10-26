import assert from "node:assert/strict";
import test from "node:test";
import { SEED_GROUPS, buildSeedCategories, seedCategoryId } from "../src/seedCategories.js";
import { buildBackup } from "../src/backup.js";
import { SEED_TIMESTAMP, defaultSettings } from "../src/constants.js";
import { SALARY_PARENT_ID } from "../src/budgetLogic.js";
import { indexExisting, planImport } from "../src/importPreview.js";
import { SETTLE_CATEGORY_ID } from "../src/reimburseLogic.js";
import { SUBSCRIPTION_CATEGORY_ID, SUBSCRIPTION_CATEGORY_IDS } from "../src/subscriptionLogic.js";
import type { Category } from "../src/types.js";
import { emptyData } from "./fixtures.js";

// 一般向けの初期分類（172 改善1 §2-1）。本人に合わせた分類は「本人用の初期データ」で入れる（profileImport.test.ts）
const NOW = "2026-10-25T00:00:00.000Z";
const cats: Category[] = buildSeedCategories(NOW);
const byId = new Map(cats.map((c) => [c.id, c]));
const children = cats.filter((c) => c.parentId !== null);
const parents = cats.filter((c) => c.parentId === null);

function childrenOf(parentName: string, kind: "expense" | "income"): Category[] {
  const p = parents.find((x) => x.kind === kind && x.name === parentName);
  assert.ok(p, `${parentName} がある`);
  return children.filter((c) => c.parentId === p.id);
}

test("idが重複しない／共通項目が入っている", () => {
  assert.equal(byId.size, cats.length);
  for (const c of cats) {
    assert.equal(c.createdAt, NOW);
    assert.equal(c.updatedAt, NOW);
    assert.equal(c.deletedAt, null);
    assert.equal(c.hidden, false);
  }
});

test("小分類が全部、同じ種類（収入／支出）の大分類にぶら下がっている", () => {
  assert.ok(children.length > 0);
  for (const c of children) {
    const p = byId.get(c.parentId!);
    assert.ok(p, `${c.name} の親がある`);
    assert.equal(p.parentId, null, `${c.name} の親は大分類`);
    assert.equal(p.kind, c.kind);
  }
  // 大分類は小分類を1つ以上持つ
  for (const p of parents) assert.ok(children.some((c) => c.parentId === p.id), `${p.name} に小分類がある`);
});

test("並び順（order）は同じ親の中で 0 から連番", () => {
  for (const kind of ["expense", "income"] as const) {
    const ps = parents.filter((p) => p.kind === kind);
    assert.deepEqual(ps.map((p) => p.order), ps.map((_, i) => i));
  }
  for (const p of parents) {
    const cs = children.filter((c) => c.parentId === p.id);
    assert.deepEqual(cs.map((c) => c.order), cs.map((_, i) => i));
  }
});

test("支出の大分類と小分類が 172 改善1 §2-1 の表と一致", () => {
  const expected: Record<string, string[]> = {
    食費: ["食料品", "外食", "カフェ", "おやつ", "飲み物"],
    日用品: ["日用品"],
    交通費: ["電車・バス", "タクシー", "車"],
    "衣服・美容": ["服・靴", "美容"],
    "趣味・娯楽": ["趣味", "本", "旅行", "その他"],
    交際費: ["交際費", "プレゼント"],
    "健康・医療": ["病院・薬"],
    住まい: ["家賃", "家具・家電"],
    水道光熱費: ["電気・ガス・水道"],
    通信費: ["携帯・ネット"],
    サブスク: ["サブスク"],
    保険: ["保険"],
    税金: ["税金"],
    特別な出費: ["冠婚葬祭", "その他"],
    その他: ["その他"],
  };
  const exp = parents.filter((p) => p.kind === "expense");
  assert.deepEqual(exp.map((p) => p.name), Object.keys(expected));
  for (const p of exp) {
    assert.deepEqual(children.filter((c) => c.parentId === p.id).map((c) => c.name), expected[p.name], p.name);
  }
});

test("収入の分類が表と一致し、すべてタグなし", () => {
  const expected: Record<string, string[]> = {
    給与: ["給与", "賞与", "手当"],
    副業: ["副業"],
    一時収入: ["立替返金", "返金", "売却", "ポイント", "お祝い", "その他"],
    その他: ["その他"],
  };
  const inc = parents.filter((p) => p.kind === "income");
  assert.deepEqual(inc.map((p) => p.name), Object.keys(expected));
  for (const p of inc) {
    const cs = children.filter((c) => c.parentId === p.id);
    assert.deepEqual(cs.map((c) => c.name), expected[p.name], p.name);
    for (const c of cs) assert.equal(c.tagMode, "none");
  }
});

test("給料の判定と立替の返金の判定が頼る2つの分類は、名前もIDも今のまま", () => {
  assert.equal(seedCategoryId("income", "給与"), "seed:income:給与");
  assert.equal(SALARY_PARENT_ID, "seed:income:給与");
  assert.equal(byId.get(SALARY_PARENT_ID)?.name, "給与");
  assert.equal(byId.get(SALARY_PARENT_ID)?.kind, "income");
  assert.equal(SETTLE_CATEGORY_ID, "seed:income:一時収入/立替返金");
  const settle = byId.get(SETTLE_CATEGORY_ID);
  assert.equal(settle?.name, "立替返金");
  assert.equal(byId.get(settle!.parentId!)?.name, "一時収入");
});

test("サブスクの分類のIDは一般向けの初期分類にある。v0.8.0 までのIDも数える", () => {
  assert.equal(SUBSCRIPTION_CATEGORY_ID, "seed:expense:サブスク/サブスク");
  assert.ok(byId.has(SUBSCRIPTION_CATEGORY_ID));
  assert.deepEqual(SUBSCRIPTION_CATEGORY_IDS, ["seed:expense:サブスク/サブスク", "seed:expense:固定費/サブスク"]);
});

test("一般向けのタグの設定：日常が初期値とタグなしだけ。「満足か反省を選ぶ」は使わない", () => {
  assert.ok(cats.every((c) => c.tagMode !== "mustChoose"), "mustChoose がない");
  const daily = new Set([
    "食費/食料品", "食費/外食", "食費/カフェ", "食費/おやつ", "食費/飲み物", "日用品/日用品", "交通費/電車・バス", "交通費/タクシー", "交通費/車",
    "衣服・美容/服・靴", "衣服・美容/美容", "趣味・娯楽/趣味", "趣味・娯楽/本", "趣味・娯楽/旅行", "趣味・娯楽/その他", "交際費/交際費", "交際費/プレゼント",
    "住まい/家具・家電", "特別な出費/冠婚葬祭", "特別な出費/その他", "その他/その他",
  ]);
  const none = new Set(["健康・医療/病院・薬", "住まい/家賃", "水道光熱費/電気・ガス・水道", "通信費/携帯・ネット", "サブスク/サブスク", "保険/保険", "税金/税金"]);
  for (const c of children.filter((x) => x.kind === "expense")) {
    const key = `${byId.get(c.parentId!)!.name}/${c.name}`;
    if (daily.has(key)) assert.equal(c.tagMode, "defaultDaily", key);
    else if (none.has(key)) assert.equal(c.tagMode, "none", key);
    else assert.fail(`${key} の割り当てが表にありません`);
  }
  assert.equal(children.filter((c) => c.kind === "expense").length, daily.size + none.size);
  // 大分類は選んで記録しないので none
  for (const p of parents) assert.equal(p.tagMode, "none");
  // 同じ大分類の中に同じ名前の小分類がない
  for (const p of parents) {
    const names = childrenOf(p.name, p.kind).map((c) => c.name);
    assert.equal(new Set(names).size, names.length, p.name);
  }
});

test("初期分類のidは何度作っても同じ（別の端末のバックアップを足しても二重にならない）", () => {
  assert.deepEqual(buildSeedCategories("2027-01-01T00:00:00.000Z").map((c) => c.id), cats.map((c) => c.id));
  assert.ok(SEED_GROUPS.length === parents.length);
});

test("初期分類は何度作っても createdAt / updatedAt が同じ固定値（deletedAt は null）", () => {
  const a = buildSeedCategories();
  const b = buildSeedCategories();
  assert.deepEqual(a, b);
  assert.ok(a.every((c) => c.createdAt === SEED_TIMESTAMP && c.updatedAt === SEED_TIMESTAMP && c.deletedAt === null));
});

test("名前を変えた初期分類を含むバックアップを、新しく初期分類を入れた入れ物へ足すと「更新する」になる", () => {
  const source = emptyData();
  source.categories = buildSeedCategories().map((c) =>
    c.id === "seed:expense:食費" ? { ...c, name: "食費A", updatedAt: "2026-11-01T00:00:00.000Z" } : c,
  );
  const incoming = buildBackup(source, defaultSettings(), "2026-11-02T00:00:00.000Z");
  const fresh = emptyData();
  fresh.categories = buildSeedCategories();
  const plan = planImport(incoming, indexExisting(fresh)).categories;
  assert.deepEqual(plan.update.map((c) => c.id), ["seed:expense:食費"]);
  assert.equal(plan.add.length, 0);
});
