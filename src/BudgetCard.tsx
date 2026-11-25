import { useState } from "react";
import type { ReactNode } from "react";
import { ConfirmSheet } from "./BottomSheet";
import type { BudgetFigure } from "./budgetLogic";
import { KebabMenu } from "./KebabMenu";
import { formatYen } from "./money";
import { periodLabel } from "./outlookLogic";
import { weekdayShort } from "./periodLogic";
import type { HomeMainFigure } from "./types";

interface BarProps {
  bars: Array<{ date: string; amount: number }>;
  today: string;
}

/** 日ごとの使った額の小さな棒(月〜日) */
function DayBars({ bars, today }: BarProps) {
  const max = Math.max(1, ...bars.map((b) => b.amount));
  return (
    <div className="bars home-bars" aria-label="日ごとの使った額">
      {bars.map((b) => (
        <div key={b.date} className="bar-col">
          <span className="bar-amount">{b.amount > 0 ? b.amount.toLocaleString("ja-JP") : ""}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ height: `${Math.round((b.amount / max) * 100)}%` }} />
          </span>
          <span className={`bar-day${b.date === today ? " today" : ""}`}>{weekdayShort(b.date)}</span>
        </div>
      ))}
    </div>
  );
}

/** 今月の週ごとの使った額の棒（v0.19.0。今月を選んだとき） */
function WeekBars({ weeks, today }: { weeks: Array<{ start: string; end: string; amount: number }>; today: string }) {
  const max = Math.max(1, ...weeks.map((w) => w.amount));
  return (
    <div className="bars home-bars" aria-label="週ごとの使った額" style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }}>
      {weeks.map((w) => (
        <div key={w.start} className="bar-col">
          <span className="bar-amount">{w.amount > 0 ? w.amount.toLocaleString("ja-JP") : ""}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ height: `${Math.round((w.amount / max) * 100)}%` }} />
          </span>
          <span className={`bar-day${w.start <= today && today <= w.end ? " today" : ""}`}>{shortDay(w.start)}〜</span>
        </div>
      ))}
    </div>
  );
}

