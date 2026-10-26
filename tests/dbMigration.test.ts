import assert from "node:assert/strict";
import test from "node:test";
import { DB_VERSION } from "../src/constants.js";
import { planUpgrade } from "../src/dbMigration.js";
import { DATA_STORE_NAMES } from "../src/types.js";

// 版1のDBが持っていたストア（subscriptionReviews は無い）
const V1_STORES = ["accounts", "categories", "transactions", "recurrings", "favorites", "payrolls", "reserves", "reserveMoves", "plannedExpenses", "budgetSnapshots", "cardStatements", "settings"];

test("DBの版は3", () => {
  assert.equal(DB_VERSION, 3);
});

// 版2のDBが持っていたストア（plannedIncomes は無い）
const V2_STORES = [...V1_STORES, "subscriptionReviews"];

test("版2→3：増えたストア（plannedIncomes）だけを作り、既存のストア（明細など）には触れない", () => {
  const plan = planUpgrade(V2_STORES);
  assert.deepEqual(plan.create, ["plannedIncomes"]);
  assert.equal(plan.createSettings, false);
  for (const name of V2_STORES) assert.ok(!(plan.create as string[]).includes(name), `${name} は作り直さない`);
});

test("版1→3：増えたストア（subscriptionReviews・plannedIncomes）だけを作り、既存のストアには触れない", () => {
  const plan = planUpgrade(V1_STORES);
  assert.deepEqual([...plan.create].sort(), ["plannedIncomes", "subscriptionReviews"]);
  assert.equal(plan.createSettings, false);
  for (const name of V1_STORES) assert.ok(!(plan.create as string[]).includes(name), `${name} は作り直さない`);
});

test("新しく作るDB：全ストアと設定を作る", () => {
  const plan = planUpgrade([]);
  assert.deepEqual(plan.create, [...DATA_STORE_NAMES]);
  assert.equal(plan.createSettings, true);
});

test("すでに版2なら何も作らない（何度開いても同じ）", () => {
  const plan = planUpgrade([...DATA_STORE_NAMES, "settings"]);
  assert.deepEqual(plan.create, []);
  assert.equal(plan.createSettings, false);
});
