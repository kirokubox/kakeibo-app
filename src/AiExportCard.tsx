import { useState } from "react";
import { aiFileName, buildAiMarkdown } from "./aiMarkdown";
import { APP_VERSION } from "./constants";
import { formatDateTimeJa, nowIso, todayKey } from "./dateUtils";
import { downloadTextFile } from "./fileUtils";
import { Icon } from "./Icon";
import { monthTitle, weekTitle } from "./periodLogic";
import { getAllData } from "./storage";
import { periodAround, shiftSummaryPeriod, summaryRange, switchDay } from "./summaryLogic";
import type { SummaryPeriod, SummaryPeriodKind } from "./summaryLogic";
import type { WeekStart } from "./types";

const KINDS: Array<[Exclude<SummaryPeriodKind, "year">, string]> = [
  ["week", "週"],
  ["month", "月"],
  ["custom", "任意"],
];

/** 設定の「AIに渡す書き出し」：週・月・任意の期間をMarkdownで書き出す（かぞえ帳・生活記録と同じ入口） */
export function AiExportCard({ weekStart }: { weekStart: WeekStart }) {
  const [period, setPeriod] = useState<SummaryPeriod>(() => periodAround("month", todayKey(), undefined, weekStart));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const range = summaryRange(period, weekStart);

  const title = period.kind === "week" ? weekTitle(period.anchor) : period.kind === "month" ? monthTitle(period.anchor.slice(0, 7)) : "任意の期間";

  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const data = await getAllData();
      const now = nowIso();
      const md = buildAiMarkdown({
        range,
        exportedAt: now,
        exportedLabel: formatDateTimeJa(now),
        appVersion: APP_VERSION,
        accounts: data.accounts.filter((a) => a.deletedAt === null),
        categories: data.categories,
        transactions: data.transactions,
        reserves: data.reserves,
        reserveMoves: data.reserveMoves,
        plannedExpenses: data.plannedExpenses,
        budgetSnapshots: data.budgetSnapshots,
      });
      const name = aiFileName(range);
      downloadTextFile(name, md, "text/markdown");
      setMessage({ kind: "ok", text: `${name} を保存しました。メモや立替の相手など、個人の情報が入っています。AIに渡す相手を確かめてから使ってください。` });
    } catch (e) {
      setMessage({ kind: "error", text: `書き出せませんでした：${e instanceof Error ? e.message : "不明なエラー"}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>AIに渡す書き出し</h2>
      <div className="segmented" role="group" aria-label="期間の種類">
        {KINDS.map(([k, label]) => (
          <button key={k} type="button" className={`seg${period.kind === k ? " on" : ""}`} aria-pressed={period.kind === k} onClick={() => setPeriod((p) => periodAround(k, switchDay(p, todayKey(), weekStart), p, weekStart))}>
            {label}
          </button>
        ))}
      </div>
      <div className="period-nav">
        <button type="button" className="icon-btn" aria-label="前の期間" onClick={() => setPeriod((p) => shiftSummaryPeriod(p, -1))}>
          <Icon name="chevron-left" size={22} />
        </button>
        <span className="period-title">{title}</span>
        <button type="button" className="icon-btn" aria-label="次の期間" onClick={() => setPeriod((p) => shiftSummaryPeriod(p, 1))}>
          <Icon name="chevron-right" size={22} />
        </button>
      </div>
      {period.kind === "custom" ? (
        <div className="date-range">
          <input type="date" className="text-input" aria-label="開始日" value={period.customStart} onChange={(e) => setPeriod((p) => ({ ...p, customStart: e.target.value }))} />
          <span className="unit">〜</span>
          <input type="date" className="text-input" aria-label="終了日" value={period.customEnd} onChange={(e) => setPeriod((p) => ({ ...p, customEnd: e.target.value }))} />
        </div>
      ) : (
        <p className="field-hint center">
          {range.start} 〜 {range.end}
        </p>
      )}
      <div className="actions">
        <button type="button" className="primary-btn" disabled={busy || !range.start || !range.end} onClick={() => void run()}>
          <Icon name="download" size={18} />
          この期間を書き出す
        </button>
      </div>
      {message && (
        <p className={`notice ${message.kind === "error" ? "danger" : "ok"}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      <p className="muted small">収入・支出のまとめ、予算と実績、分類別の合計、明細（メモ・立替・取り置きを含む）、未回収の立替などをMarkdownにします。ファイル名は kakeibo-ai-開始日_終了日.md です。</p>
    </section>
  );
}
