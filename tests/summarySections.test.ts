import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings } from "../src/constants.js";
import { hiddenSummarySections, isSummarySectionVisible, SUMMARY_SECTIONS } from "../src/summarySections.js";

test("古い設定は通常表示ですべて出す", () => {
  const settings = defaultSettings();
  assert.deepEqual(hiddenSummarySections(settings), []);
  assert.ok(SUMMARY_SECTIONS.every(([key]) => isSummarySectionVisible(settings, key)));
});

test("かんたん表示の未選択時は3項目だけ出す", () => {
  const settings = { ...defaultSettings(), simpleMode: true };
  assert.deepEqual(SUMMARY_SECTIONS.filter(([key]) => isSummarySectionVisible(settings, key)).map(([key]) => key), ["category", "income", "asset"]);
});

test("本人の選択は表示モードを変えても優先する", () => {
  const settings = { ...defaultSettings(), simpleMode: true, hiddenSummarySections: ["tag"] };
  assert.equal(isSummarySectionVisible(settings, "tag"), false);
  assert.equal(isSummarySectionVisible(settings, "budget"), true);
});
