import { weekdayHeads } from "./periodLogic";
import type { CalendarCell } from "./periodLogic";
import type { WeekStart } from "./types";

interface Props {
  cells: CalendarCell[];
  /** 週の始まり（見出しの並び） */
  weekStart?: WeekStart;
  today: string;
  selected: string;
  onSelect: (date: string) => void;
}

/** 月のカレンダー（週の始まりは設定の月曜か日曜）。各日に収入（青）と支出（赤） */
export function CalendarMonth({ cells, weekStart = "monday", today, selected, onSelect }: Props) {
  const heads = weekdayHeads(weekStart);
  return (
    <div className="calendar" role="grid" aria-label="日別のカレンダー">
      {heads.map((h) => (
        <div key={h} className={`cal-head${h === "土" ? " sat" : h === "日" ? " sun" : ""}`} role="columnheader">
          {h}
        </div>
      ))}
      {cells.map((c) => (
        <button
          key={c.date}
          type="button"
          role="gridcell"
          className={`cal-cell${c.inMonth ? "" : " out"}${c.date === today ? " today" : ""}${c.date === selected ? " selected" : ""}`}
          aria-label={`${c.date}${c.hasItems ? `、収入${c.income}円、支出${c.expense}円` : ""}`}
          aria-pressed={c.date === selected}
          onClick={() => onSelect(c.date)}
        >
          <span className="cal-day">{Number(c.date.slice(8))}</span>
          {c.income > 0 && <span className="cal-income">{c.income.toLocaleString("ja-JP")}</span>}
          {c.expense > 0 && <span className="cal-expense">{c.expense.toLocaleString("ja-JP")}</span>}
        </button>
      ))}
    </div>
  );
}
