import { useDeferredValue, useMemo, useState } from "react";
import { AdjustSheet } from "./AdjustSheet";
import { useAllData } from "./allData";
import { BottomSheet } from "./BottomSheet";
import { DayGroup } from "./DayGroup";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { groupByDay } from "./periodLogic";
import { computeAllocation } from "./reimburseLogic";
import {
  SEARCH_TAG_LABELS,
  SEARCH_TYPE_LABELS,
  buildSearchIndex,
  emptyFilter,
  filterChips,
  hasAnyCondition,
  removeFilter,
  searchTotals,
  searchTransactions,
} from "./searchLogic";
import type { PeriodChoice, SearchFilter, TagChoice } from "./searchLogic";
import { useToast } from "./Toast";
import type { Category, Id, Transaction, TxType } from "./types";
import { YenInput } from "./YenInput";

interface Props {
  today: string;
  version: number;
  onBack: () => void;
  onEdit: (tx: Transaction) => void;
  onChanged: () => void;
}

const PAGE_DAYS = 40;
const PERIOD_OPTIONS: Array<[PeriodChoice, string]> = [
  ["all", "すべて"],
  ["thisYear", "今年"],
  ["lastYear", "去年"],
  ["custom", "任意"],
];
const TAG_ORDER: TagChoice[] = ["daily", "satisfied", "regret", "none"];
const TYPE_ORDER: TxType[] = ["income", "expense", "transfer", "adjustment"];

