// テスト用の架空データ（個人データは一切使わない）
import { defaultSettings } from "../src/constants.js";
import { buildBackup } from "../src/backup.js";
import type { Account, BackupFile, Category, DataSet, Transaction } from "../src/types.js";

export const T0 = "2026-10-01T00:00:00.000Z";
export const T1 = "2026-10-02T00:00:00.000Z";
export const T2 = "2026-10-03T00:00:00.000Z";

export function emptyData(): DataSet {
  return {
    accounts: [],
    categories: [],
    transactions: [],
    recurrings: [],
    favorites: [],
    payrolls: [],
    reserves: [],
    reserveMoves: [],
    plannedExpenses: [],
    budgetSnapshots: [],
    cardStatements: [],
  };
}

export function account(id: string, extra: Partial<Account> = {}): Account {
  return {
    id, createdAt: T0, updatedAt: T0, deletedAt: null,
    name: `テスト資産${id}`, group: "cash", order: 0, includeInUsable: true, hidden: false, openingBalance: 1000,
    ...extra,
  };
}

export function category(id: string, extra: Partial<Category> = {}): Category {
  return {
    id, createdAt: T0, updatedAt: T0, deletedAt: null,
    kind: "expense", parentId: null, name: `テスト分類${id}`, order: 0, tagMode: "none", hidden: false,
    ...extra,
  };
}

export function tx(id: string, extra: Partial<Transaction> = {}): Transaction {
  return {
    id, createdAt: T0, updatedAt: T0, deletedAt: null,
    type: "expense", date: "2026-10-01", amount: 500, accountId: "a1", categoryId: "c1",
    content: `テスト店${id}`, memo: "", source: "manual",
    ...extra,
  };
}

/** 振替（分類なし。undefined のキーを残さない） */
function transfer(id: string): Transaction {
  const t = tx(id, { type: "transfer", toAccountId: "a2", fee: 110 });
  delete t.categoryId;
  return t;
}

/** 全ストアに1件以上入った、正しいバックアップのデータ */
export function sampleData(): DataSet {
  const d = emptyData();
  d.accounts = [account("a1"), account("a2", { group: "card", card: { paymentDay: 27, holidayShift: "after", paymentAccountId: "a1" } })];
  d.categories = [category("c0"), category("c1", { parentId: "c0", tagMode: "defaultDaily" })];
  d.transactions = [
    tx("t1", { tag: "daily", reimbursement: { counterparty: "テスト太郎", amount: 100 } }),
    transfer("t2"),
    tx("t3", { deletedAt: T1, updatedAt: T1 }),
    tx("t4", { type: "income", amount: 100, settles: { txId: "t1" } }),
  ];
  const template = { type: "expense" as const, amount: 3000, accountId: "a1", categoryId: "c1", content: "テスト定期", memo: "" };
  d.recurrings = [{ id: "r1", createdAt: T0, updatedAt: T0, deletedAt: null, template, rule: { every: "month", day: "last" }, startDate: "2026-10-01", holidayShift: "before", estimated: false }];
  d.favorites = [{ id: "f1", createdAt: T0, updatedAt: T0, deletedAt: null, template, order: 0 }];
  d.payrolls = [{
    id: "p1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト給与", accountId: "a1", day: 25, holidayShift: "before",
    lines: [
      { lineId: "pl1", kind: "pay", categoryId: "c1", label: "基本給", amount: 200000 },
      { lineId: "pl2", kind: "deduction", categoryId: "c1", label: "税", amount: 20000 },
      { lineId: "pl3", kind: "settlement", accountId: "a2", label: "精算", amount: 5000 },
    ],
  }];
  d.reserves = [{ id: "rs1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト旅行", targetAmount: 50000, targetMonth: "2027-03" }];
  d.reserveMoves = [{ id: "rm1", createdAt: T0, updatedAt: T0, deletedAt: null, reserveId: "rs1", date: "2026-10-05", amount: 10000, kind: "assign" }];
  d.plannedExpenses = [{ id: "pe1", createdAt: T0, updatedAt: T0, deletedAt: null, name: "テスト予定", month: "2026-12", amount: 8000 }];
  d.budgetSnapshots = [{ id: "b1", createdAt: T0, updatedAt: T0, deletedAt: null, period: "week", start: "2026-10-05", end: "2026-10-11", amount: 21000, basis: { usable: 150000 } }];
  d.cardStatements = [{ id: "cs1", createdAt: T0, updatedAt: T0, deletedAt: null, cardAccountId: "a2", paymentDate: "2026-10-27", actualAmount: 12345, diff: 0 }];
  return d;
}

export function sampleBackup(): BackupFile {
  return buildBackup(sampleData(), defaultSettings(), "2026-10-25T09:00:00.000Z");
}

/** 取引だけ n 件のデータ（性能テスト用） */
export function manyTransactions(n: number, updatedAt: string = T0): Transaction[] {
  const list: Transaction[] = [];
  for (let i = 0; i < n; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    list.push(tx(`m${i}`, { date: `2026-10-${day}`, amount: (i % 5000) + 1, updatedAt, createdAt: T0 }));
  }
  return list;
}

/** parse→stringify で別オブジェクトにして返す（ファイルを読んだ状態を再現） */
export function viaJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
