// 資産の計算と入力チェック（画面から切り離した純粋なロジック）
import { nextCardPayment } from "./businessDay.js";
import { formatMonthDayWeekday } from "./dateUtils.js";
import { isYen } from "./money.js";
import { byOrder } from "./orderUtils.js";
import { isDayOfMonth } from "./settingsLogic.js";
import type { Account, AccountGroup, DataSet, HolidayShift, Id, Transaction } from "./types.js";

/** 資産タブで並べる種類の順 */
export const GROUP_ORDER: readonly AccountGroup[] = ["cash", "emoney", "bank", "card", "investment", "other"];
export const GROUP_LABELS: Record<AccountGroup, string> = {
  cash: "現金",
  emoney: "電子マネー",
  bank: "銀行",
  card: "カード",
  investment: "投資",
  other: "その他",
};
export const SHIFT_LABELS: Record<HolidayShift, string> = { before: "前の平日", after: "後の平日", none: "そのまま" };

/**
 * 残高 = 初期残高 + 取引。論理削除済みの取引は除く。
 *  収入 ＋金額 / 支出 −金額 / 振替 元から −(金額＋手数料)・先へ ＋金額 / 残高修正 ＋金額（金額は符号つき）。
 *  立替（reimbursement）は残高に影響しない。
 */
export function computeBalances(accounts: readonly Account[], transactions: readonly Transaction[]): Map<Id, number> {
  const balances = new Map<Id, number>();
  for (const a of accounts) balances.set(a.id, a.openingBalance);
  const add = (id: Id | undefined, delta: number) => {
    if (id === undefined) return;
    const current = balances.get(id);
    if (current !== undefined) balances.set(id, current + delta);
  };
  for (const t of transactions) {
    if (t.deletedAt !== null) continue;
    switch (t.type) {
      case "income":
        add(t.accountId, t.amount);
        break;
      case "expense":
        add(t.accountId, -t.amount);
        break;
      case "transfer":
        add(t.accountId, -(t.amount + (t.fee ?? 0)));
        add(t.toAccountId, t.amount);
        break;
      case "adjustment":
        add(t.accountId, t.amount);
        break;
    }
  }
  return balances;
}

/** 1件の取引が、1つの資産の残高を動かす額（計算は computeBalances と同じ。論理削除済みも計算に入れるので呼び出し側で除く） */
export function txEffect(accountId: Id, t: Transaction): number {
  let delta = 0;
  switch (t.type) {
    case "income":
    case "adjustment":
      if (t.accountId === accountId) delta += t.amount;
      break;
    case "expense":
      if (t.accountId === accountId) delta -= t.amount;
      break;
    case "transfer":
      if (t.accountId === accountId) delta -= t.amount + (t.fee ?? 0);
      if (t.toAccountId === accountId) delta += t.amount;
      break;
  }
  return delta;
}

export interface AccountTotals {
  usable: number; // 使える資産（含める資産の残高合計。カードの未払いはマイナスで入る）
  assets: number; // プラスの残高の合計
  liabilities: number; // マイナスの残高の合計（正の数）
  total: number; // 資産 − 負債
  excluded: number; // 使える資産に含めない資産の合計
}

/** 合計。論理削除済みは除く。非表示の資産も入れる（お金が黙って消えないように） */
export function summarizeAccounts(accounts: readonly Account[], balances: ReadonlyMap<Id, number>): AccountTotals {
  const totals: AccountTotals = { usable: 0, assets: 0, liabilities: 0, total: 0, excluded: 0 };
  for (const a of accounts) {
    if (a.deletedAt !== null) continue;
    const b = balances.get(a.id) ?? 0;
    if (a.includeInUsable) totals.usable += b;
    else totals.excluded += b;
    if (b >= 0) totals.assets += b;
    else totals.liabilities += -b;
  }
  totals.total = totals.assets - totals.liabilities;
  return totals;
}

export interface AccountSection {
  group: AccountGroup;
  label: string;
  items: Account[];
  subtotal: number;
}

/** 種類ごとの見出しと小計。表示中（削除・非表示でない）の資産だけ。0件の種類は出さない */
export function groupSections(accounts: readonly Account[], balances: ReadonlyMap<Id, number>): AccountSection[] {
  const sections: AccountSection[] = [];
  for (const group of GROUP_ORDER) {
    const items = accounts.filter((a) => a.group === group && a.deletedAt === null && !a.hidden).sort(byOrder);
    if (items.length === 0) continue;
    sections.push({ group, label: GROUP_LABELS[group], items, subtotal: items.reduce((s, a) => s + (balances.get(a.id) ?? 0), 0) });
  }
  return sections;
}

export interface AccountUsage {
  transactions: number;
  recurrings: number;
  favorites: number;
  payrolls: number;
  cardPayments: number; // 引き落とし口座として使っているカード
  total: number;
}

type UsageData = Pick<DataSet, "accounts" | "transactions" | "recurrings" | "favorites" | "payrolls">;

