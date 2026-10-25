// AI用Markdown（設定の「AIに渡す書き出し」）。画面から切り離した純粋なロジック。
// 方針：アプリに記録されているのにMarkdownで欠けている情報（メモ・立替の相手・取り置きの名前など）を、意味を失わずに渡す。
import { variableSpent } from "./budgetLogic.js";
import { formatMonthDayWeekday } from "./dateUtils.js";
import { categoryNames } from "./entryLogic.js";
import { computeAllocation, outstandingGroups, reimbAmountOf } from "./reimburseLogic.js";
import { inRange, summarize } from "./periodLogic.js";
import type { DateRange } from "./periodLogic.js";
import { reserveBalances, spendByTx } from "./reserveLogic.js";
import { categoryBreakdown, tagBreakdown } from "./summaryLogic.js";
import type { Account, BudgetSnapshot, Category, Id, PlannedExpense, Reserve, ReserveMove, Transaction } from "./types.js";

export interface AiMarkdownInput {
  range: DateRange;
  /** 書き出した日時（ISO）。表示用の文字は exportedLabel */
  exportedAt: string;
  exportedLabel: string;
  appVersion: string;
  accounts: readonly Account[];
  categories: readonly Category[];
  transactions: readonly Transaction[];
  reserves: readonly Reserve[];
  reserveMoves: readonly ReserveMove[];
  plannedExpenses: readonly PlannedExpense[];
  budgetSnapshots: readonly BudgetSnapshot[];
}

/** 表のセルに入れる文字：`|` は `\|`、改行は `<br>`、前後の空白は除く */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>").trim();
}

function yen(n: number): string {
  return `${n.toLocaleString("ja-JP")}円`;
}
function signedYen(n: number): string {
  return `${n > 0 ? "＋" : n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("ja-JP")}円`;
}

function table(header: string[], rows: string[][]): string {
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const r of rows) lines.push(`| ${r.map(escapeCell).join(" | ")} |`);
  return lines.join("\n");
}

/** ファイル名：kakeibo-ai-YYYY-MM-DD_YYYY-MM-DD.md */
export function aiFileName(range: DateRange): string {
  return `kakeibo-ai-${range.start}_${range.end}.md`;
}

const TYPE_LABELS = { income: "収入", expense: "支出", transfer: "振替", adjustment: "残高修正" } as const;
const TAG_LABELS = { daily: "日常", satisfied: "満足", regret: "反省" } as const;

function bySequence(a: Transaction, b: Transaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
}

/** 明細1件の「補足」：手数料・立替・返金・取り置き・見込み額・繰り返し・給料明細 */
function notesOf(t: Transaction, byId: ReadonlyMap<Id, Transaction>, reserveNames: ReadonlyMap<Id, string>, reserveSpend: ReadonlyMap<Id, number>): string[] {
  const notes: string[] = [];
  if (t.type === "transfer" && t.fee) notes.push(`手数料 ${yen(t.fee)}`);
  if (t.type === "expense" && t.reimbursement) {
    notes.push(`立替 ${t.reimbursement.counterparty}に ${yen(reimbAmountOf(t))}（自分の負担 ${yen(t.amount - reimbAmountOf(t))}）`);
  }
  if (t.type === "income" && t.settles) {
    const target = byId.get(t.settles.txId);
    notes.push(target ? `立替の返金（${formatMonthDayWeekday(target.date)} ${target.content || "内容なし"}${target.reimbursement ? `・${target.reimbursement.counterparty}` : ""}）` : "立替の返金（元の明細は見つからない）");
  }
  if (t.reserveId) {
    const name = reserveNames.get(t.reserveId) ?? "不明な取り置き";
    const spent = reserveSpend.get(t.id);
    notes.push(spent !== undefined ? `取り置き「${name}」から ${yen(spent)}` : `取り置き「${name}」`);
  }
  if (t.estimated) notes.push("見込み額");
  if (t.recurringId) notes.push("繰り返し");
  if (t.payrollId) notes.push("給料明細");
  if (t.reconciledStatementId) notes.push("カード照合済み");
  return notes;
}

