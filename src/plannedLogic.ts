// 予定出費のロジック（画面から切り離した純粋なロジック）。
// 予定出費 = 月が決まっている先の出費（旅行・車検など）。取り置きと結ぶと、取り置き済みの額を引いた「足りない額」だけが決まった出費になる。
import { isMonthKey } from "./dateUtils.js";
import { isYen } from "./money.js";
import type { Base, Id, PlannedExpense, Reserve, Transaction } from "./types.js";

/** 済みか（済みの判定は doneAt） */
export function isPlannedDone(p: Pick<PlannedExpense, "doneAt">): boolean {
  return p.doneAt !== undefined;
}

export interface PlannedDraft {
  name: string;
  month: string;
  amount: number | null;
}

/** 保存前のチェック。エラーの文章（なければ null） */
export function validatePlannedDraft(d: PlannedDraft): string | null {
  if (d.name.trim() === "") return "名前を入れてください";
  if (!isMonthKey(d.month)) return "月を 2027-03 の形で入れてください";
  if (d.amount === null || !isYen(d.amount) || d.amount <= 0) return "金額を1円以上で入れてください";
  return null;
}

export interface PlannedStatus {
  /** 取り置き済み（結んだ取り置きの残高から充てた額） */
  covered: number;
  /** 足りない額 */
  shortfall: number;
}

/** 一覧の並び：月の順、同じ月は作った順 */
export function sortPlanned<T extends PlannedExpense>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.month.localeCompare(b.month) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * 予定出費ごとの「取り置き済み・足りない」。済みでないものだけ。
 * 同じ取り置きに複数の予定出費を結んだときは、月の古い順に残高を充てていく（同じ残高を二重に数えない）。
 */
export function plannedStatuses(planned: readonly PlannedExpense[], balances: ReadonlyMap<Id, number>): Map<Id, PlannedStatus> {
  const pool = new Map<Id, number>();
  const result = new Map<Id, PlannedStatus>();
  const open = sortPlanned(planned.filter((p) => p.deletedAt === null && !isPlannedDone(p)));
  for (const p of open) {
    let covered = 0;
    if (p.reserveId) {
      const left = pool.get(p.reserveId) ?? Math.max(0, balances.get(p.reserveId) ?? 0);
      covered = Math.min(left, p.amount);
      pool.set(p.reserveId, left - covered);
    }
    result.set(p.id, { covered, shortfall: p.amount - covered });
  }
  return result;
}

/** その月の1日が through 以前か（過ぎてしまった月も含む） */
export function plannedStartsBy(p: Pick<PlannedExpense, "month">, through: string): boolean {
  return `${p.month}-01` <= through;
}

/** 決まった出費に入れる額：済みでなく、月の1日が through 以前のものの「足りない額」の合計 */
export function plannedCommitted(planned: readonly PlannedExpense[], statuses: ReadonlyMap<Id, PlannedStatus>, through: string): number {
  let sum = 0;
  for (const p of planned) {
    if (p.deletedAt !== null || isPlannedDone(p) || !plannedStartsBy(p, through)) continue;
    sum += statuses.get(p.id)?.shortfall ?? p.amount;
  }
  return sum;
}

/** 済みにするときの候補：その月の支出。結んだ取り置きで払ったものを先頭に、あとは日付の順。ほかの予定出費で使い済みのものは除く */
export function doneCandidates(p: PlannedExpense, txs: readonly Transaction[], planned: readonly PlannedExpense[]): Transaction[] {
  const used = new Set(planned.filter((x) => x.deletedAt === null && x.id !== p.id && x.doneTxId).map((x) => x.doneTxId as Id));
  const list = txs.filter((t) => t.deletedAt === null && t.type === "expense" && t.date.slice(0, 7) === p.month && !used.has(t.id));
  const rank = (t: Transaction) => (p.reserveId && t.reserveId === p.reserveId ? 0 : 1);
  return list.sort((a, b) => rank(a) - rank(b) || a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** 済みにする（txId が null なら明細なしで済み） */
export function markPlannedDone(p: PlannedExpense, txId: Id | null, now: string): PlannedExpense {
  const next: PlannedExpense = { ...p, doneAt: now };
  if (txId) next.doneTxId = txId;
  else delete next.doneTxId;
  return next;
}

/** 済みを取り消す */
export function reopenPlanned(p: PlannedExpense): PlannedExpense {
  const next: PlannedExpense = { ...p };
  delete next.doneAt;
  delete next.doneTxId;
  return next;
}

// ---- 予定出費から取り置きを作る ----

/** 予定出費に結んである、いま使える取り置き（削除していない・閉じていない）。なければ undefined */
export function linkedOpenReserve(p: Pick<PlannedExpense, "reserveId">, reserves: readonly Reserve[]): Reserve | undefined {
  if (!p.reserveId) return undefined;
  return reserves.find((r) => r.id === p.reserveId && r.deletedAt === null && !r.closedAt);
}

/**
 * 予定出費から作る取り置きの名前：予定の名前。同じ名前の取り置きがすでにあれば「（使う月）」を、
 * それでも重なれば「（使う月）2」…を付ける（取り置きの名前は重ならない決まり）。
 */
export function reserveNameForPlanned(p: Pick<PlannedExpense, "name" | "month">, reserves: readonly Reserve[]): string {
  const taken = new Set(reserves.filter((r) => r.deletedAt === null).map((r) => r.name.trim()));
  const base = p.name.trim();
  if (!taken.has(base)) return base;
  const withMonth = `${base}（${p.month}）`;
  if (!taken.has(withMonth)) return withMonth;
  for (let n = 2; ; n++) {
    const candidate = `${withMonth}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 取り置きごとの「予定：帰省 2027-01」（結んでいる、済みでない予定出費。月の順。複数は「、」でつなぐ） */
export function plannedNotesByReserve(planned: readonly PlannedExpense[]): Map<Id, string> {
  const names = new Map<Id, string[]>();
  for (const p of sortPlanned(planned.filter((x) => x.deletedAt === null && !isPlannedDone(x) && x.reserveId))) {
    const list = names.get(p.reserveId as Id) ?? [];
    list.push(`${p.name} ${p.month}`);
    names.set(p.reserveId as Id, list);
  }
  return new Map([...names].map(([id, list]) => [id, `予定：${list.join("、")}`]));
}

export type SetAsidePlan =
  /** 結んだ取り置きがある：その取り置きの「入れる」を開くだけ */
  | { kind: "existing"; reserve: Reserve }
  /** 結んだ取り置きがない：名前＝予定の名前・目標額＝予定の金額・使う月＝予定の月で作って結ぶ（そのあと「入れる」を開く） */
  | { kind: "create"; reserve: Reserve; planned: PlannedExpense };

/** 「この予定のために取っておく」の計画 */
export function planSetAside(p: PlannedExpense, reserves: readonly Reserve[], base: Base): SetAsidePlan {
  const linked = linkedOpenReserve(p, reserves);
  if (linked) return { kind: "existing", reserve: linked };
  const reserve: Reserve = { ...base, name: reserveNameForPlanned(p, reserves), targetAmount: p.amount, targetMonth: p.month };
  return { kind: "create", reserve, planned: { ...p, reserveId: reserve.id } };
}