function toggle<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/** 検索：明細タブの虫めがねから。文字・期間・資産・分類・金額・タグ・種類で絞り込み、結果の件数と合計を出す */
export function SearchView({ today, version, onBack, onEdit, onChanged }: Props) {
  const { data, error } = useAllData(version);
  const [filter, setFilter] = useState<SearchFilter>(emptyFilter);
  const [sheet, setSheet] = useState(false);
  const [days, setDays] = useState(PAGE_DAYS);
  const [adjusting, setAdjusting] = useState<Transaction | null>(null);
  const [toast, showToast] = useToast();

  // 打つたびに全件から探す。入力欄の反応を先にして、結果は少し遅れて更新する
  const deferred = useDeferredValue(filter);
  const index = useMemo(() => (data ? buildSearchIndex(data.transactions) : []), [data]);
  const applied = useMemo(() => (data ? computeAllocation(data.transactions).applied : undefined), [data]);
  const results = useMemo(() => (data ? searchTransactions(index, deferred, data.categories, today) : []), [data, index, deferred, today]);
  const totals = useMemo(() => searchTotals(results, applied), [results, applied]);
  const groups = useMemo(() => groupByDay(results, undefined, applied), [results, applied]);
  const accountNames = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a.name])), [data]);
  const chips = useMemo(() => (data ? filterChips(filter, data.accounts, data.categories, today) : []), [data, filter, today]);
  const any = hasAnyCondition(deferred);

  const update = (patch: Partial<SearchFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setDays(PAGE_DAYS);
  };

  const select = (tx: Transaction) => {
    if (tx.type === "adjustment") setAdjusting(tx);
    else onEdit(tx);
  };

  return (
    <>
      <header className="topbar search-bar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <input
          className="text-input search-input"
          type="search"
          autoFocus
          aria-label="内容・メモ・立替の相手で探す"
          placeholder="内容・メモ・相手（空白で区切るとすべて含む）"
          value={filter.text}
          onChange={(e) => update({ text: e.target.value })}
        />
        <button type="button" className={`text-btn${chips.length > 0 ? " has-filter" : ""}`} onClick={() => setSheet(true)}>
          絞り込み{chips.length > 0 ? `（${chips.length}）` : ""}
        </button>
      </header>
      <main className="content entries-content search-content">
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        {!data && !error && <p className="muted small">データを準備しています…</p>}
        {chips.length > 0 && (
          <ul className="filter-chips" aria-label="選んだ絞り込み">
            {chips.map((c) => (
              <li key={c.key}>
                <span className="filter-chip">
                  {c.label}
                  <button type="button" aria-label={`${c.label}を外す`} onClick={() => update(removeFilter(filter, c.key))}>
                    <Icon name="close" size={14} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {data && (
          <section className="card search-summary" aria-live="polite" aria-label="結果の合計">
            {!any ? (
              <p className="muted small">文字を入れるか、絞り込みを選ぶと、件数と合計を出します。</p>
            ) : (
              <>
                <p className="search-count">{totals.count.toLocaleString("ja-JP")}件</p>
                <p className="search-sums">
                  <span>
                    支出 <b className="expense">{formatYen(totals.expense)}</b>
                  </span>
                  <span>
                    収入 <b className="income">{formatYen(totals.income)}</b>
                  </span>
                </p>
                <p className="field-hint">立替分と、返金に充てた分は除いた額です。振替と残高修正は数えません。</p>
              </>
            )}
          </section>
        )}
        {any && groups.slice(0, days).map((g) => <DayGroup key={g.date} group={g} accountNames={accountNames} categories={data?.categories ?? []} onSelect={select} />)}
        {any && groups.length > days && (
          <div className="more-row">
            <button type="button" className="secondary-btn" onClick={() => setDays((d) => d + PAGE_DAYS)}>
              もっと見る（残り{groups.length - days}日分）
            </button>
          </div>
        )}
        {any && data && results.length === 0 && <p className="empty-note">見つかりませんでした</p>}
        <div className="fab-space" aria-hidden="true" />
      </main>
      {sheet && data && <FilterSheet filter={filter} accounts={data.accounts} categories={data.categories} onChange={update} onReset={() => update({ ...emptyFilter(), text: filter.text })} onClose={() => setSheet(false)} />}
      {adjusting && data?.accounts.find((a) => a.id === adjusting.accountId) && (
        <AdjustSheet account={data.accounts.find((a) => a.id === adjusting.accountId)!} mode={{ kind: "edit", tx: adjusting }} today={today} showToast={showToast} onChanged={onChanged} onClose={() => setAdjusting(null)} />
      )}
      {toast}
    </>
  );
}

interface FilterSheetProps {
  filter: SearchFilter;
  accounts: ReadonlyArray<{ id: Id; name: string; deletedAt: string | null; hidden: boolean }>;
  categories: readonly Category[];
  onChange: (patch: Partial<SearchFilter>) => void;
  onReset: () => void;
  onClose: () => void;
}

/** 絞り込みのシート（選ぶとすぐ反映する） */
function FilterSheet({ filter, accounts, categories, onChange, onReset, onClose }: FilterSheetProps) {
  const liveAccounts = accounts.filter((a) => a.deletedAt === null);
  const cats = categories.filter((c) => c.deletedAt === null);
  const groupsFor = (kind: "expense" | "income") =>
    cats
      .filter((c) => c.kind === kind && c.parentId === null)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ parent: p, children: cats.filter((c) => c.parentId === p.id).sort((a, b) => a.order - b.order) }));
  return (
    <BottomSheet title="絞り込み" onClose={onClose}>
      <div className="filter-sheet">
        <div className="field">
          <span className="field-label">期間</span>
          <div className="chips">
            {PERIOD_OPTIONS.map(([v, label]) => (
              <button key={v} type="button" className={`chip${filter.period === v ? " on" : ""}`} aria-pressed={filter.period === v} onClick={() => onChange({ period: v })}>
                {label}
              </button>
            ))}
          </div>
          {filter.period === "custom" && (
            <div className="date-range">
              <input type="date" className="text-input" aria-label="開始日" value={filter.customStart} onChange={(e) => onChange({ customStart: e.target.value })} />
              <span className="unit">〜</span>
              <input type="date" className="text-input" aria-label="終了日" value={filter.customEnd} onChange={(e) => onChange({ customEnd: e.target.value })} />
            </div>
          )}
        </div>

        <div className="field">
          <span className="field-label">種類</span>
          <div className="chips">
            {TYPE_ORDER.map((t) => (
              <button key={t} type="button" className={`chip${filter.types.includes(t) ? " on" : ""}`} aria-pressed={filter.types.includes(t)} onClick={() => onChange({ types: toggle(filter.types, t) })}>
                {SEARCH_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">タグ</span>
          <div className="chips">
            {TAG_ORDER.map((t) => (
              <button key={t} type="button" className={`chip${filter.tags.includes(t) ? " on" : ""}`} aria-pressed={filter.tags.includes(t)} onClick={() => onChange({ tags: toggle(filter.tags, t) })}>
                {SEARCH_TAG_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">金額（円）</span>
          <div className="amount-range">
            <YenInput value={filter.amountMin} onChange={(v) => onChange({ amountMin: v })} ariaLabel="金額の下限" />
            <span className="unit">〜</span>
            <YenInput value={filter.amountMax} onChange={(v) => onChange({ amountMax: v })} ariaLabel="金額の上限" />
          </div>
          <p className="field-hint">空欄は、そちら側に制限なし。</p>
        </div>

        <div className="field">
          <span className="field-label">資産（複数選べます）</span>
          <div className="chips">
            {liveAccounts.map((a) => (
              <button key={a.id} type="button" className={`chip${filter.accountIds.includes(a.id) ? " on" : ""}`} aria-pressed={filter.accountIds.includes(a.id)} onClick={() => onChange({ accountIds: toggle(filter.accountIds, a.id) })}>
                {a.name}
                {a.hidden ? "（非表示）" : ""}
              </button>
            ))}
          </div>
        </div>

        {(["expense", "income"] as const).map((kind) => (
          <div className="field" key={kind}>
            <span className="field-label">{kind === "expense" ? "支出の分類" : "収入の分類"}（大分類を選ぶと下の小分類すべて）</span>
            {groupsFor(kind).map(({ parent, children }) => (
              <div key={parent.id} className="cat-group">
                <div className="chips">
                  <button type="button" className={`chip strong${filter.categoryIds.includes(parent.id) ? " on" : ""}`} aria-pressed={filter.categoryIds.includes(parent.id)} onClick={() => onChange({ categoryIds: toggle(filter.categoryIds, parent.id) })}>
                    {parent.name}
                  </button>
                  {children.map((c) => (
                    <button key={c.id} type="button" className={`chip${filter.categoryIds.includes(c.id) ? " on" : ""}`} aria-pressed={filter.categoryIds.includes(c.id)} onClick={() => onChange({ categoryIds: toggle(filter.categoryIds, c.id) })}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" onClick={onReset}>
          絞り込みを全部外す
        </button>
        <button type="button" className="primary-btn" onClick={onClose}>
          結果を見る
        </button>
      </div>
    </BottomSheet>
  );
}
