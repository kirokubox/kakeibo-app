// 検索のロジック（画面から切り離した純粋なロジック）。
// 文字は全角・半角の英数字、カタカナ・ひらがなの違いを区別しない。空白で区切ると「すべて含む」。
import { monthRange, summarize } from "./periodLogic.js";
import type { AppliedReturns, PeriodTotals } from "./periodLogic.js";
import type { Account, Category, Id, Tag, Transaction, TxType } from "./types.js";

/** 検索用にそろえる：全角半角（NFKC）・大文字小文字・カタカナ→ひらがな */
export function normalizeText(text: string): string {
  const s = text.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}

/** 文字の欄を語に分ける（空白で区切る。空なら空配列） */
export function searchTerms(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .filter((w) => w !== "");
}

export type PeriodChoice = "all" | "thisYear" | "lastYear" | "custom";
export type TagChoice = Tag | "none";

export interface SearchFilter {
  text: string;
  period: PeriodChoice;
  /** 期間が custom のとき（どちらかが空でもよい） */
  customStart: string;
  customEnd: string;
  accountIds: Id[];
  /** 大分類か小分類のid（大分類を選ぶと、その下の小分類すべて） */
  categoryIds: Id[];
  amountMin: number | null;
  amountMax: number | null;
  tags: TagChoice[];
  types: TxType[];
}

export function emptyFilter(): SearchFilter {
  return { text: "", period: "all", customStart: "", customEnd: "", accountIds: [], categoryIds: [], amountMin: null, amountMax: null, tags: [], types: [] };
}

/** 絞り込み（文字以外）が1つでも選ばれているか */
export function hasRefinement(f: SearchFilter): boolean {
  return f.period !== "all" || f.accountIds.length > 0 || f.categoryIds.length > 0 || f.amountMin !== null || f.amountMax !== null || f.tags.length > 0 || f.types.length > 0;
}

/** 何か1つでも条件があるか（文字か絞り込み） */
export function hasAnyCondition(f: SearchFilter): boolean {
  return searchTerms(f.text).length > 0 || hasRefinement(f);
}

/** 期間の選びかたを日付の範囲にする（無制限の側は空） */
export function periodBounds(f: SearchFilter, today: string): { start: string; end: string } {
  const year = Number(today.slice(0, 4));
  if (f.period === "thisYear") return { start: `${year}-01-01`, end: `${year}-12-31` };
  if (f.period === "lastYear") return { start: `${year - 1}-01-01`, end: `${year - 1}-12-31` };
  if (f.period === "custom") return { start: f.customStart, end: f.customEnd };
  return { start: "", end: "" };
}

export interface SearchEntry {
  tx: Transaction;
  /** 内容・メモ・立替の相手をそろえてつなげたもの */
  hay: string;
}

/** 検索の元。全件に対して1回だけ作り、保存・削除のあとに作り直す（打つたびに文字をそろえ直さないため） */
export function buildSearchIndex(transactions: readonly Transaction[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const tx of transactions) {
    if (tx.deletedAt !== null) continue;
    out.push({ tx, hay: normalizeText(`${tx.content}\n${tx.memo}\n${tx.reimbursement?.counterparty ?? ""}`) });
  }
  return out;
}

/** 絞り込みに使う分類idの集まり（大分類を選んだらその小分類も入れる）。選んでいなければ null */
export function expandCategoryIds(selected: readonly Id[], categories: readonly Category[]): Set<Id> | null {
  if (selected.length === 0) return null;
  const set = new Set<Id>(selected);
  for (const c of categories) if (c.parentId !== null && set.has(c.parentId)) set.add(c.id);
  return set;
}

