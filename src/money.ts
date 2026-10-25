// 金額は1円単位の整数で持つ。整数以外（小数・文字列・NaN・桁あふれ）は保存しない

export function isYen(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** 整数でなければ例外。保存の直前に使う */
export function assertYen(value: unknown, label = "金額"): number {
  if (!isYen(value)) throw new Error(`${label}は1円単位の整数で入力してください`);
  return value;
}

/** 画面表示用：12,345円（負は −12,345円） */
export function formatYen(value: number): string {
  const sign = value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toLocaleString("ja-JP")}円`;
}
