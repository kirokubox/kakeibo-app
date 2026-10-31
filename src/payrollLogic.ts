// 給料明細のロジック（画面から切り離した純粋なロジック）。
// ひな形（Payroll）の行を、毎月の明細（収入・支出・振替）にまとめて変換する。
import { MAX_AMOUNT } from "./calculator.js";
import { shiftedDateInMonth } from "./businessDay.js";
import { addMonths } from "./dateUtils.js";
import { isYen } from "./money.js";
import type { Base, Category, HolidayShift, Id, Payroll, PayrollLine, Tag, Transaction } from "./types.js";

export type PayrollLineKind = PayrollLine["kind"];

// 画面に出す名前。内部の種類（settlement）は変えない（バックアップの形に関わるため）
export const PAYROLL_KIND_LABELS: Record<PayrollLineKind, string> = { pay: "支給", deduction: "控除", settlement: "天引きで払う後払い" };
/** 天引きで払う後払いの行の説明（ひな形・毎月の入力で、見出しの下に出す） */
export const SETTLEMENT_NOTE = "社員証で先に使った社員食堂などの代金を、給料から天引きで払う分。社員証の残高が戻ります（支出には数えません）";
/** 行を足すボタンの文字 */
export function addLineLabel(kind: PayrollLineKind): string {
  return kind === "settlement" ? "＋ 天引きで払う後払いを追加" : `＋ ${PAYROLL_KIND_LABELS[kind]}の行を追加`;
}
export const PAYROLL_KINDS: readonly PayrollLineKind[] = ["pay", "deduction", "settlement"];

// ---- ひな形 ----

export function blankPayroll(base: Base, payday: number, shift: HolidayShift): Payroll {
  return { ...base, name: "", accountId: "", day: payday, holidayShift: shift, lines: [] };
}

/** ひな形の新しい行（金額 0、行き先は未選択） */
export function blankLine(kind: PayrollLineKind, lineId: Id): PayrollLine {
  return kind === "settlement"
    ? { lineId, kind, accountId: "", label: "", amount: 0 }
    : { lineId, kind, categoryId: "", label: "", amount: 0 };
}

// ---- 支給の周期（毎月／毎年◯月） ----

/** 支給する月がそろっているか（1〜12の整数、重なりなし、1つ以上） */
export function isValidPayMonths(months: unknown): months is number[] {
  return (
    Array.isArray(months) &&
    months.length > 0 &&
    months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12) &&
    new Set(months).size === months.length
  );
}

/** 支給する月を小さい順にそろえる。12か月すべて＝毎月なので undefined（保存しない）にする */
export function normalizePayMonths(months: readonly number[] | undefined): number[] | undefined {
  if (!months) return undefined;
  const sorted = [...new Set(months)].filter((m) => Number.isInteger(m) && m >= 1 && m <= 12).sort((a, b) => a - b);
  return sorted.length === 0 || sorted.length === 12 ? undefined : sorted;
}

/** その月（YYYY-MM）が支給する月か。months が無ければ毎月 */
export function isPayMonth(p: Pick<Payroll, "months">, ym: string): boolean {
  if (!p.months || p.months.length === 0) return true;
  return p.months.includes(Number(ym.slice(5, 7)));
}

/** 画面に出す支給日：「毎月25日」「毎月末日」「毎年6月・12月の10日」 */
export function payScheduleText(p: Pick<Payroll, "day" | "months">): string {
  const day = p.day >= 31 ? "末日" : `${p.day}日`;
  if (!p.months || p.months.length === 0) return `毎月${day}`;
  return `毎年${p.months.map((m) => `${m}月`).join("・")}の${day}`;
}

