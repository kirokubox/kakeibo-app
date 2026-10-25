// 内容・メモの候補の集計を、アプリを開いたときに1回だけ作って持っておく場所
import { getAll } from "./storage";
import { buildSuggestIndex, updateSuggestIndex } from "./suggestLogic";
import type { SuggestIndex } from "./suggestLogic";
import type { Transaction } from "./types";

let current: SuggestIndex | null = null;
let loading: Promise<SuggestIndex> | null = null;
/** 集計を作っている最中に起きた変更（作り終えたあとに反映する） */
let pending: Transaction[] = [];

/** 集計を返す（まだなら全件から作る。作っている間に呼ばれても1回だけ作る） */
export function getSuggestIndex(): Promise<SuggestIndex> {
  if (current) return Promise.resolve(current);
  if (!loading) {
    loading = getAll("transactions").then((all) => {
      const built = buildSuggestIndex(all);
      for (const t of pending) updateSuggestIndex(built, t);
      pending = [];
      current = built;
      return built;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** 保存・削除・元に戻すのあとに、その1件の分だけ直す */
export function noteTransactionChanged(t: Transaction): void {
  if (current) updateSuggestIndex(current, t);
  else if (loading) pending.push(t);
}

/** バックアップから追加したあとなど、集計を捨てて次に作り直す */
export function resetSuggestIndex(): void {
  current = null;
  loading = null;
  pending = [];
}
