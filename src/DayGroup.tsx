import { dayHeading } from "./periodLogic";
import type { DayGroup as DayGroupData } from "./periodLogic";
import { weekdayOf } from "./dateUtils";
import { formatYen } from "./money";
import { TxRow } from "./TxRow";
import type { Category, Id, Transaction } from "./types";

interface Props {
  group: DayGroupData;
  accountNames: ReadonlyMap<Id, string>;
  categories: readonly Category[];
  onSelect: (tx: Transaction) => void;
}

/** 1日分のまとまり：見出し（日付・曜日・その日の収入と支出）と、その日の明細の行 */
export function DayGroup({ group, accountNames, categories, onSelect }: Props) {
  const h = dayHeading(group.date);
  const wd = weekdayOf(group.date);
  const tone = wd === 0 ? "sun" : wd === 6 ? "sat" : "";
  return (
    <section className="day-group">
      <h3 className="day-head">
        <span className={`day-title ${tone}`}>
          {h.day} {h.weekday} <span className="day-ym">{h.yearMonth}</span>
        </span>
        <span className="day-sums">
          {group.income > 0 && <span className="income">{formatYen(group.income)}</span>}
          {group.expense > 0 && <span className="expense">{formatYen(group.expense)}</span>}
        </span>
      </h3>
      <ul className="list">
        {group.items.map((t) => (
          <li key={t.id}>
            <TxRow tx={t} accountNames={accountNames} categories={categories} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}
