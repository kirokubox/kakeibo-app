import { BACKUP_APP_NAME, BACKUP_SCHEMA_VERSION } from "./constants.js";
import { isIsoDateTime, isLocalDate, isMonthKey } from "./dateUtils.js";
import { isYen } from "./money.js";
import { DATA_STORE_NAMES } from "./types.js";
import type { BackupFile, DataSet, DataStoreName, Settings } from "./types.js";

/** 全データストア＋設定からバックアップを作る（論理削除したものも含む） */
export function buildBackup(data: DataSet, settings: Settings, exportedAt: string): BackupFile {
  return {
    app: BACKUP_APP_NAME,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    accounts: data.accounts,
    categories: data.categories,
    transactions: data.transactions,
    recurrings: data.recurrings,
    favorites: data.favorites,
    payrolls: data.payrolls,
    reserves: data.reserves,
    reserveMoves: data.reserveMoves,
    plannedExpenses: data.plannedExpenses,
    budgetSnapshots: data.budgetSnapshots,
    cardStatements: data.cardStatements,
    subscriptionReviews: data.subscriptionReviews,
    settings,
  };
}

export function backupFileName(dateKey: string): string {
  return `kakeibo-backup-${dateKey}.json`;
}

export type ValidationResult = { ok: true; backup: BackupFile } | { ok: false; reason: string };

type Rec = Record<string, unknown>;
/** 検証関数：問題があれば理由（日本語）を、なければ null を返す */
type Check = (v: Rec, at: string) => string | null;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function oneOf(v: unknown, options: readonly string[]): boolean {
  return typeof v === "string" && options.includes(v);
}

/** 必須の文字列 */
function reqStr(v: Rec, key: string, at: string): string | null {
  return isStr(v[key]) ? null : `${at}.${key} が文字列ではありません`;
}
function reqId(v: Rec, key: string, at: string): string | null {
  return isNonEmptyStr(v[key]) ? null : `${at}.${key} が空でない文字列ではありません`;
}
function reqBool(v: Rec, key: string, at: string): string | null {
  return isBool(v[key]) ? null : `${at}.${key} が true/false ではありません`;
}
function reqYen(v: Rec, key: string, at: string): string | null {
  return isYen(v[key]) ? null : `${at}.${key} が整数の金額ではありません（小数・文字列は読み込めません）`;
}
function reqInt(v: Rec, key: string, at: string): string | null {
  return Number.isSafeInteger(v[key]) ? null : `${at}.${key} が整数ではありません`;
}
function reqEnum(v: Rec, key: string, options: readonly string[], at: string): string | null {
  return oneOf(v[key], options) ? null : `${at}.${key} が ${options.join(" / ")} のどれかではありません`;
}
function reqDate(v: Rec, key: string, at: string): string | null {
  return isLocalDate(v[key]) ? null : `${at}.${key} が YYYY-MM-DD 形式の実在する日付ではありません`;
}
function reqIso(v: Rec, key: string, at: string): string | null {
  return isIsoDateTime(v[key]) ? null : `${at}.${key} が時刻つきの日時（ISO 8601）ではありません`;
}

/** 無くてもよい項目（undefined なら OK。あれば check で検証） */
function opt(v: Rec, key: string, at: string, check: (value: unknown) => boolean, what: string): string | null {
  if (v[key] === undefined) return null;
  return check(v[key]) ? null : `${at}.${key} が ${what} ではありません`;
}

/** 先に見つかった問題を返す */
function first(...results: Array<string | null>): string | null {
  for (const r of results) if (r !== null) return r;
  return null;
}

const HOLIDAY_SHIFTS = ["before", "after", "none"] as const;
const ACCOUNT_GROUPS = ["cash", "emoney", "bank", "card", "investment", "other"] as const;
const TAG_MODES = ["defaultDaily", "mustChoose", "none"] as const;
const TX_TYPES = ["income", "expense", "transfer", "adjustment"] as const;
const TAGS = ["daily", "satisfied", "regret"] as const;
const TX_SOURCES = ["manual", "recurring", "import"] as const;

