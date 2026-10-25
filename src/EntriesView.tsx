import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AdjustSheet } from "./AdjustSheet";
import { BottomSheet } from "./BottomSheet";
import { CalendarMonth } from "./CalendarMonth";
import { DayGroup } from "./DayGroup";
import { addDays } from "./dateUtils";
import { Fab } from "./Fab";
import { computeAllocation } from "./reimburseLogic";
import { getReimburseSet } from "./reimburseStore";
import { useToast } from "./Toast";
import { Icon } from "./Icon";
import { PREF_ENTRIES_MODE, readPref, writePref } from "./localPrefs";
import { formatYen } from "./money";
import {
  addMonths,
  calendarCells,
  groupByDay,
  monthKeyOf,
  monthRange,
  monthTitle,
  parseMonth,
  summarize,
  shortDate,
  weekExpenseBars,
  weekRange,
  weekStartOf,
  weekTitle,
  weekdayShort,
} from "./periodLogic";
import { getAll, getTransactionsInRange } from "./storage";
import type { Account, Category, Transaction } from "./types";

type ViewMode = "day" | "week" | "month";

const MODE_LABELS: Record<ViewMode, string> = { day: "日別", week: "週別", month: "月別" };

interface Props {
  tabBar: ReactNode;
  today: string;
  /** 保存・削除などで増える。変わったら読み直す */
  version: number;
  onOpenSettings: () => void;
  onAdd: (date: string) => void;
  onEdit: (tx: Transaction) => void;
  /** 残高修正を保存・削除したあと */
  onChanged: () => void;
}

function readMode(): ViewMode {
  const v = readPref(PREF_ENTRIES_MODE);
  return v === "week" || v === "month" || v === "day" ? v : "day";
}