/** 入力の初期の月：毎月なら今月。毎年なら今日にいちばん近い支給月（同じ近さなら過ぎたほう＝入れ忘れを先に） */
export function entryMonthOf(p: Pick<Payroll, "months">, today: string): string {
  const ym = today.slice(0, 7);
  if (isPayMonth(p, ym)) return ym;
  for (let k = 1; k <= 12; k++) {
    const past = addMonths(ym, -k);
    if (isPayMonth(p, past)) return past;
    const next = addMonths(ym, k);
    if (isPayMonth(p, next)) return next;
  }
  return ym;
}

/** 保存前のチェック。エラーの文章（なければ null） */
export function validatePayroll(p: Pick<Payroll, "name" | "accountId" | "day" | "lines" | "months">): string | null {
  if (p.name.trim() === "") return "名前を入れてください";
  if (!p.accountId) return "入金する資産を選んでください";
  if (!Number.isInteger(p.day) || p.day < 1 || p.day > 31) return "支給日は1〜31日で入れてください";
  if (p.months !== undefined && !isValidPayMonths(p.months)) return "支給する月を1つ以上選んでください";
  for (const l of p.lines) {
    const what = l.kind === "settlement" ? PAYROLL_KIND_LABELS[l.kind] : `${PAYROLL_KIND_LABELS[l.kind]}の行`;
    if (l.kind === "settlement" ? !l.accountId : !l.categoryId) return `${what}の${l.kind === "settlement" ? "資産" : "分類"}を選んでください`;
    if (!isYen(l.amount) || l.amount < 0 || l.amount > MAX_AMOUNT) return `${what}の金額を0円以上の整数で入れてください`;
  }
  return null;
}