/** 全レコード共通の項目（id・createdAt・updatedAt・deletedAt） */
function checkBase(v: Rec, at: string): string | null {
  return first(
    reqId(v, "id", at),
    reqIso(v, "createdAt", at),
    reqIso(v, "updatedAt", at),
    v.deletedAt === null || isIsoDateTime(v.deletedAt) ? null : `${at}.deletedAt が null または時刻つきの日時ではありません`,
  );
}

/** 取引のひな形（Transaction から Base・date・source を除いたもの） */
function checkTemplate(t: unknown, at: string): string | null {
  if (!isRecord(t)) return `${at} がオブジェクトではありません`;
  return first(
    reqEnum(t, "type", TX_TYPES, at),
    reqYen(t, "amount", at),
    reqId(t, "accountId", at),
    opt(t, "toAccountId", at, isNonEmptyStr, "文字列"),
    opt(t, "fee", at, isYen, "整数の金額"),
    opt(t, "categoryId", at, isNonEmptyStr, "文字列"),
    reqStr(t, "content", at),
    reqStr(t, "memo", at),
    opt(t, "tag", at, (x) => oneOf(x, TAGS), "daily / satisfied / regret のどれか"),
    checkReimbursement(t, at),
    checkSettles(t, at),
    opt(t, "reserveId", at, isNonEmptyStr, "文字列"),
    opt(t, "estimated", at, isBool, "true/false"),
    opt(t, "reconciledStatementId", at, isNonEmptyStr, "文字列"),
    opt(t, "recurringId", at, isNonEmptyStr, "文字列"),
    opt(t, "payrollId", at, isNonEmptyStr, "文字列"),
    opt(t, "payrollBatchId", at, isNonEmptyStr, "文字列"),
  );
}

function checkReimbursement(t: Rec, at: string): string | null {
  const r = t.reimbursement;
  if (r === undefined) return null;
  if (!isRecord(r)) return `${at}.reimbursement がオブジェクトではありません`;
  const p = `${at}.reimbursement`;
  return first(reqStr(r, "counterparty", p), reqYen(r, "amount", p), opt(r, "settledTxId", p, isNonEmptyStr, "文字列"));
}

/** 返金の収入が指す立替：{ txId: 文字列 } */
function checkSettles(t: Rec, at: string): string | null {
  const s = t.settles;
  if (s === undefined) return null;
  if (!isRecord(s)) return `${at}.settles がオブジェクトではありません`;
  return reqId(s, "txId", `${at}.settles`);
}

const checkAccount: Check = (v, at) => {
  const card = v.card;
  let cardProblem: string | null = null;
  if (card !== undefined) {
    if (!isRecord(card)) cardProblem = `${at}.card がオブジェクトではありません`;
    else {
      const p = `${at}.card`;
      cardProblem = first(reqInt(card, "paymentDay", p), reqEnum(card, "holidayShift", HOLIDAY_SHIFTS, p), reqId(card, "paymentAccountId", p));
    }
  }
  return first(
    reqStr(v, "name", at),
    reqEnum(v, "group", ACCOUNT_GROUPS, at),
    reqInt(v, "order", at),
    reqBool(v, "includeInUsable", at),
    reqBool(v, "hidden", at),
    reqYen(v, "openingBalance", at),
    cardProblem,
  );
};

const checkCategory: Check = (v, at) =>
  first(
    reqEnum(v, "kind", ["income", "expense"], at),
    v.parentId === null || isNonEmptyStr(v.parentId) ? null : `${at}.parentId が文字列または null ではありません`,
    reqStr(v, "name", at),
    reqInt(v, "order", at),
    reqEnum(v, "tagMode", TAG_MODES, at),
    reqBool(v, "hidden", at),
  );

