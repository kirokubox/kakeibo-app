// 繰り返しの明細の自動作成と、明細の行に出す「(毎月)」の材料（画面側の読み書き）
import { createContext } from "react";
import { planGeneration, ruleShortLabel } from "./recurrence";
import { activeOnly, getAll, newBase, saveStores } from "./storage";
import { noteTransactionChanged } from "./suggestStore";

let chain: Promise<unknown> = Promise.resolve();

/**
 * 今日までに来た予定の明細を、まだ作っていなければ作る（アプリを開いたとき・画面に戻ったとき・日付が変わったとき）。
 * 呼ばれた順に1つずつ動かすので、続けて呼ばれても二重に作らない。作った件数を返す。
 */
export function generateDueRecurrings(today: string): Promise<number> {
  const run = chain.then(async () => {
    const recs = activeOnly(await getAll("recurrings"));
    const plan = planGeneration(recs, today, () => newBase());
    if (plan.transactions.length === 0) return 0;
    // 明細と、どこまで作ったかの記録は同じトランザクションで書く（片方だけ書かれて二重に作ることがないように）
    await saveStores({ transactions: plan.transactions, recurrings: plan.recurrings });
    for (const t of plan.transactions) noteTransactionChanged(t);
    return plan.transactions.length;
  });
  chain = run.catch(() => undefined);
  return run;
}

/** 繰り返しのid → 「毎月」などの短い名前（論理削除した繰り返しも、作り済みの明細のために残す） */
export async function loadRecurringLabels(): Promise<Map<string, string>> {
  const recs = await getAll("recurrings");
  return new Map(recs.map((r) => [r.id, ruleShortLabel(r.rule)]));
}

export const RecurringLabelsContext = createContext<ReadonlyMap<string, string>>(new Map());
