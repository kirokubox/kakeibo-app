import { useEffect, useMemo, useState } from "react";
import { ChoiceSheet } from "./BottomSheet";
import { formatDateJa, isLocalDate, nowIso } from "./dateUtils";
import { categoryNames } from "./entryLogic";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { PayrollLineRow, TakeHome, TargetPanel } from "./PayrollParts";
import {
  PAYROLL_KINDS,
  PAYROLL_KIND_LABELS,
  SETTLEMENT_NOTE,
  batchTransactions,
  entryDraftFromBatch,
  newEntryDraft,
  nextLastAmounts,
  payrollTotals,
  planPayrollSave,
  validateEntryDraft,
} from "./payrollLogic";
import type { PayrollEntryDraft, PayrollEntryLine, PayrollLineKind } from "./payrollLogic";
import { getAll, newBase, newId, saveStores } from "./storage";
import { noteTransactionChanged } from "./suggestStore";
import type { ShowToast } from "./Toast";
import type { Account, Category, Id, Payroll, Transaction } from "./types";

interface Props {
  /** 入れるひな形。null なら、ひな形が1つならそれを、2つ以上なら選ぶ画面を出す */
  payrollId: Id | null;
  /** あとから直すとき：直す1枚の payrollBatchId */
  batchId: Id | null;
  today: string;
  showToast: ShowToast;
  onClose: () => void;
  /** 保存したあと */
  onSaved: (message: string) => void;
}

const KIND_OPTIONS = PAYROLL_KINDS.map((value) => ({ value, label: PAYROLL_KIND_LABELS[value] }));

