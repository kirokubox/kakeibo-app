// 内容（店名）の候補・前回の分類と資産とタグ・メモの語の候補（集計と並べ替え）。
// 全件から1回だけ集計して手元に持ち、保存・削除のたびに、その1件の分だけ直す。
import { addDays } from "./dateUtils.js";
import type { Id, Tag, Transaction } from "./types.js";

export const RECENT_DAYS = 90;
export const CONTENT_LIMIT = 8;
export const MEMO_WORD_LIMIT = 6;

/** 内容の集計に使う、取引1件の控え */
interface UseRecord {
  id: Id;
  date: string;
  createdAt: string;
  categoryId?: Id;
  accountId: Id;
  toAccountId?: Id; // 振替の入金
  tag?: Tag;
}

/** 内容の候補を出す種類（残高修正は内容を持たないので除く） */
export type SuggestType = "income" | "expense" | "transfer";

interface ContentEntry {
  content: string;
  norm: string; // 検索用にそろえた内容
  records: UseRecord[];
}

/** 取り込み時点の控え（直すとき・消すときに、前に足した分を引くため） */
interface Snapshot {
  contentKey: string | null; // 内容の集計に入れていれば、その鍵
  words: string[]; // メモから取った語
}

export interface SuggestIndex {
  contents: Map<string, ContentEntry>; // 鍵 = 種類 + 内容
  words: Map<string, number>; // メモの語 → 出てきた明細の数
  snapshots: Map<Id, Snapshot>;
}

const SEPARATOR_RE = /[\s　/、,，]+/;

function contentKey(type: string, content: string): string {
  return `${type}\u0000${content}`;
}

/** 検索用にそろえる（全角半角・大文字小文字を同じ扱いにする） */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

// ---- メモの語 ----

/** メモを語に分ける。区切りは ` / `・`/`・`、`・`,`・`，`・全角半角の空白 */
export function splitMemo(memo: string): string[] {
  return memo.split(SEPARATOR_RE).filter((w) => w !== "");
}

/** 候補にする語か：2文字以上で、数字だけではない */
export function isCandidateWord(word: string): boolean {
  return [...word].length >= 2 && !/^[0-9０-９]+$/.test(word);
}

/** 打っている最中の語（最後の区切りより後ろ） */
export function currentWord(memo: string): string {
  const parts = memo.split(SEPARATOR_RE);
  return parts[parts.length - 1] ?? "";
}

/** 打っている最中の語を、選んだ語に置き換える（後ろに区切りは付けない） */
export function replaceCurrentWord(memo: string, word: string): string {
  const typed = currentWord(memo);
  return memo.slice(0, memo.length - typed.length) + word;
}

// ---- 集計 ----

export function emptySuggestIndex(): SuggestIndex {
  return { contents: new Map(), words: new Map(), snapshots: new Map() };
}

function addToIndex(index: SuggestIndex, t: Transaction): void {
  const snap: Snapshot = { contentKey: null, words: [] };
  const content = t.content.trim();
  if ((t.type === "income" || t.type === "expense" || t.type === "transfer") && content !== "") {
    const key = contentKey(t.type, content);
    let entry = index.contents.get(key);
    if (!entry) {
      entry = { content, norm: normalizeForMatch(content), records: [] };
      index.contents.set(key, entry);
    }
    entry.records.push({
      id: t.id,
      date: t.date,
      createdAt: t.createdAt,
      categoryId: t.categoryId,
      accountId: t.accountId,
      toAccountId: t.toAccountId,
      tag: t.tag,
    });
    snap.contentKey = key;
  }
  const words = [...new Set(splitMemo(t.memo).filter(isCandidateWord))];
  for (const w of words) index.words.set(w, (index.words.get(w) ?? 0) + 1);
  snap.words = words;
  index.snapshots.set(t.id, snap);
}

function removeFromIndex(index: SuggestIndex, id: Id): void {
  const snap = index.snapshots.get(id);
  if (!snap) return;
  if (snap.contentKey !== null) {
    const entry = index.contents.get(snap.contentKey);
    if (entry) {
      entry.records = entry.records.filter((r) => r.id !== id);
      if (entry.records.length === 0) index.contents.delete(snap.contentKey);
    }
  }
  for (const w of snap.words) {
    const n = (index.words.get(w) ?? 0) - 1;
    if (n <= 0) index.words.delete(w);
    else index.words.set(w, n);
  }
  index.snapshots.delete(id);
}

