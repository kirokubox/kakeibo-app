import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { calcUsable, isFirstUse } from "./budgetLogic";
import { useBudgetBundle } from "./budgetStore";
import { Fab } from "./Fab";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { OUTLOOK_LENGTHS, buildOutlook, periodLabel, summarizeOutlook } from "./outlookLogic";
import type { OutlookColumn, OutlookMonths } from "./outlookLogic";
import { PlannedIncomeView } from "./PlannedIncomeView";
import { PlannedView } from "./PlannedView";
import { PREF_OUTLOOK_MONTHS, readPref, writePref } from "./localPrefs";
import { RESERVE_INTRO, ReserveRows, ReservesView } from "./ReservesView";
import { plannedNotesByReserve } from "./plannedLogic";
import { ReserveEditor } from "./ReserveEditor";
import { reserveBalances, splitReserves, totalReserveBalance } from "./reserveLogic";
import { useToast } from "./Toast";
import type { Id, Settings } from "./types";

interface Props {
  tabBar: ReactNode;
  today: string;
  version: number;
  settings: Settings;
  onOpenSettings: () => void;
  onAdd: (date: string) => void;
  onChanged: () => void;
}

function readMonths(): OutlookMonths {
  const v = readPref(PREF_OUTLOOK_MONTHS);
  return v === "6" ? 6 : v === "12" ? 12 : 3;
}

/** 金額の符号つき表示：＋12,000円 / −3,000円 */
function signed(n: number): string {
  return `${n > 0 ? "＋" : ""}${formatYen(n)}`;
}

/** 見通しタブ：給料日ごとの3〜6か月の表、予定出費、取り置き */
export function OutlookView({ tabBar, today, version, settings, onOpenSettings, onAdd, onChanged }: Props) {
  const [months, setMonths] = useState<OutlookMonths>(readMonths);
  const [page, setPage] = useState<{ openId: Id | null; adding: boolean } | null>(null);
  const [addingReserve, setAddingReserve] = useState(false);
  const [toast, showToast] = useToast();
  const { bundle, error, reload } = useBudgetBundle(version);

  const changed = () => {
    reload();
    onChanged();
  };

  const firstUse = bundle ? isFirstUse(bundle) : false;
  const outlook = useMemo(() => (bundle && !isFirstUse(bundle) ? buildOutlook(bundle, settings, today, months) : null), [bundle, settings, today, months]);
  const summary = useMemo(() => (outlook ? summarizeOutlook(outlook.columns) : null), [outlook]);
  const plannedNotes = useMemo(() => plannedNotesByReserve(bundle?.plannedExpenses ?? []), [bundle]);
  const usableNow = useMemo(() => (bundle ? calcUsable(bundle, settings, today).usable : null), [bundle, settings, today]);
  const balances = useMemo(() => reserveBalances(bundle?.reserveMoves ?? []), [bundle]);
  const reserveSplit = useMemo(() => splitReserves(bundle?.reserves ?? []), [bundle]);

  if (page && bundle) {
    return (
      <ReservesView
        bundle={bundle}
        today={today}
        usable={usableNow}
        initialOpenId={page.openId}
        initialAdding={page.adding}
        onBack={() => setPage(null)}
        onChanged={changed}
        showToast={showToast}
      />
    );
  }

  const changeMonths = (m: OutlookMonths) => {
    setMonths(m);
    writePref(PREF_OUTLOOK_MONTHS, String(m));
  };

  return (
    <>
      <header className="topbar">
        <h1 className="topbar-title">見通し</h1>
        <button type="button" className="icon-btn" aria-label="設定" onClick={onOpenSettings}>
          <Icon name="settings" size={22} />
        </button>
      </header>
      <main className="content outlook-content">
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <div className="segmented" role="group" aria-label="見通しの長さ">
          {OUTLOOK_LENGTHS.map((m) => (
            <button key={m} type="button" className={`seg${months === m ? " on" : ""}`} aria-pressed={months === m} onClick={() => changeMonths(m)}>
              {m === 12 ? "1年" : `${m}か月`}
            </button>
          ))}
        </div>

        {firstUse && (
          <section className="card outlook-card" aria-label="給料日ごとの見通し">
            <p className="empty-note small">資産と明細を入れると、先の見通しが出ます。</p>
          </section>
        )}

        {outlook && summary && (
          <section className="card outlook-summary" aria-label="見通しのまとめ">
            <h2 className="outlook-summary-title">{months === 12 ? "1年" : `${months}か月`}のまとめ</h2>
            <dl className="rows">
              <div className="row">
                <dt>収入 − 出費の合計</dt>
                <dd className={summary.net < 0 ? "caution" : undefined}>{signed(summary.net)}</dd>
              </div>
              {summary.lowest && (
                <div className="row">
                  <dt>{periodLabel(summary.lowest.start, summary.lowest.end)} が一番低い</dt>
                  <dd className={summary.lowest.closing < settings.defenseFund ? "caution" : undefined}>{formatYen(summary.lowest.closing)}</dd>
                </div>
              )}
              <div className="row">
                <dt>生活防衛資金を下回る区切り</dt>
                <dd className={summary.belowCount > 0 ? "caution" : undefined}>{summary.belowCount}個</dd>
              </div>
            </dl>
          </section>
        )}

        {outlook && (
          <section className="card outlook-card" aria-label="給料日ごとの見通し">
            <div className="table-scroll">
              <OutlookTable columns={outlook.columns} />
            </div>
            <p className="field-hint outlook-note">
              変動費の見込みは、直近の終わった{outlook.averagedPeriods > 0 ? `${outlook.averagedPeriods}区切り` : "区切り"}の平均です
              {outlook.averagedPeriods === 0 ? "（まだ数えられる区切りがないので「—」。0円として計算しています）" : ""}。今の区切りは、平均から今の区切りでもう使った分（{formatYen(outlook.currentSpent)}）を引いた残りで数えています。
              給料の見込みは、給料明細のひな形の手取り（前回の金額）です。支給する月を「毎年」にしたひな形（賞与など）は、その月だけ入れます。「毎月変わる」にした行（残業代など）は入れていません。予定収入（見込み）は期末の見込みに足していますが、使える額・予算には入れていません。カードの引き落としは参考の行で、期末の見込みには入れていません。
            </p>
            <p className="field-hint outlook-note">3か月より先は、予定出費・年1回や半年ごとの繰り返し・賞与を入れると違いが出ます。</p>
          </section>
        )}

        {bundle && <PlannedView bundle={bundle} today={today} usable={usableNow} onChanged={changed} showToast={showToast} />}
        {bundle && <PlannedIncomeView bundle={bundle} today={today} onChanged={changed} showToast={showToast} />}

        {bundle && (
          <section className="card list-card outlook-section" aria-label="取り置き">
            <h2 className="list-head">
              <span>取り置き（合計 {formatYen(totalReserveBalance(bundle.reserves, bundle.reserveMoves))}）</span>
              <button type="button" className="text-btn" onClick={() => setAddingReserve(true)}>
                追加
              </button>
            </h2>
            <p className="field-hint list-intro">{RESERVE_INTRO}</p>
            {reserveSplit.open.length === 0 ? (
              <p className="empty-note small">取り置きはまだありません。先の出費のために、使える額から外しておくお金です。</p>
            ) : (
              <ReserveRows reserves={reserveSplit.open} balances={balances} plannedNotes={plannedNotes} onOpen={(id) => setPage({ openId: id, adding: false })} />
            )}
            {(reserveSplit.closed.length > 0 || reserveSplit.open.length > 0) && (
              <div className="more-row">
                <button type="button" className="text-btn" onClick={() => setPage({ openId: null, adding: false })}>
                  取り置きの一覧を開く
                </button>
              </div>
            )}
          </section>
        )}
        <div className="fab-space" aria-hidden="true" />
      </main>
      <Fab onClick={() => onAdd(today)} />
      {tabBar}
      {addingReserve && bundle && (
        <ReserveEditor
          reserve={null}
          reserves={bundle.reserves}
          showToast={showToast}
          onDone={() => {
            setAddingReserve(false);
            changed();
          }}
          onClose={() => setAddingReserve(false)}
        />
      )}
      {toast}
    </>
  );
}