/** AI用Markdownを作る */
export function buildAiMarkdown(input: AiMarkdownInput): string {
  const { range } = input;
  const txs = input.transactions.filter((t) => t.deletedAt === null);
  const accountNames = new Map(input.accounts.map((a) => [a.id, a.name]));
  const byId = new Map(txs.map((t) => [t.id, t]));
  const reserveNames = new Map(input.reserves.map((r) => [r.id, r.name]));
  const reserveSpend = spendByTx(input.reserveMoves.filter((m) => m.deletedAt === null));
  const { applied } = computeAllocation(txs);
  const inPeriod = txs.filter((t) => inRange(t.date, range)).sort(bySequence);
  const out: string[] = [];

  out.push("# 家計簿 AI用書き出し", "");
  out.push(`- 対象期間：${range.start} 〜 ${range.end}`);
  out.push(`- 書き出し日時：${input.exportedLabel}`);
  out.push(`- アプリの版：${input.appVersion}`, "");

  // 2. 期間のまとめ
  const sum = summarize(inPeriod, undefined, applied);
  const tags = tagBreakdown(inPeriod, range);
  const tagAmount = (k: string) => tags.rows.find((r) => r.tag === k)?.amount ?? 0;
  const variable = tagAmount("daily") + tagAmount("satisfied") + tagAmount("regret");
  out.push("## 期間のまとめ", "");
  out.push(
    table(
      ["項目", "金額"],
      [
        ["収入", yen(sum.income)],
        ["支出", yen(sum.expense)],
        ["収支（収入−支出）", signedYen(sum.total)],
        ["変動費（日常・満足・反省）", yen(variable)],
        ["変動費のうち日常", yen(tagAmount("daily"))],
        ["変動費のうち満足", yen(tagAmount("satisfied"))],
        ["変動費のうち反省", yen(tagAmount("regret"))],
        ["タグのない支出（固定費・税金・保険など）", yen(tagAmount("none"))],
      ],
    ),
  );
  out.push("", "> 数え方：立替は、立て替えた額を支出から除く。返金（立替返金）は、立替に充てた額を収入から除く（多い分だけ収入）。振替と残高修正は収入にも支出にも数えない。", "");

  // 3. 予算と実績
  const snaps = input.budgetSnapshots
    .filter((s) => s.deletedAt === null && s.start <= range.end && s.end >= range.start)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.period < b.period ? -1 : 1));
  out.push("## 予算と実績", "");
  if (snaps.length === 0) out.push("この期間に重なる予算の記録はありません。", "");
  else {
    const rows = snaps.map((s) => {
      const spent = variableSpent(txs, { start: s.start, end: s.end }, reserveSpend);
      return [s.period === "week" ? "週" : "月", `${s.start} 〜 ${s.end}`, yen(s.amount), yen(spent), s.amount - spent >= 0 ? yen(s.amount - spent) : `${yen(s.amount - spent).replace("-", "−")}（こえている）`];
    });
    out.push(table(["種類", "期間", "予算", "使った額", "あと"], rows));
    out.push("", "> 使った額 = 日常・満足・反省の支出（立替分と、取り置きから払った分を除く）。予算の期間は期間の外にはみ出すことがある。", "");
  }

  // 4. 分類別の合計
  for (const [kind, title] of [["expense", "支出"], ["income", "収入"]] as const) {
    const b = categoryBreakdown(txs, input.categories, kind, range, applied);
    out.push(`## 分類別の合計（${title}）`, "");
    if (b.rows.length === 0) {
      out.push(`この期間の${title}はありません。`, "");
      continue;
    }
    const rows: string[][] = [];
    for (const p of b.rows) {
      rows.push([`**${p.name}**`, "", yen(p.amount), `${Math.round(p.ratio * 100)}%`]);
      for (const c of p.children ?? []) rows.push(["", c.name, yen(c.amount), ""]);
    }
    rows.push(["**合計**", "", yen(b.total), "100%"]);
    out.push(table(["大分類", "小分類", "金額", "割合"], rows), "");
  }

  // 5. 明細
  out.push("## 明細", "");
  if (inPeriod.length === 0) out.push("この期間の明細はありません。", "");
  else {
    const rows = inPeriod.map((t) => {
      const names = categoryNames(input.categories, t.categoryId);
      const category = t.type === "transfer" || t.type === "adjustment" ? "" : names ? `${names.parent}/${names.child}` : "分類なし";
      const account =
        t.type === "transfer" ? `${accountNames.get(t.accountId) ?? "資産不明"} → ${accountNames.get(t.toAccountId ?? "") ?? "資産不明"}` : (accountNames.get(t.accountId) ?? "資産不明");
      const amount = t.type === "adjustment" ? signedYen(t.amount) : yen(t.amount);
      return [t.date, TYPE_LABELS[t.type], category, t.content, amount, t.tag ? TAG_LABELS[t.tag] : "", t.memo, account, notesOf(t, byId, reserveNames, reserveSpend).join("／")];
    });
    out.push(table(["日付", "種類", "分類", "内容", "金額", "タグ", "メモ", "資産", "補足"], rows), "");
    out.push(`> ${inPeriod.length}件。金額は記録した額（立替・返金を除く前）。残高修正の金額は増えたら＋、減ったら−。`, "");
  }

  // 6. 未回収の立替・取り置き・予定出費
  out.push("## 未回収の立替（書き出した時点）", "");
  const groups = outstandingGroups(txs);
  if (groups.length === 0) out.push("未回収の立替はありません。", "");
  else {
    const rows: string[][] = [];
    for (const g of groups) for (const it of g.items) rows.push([g.counterparty, it.tx.date, it.tx.content, yen(it.amount), yen(it.returned), yen(it.remaining)]);
    out.push(table(["相手", "日付", "内容", "立替の額", "返ってきた額", "残り"], rows), "");
  }

  out.push("## 取り置き（書き出した時点）", "");
  const balances = reserveBalances(input.reserveMoves.filter((m) => m.deletedAt === null));
  const reserves = input.reserves.filter((r) => r.deletedAt === null && !r.closedAt);
  if (reserves.length === 0) out.push("取り置きはありません。", "");
  else {
    const rows = reserves.map((r) => [r.name, yen(balances.get(r.id) ?? 0), r.targetAmount !== undefined ? yen(r.targetAmount) : "", r.targetMonth ?? ""]);
    out.push(table(["名前", "残高", "目標額", "目標の月"], rows), "");
  }

  out.push("## 予定出費（この期間以降）", "");
  const startMonth = range.start.slice(0, 7);
  const planned = input.plannedExpenses.filter((p) => p.deletedAt === null && !p.doneAt && p.month >= startMonth).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.name < b.name ? -1 : 1));
  if (planned.length === 0) out.push("予定出費はありません。", "");
  else {
    const rows = planned.map((p) => [p.month, p.name, yen(p.amount), p.reserveId ? `取り置き「${reserveNames.get(p.reserveId) ?? "不明"}」` : ""]);
    out.push(table(["月", "名前", "金額", "取り置き"], rows), "");
  }

  return out.join("\n");
}
