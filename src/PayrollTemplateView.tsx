import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountPanel } from "./AccountPanel";
import { SHIFT_LABELS } from "./accountLogic";
import { ChoiceSheet, ConfirmSheet } from "./BottomSheet";
import { categoryNames, selectableAccounts } from "./entryLogic";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { formatYen } from "./money";
import { NumberSheet } from "./NumberSheet";
import { PayrollLineRow, TakeHome, TargetPanel } from "./PayrollParts";
import { PREF_PAYROLL_INTRO, readPref, writePref } from "./localPrefs";
import { PAYROLL_KINDS, PAYROLL_KIND_LABELS, SETTLEMENT_NOTE, addLineLabel, blankLine, blankPayroll, moveLine, payrollTotals, validatePayroll } from "./payrollLogic";
import { payrollForecast } from "./scheduleLogic";
import { getAll, newBase, newId, saveRecord, softDelete } from "./storage";
import { useToast } from "./Toast";
import type { Account, Category, HolidayShift, Id, Payroll, PayrollLine, Settings } from "./types";

interface Props {
  settings: Settings;
  today: string;
  onBack: () => void;
  /** 「この月を入れる」 */
  onEnterMonth: (payrollId: Id) => void;
}

const SHIFT_OPTIONS = (["before", "after", "none"] as const).map((value) => ({ value, label: SHIFT_LABELS[value] }));

function dayText(day: number): string {
  return day >= 31 ? "毎月末日" : `毎月${day}日`;
}

