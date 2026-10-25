// 分類の整理（画面から切り離した純粋なロジック）
import { byOrder } from "./orderUtils.js";
import type { Category, CategoryKind, DataSet, Id, TagMode } from "./types.js";

export interface CategoryGroup {
  parent: Category;
  children: Category[]; // order 順。非表示の小分類も含む（論理削除済みは除く）
}

export const TAG_MODE_LABELS: Record<TagMode, string> = {
  defaultDaily: "日常が初期値",
  mustChoose: "満足か反省を選ぶ",
  none: "タグなし",
};
export const TAG_MODE_DESCRIPTIONS: Record<TagMode, string> = {
  defaultDaily: "入力のときに「日常」が入った状態で開きます",
  mustChoose: "満足か反省を選ばないと保存できません",
  none: "固定費など、タグを付けません",
};

/** 大分類ごとに小分類をまとめる（論理削除済みは除く。非表示は残す） */
export function buildGroups(categories: readonly Category[], kind: CategoryKind): CategoryGroup[] {
  const active = categories.filter((c) => c.deletedAt === null && c.kind === kind);
  return active
    .filter((c) => c.parentId === null)
    .sort(byOrder)
    .map((parent) => ({ parent, children: active.filter((c) => c.parentId === parent.id).sort(byOrder) }));
}

/** 同じ大分類（親が null なら大分類どうし）の中で同じ名前があるか。論理削除済みは除く */
export function isDuplicateCategoryName(
  categories: readonly Category[],
  name: string,
  kind: CategoryKind,
  parentId: Id | null,
  excludeId?: Id,
): boolean {
  const n = name.trim();
  return categories.some((c) => c.deletedAt === null && c.id !== excludeId && c.kind === kind && c.parentId === parentId && c.name.trim() === n);
}

/** 同じ親の末尾に付ける order */
export function nextCategoryOrder(categories: readonly Category[], kind: CategoryKind, parentId: Id | null, excludeId?: Id): number {
  const orders = categories.filter((c) => c.deletedAt === null && c.kind === kind && c.parentId === parentId && c.id !== excludeId).map((c) => c.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

/** 小分類を別の大分類へ移した結果。移した先の末尾に並ぶ。移せなければ null（種類違い・大分類でない・移し先が見つからない） */
export function moveToParent(categories: readonly Category[], id: Id, newParentId: Id): Category | null {
  const leaf = categories.find((c) => c.id === id && c.deletedAt === null);
  const parent = categories.find((c) => c.id === newParentId && c.deletedAt === null);
  if (!leaf || !parent || leaf.parentId === null || parent.parentId !== null || parent.kind !== leaf.kind) return null;
  if (leaf.parentId === newParentId) return leaf;
  return { ...leaf, parentId: newParentId, order: nextCategoryOrder(categories, leaf.kind, newParentId, leaf.id) };
}

type UsageData = Pick<DataSet, "transactions" | "recurrings" | "favorites" | "payrolls">;

/** その分類を使っているものの数（論理削除済みを除く） */
export function categoryUsage(categoryId: Id, data: UsageData): number {
  return (
    data.transactions.filter((t) => t.deletedAt === null && t.categoryId === categoryId).length +
    data.recurrings.filter((r) => r.deletedAt === null && r.template.categoryId === categoryId).length +
    data.favorites.filter((f) => f.deletedAt === null && f.template.categoryId === categoryId).length +
    data.payrolls.filter((p) => p.deletedAt === null && p.lines.some((l) => l.kind !== "settlement" && l.categoryId === categoryId)).length
  );
}

export type DeleteCheck = { ok: true } | { ok: false; reason: string; suggestHide: boolean };

/** 削除できるか。大分類は、論理削除されていない小分類（非表示も含む）があるうちは不可。使われているときは非表示を案内する */
export function checkCategoryDelete(category: Category, categories: readonly Category[], data: UsageData): DeleteCheck {
  if (category.parentId === null) {
    const remaining = categories.filter((c) => c.deletedAt === null && c.parentId === category.id).length;
    if (remaining > 0) return { ok: false, reason: "先に小分類を移すか削除してください（非表示の小分類も含みます）", suggestHide: false };
  }
  const used = categoryUsage(category.id, data);
  if (used > 0) return { ok: false, reason: `${used}件の明細などで使っているので削除できません。使わなくなったなら非表示にしてください`, suggestHide: true };
  return { ok: true };
}

/** 新しい小分類のタグの初期値：支出は「日常が初期値」、収入は none */
export function defaultTagModeForNew(kind: CategoryKind): TagMode {
  return kind === "expense" ? "defaultDaily" : "none";
}