/** 検索する。新しい日から、同じ日は作った順の新しいものを上にする必要はなく、groupByDay が並べる */
export function searchTransactions(index: readonly SearchEntry[], f: SearchFilter, categories: readonly Category[], today: string): Transaction[] {
  const terms = searchTerms(f.text);
  const { start, end } = periodBounds(f, today);
  const accounts = f.accountIds.length > 0 ? new Set(f.accountIds) : null;
  const cats = expandCategoryIds(f.categoryIds, categories);
  const tags = f.tags.length > 0 ? new Set<TagChoice>(f.tags) : null;
  const types = f.types.length > 0 ? new Set<TxType>(f.types) : null;
  const out: Transaction[] = [];
  for (const { tx, hay } of index) {
    if (start !== "" && tx.date < start) continue;
    if (end !== "" && tx.date > end) continue;
    if (types && !types.has(tx.type)) continue;
    if (accounts && !accounts.has(tx.accountId) && !(tx.toAccountId !== undefined && accounts.has(tx.toAccountId))) continue;
    if (cats && !(tx.categoryId !== undefined && cats.has(tx.categoryId))) continue;
    const amount = Math.abs(tx.amount);
    if (f.amountMin !== null && amount < f.amountMin) continue;
    if (f.amountMax !== null && amount > f.amountMax) continue;
    if (tags && !tags.has(tx.tag ?? "none")) continue;
    let all = true;
    for (const w of terms) {
      if (!hay.includes(w)) {
        all = false;
        break;
      }
    }
    if (all) out.push(tx);
  }
  return out;
}

export interface SearchResultTotals extends PeriodTotals {
  count: number;
}

/** 結果の件数と合計（明細タブと同じ数え方：立替・返金の除き方、振替・残高修正は数えない） */
export function searchTotals(results: readonly Transaction[], applied?: AppliedReturns): SearchResultTotals {
  return { count: results.length, ...summarize(results, undefined, applied) };
}

// ---- 選んだ絞り込みの表示 ----

export type FilterKey = "period" | "amount" | `account:${string}` | `category:${string}` | `tag:${string}` | `type:${string}`;
export interface FilterChip {
  key: FilterKey;
  label: string;
}

const TYPE_LABELS: Record<TxType, string> = { income: "収入", expense: "支出", transfer: "振替", adjustment: "残高修正" };
const TAG_NAMES: Record<TagChoice, string> = { daily: "日常", satisfied: "満足", regret: "反省", none: "タグなし" };
export { TYPE_LABELS as SEARCH_TYPE_LABELS, TAG_NAMES as SEARCH_TAG_LABELS };

function yenText(n: number): string {
  return `${n.toLocaleString("ja-JP")}円`;
}

/** 文字の欄の下に並べる、選んだ絞り込み */
export function filterChips(f: SearchFilter, accounts: readonly Account[], categories: readonly Category[], today: string): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.period !== "all") {
    const b = periodBounds(f, today);
    const label = f.period === "thisYear" ? "今年" : f.period === "lastYear" ? "去年" : `${b.start || "…"}〜${b.end || "…"}`;
    chips.push({ key: "period", label });
  }
  for (const id of f.accountIds) chips.push({ key: `account:${id}`, label: accounts.find((a) => a.id === id)?.name ?? "資産不明" });
  for (const id of f.categoryIds) {
    const c = categories.find((x) => x.id === id);
    const parent = c?.parentId ? categories.find((x) => x.id === c.parentId) : undefined;
    chips.push({ key: `category:${id}`, label: c ? (parent ? `${parent.name}/${c.name}` : c.name) : "分類不明" });
  }
  if (f.amountMin !== null || f.amountMax !== null) {
    const label = f.amountMin !== null && f.amountMax !== null ? `${yenText(f.amountMin)}〜${yenText(f.amountMax)}` : f.amountMin !== null ? `${yenText(f.amountMin)}以上` : `${yenText(f.amountMax!)}以下`;
    chips.push({ key: "amount", label });
  }
  for (const t of f.tags) chips.push({ key: `tag:${t}`, label: TAG_NAMES[t] });
  for (const t of f.types) chips.push({ key: `type:${t}`, label: TYPE_LABELS[t] });
  return chips;
}

/** ×で外す */
export function removeFilter(f: SearchFilter, key: FilterKey): SearchFilter {
  if (key === "period") return { ...f, period: "all", customStart: "", customEnd: "" };
  if (key === "amount") return { ...f, amountMin: null, amountMax: null };
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  if (kind === "account") return { ...f, accountIds: f.accountIds.filter((x) => x !== value) };
  if (kind === "category") return { ...f, categoryIds: f.categoryIds.filter((x) => x !== value) };
  if (kind === "tag") return { ...f, tags: f.tags.filter((x) => x !== value) };
  return { ...f, types: f.types.filter((x) => x !== value) };
}

/** 今月の範囲（任意の期間の初期値に使う） */
export function thisMonthBounds(today: string): { start: string; end: string } {
  return monthRange(today.slice(0, 7));
}
