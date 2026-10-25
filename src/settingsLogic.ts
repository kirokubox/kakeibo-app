// 設定の入力チェック（画面と自動テストで共通）
import { isYen } from "./money.js";

export const BACKUP_REMINDER_MIN = 1;
export const BACKUP_REMINDER_MAX = 90;

/** 1〜31 の整数か（給料日・引き落とし日） */
export function isDayOfMonth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 31;
}

/** エラーの文章。問題なければ null */
export function validatePayday(value: unknown, label = "給料日"): string | null {
  return isDayOfMonth(value) ? null : `${label}は1〜31日の整数で入力してください`;
}

/** 生活防衛資金：0以上の整数 */
export function validateDefenseFund(value: unknown): string | null {
  if (!isYen(value)) return "生活防衛資金は1円単位の整数で入力してください";
  if (value < 0) return "生活防衛資金は0円以上で入力してください";
  return null;
}

export function validateReminderDays(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < BACKUP_REMINDER_MIN || value > BACKUP_REMINDER_MAX) {
    return `お知らせまでの日数は${BACKUP_REMINDER_MIN}〜${BACKUP_REMINDER_MAX}日の整数で入力してください`;
  }
  return null;
}
