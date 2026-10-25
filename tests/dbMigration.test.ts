import assert from "node:assert/strict";
import test from "node:test";
import { DB_VERSION } from "../src/constants.js";
import { planUpgrade } from "../src/dbMigration.js";
import { DATA_STORE_NAMES } from "../src/types.js";

// 版1のDBが持っていたストア（subscriptionReviews は無い）
const V1_STORES = ["accounts", "categories", "transactions", "recurrings", "favorites", "payrolls", "reserves", "reserveMoves", "plannedExpenses", "budgetSnapshots", "cardStatements", "settings"];

test("DBの版は2", () => {
  assert.equal(DB_VERSION, 2);
});

test("版1→2：増えたストア（subscriptionReviews）だけを作り、既存のストアには触れない", () => {
  const plan = planUpgrade(V1_STORES);
  assert.deepEqual(plan.create, ["subscriptionReviews"]);
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