const checkTransaction: Check = (v, at) =>
  first(
    reqEnum(v, "type", TX_TYPES, at),
    reqDate(v, "date", at),
    reqYen(v, "amount", at),
    reqId(v, "accountId", at),
    opt(v, "toAccountId", at, isNonEmptyStr, "文字列"),
    opt(v, "fee", at, isYen, "整数の金額"),
    opt(v, "categoryId", at, isNonEmptyStr, "文字列"),
    reqStr(v, "content", at),
    reqStr(v, "memo", at),
    opt(v, "tag", at, (x) => oneOf(x, TAGS), "daily / satisfied / regret のどれか"),
    checkReimbursement(v, at),
    checkSettles(v, at),
    opt(v, "reserveId", at, isNonEmptyStr, "文字列"),
    opt(v, "estimated", at, isBool, "true/false"),
    opt(v, "reconciledStatementId", at, isNonEmptyStr, "文字列"),
    opt(v, "recurringId", at, isNonEmptyStr, "文字列"),
    opt(v, "payrollId", at, isNonEmptyStr, "文字列"),
    opt(v, "payrollBatchId", at, isNonEmptyStr, "文字列"),
    reqEnum(v, "source", TX_SOURCES, at),
  );

const checkRecurring: Check = (v, at) => {
  const rule = v.rule;
  let ruleProblem: string | null;
  if (!isRecord(rule)) ruleProblem = `${at}.rule がオブジェクトではありません`;
  else {
    const p = `${at}.rule`;
    const every = rule.every;
    const day = rule.day;
    const isInt = (x: unknown, min: number, max: number) => Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
    let dayProblem: string | null;
    if (every === "week") dayProblem = isInt(day, 1, 7) ? null : `${p}.day が 1（月）〜7（日）の整数ではありません`;
    else dayProblem = isInt(day, 1, 31) || day === "last" ? null : `${p}.day が 1〜31 の整数または "last" ではありません`;
    ruleProblem = first(
      reqEnum(rule, "every", ["month", "nMonths", "year", "week"], p),
      every === "nMonths"
        ? isInt(rule.n, 2, 12)
          ? null
          : `${p}.n が 2〜12 の整数ではありません`
        : opt(rule, "n", p, (x) => Number.isSafeInteger(x), "整数"),
      every === "year"
        ? isInt(rule.month, 1, 12)
          ? null
          : `${p}.month が 1〜12 の整数ではありません`
        : opt(rule, "month", p, (x) => isInt(x, 1, 12), "1〜12 の整数"),
      dayProblem,
    );
  }
  return first(
    checkTemplate(v.template, `${at}.template`),
    ruleProblem,
    reqDate(v, "startDate", at),
    v.endDate === undefined || isLocalDate(v.endDate) ? null : `${at}.endDate が YYYY-MM-DD 形式の実在する日付ではありません`,
    v.generatedThrough === undefined || isLocalDate(v.generatedThrough) ? null : `${at}.generatedThrough が YYYY-MM-DD 形式の実在する日付ではありません`,
    reqEnum(v, "holidayShift", HOLIDAY_SHIFTS, at),
    reqBool(v, "estimated", at),
  );
};

const checkFavorite: Check = (v, at) => first(checkTemplate(v.template, `${at}.template`), reqInt(v, "order", at));

const checkPayroll: Check = (v, at) => {
  let linesProblem: string | null = null;
  if (!Array.isArray(v.lines)) linesProblem = `${at}.lines が配列ではありません`;
  else {
    for (let i = 0; i < v.lines.length && linesProblem === null; i++) {
      const line: unknown = v.lines[i];
      const p = `${at}.lines[${i}]`;
      if (!isRecord(line)) {
        linesProblem = `${p} がオブジェクトではありません`;
      } else if (line.kind === "settlement") {
        linesProblem = first(reqId(line, "lineId", p), reqId(line, "accountId", p), reqStr(line, "label", p), reqYen(line, "amount", p));
      } else if (line.kind === "pay" || line.kind === "deduction") {
        linesProblem = first(reqId(line, "lineId", p), reqId(line, "categoryId", p), reqStr(line, "label", p), reqYen(line, "amount", p));
      } else {
        linesProblem = `${p}.kind が pay / deduction / settlement のどれかではありません`;
      }
    }
  }
  let lastProblem: string | null = null;
  if (v.lastAmounts !== undefined) {
    if (!isRecord(v.lastAmounts)) lastProblem = `${at}.lastAmounts がオブジェクトではありません`;
    else {
      for (const [k, val] of Object.entries(v.lastAmounts)) {
        if (!isYen(val)) {
          lastProblem = `${at}.lastAmounts.${k} が整数の金額ではありません`;
          break;
        }
      }
    }
  }
  return first(
    reqStr(v, "name", at),
    reqId(v, "accountId", at),
    Number.isSafeInteger(v.day) && (v.day as number) >= 1 && (v.day as number) <= 31 ? null : `${at}.day が 1〜31 の整数ではありません`,
    reqEnum(v, "holidayShift", HOLIDAY_SHIFTS, at),
    linesProblem,
    lastProblem,
  );
};

