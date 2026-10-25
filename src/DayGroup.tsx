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
  /** 資産の明細：明細のid → そのあとの残高 */
  balances?: ReadonlyMap<Id, number>;
  /** 日の収入・支出を出さない（資産の明細） */
  hideSums?: boolean;
}

/** 1日分のまとまり：見出し（日付・曜日・その日の収入と支出）と、その日の明細の行 */
export function DayGroup({ group, accountNames, categories, onSelect, balances, hideSums }: Props) {
  const h = dayHeading(group.date);
  const wd = weekdayOf(group.date);
  const tone = wd === 0 ? "sun" : wd === 6 ? "sat" : "";
  return (
    <section className="day-group">
      <h3 className="day-head">
        <span className={`day-title ${tone}`}>
          {h.day} {h.weekday} <span className="day-ym">{h.yearMonth}</span>
        </span>
        {!hideSums && (
          <span className="day-sums">
            {group.income > 0 && <span className="income">{formatYen(group.income)}</span>}
            {group.expense > 0 && <span className="expense">{formatYen(group.expense)}</span>}
          </span>
        )}
      </h3>
      <ul className="list">
        {group.items.map((t) => (
          <li key={t.id}>
            <TxRow tx={t} accountNames={accountNames} categories={categories} onSelect={onSelect} balanceAfter={balances?.get(t.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
