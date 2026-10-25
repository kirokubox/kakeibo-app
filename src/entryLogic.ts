// 入力画面のロジック（画面から切り離した純粋なロジック）
import { GROUP_ORDER } from "./accountLogic.js";
import { MAX_AMOUNT } from "./calculator.js";
import { buildGroups } from "./categoryLogic.js";
import { isYen } from "./money.js";
import { byOrder } from "./orderUtils.js";
import type { Account, Base, Category, CategoryKind, Favorite, Id, Tag, Transaction, TransactionTemplate, TxSource, TxType } from "./types.js";

/** 入力画面の収入・支出で扱う種類（振替は transferLogic の TransferDraft で扱う） */
export type EntryType = "income" | "expense";

export interface EntryDraft {
  type: EntryType;
  date: string;
  accountId: Id | null;
  categoryId: Id | null;
  amount: number | null;
  content: string;
  memo: string;
  tag: Tag | null;
}

export const TAG_LABELS: Record<Tag, string> = { daily: "日常", satisfied: "満足", regret: "反省" };

export function emptyDraft(type: EntryType, date: string): EntryDraft {
  return { type, date, accountId: null, categoryId: null, amount: null, content: "", memo: "", tag: null };
}

export function isEntryType(type: TxType): type is EntryType {
  return type === "income" || type === "expense";
}

export function kindOf(type: EntryType): CategoryKind {
  return type;
}

// ---- 資産・分類の選択肢 ----

/** 資産パネルに出す資産：表示中のもの（種類の順→並び順）。いま選んでいる資産は非表示でも出す */
export function selectableAccounts(accounts: readonly Account[], currentId: Id | null): Account[] {
  return accounts
    .filter((a) => a.deletedAt === null && (!a.hidden || a.id === currentId))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || byOrder(a, b));
}

export function isAccountSelectable(accounts: readonly Account[], id: Id | null | undefined): boolean {
  if (!id) return false;
  return accounts.some((a) => a.id === id && a.deletedAt === null && !a.hidden);
}

export interface CategoryChoiceGroup {
  parent: Category;
  children: Category[];
}

/**
 * 分類パネルに出す大分類と小分類：表示中のものだけ。小分類が0件の大分類は出さない。
 * いま選んでいる小分類は、非表示でも（その親ごと）出す。
 */
export function selectableCategoryGroups(categories: readonly Category[], kind: CategoryKind, currentId: Id | null): CategoryChoiceGroup[] {
  const result: CategoryChoiceGroup[] = [];
  for (const g of buildGroups(categories, kind)) {
    const children = g.children.filter((c) => !c.hidden || c.id === currentId);
    if (children.length === 0) continue;
    if (g.parent.hidden && !children.some((c) => c.id === currentId)) continue;
    result.push({ parent: g.parent, children });
  }
  return result;
}

/** 小分類として選べるか（表示中の小分類で、親も表示中） */
export function isCategorySelectable(categories: readonly Category[], id: Id | null | undefined, kind: CategoryKind): boolean {
  if (!id) return false;
  const c = categories.find((x) => x.id === id && x.deletedAt === null);
  if (!c || c.hidden || c.parentId === null || c.kind !== kind) return false;
  const p = categories.find((x) => x.id === c.parentId && x.deletedAt === null);
  return !!p && !p.hidden;
}

/** 大分類と小分類の名前（見つからなければ null） */
export function categoryNames(categories: readonly Category[], id: Id | undefined | null): { parent: string; child: string } | null {
  if (!id) return null;
  const c = categories.find((x) => x.id === id);
  if (!c) return null;
  const p = c.parentId ? categories.find((x) => x.id === c.parentId) : undefined;
  return { parent: p ? p.name : c.name, child: p ? c.name : "" };
}

// ---- タグ ----

/** 分類に合わせて選べるタグ。収入・タグなしの分類は空（タグの行を出さない） */
export function tagOptions(type: EntryType, category: Category | null | undefined): Tag[] {
  if (type !== "expense" || !category) return [];
  switch (category.tagMode) {
    case "defaultDaily":
      return ["daily", "satisfied", "regret"];
    case "mustChoose":
      return ["satisfied", "regret"];
    default:
      return [];
  }
}

/**
 * 分類を選んだ（選び直した）ときのタグ。
 * 満足か反省を選んでいて新しい分類でも選べるなら残す。日常が初期値なら日常、満足か反省を選ぶなら未選択、タグなしなら消す。
 */
