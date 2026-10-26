import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AdjustSheet } from "./AdjustSheet";
import { useAllData } from "./allData";
import { BarChart, Legend, LineChart, PieChart, formatCompact } from "./Charts";
import type { PieSlice } from "./Charts";
import { DayGroup } from "./DayGroup";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { countedExpense, countedIncome, groupByDay, monthTitle, summarize, weekTitle } from "./periodLogic";
import { computeAllocation } from "./reimburseLogic";
import { spendByTx } from "./reserveLogic";
import { SubscriptionView } from "./SubscriptionView";
import {
  PALETTE,
  TAG_KEYS,
  TAG_KEY_LABELS,
  adjustmentStats,
  assetTrend,
  categoryBreakdown,
  categoryTransactions,
  categoryTrend,
  childPalette,
  incomeExpenseTrend,
  lastMonths,
  monthBudgetBars,
  periodAround,
  pieSlices,
  shiftSummaryPeriod,
  summaryRange,
  switchDay,
  tagBreakdown,
  tagTrend,
  weekBudgetBars,
} from "./summaryLogic";
import type { CategoryRow, SummaryPeriod, SummaryPeriodKind, TagKey } from "./summaryLogic";
import { useToast } from "./Toast";
import type { CategoryKind, Id, Transaction, WeekStart } from "./types";

interface Props {
  tabBar: ReactNode;
  today: string;
  /** 週の始まり（設定）。集計の「週」に使う */
  weekStart: WeekStart;
  /** 保存・削除などで増える。変わったら読み直す */
  version: number;
  onOpenSettings: () => void;
  onEdit: (tx: Transaction) => void;
  onChanged: () => void;
}

const KIND_LABELS: Record<SummaryPeriodKind, string> = { week: "週", month: "月", year: "年", custom: "任意" };
const TAG_COLORS: Record<TagKey, string> = { daily: "#2f8f6b", satisfied: "#5a5fb0", regret: "#c2570c", none: "#9aa5ab" };
const INCOME = "var(--kb-income)";
const EXPENSE = "var(--kb-expense)";

function monthLabel(m: string): string {
  return `${Number(m.slice(5, 7))}月`;
}