/** 明細タブ：日別（カレンダー）・週別・月別 */
export function EntriesView({ tabBar, today, version, onOpenSettings, onAdd, onEdit, onChanged }: Props) {
  const [mode, setMode] = useState<ViewMode>(readMode);
  const [month, setMonth] = useState(() => monthKeyOf(today));
  const [selectedDay, setSelectedDay] = useState(today);
  const [weekStart, setWeekStart] = useState(() => weekStartOf(today));
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [picker, setPicker] = useState(false);
  const [adjusting, setAdjusting] = useState<Transaction | null>(null);
  const [reimburse, setReimburse] = useState<Transaction[]>([]);
  const [toast, showToast] = useToast();
  const seq = useRef(0);

  // 表示中の期間（＋前後の週）だけを date の索引で読む
  const range = useMemo(() => {
    if (mode === "week") return { start: addDays(weekStart, -7), end: addDays(weekStart, 13) };
    const r = monthRange(month);
    return { start: addDays(r.start, -7), end: addDays(r.end, 7) };
  }, [mode, month, weekStart]);

  useEffect(() => {
    const my = ++seq.current;
    (async () => {
      try {
        const [t, a, c, r] = await Promise.all([getTransactionsInRange(range.start, range.end), getAll("accounts"), getAll("categories"), getReimburseSet()]);
        if (my !== seq.current) return;
        setTxs(t.filter((x) => x.deletedAt === null));
        setReimburse(r);
        setAccounts(a);
        setCategories(c);
        setLoadError("");
        setLoaded(true);
      } catch (e) {
        if (my === seq.current) setLoadError(e instanceof Error ? e.message : "明細を読み込めませんでした");
      }
    })();
  }, [range, version]);

  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const changeMode = (next: ViewMode) => {
    setMode(next);
    writePref(PREF_ENTRIES_MODE, next);
    if (next === "week") setWeekStart(weekStartOf(selectedDay));
  };

  const goMonth = (m: string) => {
    setMonth(m);
    setSelectedDay(m === monthKeyOf(today) ? today : `${m}-01`);
  };

  const shift = (n: number) => {
    if (mode === "week") setWeekStart((w) => addDays(w, 7 * n));
    else goMonth(addMonths(month, n));
  };

  const monthRangeNow = monthRange(month);
  const weekRangeNow = weekRange(weekStart);
  const period = mode === "week" ? weekRangeNow : monthRangeNow;
  // 返金に充てた額（期間の外の立替・返金も見るので、立替・返金の集まりから計算する）
  const applied = useMemo(() => computeAllocation(reimburse).applied, [reimburse]);
  const totals = useMemo(() => summarize(txs, period, applied), [txs, period, applied]);
  const cells = useMemo(() => (mode === "day" ? calendarCells(month, txs, applied) : []), [mode, month, txs, applied]);
  const dayGroup = useMemo(() => (mode === "day" ? groupByDay(txs, { start: selectedDay, end: selectedDay }, applied)[0] : undefined), [mode, txs, selectedDay, applied]);
  const groups = useMemo(() => (mode === "day" ? [] : groupByDay(txs, period, applied)), [mode, txs, period, applied]);
  const bars = useMemo(() => (mode === "week" ? weekExpenseBars(txs, weekStart, applied) : []), [mode, txs, weekStart, applied]);
  const barMax = Math.max(1, ...bars.map((b) => b.expense));

  const select = (tx: Transaction) => {
    if (tx.type === "adjustment") setAdjusting(tx);
    else onEdit(tx);
  };

  const title = mode === "week" ? weekTitle(weekStart) : monthTitle(month);

  return (
    <>
      <header className="topbar">
        <h1 className="topbar-title">明細</h1>
        <button type="button" className="icon-btn" aria-label="設定" onClick={onOpenSettings}>
          <Icon name="settings" size={22} />
        </button>
      </header>
      <main className="content entries-content">
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}

        <div className="period-nav">
          <button type="button" className="icon-btn" aria-label={mode === "week" ? "前の週" : "前の月"} onClick={() => shift(-1)}>
            <Icon name="chevron-left" size={22} />
          </button>
          {mode === "week" ? (
            <span className="period-title">{title}</span>
          ) : (
            <button type="button" className="period-title pick-title" onClick={() => setPicker(true)}>
              {title}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label={mode === "week" ? "次の週" : "次の月"} onClick={() => shift(1)}>
            <Icon name="chevron-right" size={22} />
          </button>
        </div>

        <div className="segmented" role="group" aria-label="表示の切り替え">
          {(["day", "week", "month"] as const).map((m) => (
            <button key={m} type="button" className={`seg${mode === m ? " on" : ""}`} aria-pressed={mode === m} onClick={() => changeMode(m)}>
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

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

        {mode === "week" && (
          <section className="card week-bars" aria-label="日ごとの支出">
            <div className="bars">
              {bars.map((b) => (
                <div key={b.date} className="bar-col" title={`${shortDate(b.date)} ${formatYen(b.expense)}`}>
                  <span className="bar-amount">{b.expense > 0 ? b.expense.toLocaleString("ja-JP") : ""}</span>
                  <span className="bar-track">
                    <span className="bar-fill" style={{ height: `${Math.round((b.expense / barMax) * 100)}%` }} />
                  </span>
                  <span className={`bar-day${b.date === today ? " today" : ""}`}>{weekdayShort(b.date)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {mode === "day" && (
          <>
            <section className="card calendar-card">
              <CalendarMonth cells={cells} today={today} selected={selectedDay} onSelect={setSelectedDay} />
            </section>
            {dayGroup ? (
              <DayGroup group={dayGroup} accountNames={accountNames} categories={categories} onSelect={select} />
            ) : (
              loaded && <p className="empty-note">この日の明細はありません</p>
            )}
          </>
        )}

        {mode !== "day" && (
          <>
            {groups.map((g) => (
              <DayGroup key={g.date} group={g} accountNames={accountNames} categories={categories} onSelect={select} />
            ))}
            {loaded && groups.length === 0 && <p className="empty-note">この期間の明細はありません</p>}
          </>
        )}
        <div className="fab-space" aria-hidden="true" />
      </main>
      <Fab onClick={() => onAdd(mode === "day" ? selectedDay : today)} />
      {tabBar}

      {picker && <MonthPicker current={month} onPick={(m) => { goMonth(m); setPicker(false); }} onClose={() => setPicker(false)} />}
      {adjusting && accounts.find((a) => a.id === adjusting.accountId) && (
        <AdjustSheet
          account={accounts.find((a) => a.id === adjusting.accountId)!}
          mode={{ kind: "edit", tx: adjusting }}
          today={today}
          showToast={showToast}
          onChanged={onChanged}
          onClose={() => setAdjusting(null)}
        />
      )}
      {toast}
    </>
  );
}

/** 年月を選ぶシート */
function MonthPicker({ current, onPick, onClose }: { current: string; onPick: (month: string) => void; onClose: () => void }) {
  const [year, setYear] = useState(parseMonth(current).year);
  return (
    <BottomSheet title="年月を選ぶ" onClose={onClose}>
      <div className="period-nav year-nav">
        <button type="button" className="icon-btn" aria-label="前の年" onClick={() => setYear((y) => y - 1)}>
          <Icon name="chevron-left" size={22} />
        </button>
        <span className="period-title">{year}年</span>
        <button type="button" className="icon-btn" aria-label="次の年" onClick={() => setYear((y) => y + 1)}>
          <Icon name="chevron-right" size={22} />
        </button>
      </div>
      <div className="month-grid">
        {Array.from({ length: 12 }, (_, i) => {
          const key = `${year}-${String(i + 1).padStart(2, "0")}`;
          return (
            <button key={key} type="button" className={`pick${key === current ? " on" : ""}`} onClick={() => onPick(key)}>
              {i + 1}月
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}