export function tagAfterCategoryChange(prev: Tag | null, type: EntryType, category: Category | null | undefined): Tag | null {
  const options = tagOptions(type, category);
  if (options.length === 0) return null;
  if ((prev === "satisfied" || prev === "regret") && options.includes(prev)) return prev;
  return category!.tagMode === "defaultDaily" ? "daily" : null;
}

// ---- 保存できるか ----

export type MissingField = "account" | "category" | "amount" | "tag";
export type DraftCheck = { ok: true } | { ok: false; field: MissingField; message: string };

/** タグを必須にするか：満足か反省を選ぶ分類で、手で入れる明細（新規・手入力の編集）だけ。取り込んだ明細の編集では必須にしない */
export function isTagRequired(type: EntryType, category: Category | null | undefined, source: TxSource): boolean {
  return type === "expense" && category?.tagMode === "mustChoose" && source === "manual";
}

export function checkDraft(draft: EntryDraft, categories: readonly Category[], source: TxSource = "manual"): DraftCheck {
  if (!draft.accountId) return { ok: false, field: "account", message: "資産を選んでください" };
  const category = draft.categoryId ? categories.find((c) => c.id === draft.categoryId && c.deletedAt === null) : undefined;
  if (!category || category.parentId === null || category.kind !== kindOf(draft.type)) {
    return { ok: false, field: "category", message: "小分類まで選んでください" };
  }
  if (draft.amount === null || !isYen(draft.amount) || draft.amount <= 0 || draft.amount > MAX_AMOUNT) {
    return { ok: false, field: "amount", message: "金額を入れてください" };
  }
  if (isTagRequired(draft.type, category, source) && draft.tag === null) {
    return { ok: false, field: "tag", message: "満足か反省を選んでください" };
  }
  return { ok: true };
}

// ---- 下書きと取引の変換 ----

export function draftFromTransaction(t: Transaction): EntryDraft | null {
  if (!isEntryType(t.type)) return null;
  return {
    type: t.type,
    date: t.date,
    accountId: t.accountId,
    categoryId: t.categoryId ?? null,
    amount: t.amount,
    content: t.content,
    memo: t.memo,
    tag: t.tag ?? null,
  };
}

/** コピーして新しく入力：日付は今日、ほかは同じ */
export function copyDraft(t: Transaction, today: string): EntryDraft | null {
  const d = draftFromTransaction(t);
  return d ? { ...d, date: today } : null;
}

/** 続ける：種類・日付・資産を残し、ほかを空にする */
export function continueDraft(draft: EntryDraft): EntryDraft {
  return { ...emptyDraft(draft.type, draft.date), accountId: draft.accountId };
}

/** 下書き → 取引。existing があれば上書き（作成日時・取り込み元などは残す）。新規は base（id と日時）が必要 */
export function draftToTransaction(draft: EntryDraft, categories: readonly Category[], base: Base, existing?: Transaction): Transaction {
  const category = categories.find((c) => c.id === draft.categoryId);
  const tag = tagOptions(draft.type, category).length > 0 && draft.tag !== null ? draft.tag : null;
  const t: Transaction = {
    ...(existing ?? { ...base, source: "manual" as const }),
    type: draft.type,
    date: draft.date,
    amount: draft.amount ?? 0,
    accountId: draft.accountId ?? "",
    categoryId: draft.categoryId ?? undefined,
    content: draft.content.trim(),
    memo: draft.memo.trim(),
  };
  if (tag === null) delete t.tag;
  else t.tag = tag;
  if (t.categoryId === undefined) delete t.categoryId;
  // 振替から種類を替えたときに、振替だけの項目を残さない
  delete t.toAccountId;
  delete t.fee;
  return t;
}

// ---- よく使う入力 ----

/** 下書き → ひな形。金額が空なら 0、資産が空なら "" で持つ（呼び出したときに空として扱う） */
export function draftToTemplate(draft: EntryDraft): TransactionTemplate {
  const t: TransactionTemplate = {
    type: draft.type,
    amount: draft.amount ?? 0,
    accountId: draft.accountId ?? "",
    content: draft.content.trim(),
    memo: draft.memo.trim(),
  };
  if (draft.categoryId) t.categoryId = draft.categoryId;
  if (draft.tag) t.tag = draft.tag;
  return t;
}