function OutlookTable({ columns }: { columns: OutlookColumn[] }) {
  return (
    <table className="outlook-table">
      <thead>
        <tr>
          <th scope="col" className="row-head">
            区切り
          </th>
          {columns.map((c, i) => (
            <th key={c.start} scope="col">
              {periodLabel(c.start, c.end)}
              {i === 0 && <span className="col-sub">今の区切り</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row" className="row-head">
            期のはじめの
            <br />
            使える資産
          </th>
          {columns.map((c) => (
            <td key={c.start}>{formatYen(c.openAssets)}</td>
          ))}
        </tr>
        <tr>
          <th scope="row" className="row-head">
            ＋入る予定の収入
          </th>
          {columns.map((c) => (
            <td key={c.start}>{formatYen(c.income)}</td>
          ))}
        </tr>
        <tr>
          <th scope="row" className="row-head">
            −決まった出費
          </th>
          {columns.map((c) => (
            <td key={c.start}>{formatYen(c.fixed)}</td>
          ))}
        </tr>
        <tr>
          <th scope="row" className="row-head">
            ＋予定収入
            <br />
            （見込み）
          </th>
          {columns.map((c) => (
            <td key={c.start} className="cell-ref">
              {c.plannedIncome > 0 ? formatYen(c.plannedIncome) : "—"}
            </td>
          ))}
        </tr>
        <tr>
          <th scope="row" className="row-head">
            −予定出費
          </th>
          {columns.map((c) => (
            <td key={c.start}>
              {formatYen(c.planned)}
              {c.plannedReserved > 0 && <span className="cell-sub">取り置き済み {formatYen(c.plannedReserved)}</span>}
            </td>
          ))}
        </tr>
        <tr>
          <th scope="row" className="row-head">
            −変動費の見込み
          </th>
          {columns.map((c) => (
            <td key={c.start}>{c.variable === null ? "—" : formatYen(c.variable)}</td>
          ))}
        </tr>
        <tr className="total-row">
          <th scope="row" className="row-head">
            ＝期末の見込み
          </th>
          {columns.map((c) => (
            <td key={c.start} className={c.belowFund ? "caution" : undefined}>
              {formatYen(c.closing)}
              {c.belowFund && <span className="cell-sub caution">生活防衛資金を下回る見込み</span>}
            </td>
          ))}
        </tr>
        <tr className="ref-row">
          <th scope="row" className="row-head">
            （参考）カードの引き落とし
            <br />
            使える額には影響しない
          </th>
          {columns.map((c) => (
            <td key={c.start}>{c.cardDebit > 0 ? formatYen(c.cardDebit) : "—"}</td>
          ))}
        </tr>
        <tr className="net-row">
          <th scope="row" className="row-head">
            収入−出費
          </th>
          {columns.map((c) => (
            <td key={c.start} className={c.net < 0 ? "caution" : undefined}>
              {signed(c.net)}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}
