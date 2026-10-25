// 取り置きのロジック（画面から切り離した純粋なロジック）。
// 取り置き = 先の出費のために、使える額から先に外しておくお金。残高 = 入れた − 戻した − 使った。
import { isMonthKey } from "./dateUtils.js";
import { formatYen, isYen } from "./money.js";
import { reimbAmountOf } from "./reimburseLogic.js";
import type { Base, Id, Reserve, ReserveMove, ReserveMoveKind, Transaction } from "./types.js";

export const RESERVE_KIND_LABELS: Record<ReserveMoveKind, string> = { assign: "入れた", release: "戻した", spend: "使った" };

/** 残高に対する動き（入れる＝＋、戻す・使う＝−） */
export function moveDelta(m: Pick<ReserveMove, "kind" | "amount">): number {
  return m.kind === "assign" ? m.amount : -m.amount;
}

/** 取り置きごとの残高（論理削除済みの出し入れは除く） */
export function reserveBalances(moves: readonly ReserveMove[]): Map<Id, number> {
  const map = new Map<Id, number>();
  for (const m of moves) {
    if (m.deletedAt !== null) continue;
    map.set(m.reserveId, (map.get(m.reserveId) ?? 0) + moveDelta(m));
  }
  return map;
}

/** 1つの取り置きの残高（0未満は0）。excludeTxId の「使った」は無かったことにして数える（支出を直すとき） */
export function balanceOf(reserveId: Id, moves: readonly ReserveMove[], excludeTxId?: Id): number {
  let sum = 0;
  for (const m of moves) {
    if (m.deletedAt !== null || m.reserveId !== reserveId) continue;
    if (excludeTxId !== undefined && m.kind === "spend" && m.txId === excludeTxId) continue;
    sum += moveDelta(m);
  }
  return Math.max(0, sum);
}

/** 取り置き残高の合計（論理削除した取り置きは除く。閉じていても残高があれば数える。取り置きごとに0未満は0） */
export function totalReserveBalance(reserves: readonly Reserve[], moves: readonly ReserveMove[]): number {
  const balances = reserveBalances(moves);
  let total = 0;
  for (const r of reserves) {
    if (r.deletedAt !== null) continue;
    total += Math.max(0, balances.get(r.id) ?? 0);
  }
  return total;
}

/** 支出（txId）→ 取り置きから払った額（論理削除済みは除く） */
export function spendByTx(moves: readonly ReserveMove[]): Map<Id, number> {
  const map = new Map<Id, number>();
  for (const m of moves) {
    if (m.deletedAt !== null || m.kind !== "spend" || !m.txId) continue;
    map.set(m.txId, (map.get(m.txId) ?? 0) + m.amount);
  }
  return map;
}

/** 払う額（立替を除いた支出）が使える残高をこえる分 */
export function overflowOf(netAmount: number, available: number): number {
  return Math.max(0, netAmount - Math.max(0, available));
}

/** 取り置きから払う額（支出の金額 − 立替の金額。0未満は0） */
export function netPayAmount(amount: number, reimb?: { amount: number } | null): number {
  const r = reimb ? Math.max(0, Math.min(reimb.amount, amount)) : 0;
  return Math.max(0, amount - r);
}

export interface ReserveDraft {
  name: string;
  targetAmount: number | null;
  targetMonth: string; // 空なら使う月なし
}

/** 保存前のチェック。エラーの文章（なければ null） */
export function validateReserveDraft(d: ReserveDraft, reserves: readonly Reserve[], editingId?: Id): string | null {
  if (d.name.trim() === "") return "名前を入れてください";
  if (reserves.some((r) => r.deletedAt === null && r.id !== editingId && r.name.trim() === d.name.trim())) return "同じ名前の取り置きがあります";
  if (d.targetAmount !== null && (!isYen(d.targetAmount) || d.targetAmount <= 0)) return "目標額は1円以上で入れてください";
  if (d.targetMonth !== "" && !isMonthKey(d.targetMonth)) return "使う月は 2027-03 の形で入れてください";
  return null;
}