/** 同じ種類（支給・控除・天引きで払う後払い）の隣の行と入れ替える。動かせないときは null */
export function moveLine(lines: readonly PayrollLine[], lineId: Id, direction: "up" | "down"): PayrollLine[] | null {
  const from = lines.findIndex((l) => l.lineId === lineId);
  if (from < 0) return null;
  const kind = lines[from].kind;
  const step = direction === "up" ? -1 : 1;
  let to = from + step;
  while (to >= 0 && to < lines.length && lines[to].kind !== kind) to += step;
  if (to < 0 || to >= lines.length) return null;
  const next = [...lines];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** 行の前回の金額（なければひな形の金額） */
export function lineInitialAmount(p: Pick<Payroll, "lastAmounts">, line: PayrollLine): number {
  const last = p.lastAmounts?.[line.lineId];
  return last !== undefined && isYen(last) ? last : line.amount;
}

export interface PayrollTotals {
  pay: number;
  deduction: number;
  settlement: number;
  takeHome: number;
}

/** 支給 − 控除 − 天引きで払う後払い ＝ 手取り（enabled が false の行は数えない） */
export function payrollTotals(lines: ReadonlyArray<{ kind: PayrollLineKind; amount: number; enabled?: boolean }>): PayrollTotals {
  const t = { pay: 0, deduction: 0, settlement: 0 };
  for (const l of lines) {
    if (l.enabled === false) continue;
    t[l.kind] += l.amount;
  }
  return { ...t, takeHome: t.pay - t.deduction - t.settlement };
}

/** 支給日：その月（YYYY-MM）の支給日に、休日の移動をした日 */
export function payrollDateOf(p: Pick<Payroll, "day" | "holidayShift">, ym: string): string {
  return shiftedDateInMonth(ym, p.day, p.holidayShift);
}

// ---- 毎月の入力 ----

export interface PayrollEntryLine {
  lineId: Id;
  kind: PayrollLineKind;
  categoryId: Id | null; // 支給・控除
  accountId: Id | null; // 精算
  label: string;
  amount: number;
  /** チェックを外すと、その月だけ外す */
  enabled: boolean;
  /** その月だけ足した行（ひな形にない） */
  extra: boolean;
  /** あとから直すとき：すでにある明細 */
  txId?: Id;
}

export interface PayrollEntryDraft {
  date: string;
  lines: PayrollEntryLine[];
  /** 今回の金額をひな形に残す（次の月の初期値にする） */
  saveToTemplate: boolean;
}

function fromTemplateLine(p: Payroll, l: PayrollLine): PayrollEntryLine {
  return {
    lineId: l.lineId,
    kind: l.kind,
    categoryId: l.kind === "settlement" ? null : l.categoryId,
    accountId: l.kind === "settlement" ? l.accountId : null,
    label: l.label,
    amount: lineInitialAmount(p, l),
    enabled: true,
    extra: false,
  };
}

/** 新しい月の入力：日付は「今月（毎年のひな形は近い支給月）の支給日に休日の移動をした日」、金額は前回の金額（なければひな形の金額） */
export function newEntryDraft(p: Payroll, today: string): PayrollEntryDraft {
  return { date: payrollDateOf(p, entryMonthOf(p, today)), lines: p.lines.map((l) => fromTemplateLine(p, l)), saveToTemplate: true };
}

/** 明細（収入・支出・振替）が指す行き先を行の形にそろえる */
function lineKeyOfTx(t: Transaction): { kind: PayrollLineKind; target: string } | null {
  if (t.type === "income") return { kind: "pay", target: t.categoryId ?? "" };
  if (t.type === "expense") return { kind: "deduction", target: t.categoryId ?? "" };
  if (t.type === "transfer") return { kind: "settlement", target: t.toAccountId ?? "" };
  return null;
}

/**
 * 保存済みの1枚（payrollBatchId が同じ明細）から、直すための入力を作る。
 * ひな形の行は順番どおりに並べ、対応する明細がなければチェックを外した行にする。ひな形にない明細は「その月だけの行」。
 */
export function entryDraftFromBatch(p: Payroll, batchTxs: readonly Transaction[], makeLineId: () => Id, today: string): PayrollEntryDraft {
  const active = batchTxs.filter((t) => t.deletedAt === null && lineKeyOfTx(t) !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const used = new Set<Id>();
  const lines: PayrollEntryLine[] = [];
  for (const l of p.lines) {
    const target = l.kind === "settlement" ? l.accountId : l.categoryId;
    const hit = active.find((t) => {
      const k = lineKeyOfTx(t)!;
      return !used.has(t.id) && k.kind === l.kind && k.target === target && t.memo === l.label;
    });
    if (hit) {
      used.add(hit.id);
      lines.push({ ...fromTemplateLine(p, l), amount: hit.amount, enabled: true, txId: hit.id });
    } else {
      lines.push({ ...fromTemplateLine(p, l), enabled: false });
    }
  }
  for (const t of active) {
    if (used.has(t.id)) continue;
    const k = lineKeyOfTx(t)!;
    lines.push({
      lineId: makeLineId(),
      kind: k.kind,
      categoryId: k.kind === "settlement" ? null : k.target || null,
      accountId: k.kind === "settlement" ? k.target || null : null,
      label: t.memo,
      amount: t.amount,
      enabled: true,
      extra: true,
      txId: t.id,
    });
  }
  const date = active[0]?.date ?? payrollDateOf(p, entryMonthOf(p, today));
  return { date, lines, saveToTemplate: false };
}

/** 保存前のチェック。エラーの文章（なければ null） */
export function validateEntryDraft(d: PayrollEntryDraft): string | null {
  for (const l of d.lines) {
    if (!l.enabled) continue;
    if (!isYen(l.amount) || l.amount < 0 || l.amount > MAX_AMOUNT) return `「${l.label || PAYROLL_KIND_LABELS[l.kind]}」の金額を0円以上の整数で入れてください`;
    if (l.amount === 0) continue; // 0円の行は明細を作らない
    if (l.kind === "settlement" ? !l.accountId : !l.categoryId) return `「${l.label || PAYROLL_KIND_LABELS[l.kind]}」の${l.kind === "settlement" ? "資産" : "分類"}を選んでください`;
  }
  return null;
}

function tagOf(category: Category | undefined): Tag | undefined {
  return category?.tagMode === "defaultDaily" ? "daily" : undefined;
}

/** 行 → 明細。existing があれば上書き（作成日時・idなどは残す） */
function lineToTransaction(p: Payroll, d: PayrollEntryDraft, l: PayrollEntryLine, batchId: Id, categories: readonly Category[], base: Base, existing?: Transaction): Transaction {
  const t: Transaction = {
    ...(existing ?? { ...base, source: "manual" as const }),
    type: l.kind === "pay" ? "income" : l.kind === "deduction" ? "expense" : "transfer",
    date: d.date,
    amount: l.amount,
    accountId: p.accountId,
    content: p.name.trim(),
    memo: l.label.trim(),
    payrollId: p.id,
    payrollBatchId: batchId,
  };
  delete t.fee;
  if (l.kind === "settlement") {
    t.toAccountId = l.accountId ?? undefined;
    delete t.categoryId;
    delete t.tag;
  } else {
    delete t.toAccountId;
    t.categoryId = l.categoryId ?? undefined;
    const tag = l.kind === "deduction" ? tagOf(categories.find((c) => c.id === l.categoryId)) : undefined;
    if (tag) t.tag = tag;
    else delete t.tag;
  }
  return t;
}

export interface PayrollSavePlan {
  creates: Transaction[];
  /** 内容が変わった既存の明細 */
  updates: Transaction[];
  /** 論理削除する既存の明細（deletedAt と updatedAt を入れてある） */
  deletes: Transaction[];
}

/**
 * 保存の計画：支給の行→収入、控除の行→支出、天引きで払う後払いの行→振替。金額0の行・チェックを外した行は作らない。
 * 直すとき（existing に今ある明細）は、変更→更新、足した行→作成、消した行・0円にした行→論理削除の差分を返す。
 */
export function planPayrollSave(args: {
  payroll: Payroll;
  draft: PayrollEntryDraft;
  batchId: Id;
  categories: readonly Category[];
  existing?: readonly Transaction[];
  now: string;
  makeBase: () => Base;
}): PayrollSavePlan {
  const { payroll, draft, batchId, categories, now, makeBase } = args;
  const existing = (args.existing ?? []).filter((t) => t.deletedAt === null);
  const byId = new Map(existing.map((t) => [t.id, t]));
  const referenced = new Set<Id>();
  const plan: PayrollSavePlan = { creates: [], updates: [], deletes: [] };
  const remove = (t: Transaction) => plan.deletes.push({ ...t, deletedAt: now, updatedAt: now });

  for (const l of draft.lines) {
    const ex = l.txId ? byId.get(l.txId) : undefined;
    if (ex) referenced.add(ex.id);
    const wanted = l.enabled && l.amount > 0;
    if (!wanted) {
      if (ex) remove(ex);
      continue;
    }
    if (ex) {
      const next = lineToTransaction(payroll, draft, l, batchId, categories, makeBase(), ex);
      if (JSON.stringify(next) !== JSON.stringify(ex)) plan.updates.push(next);
    } else {
      plan.creates.push(lineToTransaction(payroll, draft, l, batchId, categories, makeBase()));
    }
  }
  for (const t of existing) if (!referenced.has(t.id)) remove(t);
  return plan;
}

/** 「今回の金額をひな形に残す」：チェックの入っているひな形の行の金額を、前回の金額として覚える */
export function nextLastAmounts(p: Payroll, draft: PayrollEntryDraft): Record<string, number> {
  const next: Record<string, number> = { ...(p.lastAmounts ?? {}) };
  if (!draft.saveToTemplate) return next;
  const ids = new Set(p.lines.map((l) => l.lineId));
  for (const l of draft.lines) if (l.enabled && !l.extra && ids.has(l.lineId)) next[l.lineId] = l.amount;
  return next;
}

/** 同じ1枚の明細（payrollBatchId が同じ）を集める */
export function batchTransactions(all: readonly Transaction[], batchId: Id): Transaction[] {
  return all.filter((t) => t.payrollBatchId === batchId && t.deletedAt === null);
}
