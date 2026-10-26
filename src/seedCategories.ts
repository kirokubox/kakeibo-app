import { SEED_TIMESTAMP } from "./constants.js";
import type { Category, CategoryKind, TagMode } from "./types.js";

// 分類の初期データ（一般向け）。
// 一般的な家計簿アプリでよく見る分け方にしてある。本人に合わせた分類・タグの設定は、アプリには入れず、
// 「本人用の初期データ」（tools/convert-mmbak/make_profile.py で作るJSON）を「バックアップから追加」で読み込んで入れる。
// 一覧の正本：172_家計簿_実装指示_改善1 §2-1
//   タグの設定は「日常が初期値（defaultDaily）」と「タグなし（none）」だけ。
//   「満足か反省を必ず選ぶ（mustChoose）」は一般向けには使わない（初めての人が保存できず戸惑うため）。
// 大分類（親）は選んで記録するものではないので tagMode は none にしてある（タグは小分類で決まる）。
// 収入の分類は収入・振替にタグを付けない決まりなので、すべて none。
// 次の2つは計算が名前とIDに頼っているので、変えない：
//   収入の大分類「給与」（seed:income:給与。給料の判定）／収入「一時収入＞立替返金」（seed:income:一時収入/立替返金。立替の返金の判定）

type Leaf = readonly [name: string, tagMode: TagMode];

interface Group {
  kind: CategoryKind;
  name: string;
  children: readonly Leaf[];
}

const D: TagMode = "defaultDaily";
const N: TagMode = "none";

const EXPENSE: readonly Group[] = [
  { kind: "expense", name: "食費", children: [["食料品", D], ["外食", D], ["カフェ", D], ["おやつ", D], ["飲み物", D]] },
  { kind: "expense", name: "日用品", children: [["日用品", D]] },
  { kind: "expense", name: "交通費", children: [["電車・バス", D], ["タクシー", D], ["車", D]] },
  { kind: "expense", name: "衣服・美容", children: [["服・靴", D], ["美容", D]] },
  { kind: "expense", name: "趣味・娯楽", children: [["趣味", D], ["本", D], ["旅行", D], ["その他", D]] },
  { kind: "expense", name: "交際費", children: [["交際費", D], ["プレゼント", D]] },
  { kind: "expense", name: "健康・医療", children: [["病院・薬", N]] },
  { kind: "expense", name: "住まい", children: [["家賃", N], ["家具・家電", D]] },
  { kind: "expense", name: "水道光熱費", children: [["電気・ガス・水道", N]] },
  { kind: "expense", name: "通信費", children: [["携帯・ネット", N]] },
  { kind: "expense", name: "サブスク", children: [["サブスク", N]] },
  { kind: "expense", name: "保険", children: [["保険", N]] },
  { kind: "expense", name: "税金", children: [["税金", N]] },
  { kind: "expense", name: "特別な出費", children: [["冠婚葬祭", D], ["その他", D]] },
  { kind: "expense", name: "その他", children: [["その他", D]] },
];

const INCOME: readonly Group[] = [
  { kind: "income", name: "給与", children: [["給与", N], ["賞与", N], ["手当", N]] },
  { kind: "income", name: "副業", children: [["副業", N]] },
  { kind: "income", name: "一時収入", children: [["立替返金", N], ["返金", N], ["売却", N], ["ポイント", N], ["お祝い", N], ["その他", N]] },
  { kind: "income", name: "その他", children: [["その他", N]] },
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
export function buildSeedCategories(now: string = SEED_TIMESTAMP): Category[] {
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
