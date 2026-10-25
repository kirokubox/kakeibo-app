import assert from "node:assert/strict";
import test from "node:test";
import { SEED_GROUPS, buildSeedCategories } from "../src/seedCategories.js";
import type { Category, TagMode } from "../src/types.js";

const NOW = "2026-10-25T00:00:00.000Z";
const cats: Category[] = buildSeedCategories(NOW);
const byId = new Map(cats.map((c) => [c.id, c]));
const children = cats.filter((c) => c.parentId !== null);
const parents = cats.filter((c) => c.parentId === null);

function leaf(kind: "expense" | "income", parent: string, name: string): Category {
  const c = children.find((x) => x.kind === kind && byId.get(x.parentId!)?.name === parent && x.name === name);
  assert.ok(c, `${parent}＞${name} がある`);
  return c;
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

test("支出の大分類と小分類が 176 §4-1 と一致", () => {
  const expected: Record<string, string[]> = {
    食費: ["ごはん", "外食", "作業カフェ", "おやつ", "飲料", "酒"],
    生活費: ["日用品", "美容", "雑貨", "病院・薬"],
    衣服費: ["服", "靴", "小物", "クリーニング"],
    "趣味・娯楽費": ["本・漫画", "映画", "音楽", "ゲーム", "サウナ", "シーシャ", "グッズ", "イベント", "配信", "その他"],
    嗜好品: ["タバコ", "アダルト"],
    交通費: ["公共交通", "タクシー", "LUUP", "車"],
    交際費: ["友達", "マチアプ", "デート", "飲み会", "プレゼント"],
    特別費: ["旅行・帰省", "家具・家電", "手続き", "自己投資", "その他"],
    固定費: ["家賃", "水道光熱費", "通信", "サブスク", "返済", "天引き"],
    "税金・保険": ["所得税", "住民税", "国民健康保険", "健康保険料", "厚生年金保険料", "雇用保険料", "民間保険", "車両税"],
  };
  const exp = parents.filter((p) => p.kind === "expense");
  assert.deepEqual(exp.map((p) => p.name), Object.keys(expected));
  for (const p of exp) {
    assert.deepEqual(children.filter((c) => c.parentId === p.id).map((c) => c.name), expected[p.name], p.name);
  }
  // 削除した分類（コンビニ・投資）は入っていない
  assert.ok(!cats.some((c) => c.name === "コンビニ" || c.name === "投資"));
});

test("収入の分類が 176 §4-2 と一致し、すべてタグなし", () => {
  const expected: Record<string, string[]> = {
    給与: ["給与", "手当", "賞与"],
    副業: ["ホスト", "保険", "転売", "ブログ", "ファッション同行", "ライター"],
    一時収入: ["立替返金", "返金", "売却", "ポイント換金", "仕送り", "お祝い金", "残高調整", "その他"],
    公的給付: ["失業手当", "給付金", "還付金"],
  };
  const inc = parents.filter((p) => p.kind === "income");
  assert.deepEqual(inc.map((p) => p.name), Object.keys(expected));
  for (const p of inc) {
    const cs = children.filter((c) => c.parentId === p.id);
    assert.deepEqual(cs.map((c) => c.name), expected[p.name], p.name);
    for (const c of cs) assert.equal(c.tagMode, "none");
  }
});

test("tagMode の割り当てが初期仕様 §4-3 と一致", () => {
  const daily = ["ごはん", "外食", "おやつ", "飲料", "作業カフェ", "タバコ", "公共交通", "LUUP", "日用品"];
  const mustChoose = ["酒", "タクシー", "車", "美容", "雑貨", "アダルト"];
  const mustChooseGroups = ["交際費", "趣味・娯楽費", "衣服費", "特別費"]; // 大分類ごと全部
  const noneGroups = ["固定費", "税金・保険"]; // 大分類ごと全部
  const noneLeaves = ["病院・薬"];

  const expect = (c: Category, mode: TagMode) => assert.equal(c.tagMode, mode, `${byId.get(c.parentId!)?.name}＞${c.name}`);

  for (const c of children.filter((x) => x.kind === "expense")) {
    const parentName = byId.get(c.parentId!)!.name;
    if (mustChooseGroups.includes(parentName)) expect(c, "mustChoose");
    else if (noneGroups.includes(parentName)) expect(c, "none");
    else if (noneLeaves.includes(c.name)) expect(c, "none");
    else if (daily.includes(c.name)) expect(c, "defaultDaily");
    else if (mustChoose.includes(c.name)) expect(c, "mustChoose");
    else assert.fail(`${parentName}＞${c.name} の割り当てが仕様にありません`);
  }

  // 仕様に出てくる名前が全部実在する（名前の打ち間違いで割り当てが漏れていないか）
  assert.equal(leaf("expense", "食費", "ごはん").tagMode, "defaultDaily");
  assert.equal(leaf("expense", "食費", "酒").tagMode, "mustChoose");
  assert.equal(leaf("expense", "嗜好品", "タバコ").tagMode, "defaultDaily");
  assert.equal(leaf("expense", "嗜好品", "アダルト").tagMode, "mustChoose");
  assert.equal(leaf("expense", "交通費", "公共交通").tagMode, "defaultDaily");
  assert.equal(leaf("expense", "交通費", "LUUP").tagMode, "defaultDaily");
  assert.equal(leaf("expense", "交通費", "タクシー").tagMode, "mustChoose");
  assert.equal(leaf("expense", "交通費", "車").tagMode, "mustChoose");
  assert.equal(leaf("expense", "生活費", "日用品").tagMode, "defaultDaily");
  assert.equal(leaf("expense", "生活費", "美容").tagMode, "mustChoose");
  assert.equal(leaf("expense", "生活費", "雑貨").tagMode, "mustChoose");
  assert.equal(leaf("expense", "生活費", "病院・薬").tagMode, "none");
  for (const name of [...daily, ...mustChoose]) assert.ok(children.some((c) => c.name === name), `${name} がある`);

  // 大分類は選んで記録しないので none
  for (const p of parents) assert.equal(p.tagMode, "none");
});

test("初期分類のidは何度作っても同じ（別の端末のバックアップを足しても二重にならない）", () => {
  assert.deepEqual(buildSeedCategories("2027-01-01T00:00:00.000Z").map((c) => c.id), cats.map((c) => c.id));
  assert.ok(SEED_GROUPS.length === parents.length);
});
