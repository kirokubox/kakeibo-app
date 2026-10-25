// 立替・返金に関わる取引だけを、アプリを開いたときに1回だけ全件から拾って持っておく場所。
// 期間の合計から立替分を除く・未回収の一覧に使う。期間の外の返金・立替も見る必要があるため（約1万3千件を毎回読まない）。
import { getAll } from "./storage";
import type { Id, Transaction } from "./types";

let current: Map<Id, Transaction> | null = null;
let loading: Promise<Map<Id, Transaction>> | null = null;
let pending: Transaction[] = [];

function relevant(t: Transaction): boolean {
  return t.deletedAt === null && ((t.type === "expense" && !!t.reimbursement) || (t.type === "income" && !!t.settles));
}

function apply(map: Map<Id, Transaction>, t: Transaction): void {
  if (relevant(t)) map.set(t.id, t);
  else map.delete(t.id);
}

function load(): Promise<Map<Id, Transaction>> {
  if (current) return Promise.resolve(current);
  if (!loading) {
    loading = getAll("transactions").then((all) => {
      const map = new Map<Id, Transaction>();
      for (const t of all) apply(map, t);
      for (const t of pending) apply(map, t);
      pending = [];
      current = map;
      return map;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** 立替の支出と、返金の収入（論理削除されていないもの） */
export async function getReimburseSet(): Promise<Transaction[]> {
  return [...(await load()).values()];
}

/** 保存・削除・元に戻すのあとに、その1件の分だけ直す */
export function noteReimburseChanged(t: Transaction): void {
  if (current) apply(current, t);
  else if (loading) pending.push(t);
}

export function resetReimburseSet(): void {
  current = null;
  loading = null;
  pending = [];
}
