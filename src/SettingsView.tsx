import { useRef, useState } from "react";
import { backupFileName, parseBackup } from "./backup";
import { SHIFT_LABELS } from "./accountLogic";
import { ChoiceSheet } from "./BottomSheet";
import { CategoriesView } from "./CategoriesView";
import { APP_VERSION, STORE_LABELS } from "./constants";
import { formatDateTimeJa, todayKey } from "./dateUtils";
import { downloadTextFile } from "./fileUtils";
import { Icon } from "./Icon";
import { indexExisting, planImport, recordsToWrite, totalsOf } from "./importPreview";
import type { ImportPlan } from "./importPreview";
import { resetSuggestIndex } from "./suggestStore";
import { formatYen } from "./money";
import { NumberSheet } from "./NumberSheet";
import { validateDefenseFund, validatePayday, validateReminderDays } from "./settingsLogic";
import { exportBackup, getAllData, requestPersistentStorage, writeImported } from "./storage";
import type { PersistenceState } from "./storage";
import { DATA_STORE_NAMES } from "./types";
import { useToast } from "./Toast";
import type { BackupFile, BudgetMonthBoundary, HolidayShift, HomeMainFigure, Settings } from "./types";

interface Props {
  settings: Settings;
  persistence: PersistenceState;
  onPersistenceChange: (state: PersistenceState) => void;
  onSettingsChange: (next: Settings) => Promise<void>;
  onClose: () => void;
}

interface Preview {
  fileName: string;
  exportedAt: string;
  backup: BackupFile;
  plan: ImportPlan;
}

type SettingSheet = "payday" | "shift" | "fund" | "boundary" | "figure" | "reminder";

const SHIFT_OPTIONS: Array<{ value: HolidayShift; label: string }> = (["before", "after", "none"] as const).map((value) => ({ value, label: SHIFT_LABELS[value] }));
const BOUNDARY_OPTIONS: Array<{ value: BudgetMonthBoundary; label: string; description: string }> = [
  { value: "payday", label: "給料日から次の給料日の前日まで", description: "給料日で区切って予算を決めます" },
  { value: "calendar", label: "暦月（1日〜末日）", description: "毎月1日から末日までで予算を決めます" },
];
const FIGURE_OPTIONS: Array<{ value: HomeMainFigure; label: string }> = [
  { value: "remaining", label: "今週あと◯円" },
  { value: "spent", label: "今週使った額" },
];

/** 設定の1行：項目名と今の値。タップで変える */
function SettingRow({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className="setting-label">{label}</span>
      <span className="setting-value">{value}</span>
      {onClick && <Icon name="chevron-right" size={18} />}
    </>
  );
  return onClick ? (
    <button type="button" className="setting-row" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="setting-row static">{inner}</div>
  );
}

const PERSISTENCE_TEXT: Record<PersistenceState, string> = {
  granted: "許可されています",
  denied: "許可されていません",
  unsupported: "このブラウザでは確認できません",
};

