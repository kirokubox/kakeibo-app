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

type RowKey = "every" | "day" | "shift" | "end";

/** 日付（YYYY-MM-DD）を「12月31日」に */
function monthDayLabel(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

/**
 * 繰り返しの設定の中身（間隔・日・休日なら・終わり・見込み額）。シートと、繰り返しの編集画面で使う。
 * v0.19.0：選択肢を全部並べるのをやめ、「項目名・今の値 ›」の行にした。押した行だけ、その下に選ぶものを開く（ほかの行は閉じる）。
 * 見込み額はスイッチ（本人 2026-11-25「案1」。`00_共通/43` §2-3）。
 */
export function RepeatFields({ value, onChange, anchorDate }: FieldsProps) {
  const [open, setOpen] = useState<RowKey | null>(null);
  const set = (patch: Partial<RepeatDraft>) => onChange({ ...value, ...patch });
  const toggle = (k: RowKey) => setOpen((cur) => (cur === k ? null : k));
  const pickAndClose = (patch: Partial<RepeatDraft>) => {
    set(patch);
    setOpen(null);
  };
  const n = value.n ?? 2;

  const everyLabel = value.every === "nMonths" ? `${n}か月ごと` : (EVERY_OPTIONS.find((o) => o.value === value.every)?.label ?? "");
  const dayLabel =
    value.every === "week"
      ? `${WEEKDAYS[(Number(value.day) || 1) - 1]}曜日`
      : `${value.every === "year" ? `${value.month ?? 1}月` : ""}${value.day === "last" ? "末日" : `${value.day}日`}`;
  const dayTitle = value.every === "week" ? "曜日" : value.every === "year" ? "月と日" : "日";

  const row = (k: RowKey, label: string, current: string) => (
    <button type="button" className={`repeat-row${open === k ? " open" : ""}`} aria-expanded={open === k} onClick={() => toggle(k)}>
      <span>{label}</span>
      <span className="repeat-row-value">
        {current}
        <span className="repeat-row-chevron" aria-hidden="true">
          ›
        </span>
      </span>
    </button>
  );

  return (
    <div className="repeat-fields rows">
      {row("every", "間隔", everyLabel)}
      {open === "every" && (
        <div className="repeat-pick">
          <div className="chips" role="group" aria-label="間隔">
            {EVERY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`chip${value.every === o.value ? " on" : ""}`}
                aria-pressed={value.every === o.value}
                onClick={() => {
                  if (value.every !== o.value) onChange(changeRepeatEvery(value, o.value, anchorDate));
                  if (o.value !== "nMonths") setOpen(null);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          {value.every === "nMonths" && (
            <div className="repeat-select">
              <span>何か月ごと</span>
              <span className="repeat-stepper">
                <button type="button" className="stepper-btn" aria-label="1か月へらす" disabled={n <= 2} onClick={() => set({ n: Math.max(2, n - 1) })}>
                  −
                </button>
                <b>{n}か月</b>
                <button type="button" className="stepper-btn" aria-label="1か月ふやす" disabled={n >= 12} onClick={() => set({ n: Math.min(12, n + 1) })}>
                  ＋
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      {row("day", dayTitle, dayLabel)}
      {open === "day" && (
        <div className="repeat-pick">
          {value.every === "week" ? (
            <div className="day-grid" role="group" aria-label="曜日">
              {WEEKDAYS.map((w, i) => (
                <button key={w} type="button" className={`chip${value.day === i + 1 ? " on" : ""}`} aria-pressed={value.day === i + 1} onClick={() => pickAndClose({ day: i + 1 })}>
                  {w}
                </button>
              ))}
            </div>
          ) : (
            <>
              {value.every === "year" && (
                <div className="month-grid" role="group" aria-label="月">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <button key={m} type="button" className={`chip${value.month === m ? " on" : ""}`} aria-pressed={value.month === m} onClick={() => set({ month: m })}>
                      {m}月
                    </button>
                  ))}
                </div>
              )}
              <div className="day-grid" role="group" aria-label="日">
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <button key={d} type="button" className={`chip${value.day === d ? " on" : ""}`} aria-pressed={value.day === d} onClick={() => pickAndClose({ day: d })}>
                    {d}
                  </button>
                ))}
                <button type="button" className={`chip day-last${value.day === "last" ? " on" : ""}`} aria-pressed={value.day === "last"} onClick={() => pickAndClose({ day: "last" })}>
                  末日
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {row("shift", "休日なら", SHIFT_LABELS[value.holidayShift])}
      {open === "shift" && (
        <div className="repeat-pick">
          <div className="chips" role="group" aria-label="休日なら">
            {SHIFTS.map((sh) => (
              <button key={sh} type="button" className={`chip${value.holidayShift === sh ? " on" : ""}`} aria-pressed={value.holidayShift === sh} onClick={() => pickAndClose({ holidayShift: sh })}>
                {SHIFT_LABELS[sh]}
              </button>
            ))}
          </div>
        </div>
      )}

      {row("end", "終わり", value.endDate === null ? "なし" : `${monthDayLabel(value.endDate)}まで`)}
      {open === "end" && (
        <div className="repeat-pick">
          <div className="chips" role="group" aria-label="終わり">
            <button type="button" className={`chip${value.endDate === null ? " on" : ""}`} aria-pressed={value.endDate === null} onClick={() => pickAndClose({ endDate: null })}>
              なし
            </button>
            <button type="button" className={`chip${value.endDate !== null ? " on" : ""}`} aria-pressed={value.endDate !== null} onClick={() => value.endDate === null && set({ endDate: anchorDate })}>
              日付を決める
            </button>
          </div>
          {value.endDate !== null && (
            <input type="date" className="date-input" aria-label="終わりの日" value={value.endDate} onChange={(e) => e.target.value && set({ endDate: e.target.value })} />
          )}
        </div>
      )}

      <label className="repeat-row switch-row">
        <span>
          見込み額
          <span className="field-hint block">公共料金など、毎月金額が変わるもの</span>
        </span>
        <input type="checkbox" role="switch" className="switch" checked={value.estimated} onChange={(e) => set({ estimated: e.target.checked })} />
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