const checkReserve: Check = (v, at) =>
  first(
    reqStr(v, "name", at),
    opt(v, "targetAmount", at, isYen, "整数の金額"),
    opt(v, "targetMonth", at, isMonthKey, "YYYY-MM 形式"),
    opt(v, "closedAt", at, isIsoDateTime, "時刻つきの日時"),
  );

const checkReserveMove: Check = (v, at) =>
  first(
    reqId(v, "reserveId", at),
    reqDate(v, "date", at),
    reqYen(v, "amount", at),
    reqEnum(v, "kind", ["assign", "release", "spend"], at),
    opt(v, "txId", at, isNonEmptyStr, "文字列"),
  );

const checkPlanned: Check = (v, at) =>
  first(
    reqStr(v, "name", at),
    isMonthKey(v.month) ? null : `${at}.month が YYYY-MM 形式ではありません`,
    reqYen(v, "amount", at),
    opt(v, "reserveId", at, isNonEmptyStr, "文字列"),
    opt(v, "doneTxId", at, isNonEmptyStr, "文字列"),
    opt(v, "doneAt", at, isIsoDateTime, "時刻つきの日時"),
  );

const checkBudget: Check = (v, at) => {
  let basisProblem: string | null;
  if (!isRecord(v.basis)) basisProblem = `${at}.basis がオブジェクトではありません`;
  else {
    basisProblem = null;
    for (const [k, val] of Object.entries(v.basis)) {
      if (!isYen(val)) {
        basisProblem = `${at}.basis.${k} が整数ではありません`;
        break;
      }
    }
  }
  return first(reqEnum(v, "period", ["week", "month"], at), reqDate(v, "start", at), reqDate(v, "end", at), reqYen(v, "amount", at), basisProblem);
};

const checkStatement: Check = (v, at) =>
  first(reqId(v, "cardAccountId", at), reqDate(v, "paymentDate", at), reqYen(v, "actualAmount", at), reqYen(v, "diff", at));

const checkReview: Check = (v, at) => {
  let itemsProblem: string | null = null;
  if (!Array.isArray(v.items)) itemsProblem = `${at}.items が配列ではありません`;
  else {
    for (let i = 0; i < v.items.length && itemsProblem === null; i++) {
      const item: unknown = v.items[i];
      const p = `${at}.items[${i}]`;
      if (!isRecord(item)) itemsProblem = `${p} がオブジェクトではありません`;
      else itemsProblem = first(reqStr(item, "content", p), reqEnum(item, "decision", ["keep", "cancel"], p), reqYen(item, "amount", p));
    }
  }
  return first(reqDate(v, "reviewedAt", at), itemsProblem);
};

const STORE_CHECKS: { [K in DataStoreName]: Check } = {
  accounts: checkAccount,
  categories: checkCategory,
  transactions: checkTransaction,
  recurrings: checkRecurring,
  favorites: checkFavorite,
  payrolls: checkPayroll,
  reserves: checkReserve,
  reserveMoves: checkReserveMove,
  plannedExpenses: checkPlanned,
  budgetSnapshots: checkBudget,
  cardStatements: checkStatement,
  subscriptionReviews: checkReview,
};

/** 変換スクリプトが付ける取り込み元（任意）。あれば type・label は文字列 */
function checkSource(s: unknown): string | null {
  if (s === undefined) return null;
  if (!isRecord(s)) return "source がオブジェクトではありません";
  const at = "source";
  const optStr = (key: string) => opt(s, key, at, isStr, "文字列");
  return first(reqStr(s, "type", at), reqStr(s, "label", at), optStr("fileName"), optStr("convertedAt"), optStr("importFrom"));
}