export function SettingsView({ settings, persistence, onPersistenceChange, onSettingsChange, onClose }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [doAdd, setDoAdd] = useState(true);
  const [doUpdate, setDoUpdate] = useState(true);
  const [page, setPage] = useState<null | "expense" | "income">(null);
  const [sheet, setSheet] = useState<SettingSheet | null>(null);
  const [toast, showToast] = useToast();

  /** 変えたらすぐ保存して、短く知らせる */
  const change = async (patch: Partial<Settings>, notice = "保存しました") => {
    try {
      await onSettingsChange({ ...settings, ...patch });
      showToast(notice, notice.length > 20 ? 5000 : 2400);
    } catch (error) {
      setMessage({ kind: "error", text: `保存できませんでした：${error instanceof Error ? error.message : "不明なエラー"}` });
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { backup, settings: updated } = await exportBackup();
      downloadTextFile(backupFileName(todayKey()), JSON.stringify(backup, null, 2));
      await onSettingsChange(updated);
      setMessage({ kind: "ok", text: "バックアップを保存しました。ダウンロードしたファイルは、公開される場所（GitHubなど）に置かないでください。" });
    } catch (error) {
      setMessage({ kind: "error", text: `バックアップを保存できませんでした：${error instanceof Error ? error.message : "不明なエラー"}` });
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setPreview(null);
    try {
      const result = parseBackup(await file.text());
      if (!result.ok) {
        setMessage({ kind: "error", text: `読み込めませんでした（何も保存していません）：${result.reason}` });
        return;
      }
      const plan = planImport(result.backup, indexExisting(await getAllData()));
      setPreview({ fileName: file.name, exportedAt: result.backup.exportedAt, backup: result.backup, plan });
      setDoAdd(true);
      setDoUpdate(true);
    } catch (error) {
      setMessage({ kind: "error", text: `読み込めませんでした（何も保存していません）：${error instanceof Error ? error.message : "不明なエラー"}` });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const handleApply = async () => {
    if (!preview) return;
    setBusy(true);
    setMessage(null);
    try {
      const records = recordsToWrite(preview.plan, { add: doAdd, update: doUpdate });
      await writeImported(records);
      resetSuggestIndex(); // 内容・メモの候補の集計は、次に使うとき作り直す
      const t = totalsOf(preview.plan);
      const added = doAdd ? t.add : 0;
      const updated = doUpdate ? t.update : 0;
      setMessage({ kind: "ok", text: `読み込みました：新しく足した ${added} 件、更新した ${updated} 件。` });
      setPreview(null);
    } catch (error) {
      setMessage({ kind: "error", text: `保存できなかったため、何も書き込んでいません：${error instanceof Error ? error.message : "不明なエラー"}` });
    } finally {
      setBusy(false);
    }
  };

  const handlePersist = async () => {
    onPersistenceChange(await requestPersistentStorage());
  };

  const totals = preview ? totalsOf(preview.plan) : null;
  const nothingToWrite = totals !== null && (doAdd ? totals.add : 0) + (doUpdate ? totals.update : 0) === 0;

  if (page) return <CategoriesView initialKind={page} onBack={() => setPage(null)} />;

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onClose}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">設定</h1>
      </header>
      <main className="content">
        {message && (
          <p className={`notice ${message.kind === "error" ? "danger" : "ok"}`} role={message.kind === "error" ? "alert" : "status"}>
            {message.text}
          </p>
        )}

        <section className="card">
          <h2>バックアップ</h2>
          <dl className="rows">
            <div className="row">
              <dt>最後に保存した日時</dt>
              <dd>{settings.lastBackupAt ? formatDateTimeJa(settings.lastBackupAt) : "まだ保存していません"}</dd>
            </div>
          </dl>
          <div className="setting-list">
            <SettingRow label="お知らせまでの日数" value={`${settings.backupReminderDays}日`} onClick={() => setSheet("reminder")} />
          </div>
          <p className="muted small">全部のデータを1つのファイルに保存します。定期的に保存してください。お知らせはホームに出します（段階6で付けます）。</p>
          <div className="actions">
            <button type="button" className="primary-btn" disabled={busy} onClick={handleExport}>
              <Icon name="download" size={18} />
              バックアップを保存
            </button>
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
              <Icon name="upload" size={18} />
              バックアップから追加
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
          </div>
          <p className="muted small">読み込むときは、今あるデータを消さずに足します。実行前に件数を確認できます。</p>

          {preview && totals && (
            <div className="preview" aria-live="polite">
              <h3>読み込む内容の確認</h3>
              <p className="muted small">
                {preview.fileName}（{formatDateTimeJa(preview.exportedAt)} 保存）。まだ何も保存していません。
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>種類</th>
                      <th>件数</th>
                      <th>足す</th>
                      <th>更新</th>
                      <th>飛ばす</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DATA_STORE_NAMES.map((name) => {
                      const p = preview.plan[name];
                      if (p.total === 0) return null;
                      return (
                        <tr key={name}>
                          <td>{STORE_LABELS[name]}</td>
                          <td>{p.total.toLocaleString("ja-JP")}</td>
                          <td>{p.add.length.toLocaleString("ja-JP")}</td>
                          <td>{p.update.length.toLocaleString("ja-JP")}</td>
                          <td>{(p.same + p.older).toLocaleString("ja-JP")}</td>
                        </tr>
                      );
                    })}
                    <tr className="total">
                      <td>合計</td>
                      <td>{totals.total.toLocaleString("ja-JP")}</td>
                      <td>{totals.add.toLocaleString("ja-JP")}</td>
                      <td>{totals.update.toLocaleString("ja-JP")}</td>
                      <td>{totals.skipped.toLocaleString("ja-JP")}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                「飛ばす」は、同じものが同じ状態で入っている、または今のデータの方が新しいもの。設定は上書きしません。
              </p>
              <label className="check">
                <input type="checkbox" checked={doAdd} onChange={(e) => setDoAdd(e.target.checked)} />
                新しく足す（{totals.add.toLocaleString("ja-JP")} 件）
              </label>
              <label className="check">
                <input type="checkbox" checked={doUpdate} onChange={(e) => setDoUpdate(e.target.checked)} />
                同じものは、新しい方で更新する（{totals.update.toLocaleString("ja-JP")} 件）
              </label>
              <div className="actions">
                <button type="button" className="primary-btn" disabled={busy || nothingToWrite} onClick={handleApply}>
                  読み込む
                </button>
                <button type="button" className="secondary-btn" disabled={busy} onClick={() => setPreview(null)}>
                  やめる
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <h2>データの保護</h2>
          <dl className="rows">
            <div className="row">
              <dt>消えにくくする設定</dt>
              <dd>{PERSISTENCE_TEXT[persistence]}</dd>
            </div>
          </dl>
          <p className="small">
            ブラウザが自動でデータを消すのを防ぐ設定です。自分で「Cookieとサイトデータ」を消したときや機種変更では消えます。
            最後に守ってくれるのはバックアップです。同じ kirokubox.github.io の他のアプリもまとめて消えます。
          </p>
          {persistence === "denied" && (
            <div className="actions">
              <button type="button" className="secondary-btn" onClick={() => void handlePersist()}>
                もう一度許可を求める
              </button>
            </div>
          )}
        </section>

        <section className="card">
          <h2>分類</h2>
          <div className="setting-list">
            <SettingRow label="支出の分類" value="" onClick={() => setPage("expense")} />
            <SettingRow label="収入の分類" value="" onClick={() => setPage("income")} />
          </div>
        </section>

        <section className="card">
          <h2>給料日と予算</h2>
          <div className="setting-list">
            <SettingRow label="給料日" value={`毎月${settings.payday}日`} onClick={() => setSheet("payday")} />
            <SettingRow label="給料日が休日なら" value={SHIFT_LABELS[settings.paydayHolidayShift]} onClick={() => setSheet("shift")} />
            <SettingRow label="生活防衛資金" value={formatYen(settings.defenseFund)} onClick={() => setSheet("fund")} />
            <SettingRow label="月の予算の区切り" value={settings.budgetMonthBoundary === "payday" ? "給料日から" : "暦月"} onClick={() => setSheet("boundary")} />
          </div>
          <p className="muted small">生活防衛資金は、使える額から先に外しておくお金です。集計の「月」は、どちらを選んでも暦月です。</p>
        </section>

        <section className="card">
          <h2>表示</h2>
          <div className="setting-list">
            <SettingRow label="ホームの一番大きい数字" value={settings.homeMainFigure === "remaining" ? "今週あと◯円" : "今週使った額"} onClick={() => setSheet("figure")} />
            <SettingRow label="週の始まり" value="月曜" />
          </div>
        </section>

        <section className="card">
          <h2>このアプリについて</h2>
          <dl className="rows">
            <div className="row">
              <dt>バージョン</dt>
              <dd>{APP_VERSION}</dd>
            </div>
          </dl>
        </section>
      </main>

      {sheet === "payday" && (
        <NumberSheet title="給料日" description="1〜31日。その月にない日は月末になります" kind="days" value={settings.payday} validate={(n) => validatePayday(n)} onSave={(n) => change({ payday: n })} onClose={() => setSheet(null)} />
      )}
      {sheet === "fund" && (
        <NumberSheet title="生活防衛資金" description="使える額から先に外しておくお金です" kind="yen" value={settings.defenseFund} validate={(n) => validateDefenseFund(n)} onSave={(n) => change({ defenseFund: n })} onClose={() => setSheet(null)} />
      )}
      {sheet === "reminder" && (
        <NumberSheet title="お知らせまでの日数" description="最後にバックアップを保存してから、この日数がたったらお知らせします（1〜90日）" kind="days" value={settings.backupReminderDays} validate={(n) => validateReminderDays(n)} onSave={(n) => change({ backupReminderDays: n })} onClose={() => setSheet(null)} />
      )}
      {sheet === "shift" && (
        <ChoiceSheet title="給料日が休日なら" options={SHIFT_OPTIONS} value={settings.paydayHolidayShift} onSelect={(v) => void change({ paydayHolidayShift: v })} onClose={() => setSheet(null)} />
      )}
      {sheet === "boundary" && (
        <ChoiceSheet
          title="月の予算の区切り"
          options={BOUNDARY_OPTIONS}
          value={settings.budgetMonthBoundary}
          onSelect={(v) => {
            if (v !== settings.budgetMonthBoundary) void change({ budgetMonthBoundary: v }, "次の区切りから新しい区切りで予算を決めます。これまでの予算の記録は変わりません");
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "figure" && (
        <ChoiceSheet title="ホームの一番大きい数字" options={FIGURE_OPTIONS} value={settings.homeMainFigure} onSelect={(v) => void change({ homeMainFigure: v })} onClose={() => setSheet(null)} />
      )}
      {toast}
    </>
  );
}