function shortDay(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

interface Common {
  /** 今の額で決め直す(まだ決まっていなければ決める) */
  onRecalc: () => Promise<void>;
  onOpenPayroll?: () => void;
  /** 自分で決めた月の予算で出しているとき：使い切れる上限（今の自動の計算）を小さく併記する文章 */
  limitText?: string | null;
  /** 自分で決めた月の予算か（メニューの文言が変わる） */
  manual?: boolean;
  /** 今週・今月の切り替え（あるときは見出しの代わりに出し、期間は下に小さく） */
  switcher?: ReactNode;
}

function CardHead({ switcher, label, period, menu }: { switcher?: ReactNode; label: string; period: string; menu: ReactNode }) {
  return switcher ? (
    <>
      <div className="home-card-head">
        {switcher}
        {menu}
      </div>
      <span className="home-period">{period}</span>
    </>
  ) : (
    <div className="home-card-head">
      <span className="home-label">
        {label}（{period}）
      </span>
      {menu}
    </div>
  );
}

/** 決め直しの確認つき︙メニュー */
function RecalcMenu({ label, onRecalc, manual }: { label: string; onRecalc: () => Promise<void>; manual?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <KebabMenu items={[{ label: manual ? "今の金額で決め直す" : "今の額で決め直す", onSelect: () => setAsking(true) }]} />
      {asking && (
        <ConfirmSheet
          title={`${label}を決め直しますか`}
          message={
            manual
              ? "設定の月の予算の金額で、今の区切りの予算を決めなおします。金額を変えたあとに、今の区切りにすぐ効かせたいときに使います。"
              : "今あるデータで、期間のはじめの時点の使える額から計算しなおします。給料明細を遅れて入れたときや、大きな入力漏れを直したときに使います。"
          }
          confirmLabel="決め直す"
          busy={busy}
          onConfirm={() => {
            setBusy(true);
            void onRecalc().finally(() => {
              setBusy(false);
              setAsking(false);
            });
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}

function Remaining({ remaining, unit }: { remaining: number; unit: string }) {
  return remaining >= 0 ? (
    <span className="home-big">
      {unit}あと {formatYen(remaining)}
    </span>
  ) : (
    <span className="home-big caution">
      {unit}の予算を {formatYen(-remaining)} こえています
    </span>
  );
}

/** 一番大きい数字のカード(今週)。設定 homeMainFigure で「あと◯円」か「使った額」を大きく出す */
export function WeekCard({ week, bars, topCategories, figure, today, hasData, onRecalc, limitText, manual, switcher, simple = false }: Common & { week: BudgetFigure; bars: BarProps["bars"]; topCategories: Array<{ id: string | null; name: string; amount: number }>; figure: HomeMainFigure; today: string; hasData: boolean; /** かんたん表示：予算の決め直しの「…」を出さない */ simple?: boolean }) {
  const budget = week.snapshot?.amount ?? null;
  return (
    <section className="card home-card main-card" aria-label="今週">
      <CardHead switcher={switcher} label="今週" period={periodLabel(week.start, week.end)} menu={!simple && <RecalcMenu label="今週の予算" onRecalc={onRecalc} manual={manual} />} />
      {week.remaining === null || budget === null ? (
        !hasData ? (
          <span className="home-hint">明細を入れると、今週の予算が決まります</span>
        ) : week.waiting ? (
          <>
            <span className="home-hint">給料明細を入れると今週の予算が決まります</span>
            <div>
              <button type="button" className="secondary-btn" onClick={() => void onRecalc()}>
                今の額で決める
              </button>
            </div>
          </>
        ) : (
          <span className="home-hint">今週の予算を計算しています…</span>
        )
      ) : (
        <>
          {figure === "remaining" ? (
            <>
              <Remaining remaining={week.remaining} unit="今週" />
              <span className="home-sub">
                <span>今週使った額 {formatYen(week.spent)}</span>
                <span>予算 {formatYen(budget)}</span>
              </span>
            </>
          ) : (
            <>
              <span className="home-big">今週使った額 {formatYen(week.spent)}</span>
              <span className="home-sub">
                <span>{week.remaining >= 0 ? `あと ${formatYen(week.remaining)}` : `${formatYen(-week.remaining)} こえています`}</span>
                <span>予算 {formatYen(budget)}</span>
              </span>
            </>
          )}
          <DayBars bars={bars} today={today} />
          {topCategories.length > 0 && (
            <div className="week-top-categories">
              <span className="home-label">今週多かったもの</span>
              <ul>
                {topCategories.map((category) => (
                  <li key={category.id ?? "none"}>
                    <span>{category.name}</span>
                    <span>{formatYen(category.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <span className="home-hint">使った額は明細の日付で数えます。今週内の先の日付は今週に入り、来週以降は入りません。</span>
          {limitText && <span className="home-limit">{limitText}</span>}
        </>
      )}
    </section>
  );
}

/** 今月の予算のカード */
export function MonthCard({ month, hasData, onRecalc, onOpenPayroll, limitText, manual, switcher, today }: Common & { month: BudgetFigure & { weeks?: Array<{ start: string; end: string; amount: number }> }; hasData: boolean; today: string }) {
  const budget = month.snapshot?.amount ?? null;
  return (
    <section className={`card home-card${switcher ? " main-card" : ""}`} aria-label="今月の予算">
      <CardHead switcher={switcher} label="今月の予算" period={periodLabel(month.start, month.end)} menu={<RecalcMenu label="今月の予算" onRecalc={onRecalc} manual={manual} />} />
      {month.remaining === null || budget === null ? (
        !hasData ? (
          <span className="home-hint">明細を入れると、今月の予算が決まります</span>
        ) : month.waiting ? (
          <>
            <span className="home-hint">給料明細を入れると今月の予算が決まります</span>
            <div className="home-actions">
              {onOpenPayroll && (
                <button type="button" className="primary-btn" onClick={onOpenPayroll}>
                  給料明細を入れる
                </button>
              )}
              <button type="button" className="secondary-btn" onClick={() => void onRecalc()}>
                今の額で決める
              </button>
            </div>
          </>
        ) : (
          <span className="home-hint">今月の予算を計算しています…</span>
        )
      ) : (
        <>
          <Remaining remaining={month.remaining} unit="今月" />
          <span className="home-sub">
            <span>使った額 {formatYen(month.spent)}</span>
            <span>予算 {formatYen(budget)}</span>
          </span>
          {month.weeks && month.weeks.length > 0 && <WeekBars weeks={month.weeks} today={today} />}
          {limitText && <span className="home-limit">{limitText}</span>}
        </>
      )}
    </section>
  );
}

/**
 * ホームの予算のカード（v0.19.0）：「今週｜今月」を切り替える1枚。開くたびに今週（本人 2026-11-25「いつも今週がいいな」）。
 * かんたん表示では切り替えを出さず、今週だけ。
 */
export function BudgetSwitchCard(props: {
  week: Parameters<typeof WeekCard>[0];
  month: Parameters<typeof MonthCard>[0] | null;
}) {
  const [which, setWhich] = useState<"week" | "month">("week");
  if (!props.month) return <WeekCard {...props.week} />;
  const switcher = (
    <div className="segmented budget-switch" role="tablist" aria-label="予算の期間">
      {(["week", "month"] as const).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={which === k} className={`seg${which === k ? " on" : ""}`} onClick={() => setWhich(k)}>
          {k === "week" ? "今週" : "今月"}
        </button>
      ))}
    </div>
  );
  return which === "week" ? <WeekCard {...props.week} switcher={switcher} /> : <MonthCard {...props.month} switcher={switcher} />;
}