/** 設定の「給料明細」：ひな形の一覧と、ひな形の編集 */
export function PayrollTemplateView({ settings, today, onBack, onEnterMonth }: Props) {
  const [payrolls, setPayrolls] = useState<Payroll[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<{ payroll: Payroll; isNew: boolean } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    try {
      const [p, a, c] = await Promise.all([getAll("payrolls"), getAll("accounts"), getAll("categories")]);
      setPayrolls(p);
      setAccounts(a);
      setCategories(c);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "データを開けませんでした");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(() => (payrolls ?? []).filter((p) => p.deletedAt === null).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [payrolls]);

  if (editing) {
    return (
      <>
        <PayrollEditor
          payroll={editing.payroll}
          isNew={editing.isNew}
          accounts={accounts}
          categories={categories}
          showToast={showToast}
          onBack={() => setEditing(null)}
          onDone={(message) => {
            setEditing(null);
            showToast(message);
            void load();
          }}
        />
        {toast}
      </>
    );
  }

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">給料明細</h1>
        <button
          type="button"
          className="text-btn"
          onClick={() => setEditing({ payroll: blankPayroll(newBase(), settings.payday, settings.paydayHolidayShift), isNew: true })}
        >
          追加
        </button>
      </header>
      <main className="content">
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}
        {payrolls === null && !loadError && <p className="muted">読み込んでいます…</p>}
        {payrolls !== null && active.length === 0 && (
          <section className="card">
            <p>給料明細のひな形はまだありません。右上の「追加」で、支給・控除・天引きで払う後払いの行を組みます。毎月の明細は、ひな形から金額だけ直して入れます。</p>
          </section>
        )}
        {active.length > 0 && (
          <section className="card list-card">
            <ul className="list">
              {active.map((p) => {
                const forecast = payrollForecast(p, today.slice(0, 7));
                return (
                  <li key={p.id}>
                    <button type="button" className="list-row" onClick={() => setEditing({ payroll: p, isNew: false })}>
                      <span className="list-main">
                        <span className="list-name">{p.name}</span>
                        <span className="list-sub">
                          入金：{accounts.find((a) => a.id === p.accountId)?.name ?? "資産不明"}・{dayText(p.day)}
                        </span>
                        <span className="list-sub">手取りの見込み（前回の金額） {formatYen(forecast.takeHome)}</span>
                      </span>
                      <Icon name="chevron-right" size={18} />
                    </button>
                    <div className="payroll-add">
                      <button type="button" className="secondary-btn" onClick={() => onEnterMonth(p.id)}>
                        この月を入れる
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <p className="muted small">給料明細は自動では作りません。明細が届いたら「この月を入れる」で、金額を直して保存します。</p>
      </main>
    </>
  );
}

interface EditorProps {
  payroll: Payroll;
  isNew: boolean;
  accounts: Account[];
  categories: Category[];
  showToast: (text: string) => void;
  onBack: () => void;
  onDone: (message: string) => void;
}

type Panel = { type: "account" } | { type: "line"; lineId: Id } | null;
type Sheet = null | "day" | "shift" | "delete" | "discard";

function PayrollEditor({ payroll: initial, isNew, accounts, categories, showToast, onBack, onDone }: EditorProps) {
  const [p, setP] = useState<Payroll>(initial);
  const [panel, setPanel] = useState<Panel>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [saving, setSaving] = useState(false);
  const [initialJson] = useState(() => JSON.stringify(initial));
  const dirty = JSON.stringify(p) !== initialJson;
  /** はじめて開いたときだけ出す短い説明（「わかった」で閉じて、二度と出さない。localStorage が使えなくても動く） */
  const [intro, setIntro] = useState(() => readPref(PREF_PAYROLL_INTRO) !== "1");

  const patchLine = (lineId: Id, patch: Partial<PayrollLine>) => setP((cur) => ({ ...cur, lines: cur.lines.map((l) => (l.lineId === lineId ? ({ ...l, ...patch } as PayrollLine) : l)) }));

  const addLine = (kind: PayrollLine["kind"]) => {
    const line = blankLine(kind, newId());
    setP((cur) => ({ ...cur, lines: [...cur.lines, line] }));
    setPanel({ type: "line", lineId: line.lineId });
  };

  const move = (lineId: Id, direction: "up" | "down") => {
    const next = moveLine(p.lines, lineId, direction);
    if (next) setP({ ...p, lines: next });
  };

  const accountName = (id: Id) => accounts.find((a) => a.id === id)?.name ?? "";
  const targetName = (l: PayrollLine) => {
    if (l.kind === "settlement") return accountName(l.accountId);
    const n = categoryNames(categories, l.categoryId || null);
    return n ? (n.child ? `${n.parent}＞${n.child}` : n.parent) : "";
  };

  const save = async () => {
    if (saving) return;
    const problem = validatePayroll(p);
    if (problem) {
      showToast(problem);
      return;
    }
    // ひな形の金額を直した行は、前回の金額（次の月の初期値）を捨てて、直した金額を使う
    const lastAmounts: Record<string, number> = {};
    for (const l of p.lines) {
      const before = initial.lines.find((x) => x.lineId === l.lineId);
      const last = p.lastAmounts?.[l.lineId];
      if (last !== undefined && before && before.amount === l.amount) lastAmounts[l.lineId] = last;
    }
    const record: Payroll = { ...p, name: p.name.trim(), lines: p.lines.map((l) => ({ ...l, label: l.label.trim() })) };
    if (Object.keys(lastAmounts).length > 0) record.lastAmounts = lastAmounts;
    else delete record.lastAmounts;
    setSaving(true);
    try {
      await saveRecord("payrolls", record);
      onDone(isNew ? "給料明細のひな形を追加しました" : "給料明細のひな形を保存しました");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存できませんでした");
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await softDelete("payrolls", p.id);
      onDone("給料明細のひな形を削除しました（入れ済みの明細は残っています）");
    } catch (e) {
      setSheet(null);
      setSaving(false);
      showToast(e instanceof Error ? e.message : "削除できませんでした");
    }
  };

  const totals = payrollTotals(p.lines);
  const panelLine = panel?.type === "line" ? p.lines.find((l) => l.lineId === panel.lineId) : undefined;

  return (
    <div className="payroll-screen">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={() => (dirty ? setSheet("discard") : onBack())}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{isNew ? "給料明細のひな形を追加" : "給料明細のひな形"}</h1>
        {!isNew && <KebabMenu items={[{ label: "削除", onSelect: () => setSheet("delete"), danger: true }]} />}
      </header>
      <main className="payroll-body">
        {intro && (
          <section className="card payroll-intro" aria-label="給料明細の説明">
            <ul className="intro-list">
              <li>
                <strong>支給</strong>＝もらう額（基本給・手当など）
              </li>
              <li>
                <strong>控除</strong>＝税金・保険など、引かれる額
              </li>
              <li>
                <strong>天引きで払う後払い</strong>＝社員証など、給料から引かれて払う分
              </li>
            </ul>
            <p className="field-hint">支給 − 控除 − 天引きで払う後払い ＝ 手取り。手取りは画面の下に出ます。</p>
            <p className="field-hint">賞与は、別のひな形（例：賞与）を作って、入ったときに入れます。先の見込みは見通しの「予定収入」へ。</p>
            <div className="actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  writePref(PREF_PAYROLL_INTRO, "1");
                  setIntro(false);
                }}
              >
                わかった
              </button>
            </div>
          </section>
        )}
        <section className="card form">
          <label className="field">
            <span className="field-label">名前（明細の内容に入ります。例：テスト商事）</span>
            <input className="text-input" type="text" autoComplete="off" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          </label>
          <div className="field">
            <span className="field-label">入金する資産</span>
            <button type="button" className="select-btn" onClick={() => setPanel({ type: "account" })}>
              <span>{accountName(p.accountId) || <span className="entry-ph">選んでください</span>}</span>
              <Icon name="chevron-right" size={18} />
            </button>
          </div>
          <div className="field">
            <span className="field-label">支給日</span>
            <button type="button" className="select-btn" onClick={() => setSheet("day")}>
              <span>{dayText(p.day)}</span>
              <Icon name="chevron-right" size={18} />
            </button>
          </div>
          <div className="field">
            <span className="field-label">休日なら</span>
            <button type="button" className="select-btn" onClick={() => setSheet("shift")}>
              <span>{SHIFT_LABELS[p.holidayShift]}</span>
              <Icon name="chevron-right" size={18} />
            </button>
          </div>
        </section>

        {PAYROLL_KINDS.map((kind) => {
          const lines = p.lines.filter((l) => l.kind === kind);
          return (
            <section key={kind} className="card list-card payroll-section">
              <h2>{kind === "settlement" ? "天引きで払う後払いの行（社員証など）" : `${PAYROLL_KIND_LABELS[kind]}の行`}</h2>
              {kind === "settlement" && <p className="field-hint list-intro">{SETTLEMENT_NOTE}</p>}
              {lines.length > 0 && (
                <ul className="list">
                  {lines.map((l) => (
                    <PayrollLineRow
                      key={l.lineId}
                      kind={l.kind}
                      targetName={targetName(l)}
                      label={l.label}
                      amount={l.amount}
                      extra={
                        l.kind === "settlement" ? undefined : (
                          <label className="check-row small">
                            <input type="checkbox" checked={l.variable === true} onChange={(e) => patchLine(l.lineId, { variable: e.target.checked ? true : undefined })} />
                            <span>毎月変わる（残業代・休日出勤など。見通しの手取りから除く）</span>
                          </label>
                        )
                      }
                      trailing={
                        <span className="move-btns">
                          <button type="button" className="icon-btn small" aria-label="上へ" disabled={moveLine(p.lines, l.lineId, "up") === null} onClick={() => move(l.lineId, "up")}>
                            <Icon name="arrow-up" size={18} />
                          </button>
                          <button type="button" className="icon-btn small" aria-label="下へ" disabled={moveLine(p.lines, l.lineId, "down") === null} onClick={() => move(l.lineId, "down")}>
                            <Icon name="arrow-down" size={18} />
                          </button>
                          <button type="button" className="icon-btn small" aria-label="この行を消す" onClick={() => setP({ ...p, lines: p.lines.filter((x) => x.lineId !== l.lineId) })}>
                            <Icon name="trash" size={18} />
                          </button>
                        </span>
                      }
                      onPickTarget={() => setPanel({ type: "line", lineId: l.lineId })}
                      onLabel={(label) => patchLine(l.lineId, { label })}
                      onAmount={(amount) => patchLine(l.lineId, { amount })}
                    />
                  ))}
                </ul>
              )}
              <div className="payroll-add">
                <button type="button" className="text-btn" onClick={() => addLine(kind)}>
                  {addLineLabel(kind)}
                </button>
              </div>
            </section>
          );
        })}
      </main>

      {panel?.type === "account" && (
        <AccountPanel
          title="入金する資産"
          accounts={selectableAccounts(accounts, p.accountId || null)}
          selectedId={p.accountId || null}
          lastUsedId={null}
          onSelect={(id) => {
            setP({ ...p, accountId: id });
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.type === "line" && panelLine && (
        <TargetPanel
          kind={panelLine.kind}
          currentId={(panelLine.kind === "settlement" ? panelLine.accountId : panelLine.categoryId) || null}
          accounts={accounts}
          categories={categories}
          payAccountId={p.accountId || null}
          onPick={(id) => {
            patchLine(panelLine.lineId, panelLine.kind === "settlement" ? { accountId: id } : { categoryId: id });
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === null && (
        <>
          <TakeHome totals={totals} />
          <footer className="entry-footer">
            <button type="button" className="primary-btn save-btn" disabled={saving} onClick={() => void save()}>
              保存
            </button>
          </footer>
        </>
      )}

      {sheet === "day" && (
        <NumberSheet
          title="支給日"
          description="1〜31日。31日にすると、短い月は月末になります"
          kind="days"
          value={p.day}
          validate={(n) => (n !== null && Number.isInteger(n) && n >= 1 && n <= 31 ? null : "支給日は1〜31日で入れてください")}
          onSave={(n) => setP({ ...p, day: n })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "shift" && (
        <ChoiceSheet<HolidayShift> title="休日なら" options={SHIFT_OPTIONS} value={p.holidayShift} onSelect={(v) => setP({ ...p, holidayShift: v })} onClose={() => setSheet(null)} />
      )}
      {sheet === "delete" && (
        <ConfirmSheet
          title="このひな形を削除しますか"
          message="入れ済みの給料明細（収入・支出・振替）は残ります。"
          confirmLabel="削除する"
          danger
          busy={saving}
          onConfirm={() => void remove()}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "discard" && (
        <ConfirmSheet title="変更を捨てますか" message="ここまでの変更は保存されません。" confirmLabel="捨てる" danger onConfirm={onBack} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}