/** その資産を使っているものの数（論理削除済みからの参照は数えない） */
export function accountUsage(accountId: Id, data: UsageData): AccountUsage {
  const transactions = data.transactions.filter((t) => t.deletedAt === null && (t.accountId === accountId || t.toAccountId === accountId)).length;
  const uses = (tpl: { accountId: Id; toAccountId?: Id }) => tpl.accountId === accountId || tpl.toAccountId === accountId;
  const recurrings = data.recurrings.filter((r) => r.deletedAt === null && uses(r.template)).length;
  const favorites = data.favorites.filter((f) => f.deletedAt === null && uses(f.template)).length;
  const payrolls = data.payrolls.filter(
    (p) => p.deletedAt === null && (p.accountId === accountId || p.lines.some((l) => l.kind === "settlement" && l.accountId === accountId)),
  ).length;
  const cardPayments = data.accounts.filter((a) => a.deletedAt === null && a.id !== accountId && a.card?.paymentAccountId === accountId).length;
  return { transactions, recurrings, favorites, payrolls, cardPayments, total: transactions + recurrings + favorites + payrolls + cardPayments };
}

/** 使われている内訳を文章にする（「12件の明細」など） */
export function usageSummary(u: AccountUsage): string {
  const parts: string[] = [];
  if (u.transactions) parts.push(`${u.transactions}件の明細`);
  if (u.recurrings) parts.push(`${u.recurrings}件の繰り返し`);
  if (u.favorites) parts.push(`${u.favorites}件のよく使う入力`);
  if (u.payrolls) parts.push(`${u.payrolls}件の給料明細`);
  if (u.cardPayments) parts.push(`${u.cardPayments}枚のカードの引き落とし口座`);
  return parts.join("・");
}

/** 表示中・非表示の資産に同じ名前があるか（論理削除済みは除く）。前後の空白は無視 */
export function isDuplicateAccountName(accounts: readonly Account[], name: string, excludeId?: Id): boolean {
  const n = name.trim();
  return accounts.some((a) => a.deletedAt === null && a.id !== excludeId && a.name.trim() === n);
}

/** 新規の「使える資産に含める」の初期値：投資はオフ、ほかはオン */
export function defaultIncludeInUsable(group: AccountGroup): boolean {
  return group !== "investment";
}

/** カードの初期残高：未払い額を正の数で入れてもらい、マイナスで保存する */
export function cardOpeningToStored(input: number): number {
  return input === 0 ? 0 : -Math.abs(input);
}

/** 種類の中で最後の order + 1 */
export function nextAccountOrder(accounts: readonly Account[], group: AccountGroup): number {
  const orders = accounts.filter((a) => a.group === group && a.deletedAt === null).map((a) => a.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

export interface AccountDraft {
  name: string;
  group: AccountGroup;
  openingBalance: number | null;
  card?: { paymentDay: number | null; holidayShift: HolidayShift; paymentAccountId: Id | "" };
}

/** 保存前のチェック。エラーの文章（なければ null） */
export function validateAccountDraft(draft: AccountDraft, accounts: readonly Account[], editingId?: Id): string | null {
  if (draft.name.trim() === "") return "名前を入れてください";
  if (isDuplicateAccountName(accounts, draft.name, editingId)) return "同じ名前の資産があります";
  if (draft.openingBalance === null || !isYen(draft.openingBalance)) return "初期残高を整数で入れてください";
  if (draft.group === "card") {
    const card = draft.card;
    if (!card || !isDayOfMonth(card.paymentDay)) return "引き落とし日を1〜31日で入れてください";
    const bank = accounts.find((a) => a.id === card.paymentAccountId && a.deletedAt === null && a.group === "bank");
    if (!bank) return "引き落とし口座を銀行の資産から選んでください";
  }
  return null;
}

/** カードの行に出す説明 */
export function cardNote(account: Account, accounts: readonly Account[]): string | null {
  if (!account.card) return null;
  const bank = accounts.find((a) => a.id === account.card!.paymentAccountId);
  return `引き落とし 毎月${account.card.paymentDay}日・${bank ? bank.name : "口座未設定"}`;
}

/** 資産タブのカードの行に出す説明：次の引き落とし 11/27(金)・テスト銀行 */
export function cardNextNote(account: Account, accounts: readonly Account[], today: string): string | null {
  if (!account.card) return null;
  const bank = accounts.find((a) => a.id === account.card!.paymentAccountId);
  return `次の引き落とし ${formatMonthDayWeekday(nextCardPayment(account.card, today))}・${bank ? bank.name : "口座未設定"}`;
}

/** 資産の明細のカードに出す「次の引き落とし 11/27(金)」 */
export function nextDebitText(account: Account, today: string): string | null {
  if (!account.card) return null;
  return `次の引き落とし ${formatMonthDayWeekday(nextCardPayment(account.card, today))}`;
}