export function nextFavoriteOrder(favorites: readonly Favorite[]): number {
  const orders = favorites.filter((f) => f.deletedAt === null).map((f) => f.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

/** 一覧から呼び出せるか（収入・支出・振替。残高修正のひな形はない） */
export function isFavoriteCallable(template: TransactionTemplate): boolean {
  return isEntryType(template.type) || template.type === "transfer";
}

/** ひな形の資産・分類が、いま選べない状態か */
export function favoriteProblems(
  template: TransactionTemplate,
  accounts: readonly Account[],
  categories: readonly Category[],
): { account: boolean; category: boolean } {
  const type = isEntryType(template.type) ? template.type : "expense";
  if (template.type === "transfer") {
    // 振替は分類がない。出金か入金のどちらかが選べないときは「資産を選び直してください」
    return { account: !isAccountSelectable(accounts, template.accountId) || !isAccountSelectable(accounts, template.toAccountId), category: false };
  }
  return {
    account: !isAccountSelectable(accounts, template.accountId),
    category: !isCategorySelectable(categories, template.categoryId, kindOf(type)),
  };
}

export type RecallFocus = "account" | "category" | "amount";

/**
 * よく使う入力の呼び出し：種類・資産・分類・金額・内容・タグ・メモを今の下書きへ入れる（日付は今のまま）。
 * 資産・分類が使えないときはその項目を空にして、そのパネルを開く。それ以外は金額のテンキー。
 */
export function recallFavorite(
  template: TransactionTemplate,
  current: EntryDraft,
  accounts: readonly Account[],
  categories: readonly Category[],
): { draft: EntryDraft; focus: RecallFocus } | null {
  if (!isEntryType(template.type)) return null;
  const problems = favoriteProblems(template, accounts, categories);
  const category = problems.category ? undefined : categories.find((c) => c.id === template.categoryId);
  let tag = problems.category ? null : tagAfterCategoryChange(template.tag ?? null, template.type, category);
  // ひな形のタグが、その分類で選べるものならそのまま使う（日常も含む）
  if (!problems.category && template.tag && tagOptions(template.type, category).includes(template.tag)) tag = template.tag;
  const draft: EntryDraft = {
    type: template.type,
    date: current.date,
    accountId: problems.account ? null : template.accountId,
    categoryId: problems.category ? null : (template.categoryId ?? null),
    amount: template.amount > 0 ? template.amount : null,
    content: template.content,
    memo: template.memo,
    tag,
  };
  return { draft, focus: problems.account ? "account" : problems.category ? "category" : "amount" };
}

// ---- 前回の分類・資産・タグ ----

export interface LastUsage {
  categoryId?: Id;
  accountId: Id;
  tag?: Tag;
}

export interface UsageHint {
  categoryId: Id | null;
  accountId: Id | null;
  tag: Tag | null;
}

/**
 * 内容を決めたあとに出す「前回：…［合わせる］」の中身。
 * いま選べない資産・分類は提案に含めず（いまの値のまま）、今の下書きと同じなら null。
 */
export function usageHint(
  last: LastUsage | null,
  draft: EntryDraft,
  accounts: readonly Account[],
  categories: readonly Category[],
): UsageHint | null {
  if (!last) return null;
  const accountId = isAccountSelectable(accounts, last.accountId) ? last.accountId : draft.accountId;
  const categoryOk = isCategorySelectable(categories, last.categoryId, kindOf(draft.type));
  const categoryId = categoryOk ? (last.categoryId ?? null) : draft.categoryId;
  let tag: Tag | null = draft.tag;
  if (categoryOk) {
    const category = categories.find((c) => c.id === categoryId);
    if (last.tag && tagOptions(draft.type, category).includes(last.tag)) tag = last.tag;
    else if (categoryId !== draft.categoryId) tag = tagAfterCategoryChange(draft.tag, draft.type, category);
  }
  if (accountId === draft.accountId && categoryId === draft.categoryId && tag === draft.tag) return null;
  return { categoryId, accountId, tag };
}

/** 「合わせる」：提案を下書きへ入れる */
export function applyHint(draft: EntryDraft, hint: UsageHint): EntryDraft {
  return { ...draft, accountId: hint.accountId, categoryId: hint.categoryId, tag: hint.tag };
}
