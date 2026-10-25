// 端末ごとの小さな好み（最後に選んだ表示など）。localStorage が使えなくても動くよう、読み書きは必ず握りつぶす

export const PREF_ENTRIES_MODE = "kakeibo-app:entriesMode";
export const PREF_LAST_ACCOUNT = "kakeibo-app:lastAccountId";
export const PREF_OUTLOOK_MONTHS = "kakeibo-app:outlookMonths";

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても動く
  }
}
