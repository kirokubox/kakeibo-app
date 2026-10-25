import { useState } from "react";
import { SHIFT_LABELS } from "./accountLogic";
import { BottomSheet } from "./BottomSheet";
import { changeRepeatEvery, repeatLabel, validateRepeat } from "./recurrence";
import type { RepeatDraft } from "./recurrence";
import type { HolidayShift, RecurringEvery } from "./types";

const EVERY_OPTIONS: Array<{ value: RecurringEvery; label: string }> = [
  { value: "month", label: "毎月" },
  { value: "nMonths", label: "◯か月ごと" },
  { value: "year", label: "毎年" },
  { value: "week", label: "毎週" },
];
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const SHIFTS: HolidayShift[] = ["before", "after", "none"];

interface FieldsProps {
  value: RepeatDraft;
  onChange: (next: RepeatDraft) => void;
  /** 間隔を替えたときの日の初期値に使う日付（入力中の日付／繰り返しの開始日） */
  anchorDate: string;
}

/** 繰り返しの設定の中身（間隔・日・休日なら・終わり・見込み額）。シートと、繰り返しの編集画面で使う */
export function RepeatFields({ value, onChange, anchorDate }: FieldsProps) {
  const set = (patch: Partial<RepeatDraft>) => onChange({ ...value, ...patch });
  const dayButtons = (
    <div className="day-grid" role="group" aria-label="日">
      {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
        <button key={d} type="button" className={`chip${value.day === d ? " on" : ""}`} aria-pressed={value.day === d} onClick={() => set({ day: d })}>
          {d}
        </button>
      ))}
      <button type="button" className={`chip${value.day === "last" ? " on" : ""}`} aria-pressed={value.day === "last"} onClick={() => set({ day: "last" })}>
        末日
      </button>
    </div>
  );

  return (
    <div className="repeat-fields">
      <div className="repeat-block">
        <span className="field-label">間隔</span>
        <div className="chips" role="group" aria-label="間隔">
          {EVERY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`chip${value.every === o.value ? " on" : ""}`}
              aria-pressed={value.every === o.value}
              onClick={() => value.every !== o.value && onChange(changeRepeatEvery(value, o.value, anchorDate))}
            >
              {o.label}
            </button>
          ))}
        </div>
        {value.every === "nMonths" && (
          <div className="chips" role="group" aria-label="何か月ごと">
            {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
              <button key={n} type="button" className={`chip${value.n === n ? " on" : ""}`} aria-pressed={value.n === n} onClick={() => set({ n })}>
                {n}か月ごと
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="repeat-block">
        <span className="field-label">{value.every === "week" ? "曜日" : value.every === "year" ? "月と日" : "日"}</span>
        {value.every === "week" ? (
          <div className="chips" role="group" aria-label="曜日">
            {WEEKDAYS.map((w, i) => (
              <button key={w} type="button" className={`chip${value.day === i + 1 ? " on" : ""}`} aria-pressed={value.day === i + 1} onClick={() => set({ day: i + 1 })}>
                {w}
              </button>
            ))}
          </div>
        ) : (
          <>
            {value.every === "year" && (
              <div className="chips" role="group" aria-label="月">
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <button key={m} type="button" className={`chip${value.month === m ? " on" : ""}`} aria-pressed={value.month === m} onClick={() => set({ month: m })}>
                    {m}月
                  </button>
                ))}
              </div>
            )}
            {dayButtons}
          </>
        )}
      </div>

      <div className="repeat-block">
        <span className="field-label">休日なら</span>
        <div className="chips" role="group" aria-label="休日なら">
          {SHIFTS.map((s) => (
            <button key={s} type="button" className={`chip${value.holidayShift === s ? " on" : ""}`} aria-pressed={value.holidayShift === s} onClick={() => set({ holidayShift: s })}>
              {SHIFT_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="repeat-block">
        <span className="field-label">終わり</span>
        <div className="chips" role="group" aria-label="終わり">
          <button type="button" className={`chip${value.endDate === null ? " on" : ""}`} aria-pressed={value.endDate === null} onClick={() => set({ endDate: null })}>
            なし
          </button>
          <button
            type="button"
            className={`chip${value.endDate !== null ? " on" : ""}`}
            aria-pressed={value.endDate !== null}
            onClick={() => value.endDate === null && set({ endDate: anchorDate })}
          >
            この日まで
          </button>
        </div>
        {value.endDate !== null && (
          <input type="date" className="date-input" aria-label="終わりの日" value={value.endDate} onChange={(e) => e.target.value && set({ endDate: e.target.value })} />
        )}
      </div>

      <label className="toggle-row">
        <span>
          見込み額
          <span className="field-hint block">毎月金額が変わるもの（公共料金など）。見込みの印を付けて作ります</span>
        </span>
        <input type="checkbox" checked={value.estimated} onChange={(e) => set({ estimated: e.target.checked })} />
      </label>
    </div>
  );
}

interface SheetProps {
  initial: RepeatDraft | null;
  anchorDate: string;
  /** 繰り返しの始まりの日（終わりの日のチェックに使う） */
  startDate: string;
  onDecide: (draft: RepeatDraft) => void;
  onRemove: () => void;
  onClose: () => void;
  defaultDraft: RepeatDraft;
}

/** 入力画面の「繰り返し」を押したときのシート */
export function RecurrenceSheet({ initial, anchorDate, startDate, onDecide, onRemove, onClose, defaultDraft }: SheetProps) {
  const [draft, setDraft] = useState<RepeatDraft>(initial ?? defaultDraft);
  const problem = validateRepeat(draft, startDate);
  return (
    <BottomSheet title="繰り返し" onClose={onClose}>
      <RepeatFields value={draft} onChange={setDraft} anchorDate={anchorDate} />
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <p className="field-hint repeat-summary">
        {repeatLabel(draft)}。決定して保存すると、今の入力が1回目になり、あとは日が来たら自動で入ります。
      </p>
      <div className="sheet-actions between">
        {initial ? (
          <button type="button" className="text-btn" onClick={onRemove}>
            繰り返しをやめる
          </button>
        ) : (
          <button type="button" className="secondary-btn" onClick={onClose}>
            やめる
          </button>
        )}
        <button type="button" className="primary-btn" disabled={problem !== null} onClick={() => onDecide(draft)}>
          決定
        </button>
      </div>
    </BottomSheet>
  );
}