/** 入れる金額のチェック */
export function validateAssign(amount: number | null): string | null {
  if (amount === null || !isYen(amount) || amount <= 0) return "金額を1円以上で入れてください";
  return null;
}

/** 戻す金額のチェック（残高以下） */
export function validateRelease(amount: number | null, balance: number): string | null {
  if (amount === null || !isYen(amount) || amount <= 0) return "金額を1円以上で入れてください";
  if (amount > balance) return "戻せるのは残高までです";
  return null;
}

/** 入れたあとの使える額の案内（使える額より多く入れるとき）。問題なければ null */
export function assignWarning(amount: number | null, usable: number | null): string | null {
  if (amount === null || usable === null || amount <= usable) return null;
  return `入れると、使える額が${formatYen(usable - amount)}になります`;
}

export function newMove(base: Base, reserveId: Id, kind: ReserveMoveKind, amount: number, date: string, txId?: Id): ReserveMove {
  const m: ReserveMove = { ...base, reserveId, date, amount, kind };
  if (txId !== undefined) m.txId = txId;
  return m;
}

/**
 * 支出1件に合わせて「使った」の出し入れを直す計画。書き込む出し入れを返す（消すものは deletedAt を入れて返す）。
 *  - 取り置きから払う支出：額 = 支出 − 立替、ただし取り置きの残高まで（こえた分は普通の変動費として数える）。日付は支出の日付
 *  - 取り置きを外した・支出でなくなった・削除した：その支出の「使った」を消す
 */
export function planSpendSync(tx: Transaction, moves: readonly ReserveMove[], now: string, makeBase: () => Base): ReserveMove[] {
  const existing = moves.filter((m) => m.deletedAt === null && m.kind === "spend" && m.txId === tx.id);
  const out: ReserveMove[] = [];
  let rest = existing;
  if (tx.deletedAt === null && tx.type === "expense" && tx.reserveId) {
    const net = Math.max(0, tx.amount - reimbAmountOf(tx));
    const amount = Math.min(net, balanceOf(tx.reserveId, moves, tx.id));
    if (amount > 0) {
      const keep = existing[0];
      if (keep) {
        rest = existing.slice(1);
        if (keep.reserveId !== tx.reserveId || keep.date !== tx.date || keep.amount !== amount) {
          out.push({ ...keep, reserveId: tx.reserveId, date: tx.date, amount });
        }
      } else {
        out.push(newMove(makeBase(), tx.reserveId, "spend", amount, tx.date, tx.id));
      }
    }
  }
  for (const m of rest) out.push({ ...m, deletedAt: now, updatedAt: now });
  return out;
}

/** 「目標 ◯円まであと◯円」。目標がなければ null */
export function targetNote(reserve: Reserve, balance: number): string | null {
  if (reserve.targetAmount === undefined) return null;
  const left = reserve.targetAmount - balance;
  const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
  return left > 0 ? `目標 ${yen(reserve.targetAmount)}まであと${yen(left)}` : `目標 ${yen(reserve.targetAmount)}に届いています`;
}

/** 一覧の並び：使う月が近い順（月なしは後ろ）、同じなら作った順。閉じたものは別に分ける */
export function splitReserves(reserves: readonly Reserve[]): { open: Reserve[]; closed: Reserve[] } {
  const active = reserves.filter((r) => r.deletedAt === null);
  const byTarget = (a: Reserve, b: Reserve) =>
    (a.targetMonth ?? "9999-99").localeCompare(b.targetMonth ?? "9999-99") || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  return {
    open: active.filter((r) => !r.closedAt).sort(byTarget),
    closed: active.filter((r) => !!r.closedAt).sort(byTarget),
  };
}

/** その取り置きの出し入れの履歴（新しい順。論理削除済みは除く） */
export function moveHistory(reserveId: Id, moves: readonly ReserveMove[]): ReserveMove[] {
  return moves
    .filter((m) => m.deletedAt === null && m.reserveId === reserveId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
