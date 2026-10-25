// 型定義。正本は 05_開発・Webアプリ/17_家計簿/171_家計簿_初期仕様.md §5

/** データを入れるストア（IndexedDB のオブジェクトストア）の名前。設定（settings）は別扱い */
export const DATA_STORE_NAMES = [
  "accounts",
  "categories",
  "transactions",
  "recurrings",
  "favorites",
  "payrolls",
  "reserves",
  "reserveMoves",
  "plannedExpenses",
  "budgetSnapshots",
  "cardStatements",
] as const;
export type DataStoreName = (typeof DATA_STORE_NAMES)[number];

export type Id = string; // UUID（初期分類だけは端末をまたいで同じになる固定の文字列）

/** 全レコード共通。削除は deletedAt に時刻を入れる論理削除 */
export interface Base {
  id: Id;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  deletedAt: string | null;
}

export type HolidayShift = "before" | "after" | "none";

export type AccountGroup = "cash" | "emoney" | "bank" | "card" | "investment" | "other";
export interface Account extends Base {
  name: string;
  group: AccountGroup;
  order: number;
  includeInUsable: boolean; // 使える資産に含める（投資・定期などは false）
  hidden: boolean; // 非表示（アーカイブ）
  openingBalance: number; // 初期残高（1円単位の整数）
  card?: {
    paymentDay: number; // 引き落とし日（例 27）
    holidayShift: HolidayShift;
    paymentAccountId: Id; // 引き落とし口座
  };
}

export type CategoryKind = "income" | "expense";
export type TagMode = "defaultDaily" | "mustChoose" | "none";
export interface Category extends Base {
  kind: CategoryKind;
  parentId: Id | null; // 大分類は null、小分類は大分類の id
  name: string;
  order: number;
  tagMode: TagMode;
  hidden: boolean;
}

export type TxType = "income" | "expense" | "transfer" | "adjustment";
export type Tag = "daily" | "satisfied" | "regret";
export type TxSource = "manual" | "recurring" | "import";
export interface Transaction extends Base {
  type: TxType;
  date: string; // YYYY-MM-DD
  amount: number; // 残高修正（adjustment）だけ符号つき（増えたら正、減ったら負）。ほかの種類は正の数
  accountId: Id;
  toAccountId?: Id;
  fee?: number; // 振替の手数料
  categoryId?: Id; // 収入・支出は必須（小分類）
  content: string;
  memo: string;
  tag?: Tag;
  /** 立替。settledTxId は段階4から使わない。返金は settles で数える（1回で返ってくる前提の項目だったため。型は互換のために残す） */
  reimbursement?: { counterparty: string; amount: number; settledTxId?: Id };
  /** 返金の収入が、どの立替（支出）を返したか。立替の残り = 立替の金額 − これで指す収入の合計 */
  settles?: { txId: Id };
  reserveId?: Id; // 取り置きから払った支出
  estimated?: boolean; // 見込み額
  reconciledStatementId?: Id; // カード照合済み
  recurringId?: Id;
  payrollId?: Id;
  source: TxSource;
}

/** 取引のひな形（繰り返し・よく使う入力で使う） */
export type TransactionTemplate = Omit<Transaction, keyof Base | "date" | "source">;

export type RecurringEvery = "month" | "nMonths" | "year" | "week";
export interface Recurring extends Base {
  template: TransactionTemplate;
  rule: { every: RecurringEvery; n?: number; day: number | "last" };
  startDate: string;
  endDate?: string;
  holidayShift: HolidayShift;
  estimated: boolean; // 毎月金額が変わるもの
}

export interface Favorite extends Base {
  template: TransactionTemplate;
  order: number;
}

export type PayrollLine =
  | { kind: "pay" | "deduction"; categoryId: Id; label: string; amount: number }
  | { kind: "settlement"; accountId: Id; label: string; amount: number }; // 社員証などの精算（支出にしない）
export interface Payroll extends Base {
  name: string;
  accountId: Id;
  day: number;
  holidayShift: HolidayShift;
  lines: PayrollLine[];
}

export interface Reserve extends Base {
  name: string;
  targetAmount?: number;
  targetMonth?: string; // YYYY-MM
  closedAt?: string;
}

export type ReserveMoveKind = "assign" | "release" | "spend";
export interface ReserveMove extends Base {
  reserveId: Id;
  date: string;
  amount: number;
  kind: ReserveMoveKind;
  txId?: Id;
}

export interface PlannedExpense extends Base {
  name: string;
  month: string; // YYYY-MM
  amount: number;
  reserveId?: Id;
  doneTxId?: Id;
}

export type BudgetPeriod = "week" | "month";
export interface BudgetSnapshot extends Base {
  period: BudgetPeriod;
  start: string;
  end: string;
  amount: number;
  basis: Record<string, number>;
}

export interface CardStatement extends Base {
  cardAccountId: Id;
  paymentDate: string;
  actualAmount: number;
  diff: number;
}

export type BudgetMonthBoundary = "payday" | "calendar";
export type HomeMainFigure = "remaining" | "spent";
/** 設定。1端末に1つだけ持つ（IndexedDB の settings ストア、キー "app"）。バックアップには入るが、追加インポートでは上書きしない */
export interface Settings {
  payday: number; // 初期値 25
  paydayHolidayShift: HolidayShift; // 初期値 'before'
  defenseFund: number; // 初期値 100000
  budgetMonthBoundary: BudgetMonthBoundary; // 初期値 'payday'
  homeMainFigure: HomeMainFigure; // 初期値 'remaining'
  weekStart: "monday";
  backupReminderDays: number; // 最後のバックアップから何日で知らせるか
  lastBackupAt: string | null;
}

/** データストア名ごとのレコード型 */
export interface DataStoreRecords {
  accounts: Account;
  categories: Category;
  transactions: Transaction;
  recurrings: Recurring;
  favorites: Favorite;
  payrolls: Payroll;
  reserves: Reserve;
  reserveMoves: ReserveMove;
  plannedExpenses: PlannedExpense;
  budgetSnapshots: BudgetSnapshot;
  cardStatements: CardStatement;
}

/** 全データストアの中身 */
export type DataSet = { [K in DataStoreName]: DataStoreRecords[K][] };

/** バックアップファイル（schemaVersion 1）。論理削除したものも含む */
export interface BackupFile extends DataSet {
  app: "kakeibo-app";
  schemaVersion: 1;
  exportedAt: string;
  settings: Settings;
}