/** 給料明細を月ごとに入れる／あとから1枚まるごと直す */
export function PayrollEntryView({ payrollId, batchId, today, showToast, onClose, onSaved }: Props) {
  const [payrolls, setPayrolls] = useState<Payroll[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [existing, setExisting] = useState<Transaction[]>([]);
  const [chosenId, setChosenId] = useState<Id | null>(payrollId);
  const [draft, setDraft] = useState<PayrollEntryDraft | null>(null);
  const [panel, setPanel] = useState<{ lineId: Id } | null>(null);
  const [addSheet, setAddSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, a, c] = await Promise.all([getAll("payrolls"), getAll("accounts"), getAll("categories")]);
        const txs = batchId ? batchTransactions(await getAll("transactions"), batchId) : [];
        if (cancelled) return;
        setPayrolls(p);
        setAccounts(a);
        setCategories(c);
        setExisting(txs);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "データを開けませんでした");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  // 直すときは、ひな形が削除済みでも開ける。新しく入れるときは削除済みを除く
  const choices = useMemo(() => (payrolls ?? []).filter((p) => p.deletedAt === null), [payrolls]);
  const payroll = useMemo(() => {
    if (!payrolls) return null;
    if (chosenId) return payrolls.find((p) => p.id === chosenId) ?? null;
    if (!batchId && choices.length === 1) return choices[0];
    if (batchId && existing[0]?.payrollId) return payrolls.find((p) => p.id === existing[0].payrollId) ?? null;
    return null;
  }, [payrolls, chosenId, batchId, choices, existing]);

  // ひな形が決まったら、入力の初期値を作る
  useEffect(() => {
    if (!payroll || draft) return;
    setDraft(batchId ? entryDraftFromBatch(payroll, existing, newId, today) : newEntryDraft(payroll, today));
  }, [payroll, draft, batchId, existing, today]);

  const accountName = (id: Id | null) => accounts.find((a) => a.id === id)?.name ?? "";
  const targetName = (l: PayrollEntryLine) => {
    if (l.kind === "settlement") return accountName(l.accountId);
    const n = categoryNames(categories, l.categoryId);
    return n ? (n.child ? `${n.parent}＞${n.child}` : n.parent) : "";
  };

  const patchLine = (lineId: Id, patch: Partial<PayrollEntryLine>) =>
    setDraft((d) => (d ? { ...d, lines: d.lines.map((l) => (l.lineId === lineId ? { ...l, ...patch } : l)) } : d));

  const addLine = (kind: PayrollLineKind) => {
    const line: PayrollEntryLine = { lineId: newId(), kind, categoryId: null, accountId: null, label: "", amount: 0, enabled: true, extra: true };
    setDraft((d) => (d ? { ...d, lines: [...d.lines, line] } : d));
    setPanel({ lineId: line.lineId });
  };

  const header = (title: string, back: () => void) => (
    <header className="topbar">
      <button type="button" className="icon-btn" aria-label="戻る" onClick={back}>
        <Icon name="chevron-left" size={22} />
      </button>
      <h1 className="topbar-title">{title}</h1>
    </header>
  );

  if (loadError) {
    return (
      <div className="payroll-screen">
        {header("給料明細", onClose)}
        <main className="payroll-body">
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        </main>
      </div>
    );
  }
  if (payrolls === null) {
    return (
      <div className="payroll-screen">
        {header("給料明細", onClose)}
        <main className="payroll-body">
          <p className="muted">読み込んでいます…</p>
        </main>
      </div>
    );
  }

  // 選ぶ画面（ひな形が2つ以上）／ひな形がない
  if (!payroll) {
    return (
      <div className="payroll-screen">
        {header("給料明細を入れる", onClose)}
        <main className="payroll-body">
          {batchId ? (
            <p className="notice danger" role="alert">
              この給料明細のひな形が見つかりません。1件ずつ直してください。
            </p>
          ) : choices.length === 0 ? (
            <section className="card">
              <p>給料明細のひな形がまだありません。設定の「給料明細」から作ってください。</p>
            </section>
          ) : (
            <section className="card list-card">
              <h2 className="list-head">
                <span>どの給料明細を入れますか</span>
              </h2>
              <ul className="list">
                {choices.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="list-row" onClick={() => setChosenId(p.id)}>
                      <span className="list-main">
                        <span className="list-name">{p.name}</span>
                        <span className="list-sub">入金：{accounts.find((a) => a.id === p.accountId)?.name ?? "資産不明"}</span>
                      </span>
                      <Icon name="chevron-right" size={18} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
      </div>
    );
  }

  if (!draft) return null;
  const totals = payrollTotals(draft.lines);
  const panelLine = panel ? draft.lines.find((l) => l.lineId === panel.lineId) : undefined;

  const save = async () => {
    if (saving) return;
    const problem = validateEntryDraft(draft);
    if (problem) {
      showToast(problem);
      return;
    }
    const plan = planPayrollSave({
      payroll,
      draft,
      batchId: batchId ?? newId(),
      categories,
      existing,
      now: nowIso(),
      makeBase: () => newBase(),
    });
    const changed = [...plan.creates, ...plan.updates, ...plan.deletes];
    if (changed.length === 0) {
      showToast("金額が入った行がありません");
      return;
    }
    setSaving(true);
    try {
      await saveStores({
        transactions: changed,
        payrolls: draft.saveToTemplate ? [{ ...payroll, lastAmounts: nextLastAmounts(payroll, draft) }] : [],
      });
      for (const t of changed) noteTransactionChanged(t);
      const n = plan.creates.length + plan.updates.length;
      onSaved(batchId ? `給料明細を直しました（明細${n}件${plan.deletes.length ? `、削除${plan.deletes.length}件` : ""}）` : `給料明細を入れました（明細${n}件）`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存できませんでした");
      setSaving(false);
    }
  };

  const sections = PAYROLL_KINDS.map((kind) => ({ kind, lines: draft.lines.filter((l) => l.kind === kind) }));

  return (
    <div className="payroll-screen">
      {header(batchId ? "給料明細を直す" : "給料明細を入れる", onClose)}
      <main className="payroll-body">
        <section className="card">
          <p className="list-name">{payroll.name}</p>
          <p className="list-sub">入金：{accountName(payroll.accountId) || "資産不明"}</p>
          <label className="field" style={{ marginTop: "var(--kb-space-3)" }}>
            <span className="field-label">日付（{isLocalDate(draft.date) ? formatDateJa(draft.date) : draft.date}）</span>
            <input
              type="date"
              className="date-input"
              value={draft.date}
              onChange={(e) => isLocalDate(e.target.value) && setDraft({ ...draft, date: e.target.value })}
            />
          </label>
        </section>

        {sections.map(({ kind, lines }) => (
          <section key={kind} className="card list-card payroll-section">
            <h2>{PAYROLL_KIND_LABELS[kind]}</h2>
            {kind === "settlement" && <p className="field-hint list-intro">{SETTLEMENT_NOTE}</p>}
            {lines.length === 0 ? (
              <p className="muted small" style={{ padding: "0 var(--kb-space-4)" }}>
                行はありません
              </p>
            ) : (
              <ul className="list">
                {lines.map((l) => (
                  <PayrollLineRow
                    key={l.lineId}
                    kind={l.kind}
                    targetName={targetName(l)}
                    label={l.label}
                    amount={l.amount}
                    dim={!l.enabled}
                    disabled={!l.enabled}
                    leading={
                      <input
                        type="checkbox"
                        className="line-check"
                        aria-label={`${l.label || PAYROLL_KIND_LABELS[l.kind]}を入れる`}
                        checked={l.enabled}
                        onChange={(e) => patchLine(l.lineId, { enabled: e.target.checked })}
                      />
                    }
                    trailing={
                      l.extra ? (
                        <button
                          type="button"
                          className="icon-btn small"
                          aria-label="この行を消す"
                          onClick={() => setDraft({ ...draft, lines: draft.lines.filter((x) => x.lineId !== l.lineId) })}
                        >
                          <Icon name="trash" size={18} />
                        </button>
                      ) : undefined
                    }
                    onPickTarget={() => setPanel({ lineId: l.lineId })}
                    onLabel={(label) => patchLine(l.lineId, { label })}
                    onAmount={(amount) => patchLine(l.lineId, { amount })}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
        <div className="payroll-add">
          <button type="button" className="text-btn" onClick={() => setAddSheet(true)}>
            ＋ 行を追加（この月だけ）
          </button>
        </div>
        {!batchId && (
          <label className="check">
            <input type="checkbox" checked={draft.saveToTemplate} onChange={(e) => setDraft({ ...draft, saveToTemplate: e.target.checked })} />
            今回の金額をひな形に残す（次の月の初期値）
          </label>
        )}
        <p className="field-hint">チェックを外した行と、金額が0円の行は、明細を作りません。{batchId ? "行を消す・チェックを外すと、対応する明細は削除されます。" : ""}</p>
      </main>

      {panel && panelLine ? (
        <TargetPanel
          kind={panelLine.kind}
          currentId={panelLine.kind === "settlement" ? panelLine.accountId : panelLine.categoryId}
          accounts={accounts}
          categories={categories}
          payAccountId={payroll.accountId}
          onPick={(id) => {
            patchLine(panelLine.lineId, panelLine.kind === "settlement" ? { accountId: id } : { categoryId: id });
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      ) : (
        <>
          <TakeHome totals={totals} />
          <footer className="entry-footer">
            <button type="button" className="secondary-btn" onClick={onClose}>
              やめる
            </button>
            <button type="button" className="primary-btn save-btn" disabled={saving} onClick={() => void save()}>
              保存（手取り {formatYen(totals.takeHome)}）
            </button>
          </footer>
        </>
      )}

      {addSheet && <ChoiceSheet title="追加する行" options={KIND_OPTIONS} value={null} onSelect={addLine} onClose={() => setAddSheet(false)} />}
    </div>
  );
}
