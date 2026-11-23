import type { Settings } from "./types.js";

export const SUMMARY_SECTIONS = [
  ["category", "分類別"], ["tag", "タグ別"], ["budget", "予算と実績"],
  ["income", "月ごとの収入と支出"], ["payday", "給料日区切りの使える額"],
  ["asset", "資産の残高の推移"], ["adjust", "残高修正"], ["subscription", "サブスク見直し"],
] as const;

const SIMPLE_VISIBLE = new Set(["category", "income", "asset"]);

export function hiddenSummarySections(settings: Settings): string[] {
  if (settings.hiddenSummarySections !== undefined) return settings.hiddenSummarySections;
  return settings.simpleMode ? SUMMARY_SECTIONS.map(([key]) => key).filter((key) => !SIMPLE_VISIBLE.has(key)) : [];
}

export function isSummarySectionVisible(settings: Settings, key: string): boolean {
  return !hiddenSummarySections(settings).includes(key);
}
