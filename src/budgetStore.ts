// 予算の読み書き（画面側）。予算を決める処理は呼ばれた順に1つずつ動かし、同じ期間の予算を二重に作らない
import { useCallback, useEffect, useRef, useState } from "react";
import { planBudgets, planRecalcMonth, planRecalcWeek } from "./budgetLogic";
import type { BudgetContext } from "./budgetLogic";
import type { OutlookData } from "./outlookLogic";
import { getAll, newBase, saveStores } from "./storage";
import type { BudgetSnapshot, CardStatement, PlannedIncome, Settings, SubscriptionReview } from "./types";

/** 使える額・予算・見通しに必要なデータ一式（論理削除したものも含む） */
export interface BudgetBundle extends OutlookData {
  budgetSnapshots: BudgetSnapshot[];
  subscriptionReviews: SubscriptionReview[];
  plannedIncomes: PlannedIncome[];
  cardStatements: CardStatement[];
}

export async function loadBudgetBundle(): Promise<BudgetBundle> {
  const [accounts, categories, transactions, recurrings, payrolls, reserves, reserveMoves, plannedExpenses, budgetSnapshots, subscriptionReviews, plannedIncomes, cardStatements] = await Promise.all([
    getAll("accounts"),
    getAll("categories"),
    getAll("transactions"),
    getAll("recurrings"),
    getAll("payrolls"),
    getAll("reserves"),
    getAll("reserveMoves"),
    getAll("plannedExpenses"),
    getAll("budgetSnapshots"),
    getAll("subscriptionReviews"),
    getAll("plannedIncomes"),
    getAll("cardStatements"),
  ]);
  return { accounts, categories, transactions, recurrings, payrolls, reserves, reserveMoves, plannedExpenses, budgetSnapshots, subscriptionReviews, plannedIncomes, cardStatements };
}

let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job);
  chain = run.catch(() => undefined);
  return run;
}

async function contextOf(settings: Settings, today: string): Promise<BudgetContext> {
  const b = await loadBudgetBundle();
  return { data: b, snapshots: b.budgetSnapshots, settings, today, makeBase: () => newBase(), nowMs: Date.now() };
}

/** まだ決まっていない今週・今月の予算を決める(アプリを開いたとき・戻ったとき・日付が変わったとき)。書き込んだ件数を返す */
export function ensureBudgets(settings: Settings, today: string): Promise<number> {
  return serialized(async () => {
    const written = planBudgets(await contextOf(settings, today));
    if (written.length > 0) await saveStores({ budgetSnapshots: written });
    return written.length;
  });
}

/** 今の額で決め直す */
export function recalcBudget(kind: "week" | "month", settings: Settings, today: string): Promise<void> {
  return serialized(async () => {
    const ctx = await contextOf(settings, today);
    const written = kind === "week" ? planRecalcWeek(ctx) : planRecalcMonth(ctx);
    await saveStores({ budgetSnapshots: written });
  });
}

export interface BundleState {
  bundle: BudgetBundle | null;
  error: string;
}

/** 使える額・予算・見通しのデータを読む。version が変わったら読み直す。ensure を渡すと、読む前に予算を決める */
export function useBudgetBundle(version: number, ensure?: { settings: Settings; today: string }): BundleState & { reload: () => void } {
  const [state, setState] = useState<BundleState>({ bundle: null, error: "" });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const settings = ensure?.settings;
  const today = ensure?.today;
  useEffect(() => {
    const my = ++seq.current;
    (async () => {
      try {
        if (settings && today) await ensureBudgets(settings, today);
        const bundle = await loadBudgetBundle();
        if (my === seq.current) setState({ bundle, error: "" });
      } catch (e) {
        if (my === seq.current) setState((s) => ({ ...s, error: e instanceof Error ? e.message : "データを開けませんでした" }));
      }
    })();
  }, [version, tick, settings, today]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
