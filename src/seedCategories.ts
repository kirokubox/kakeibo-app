import type { Category, CategoryKind, TagMode } from "./types.js";

// 分類の初期データ。
// 一覧の正本：176_家計簿_要件と経緯.md §4-1（支出）・§4-2（収入）
// タグの設定の正本：171_家計簿_初期仕様.md §4-3
//   日常が初期値（defaultDaily）：ごはん・外食・おやつ・飲料・作業カフェ・タバコ・公共交通・LUUP・日用品
//   満足か反省を必ず選ぶ（mustChoose）：酒・交際費全部・趣味・娯楽費全部・アダルト・タクシー・車・衣服費全部・美容・雑貨・特別費全部
//   タグなし（none）：固定費全部・税金・保険全部・病院・薬
// 大分類（親）は選んで記録するものではないので tagMode は none にしてある（タグは小分類で決まる）。
// 収入の分類は収入・振替にタグを付けない決まりなので、すべて none。

type Leaf = readonly [name: string, tagMode: TagMode];

interface Group {
  kind: CategoryKind;
  name: string;
  children: readonly Leaf[];
}

const D: TagMode = "defaultDaily";
const M: TagMode = "mustChoose";
const N: TagMode = "none";

const EXPENSE: readonly Group[] = [
  { kind: "expense", name: "食費", children: [["ごはん", D], ["外食", D], ["作業カフェ", D], ["おやつ", D], ["飲料", D], ["酒", M]] },
  { kind: "expense", name: "生活費", children: [["日用品", D], ["美容", M], ["雑貨", M], ["病院・薬", N]] },
  { kind: "expense", name: "衣服費", children: [["服", M], ["靴", M], ["小物", M], ["クリーニング", M]] },
  {
    kind: "expense",
    name: "趣味・娯楽費",
    children: [["本・漫画", M], ["映画", M], ["音楽", M], ["ゲーム", M], ["サウナ", M], ["シーシャ", M], ["グッズ", M], ["イベント", M], ["配信", M], ["その他", M]],
  },
  { kind: "expense", name: "嗜好品", children: [["タバコ", D], ["アダルト", M]] },
  { kind: "expense", name: "交通費", children: [["公共交通", D], ["タクシー", M], ["LUUP", D], ["車", M]] },
  { kind: "expense", name: "交際費", children: [["友達", M], ["マチアプ", M], ["デート", M], ["飲み会", M], ["プレゼント", M]] },
  { kind: "expense", name: "特別費", children: [["旅行・帰省", M], ["家具・家電", M], ["手続き", M], ["自己投資", M], ["その他", M]] },
  { kind: "expense", name: "固定費", children: [["家賃", N], ["水道光熱費", N], ["通信", N], ["サブスク", N], ["返済", N], ["天引き", N]] },
  {
    kind: "expense",
    name: "税金・保険",
    children: [["所得税", N], ["住民税", N], ["国民健康保険", N], ["健康保険料", N], ["厚生年金保険料", N], ["雇用保険料", N], ["民間保険", N], ["車両税", N]],
  },
];

const INCOME: readonly Group[] = [
  { kind: "income", name: "給与", children: [["給与", N], ["手当", N], ["賞与", N]] },
  { kind: "income", name: "副業", children: [["ホスト", N], ["保険", N], ["転売", N], ["ブログ", N], ["ファッション同行", N], ["ライター", N]] },
  { kind: "income", name: "一時収入", children: [["立替返金", N], ["返金", N], ["売却", N], ["ポイント換金", N], ["仕送り", N], ["お祝い金", N], ["残高調整", N], ["その他", N]] },
  { kind: "income", name: "公的給付", children: [["失業手当", N], ["給付金", N], ["還付金", N]] },
];

export const SEED_GROUPS: readonly Group[] = [...EXPENSE, ...INCOME];

/**
 * 初期分類の id。端末が違っても同じ分類は同じ id になるようにしてある
 * （ランダムなUUIDだと、別の端末のバックアップを追加インポートしたときに分類が二重になるため）。
 * 形式：`seed:支出|収入:大分類` / `seed:支出|収入:大分類/小分類`
 */
export function seedCategoryId(kind: CategoryKind, parent: string, child?: string): string {
  const k = kind === "expense" ? "expense" : "income";
  return child === undefined ? `seed:${k}:${parent}` : `seed:${k}:${parent}/${child}`;
}

/** 初期の分類を作る（大分類→小分類の順。order は同じ親の中での並び順） */
export function buildSeedCategories(now: string): Category[] {
  const result: Category[] = [];
  const counters: Record<CategoryKind, number> = { expense: 0, income: 0 };
  for (const group of SEED_GROUPS) {
    const parentId = seedCategoryId(group.kind, group.name);
    result.push({
      id: parentId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      kind: group.kind,
      parentId: null,
      name: group.name,
      order: counters[group.kind]++,
      tagMode: "none",
      hidden: false,
    });
    group.children.forEach(([name, tagMode], index) => {
      result.push({
        id: seedCategoryId(group.kind, group.name, name),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        kind: group.kind,
        parentId,
        name,
        order: index,
        tagMode,
        hidden: false,
      });
    });
  }
  return result;
}
