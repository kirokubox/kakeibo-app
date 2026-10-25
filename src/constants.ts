import type { Settings } from "./types.js";

export const APP_VERSION = "0.4.0";
/** 初期分類の作成・更新時刻（固定）。別の端末で初期分類を入れても同じ時刻になり、本人が変えたもの（これより後）が追加読み込みで「新しい方」になる */
export const SEED_TIMESTAMP = "2026-10-25T00:00:00.000Z";
export const APP_NAME = "家計簿";
export const BACKUP_APP_NAME = "kakeibo-app" as const;
export const BACKUP_SCHEMA_VERSION = 1 as const;

export const DB_NAME = "kakeibo-app";
/** 1: 全ストアを作成（transactions には索引を付ける） */
export const DB_VERSION = 1;
export const SETTINGS_STORE = "settings";
export const SETTINGS_KEY = "app";

/** 画面に出すストア名 */
export const STORE_LABELS = {
  accounts: "資産",
  categories: "分類",
  transactions: "明細",
  recurrings: "繰り返し",
  favorites: "よく使う入力",
  payrolls: "給料明細",
  reserves: "取り置き",
  reserveMoves: "取り置きの出し入れ",
  plannedExpenses: "予定出費",
  budgetSnapshots: "予算の記録",
  cardStatements: "カードの請求",
} as const;

/** transactions に付ける索引（約1万3千件を毎回全部読まないため） */
export const TRANSACTION_INDEXES = ["date", "accountId", "toAccountId", "categoryId", "updatedAt"] as const;

export function defaultSettings(): Settings {
  return {
    payday: 25,
    paydayHolidayShift: "before",
    defenseFund: 100000,
    budgetMonthBoundary: "payday",
    homeMainFigure: "remaining",
    weekStart: "monday",
    backupReminderDays: 14,
    lastBackupAt: null,
  };
}