/** 全件から作る（論理削除されたものは入れない） */
export function buildSuggestIndex(transactions: readonly Transaction[]): SuggestIndex {
  const index = emptySuggestIndex();
  for (const t of transactions) if (t.deletedAt === null) addToIndex(index, t);
  return index;
}

/** 保存・削除・元に戻すのあとに、その1件の分だけ直す */
export function updateSuggestIndex(index: SuggestIndex, t: Transaction): void {
  removeFromIndex(index, t.id);
  if (t.deletedAt === null) addToIndex(index, t);
}

// ---- 内容の候補 ----

interface Scored {
  content: string;
  count: number;
  last: string; // 最後に使った日
}

function scoreEntry(entry: ContentEntry, cutoff: string, categoryId: Id | null): Scored {
  let count = 0;
  let last = "";
  for (const r of entry.records) {
    if (categoryId !== null && r.categoryId !== categoryId) continue;
    if (r.date >= cutoff) count++;
    if (r.date > last) last = r.date;
  }
  return { content: entry.content, count, last };
}

function byUsage(a: Scored, b: Scored): number {
  return b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || (a.content < b.content ? -1 : a.content > b.content ? 1 : 0);
}

/**
 * 内容の候補（最大 limit 件）。
 * 打った文字で始まるもの → 含むもの。それぞれ「直近90日の回数の多い順 → 最後に使った日の新しい順」。
 * 何も打っていないときは、categoryId の小分類で直近90日に使った内容。
 */
export function suggestContents(
  index: SuggestIndex,
  type: SuggestType,
  typed: string,
  today: string,
  categoryId: Id | null = null,
  limit: number = CONTENT_LIMIT,
): string[] {
  const cutoff = addDays(today, -(RECENT_DAYS - 1));
  const needle = normalizeForMatch(typed.trim());
  const prefix = `${type}\u0000`;
  if (needle === "") {
    if (type === "transfer") {
      // 振替は分類がないので、直近90日によく使った内容
      const recent: Scored[] = [];
      for (const [key, entry] of index.contents) {
        if (!key.startsWith(prefix)) continue;
        const s = scoreEntry(entry, cutoff, null);
        if (s.count > 0) recent.push(s);
      }
      return recent.sort(byUsage).slice(0, limit).map((s) => s.content);
    }
    if (categoryId === null) return [];
    const list: Scored[] = [];
    for (const [key, entry] of index.contents) {
      if (!key.startsWith(prefix)) continue;
      const s = scoreEntry(entry, cutoff, categoryId);
      if (s.count > 0) list.push(s);
    }
    return list.sort(byUsage).slice(0, limit).map((s) => s.content);
  }
  const starts: Scored[] = [];
  const includes: Scored[] = [];
  for (const [key, entry] of index.contents) {
    if (!key.startsWith(prefix)) continue;
    const at = entry.norm.indexOf(needle);
    if (at < 0) continue;
    (at === 0 ? starts : includes).push(scoreEntry(entry, cutoff, null));
  }
  return [...starts.sort(byUsage), ...includes.sort(byUsage)].slice(0, limit).map((s) => s.content);
}

/** その内容で前回（いちばん新しい日付、同じ日なら作成が新しいもの）入力した分類・資産・タグ */
export function lastUsageOf(index: SuggestIndex, type: SuggestType, content: string) {
  const entry = index.contents.get(contentKey(type, content.trim()));
  if (!entry) return null;
  let best: UseRecord | null = null;
  for (const r of entry.records) {
    if (best === null || r.date > best.date || (r.date === best.date && r.createdAt > best.createdAt)) best = r;
  }
  if (best === null) return null;
  const usage: { categoryId?: Id; accountId: Id; toAccountId?: Id; tag?: Tag } = { categoryId: best.categoryId, accountId: best.accountId, tag: best.tag };
  if (best.toAccountId !== undefined) usage.toAccountId = best.toAccountId; // 振替だけ
  return usage;
}

// ---- メモの語の候補 ----

/** 打っている最中の語で始まる過去の語を、回数の多い順に最大 limit 件 */
export function suggestMemoWords(index: SuggestIndex, memo: string, limit: number = MEMO_WORD_LIMIT): string[] {
  const typed = currentWord(memo);
  if (typed === "") return [];
  const needle = normalizeForMatch(typed);
  const hits: Array<[string, number]> = [];
  for (const [word, count] of index.words) {
    if (word === typed) continue;
    if (normalizeForMatch(word).startsWith(needle)) hits.push([word, count]);
  }
  hits.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return hits.slice(0, limit).map((h) => h[0]);
}