function percent(ratio: number): string {
  const p = ratio * 100;
  return `${p >= 10 || p === 0 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}

interface DrillStep {
  id: Id | null;
  name: string;
}

/** 集計タブ：開閉なしで縦に並べる（キロクカレンダーと同じ考え方） */
export function SummaryView({ tabBar, today, weekStart, version, onOpenSettings, onEdit, onChanged }: Props) {
  const { data, error } = useAllData(version);
  const [period, setPeriod] = useState<SummaryPeriod>(() => periodAround("month", today, undefined, weekStart));
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [path, setPath] = useState<DrillStep[]>([]);
  const [assetSel, setAssetSel] = useState<Id[]>([]);
  const [adjusting, setAdjusting] = useState<Transaction | null>(null);
  const [toast, showToast] = useToast();

  const range = summaryRange(period, weekStart);
  const endMonth = today.slice(0, 7);
  const txs = data?.transactions;
  const categories = data?.categories;
  const applied = useMemo(() => (txs ? computeAllocation(txs).applied : undefined), [txs]);
  const spend = useMemo(() => spendByTx((data?.reserveMoves ?? []).filter((m) => m.deletedAt === null)), [data]);
  const accountNames = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a.name])), [data]);

  const totals = useMemo(() => (txs ? summarize(txs, range, applied) : null), [txs, range.start, range.end, applied]); // eslint-disable-line react-hooks/exhaustive-deps
  const breakdown = useMemo(() => (txs && categories ? categoryBreakdown(txs, categories, kind, range, applied) : null), [txs, categories, kind, range.start, range.end, applied]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = useMemo(() => (txs ? tagBreakdown(txs, range) : null), [txs, range.start, range.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagMonths = useMemo(() => (txs ? tagTrend(txs, endMonth) : []), [txs, endMonth]);
  const weekBars = useMemo(() => (txs && data ? weekBudgetBars(data.budgetSnapshots, txs, today, spend, 12, weekStart) : []), [txs, data, today, spend, weekStart]);
  const monthBars = useMemo(() => (txs && data ? monthBudgetBars(data.budgetSnapshots, txs, today, spend) : []), [txs, data, today, spend]);
  const incomeExpense = useMemo(() => (txs ? incomeExpenseTrend(txs, endMonth, 12, applied) : []), [txs, endMonth, applied]);
  const assets = useMemo(() => (txs && data ? assetTrend(data.accounts, txs, endMonth) : null), [txs, data, endMonth]);
  const adjust = useMemo(() => (txs && data ? adjustmentStats(txs, data.accounts, range) : null), [txs, data, range.start, range.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeKind = (k: SummaryPeriodKind) => setPeriod((p) => periodAround(k, switchDay(p, today, weekStart), p, weekStart));
  const shift = (n: number) => setPeriod((p) => shiftSummaryPeriod(p, n));

  const title = (() => {
    if (period.kind === "week") return weekTitle(period.anchor);
    if (period.kind === "month") return monthTitle(period.anchor.slice(0, 7));
    if (period.kind === "year") return `${period.anchor.slice(0, 4)}年`;
    return "任意の期間";
  })();

  const periodControls = (
    <>
      <div className="period-nav">
        <button type="button" className="icon-btn" aria-label="前の期間" onClick={() => shift(-1)}>
          <Icon name="chevron-left" size={22} />
        </button>
        <span className="period-title">{title}</span>
        <button type="button" className="icon-btn" aria-label="次の期間" onClick={() => shift(1)}>
          <Icon name="chevron-right" size={22} />
        </button>
      </div>
      <div className="segmented" role="group" aria-label="期間の種類">
        {(["week", "month", "year", "custom"] as const).map((k) => (
          <button key={k} type="button" className={`seg${period.kind === k ? " on" : ""}`} aria-pressed={period.kind === k} onClick={() => changeKind(k)}>
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>
      {period.kind === "custom" && (
        <div className="date-range">
          <input type="date" className="text-input" aria-label="開始日" value={period.customStart} onChange={(e) => setPeriod((p) => ({ ...p, customStart: e.target.value }))} />
          <span className="unit">〜</span>
          <input type="date" className="text-input" aria-label="終了日" value={period.customEnd} onChange={(e) => setPeriod((p) => ({ ...p, customEnd: e.target.value }))} />
        </div>
      )}
      {period.kind !== "custom" && (
        <p className="field-hint center">
          {range.start} 〜 {range.end}（月・年は暦月・暦年）
        </p>
      )}
    </>
  );

  const header = (
    <header className="topbar">
      {path.length > 0 && (
        <button type="button" className="icon-btn" aria-label="戻る" onClick={() => setPath((p) => p.slice(0, -1))}>
          <Icon name="chevron-left" size={22} />
        </button>
      )}
      <h1 className="topbar-title">{path.length > 0 ? path[path.length - 1].name : "集計"}</h1>
      {path.length === 0 && (
        <button type="button" className="icon-btn" aria-label="設定" onClick={onOpenSettings}>
          <Icon name="settings" size={22} />
        </button>
      )}
    </header>
  );

  const loading = !data && !error;
  const select = (tx: Transaction) => {
    if (tx.type === "adjustment") setAdjusting(tx);
    else onEdit(tx);
  };

  // ---- 分類の画面（大分類→小分類） ----
  if (path.length > 0 && data && txs && categories && breakdown) {
    const step = path[path.length - 1];
    const parentStep = path.length === 2 ? path[0] : null;
    const rowsInfo = parentStep ? null : breakdown.rows.find((r) => r.id === step.id);
    const trend = categoryTrend(txs, categories, step.id, kind, endMonth, 12, applied);
    const items = categoryTransactions(txs, categories, step.id, kind, range);
    const groups = groupByDay(items, undefined, applied);
    const sum = items.reduce((s, t) => s + (kind === "expense" ? countedExpense(t) : countedIncome(t, applied)), 0);
    const kids = rowsInfo?.children ? childPalette(rowsInfo.children) : [];
    return (
      <>
        {header}
        <main className="content entries-content summary-content">
          {periodControls}
          <section className="card band single" aria-label="この分類の合計">
            <div>
              <p className="band-label">{kind === "expense" ? "支出" : "収入"}（{step.name}）</p>
              <p className={`band-value ${kind === "expense" ? "expense" : "income"}`}>{formatYen(sum)}</p>
            </div>
          </section>
          {kids.length > 0 && (
            <section className="card summary-section" aria-label="小分類">
              <h2>小分類</h2>
              <div className="pie-wrap">
                <PieChart
                  slices={pieSlices(kids).map((r): PieSlice => ({ key: r.id ?? "other", label: r.name, value: r.amount, color: r.color }))}
                  center={{ top: kind === "expense" ? "支出" : "収入", bottom: formatCompact(rowsInfo!.amount) }}
                  onSelect={(key) => {
                    const r = kids.find((x) => (x.id ?? "other") === key);
                    if (r && r.id) setPath((p) => [...p, { id: r.id, name: r.name }]);
                  }}
                />
              </div>
              <CategoryList rows={kids} onPick={(r) => r.id && setPath((p) => [...p, { id: r.id, name: r.name }])} />
            </section>
          )}
          <section className="card summary-section" aria-label="月ごとの推移">
            <h2>月ごとの推移（直近12か月）</h2>
            <LineChart
              labels={trend.map((m) => monthLabel(m.month))}
              series={[{ key: "v", label: step.name, color: kind === "expense" ? EXPENSE : INCOME, values: trend.map((m) => m.amount) }]}
              ariaLabel={`${step.name}の月ごとの推移（折れ線）`}
            />
          </section>
          <h2 className="list-group-title">この期間の明細（{items.length}件）</h2>
          {groups.map((g) => (
            <DayGroup key={g.date} group={g} accountNames={accountNames} categories={categories} onSelect={select} />
          ))}
          {groups.length === 0 && <p className="empty-note">この期間の明細はありません</p>}
          <div className="fab-space" aria-hidden="true" />
        </main>
        {tabBar}
        {toast}
      </>
    );
  }

  // ---- 集計タブ本体 ----
  const slices = breakdown ? pieSlices(breakdown.rows) : [];
  const tagSeries = TAG_KEYS.map((k) => ({ key: k, label: TAG_KEY_LABELS[k], color: TAG_COLORS[k], values: tagMonths.map((m) => m.values[k]) }));
  const months12 = lastMonths(endMonth, 12).map(monthLabel);
  const assetSeries = assets
    ? [
        { key: "usable", label: "使える資産の合計", color: PALETTE[0], values: assets.usable as ReadonlyArray<number | null> },
        ...assetSel
          .map((id, i) => {
            const a = assets.accounts.find((x) => x.id === id);
            return a ? { key: id, label: a.name, color: PALETTE[(i + 1) % PALETTE.length], values: a.values as ReadonlyArray<number | null> } : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      ]
    : [];
  const selectableAccounts = (data?.accounts ?? []).filter((a) => a.deletedAt === null && !a.hidden);

  return (
    <>
      {header}
      <main className="content entries-content summary-content">
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        {loading && <p className="muted small">データを準備しています…</p>}
        {periodControls}

        {totals && (
          <section className="card band" aria-label="期間の合計">
            <div>
              <p className="band-label">収入</p>
              <p className="band-value income">{formatYen(totals.income)}</p>
            </div>
            <div>
              <p className="band-label">支出</p>
              <p className="band-value expense">{formatYen(totals.expense)}</p>
            </div>
            <div>
              <p className="band-label">合計</p>
              <p className={`band-value${totals.total < 0 ? " expense" : ""}`}>{formatYen(totals.total)}</p>
            </div>
          </section>
        )}

        {breakdown && categories && (
          <section className="card summary-section" aria-label="分類別">
            <h2>分類別</h2>
            <div className="segmented" role="group" aria-label="支出か収入か">
              {(["expense", "income"] as const).map((k) => (
                <button key={k} type="button" className={`seg${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === "expense" ? "支出" : "収入"}
                </button>
              ))}
            </div>
            {breakdown.rows.length === 0 ? (
              <p className="empty-note">この期間の{kind === "expense" ? "支出" : "収入"}はありません</p>
            ) : (
              <>
                <div className="pie-wrap">
                  <PieChart
                    slices={slices.map((r): PieSlice => ({ key: r.id ?? (r.name === "その他" ? "other" : "none"), label: r.name, value: r.amount, color: r.color }))}
                    center={{ top: kind === "expense" ? "支出" : "収入", bottom: formatCompact(breakdown.total) }}
                    onSelect={(key) => {
                      const r = breakdown.rows.find((x) => (x.id ?? "none") === key);
                      if (r) setPath([{ id: r.id, name: r.name }]);
                    }}
                  />
                </div>
                <CategoryList rows={breakdown.rows} onPick={(r) => setPath([{ id: r.id, name: r.name }])} />
              </>
            )}
          </section>
        )}

        {tags && (
          <section className="card summary-section" aria-label="タグ別">
            <h2>タグ別（支出）</h2>
            <ul className="tag-bars">
              {tags.rows.map((r) => (
                <li key={r.tag}>
                  <div className="tag-bar-head">
                    <span>
                      <span className="legend-dot" style={{ background: TAG_COLORS[r.tag] }} />
                      {TAG_KEY_LABELS[r.tag]}
                      {r.tag === "none" && <span className="muted small">（固定費など）</span>}
                    </span>
                    <span className="tag-bar-amount">
                      {formatYen(r.amount)}（{percent(r.ratio)}）
                    </span>
                  </div>
                  <div className="hbar">
                    <span style={{ width: `${Math.round(r.ratio * 100)}%`, background: TAG_COLORS[r.tag] }} />
                  </div>
                </li>
              ))}
            </ul>
            <h3>直近12か月の推移</h3>
            <BarChart labels={months12} series={tagSeries} stacked ariaLabel="タグ別の支出の推移（積み上げ棒）" />
            <Legend items={tagSeries.map((s) => ({ label: s.label, color: s.color }))} />
          </section>
        )}

        {data && (
          <section className="card summary-section" aria-label="予算と実績">
            <h2>予算と実績</h2>
            <h3>週（直近12週）</h3>
            <BarChart
              labels={weekBars.map((b) => b.label)}
              series={[{ key: "spent", label: "使った額", color: EXPENSE, values: weekBars.map((b) => b.spent) }]}
              line={{ key: "budget", label: "予算", color: PALETTE[0], values: weekBars.map((b) => b.budget) }}
              ariaLabel="週の予算と使った額"
            />
            <Legend items={[{ label: "使った額（日常・満足・反省）", color: EXPENSE }, { label: "予算", color: PALETTE[0] }]} />
            <h3>月（直近12区切り）</h3>
            <BarChart
              labels={monthBars.map((b) => b.label)}
              series={[{ key: "spent", label: "使った額", color: EXPENSE, values: monthBars.map((b) => b.spent) }]}
              line={{ key: "budget", label: "予算", color: PALETTE[0], values: monthBars.map((b) => b.budget) }}
              ariaLabel="月の予算と使った額"
            />
            <p className="field-hint">予算を決めていない期間は、使った額だけを出します。</p>
          </section>
        )}

        {data && (
          <section className="card summary-section" aria-label="月ごとの収入と支出">
            <h2>月ごとの収入と支出（直近12か月）</h2>
            <BarChart
              labels={months12}
              series={[
                { key: "income", label: "収入", color: INCOME, values: incomeExpense.map((m) => m.income) },
                { key: "expense", label: "支出", color: EXPENSE, values: incomeExpense.map((m) => m.expense) },
              ]}
              line={{ key: "diff", label: "差額", color: "#2f8f6b", values: incomeExpense.map((m) => m.diff) }}
              ariaLabel="月ごとの収入と支出と差額"
            />
            <Legend items={[{ label: "収入", color: INCOME }, { label: "支出", color: EXPENSE }, { label: "差額（収入−支出）", color: "#2f8f6b" }]} />
          </section>
        )}

        {assets && (
          <section className="card summary-section" aria-label="資産の残高の推移">
            <h2>資産の残高の推移（月末）</h2>
            <LineChart labels={months12} series={assetSeries} ariaLabel="使える資産の合計と、選んだ資産の月末残高" />
            <Legend items={assetSeries.map((s) => ({ label: s.label, color: s.color }))} />
            <p className="field-hint">資産を選ぶと、その資産の月末残高の線を足せます。</p>
            <div className="chips">
              {selectableAccounts.map((a) => (
                <button key={a.id} type="button" className={`chip${assetSel.includes(a.id) ? " on" : ""}`} aria-pressed={assetSel.includes(a.id)} onClick={() => setAssetSel((s) => (s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id].slice(-5)))}>
                  {a.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {adjust && (
          <section className="card summary-section" aria-label="残高修正">
            <h2>残高修正</h2>
            {adjust.count === 0 ? (
              <p className="empty-note">この期間の残高修正はありません</p>
            ) : (
              <>
                <dl className="rows">
                  <div className="row">
                    <dt>回数</dt>
                    <dd>{adjust.count}回</dd>
                  </div>
                  <div className="row">
                    <dt>増えた合計</dt>
                    <dd>{adjust.up > 0 ? "＋" : ""}{formatYen(adjust.up)}</dd>
                  </div>
                  <div className="row">
                    <dt>減った合計</dt>
                    <dd>{adjust.down > 0 ? "−" : ""}{formatYen(adjust.down)}</dd>
                  </div>
                </dl>
                <h3>資産ごとの回数</h3>
                <ul className="list">
                  {adjust.byAccount.map((a) => (
                    <li key={a.id} className="list-row static">
                      <span className="list-main">
                        <span className="list-name">{a.name}</span>
                      </span>
                      <span className="list-amount">{a.count}回</span>
                    </li>
                  ))}
                </ul>
                <p className="field-hint">回数が多い資産は、入力が漏れやすいところです。</p>
              </>
            )}
          </section>
        )}

        {data && txs && (
          <SubscriptionView transactions={txs} reviews={data.subscriptionReviews} today={today} showToast={showToast} onChanged={onChanged} />
        )}
        <div className="fab-space" aria-hidden="true" />
      </main>
      {tabBar}
      {adjusting && data?.accounts.find((a) => a.id === adjusting.accountId) && (
        <AdjustSheet account={data.accounts.find((a) => a.id === adjusting.accountId)!} mode={{ kind: "edit", tx: adjusting }} today={today} showToast={showToast} onChanged={onChanged} onClose={() => setAdjusting(null)} />
      )}
      {toast}
    </>
  );
}

/** 分類の一覧（色の点・名前・割合・金額）。押すとその分類の画面へ */
function CategoryList({ rows, onPick }: { rows: readonly CategoryRow[]; onPick: (r: CategoryRow) => void }) {
  return (
    <ul className="list cat-list">
      {rows.map((r) => (
        <li key={r.id ?? r.name}>
          <button type="button" className="list-row" onClick={() => onPick(r)}>
            <span className="legend-dot" style={{ background: r.color }} />
            <span className="list-main">
              <span className="list-name">{r.name}</span>
            </span>
            <span className="cat-ratio">{percent(r.ratio)}</span>
            <span className="list-amount">{formatYen(r.amount)}</span>
            <Icon name="chevron-right" size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}
