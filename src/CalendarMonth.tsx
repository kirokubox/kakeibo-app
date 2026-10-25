import type { CalendarCell } from "./periodLogic";

interface Props {
  cells: CalendarCell[];
  today: string;
  selected: string;
  onSelect: (date: string) => void;
}

const HEAD = ["月", "火", "水", "木", "金", "土", "日"];

/** 月のカレンダー（月曜始まり）。各日に収入（青）と支出（赤） */
export function CalendarMonth({ cells, today, selected, onSelect }: Props) {
  return (
    <div className="calendar" role="grid" aria-label="日別のカレンダー">
      {HEAD.map((h, i) => (
        <div key={h} className={`cal-head${i === 5 ? " sat" : i === 6 ? " sun" : ""}`} role="columnheader">
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
