import { useRef, useState } from "react";
import { backupFileName, parseBackup } from "./backup";
import { APP_VERSION, STORE_LABELS } from "./constants";
import { formatDateTimeJa, todayKey } from "./dateUtils";
import { downloadTextFile } from "./fileUtils";
import { Icon } from "./Icon";
import { indexExisting, planImport, recordsToWrite, totalsOf } from "./importPreview";
import type { ImportPlan } from "./importPreview";
import { formatYen } from "./money";
import { exportBackup, getAllData, requestPersistentStorage, writeImported } from "./storage";
import type { PersistenceState } from "./storage";
import { DATA_STORE_NAMES } from "./types";
import type { BackupFile, Settings } from "./types";

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

const SHIFT_LABELS = { before: "前の平日", after: "後の平日", none: "そのまま" } as const;

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
          <p className="muted small">全部のデータを1つのファイルに保存します。定期的に保存してください。</p>
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
          <h2>今の設定</h2>
          <p className="muted small">変更できる画面は段階2で作ります。</p>
          <dl className="rows">
            <div className="row">
              <dt>給料日</dt>
              <dd>毎月{settings.payday}日（休日は{SHIFT_LABELS[settings.paydayHolidayShift]}）</dd>
            </div>
            <div className="row">
              <dt>生活防衛資金</dt>
              <dd>{formatYen(settings.defenseFund)}</dd>
            </div>
            <div className="row">
              <dt>月の区切り</dt>
              <dd>{settings.budgetMonthBoundary === "payday" ? "給料日から次の給料日の前日まで" : "毎月1日から末日まで"}</dd>
            </div>
            <div className="row">
              <dt>ホームの大きい数字</dt>
              <dd>{settings.homeMainFigure === "remaining" ? "今週あと◯円" : "今週使った額"}</dd>
            </div>
            <div className="row">
              <dt>週の始まり</dt>
              <dd>月曜</dd>
            </div>
            <div className="row">
              <dt>バックアップのお知らせ</dt>
              <dd>最後の保存から{settings.backupReminderDays}日</dd>
            </div>
          </dl>
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
    </>
  );
}