/** 本人用の初期データの印（任意）。あれば label は文字列、createdAt は時刻つきの日時 */
function checkProfile(p: unknown): string | null {
  if (p === undefined) return null;
  if (!isRecord(p)) return "profile がオブジェクトではありません";
  const at = "profile";
  return first(reqStr(p, "label", at), isIsoDateTime(p.createdAt) ? null : `${at}.createdAt が時刻つきの日時ではありません`);
}

function checkSettings(s: unknown): string | null {
  if (!isRecord(s)) return "settings がオブジェクトではありません";
  const at = "settings";
  return first(
    Number.isSafeInteger(s.payday) && (s.payday as number) >= 1 && (s.payday as number) <= 31 ? null : `${at}.payday が 1〜31 の整数ではありません`,
    reqEnum(s, "paydayHolidayShift", HOLIDAY_SHIFTS, at),
    reqYen(s, "defenseFund", at),
    reqEnum(s, "budgetMonthBoundary", ["payday", "calendar"], at),
    reqEnum(s, "homeMainFigure", ["remaining", "spent"], at),
    reqEnum(s, "weekStart", ["monday", "sunday"], at),
    Number.isSafeInteger(s.backupReminderDays) && (s.backupReminderDays as number) >= 0 ? null : `${at}.backupReminderDays が 0 以上の整数ではありません`,
    s.lastBackupAt === null || isIsoDateTime(s.lastBackupAt) ? null : `${at}.lastBackupAt が null または時刻つきの日時ではありません`,
  );
}

/** 読み込んだJSON（parse済み）がバックアップとして正しいか確かめる。だめなら理由を返し、何も保存しない */
export function validateBackup(input: unknown): ValidationResult {
  const fail = (reason: string): ValidationResult => ({ ok: false, reason });
  if (!isRecord(input)) return fail("バックアップファイルの形式ではありません（オブジェクトではありません）");
  let data: Rec = input;
  if (data.app !== BACKUP_APP_NAME) return fail(`${BACKUP_APP_NAME} のバックアップではありません（app が "${String(data.app)}" です）`);
  if (data.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    return fail(`このバージョンでは読み込めません（schemaVersion が ${String(data.schemaVersion)} です。読めるのは ${BACKUP_SCHEMA_VERSION} だけです）`);
  }
  if (!isIsoDateTime(data.exportedAt)) return fail("exportedAt が時刻つきの日時ではありません");

  // 版2より前に書き出したファイルには subscriptionReviews が無い。空として読む
  if (data.subscriptionReviews === undefined) data = { ...data, subscriptionReviews: [] };
  const sourceProblem = checkSource(data.source);
  if (sourceProblem !== null) return fail(sourceProblem);
  const profileProblem = checkProfile(data.profile);
  if (profileProblem !== null) return fail(profileProblem);

  for (const store of DATA_STORE_NAMES) {
    const list = data[store];
    if (!Array.isArray(list)) return fail(`${store} が配列ではありません`);
    const check = STORE_CHECKS[store];
    const seen = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const item: unknown = list[i];
      const at = `${store}[${i}]`;
      if (!isRecord(item)) return fail(`${at} がオブジェクトではありません`);
      const problem = first(checkBase(item, at), check(item, at));
      if (problem !== null) return fail(problem);
      const id = item.id as string;
      if (seen.has(id)) return fail(`${at}.id「${id}」が同じ ${store} の中で重複しています`);
      seen.add(id);
    }
  }
  const settingsProblem = checkSettings(data.settings);
  if (settingsProblem !== null) return fail(settingsProblem);

  return { ok: true, backup: data as unknown as BackupFile };
}

/** ファイルの文字列からバックアップを読む（JSONとして読めなければ理由を返す） */
export function parseBackup(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "JSONとして読めませんでした（ファイルが壊れているか、別の種類のファイルです）" };
  }
  return validateBackup(parsed);
}
