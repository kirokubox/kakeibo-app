import { useEffect, useMemo, useState } from "react";
import { ConfirmSheet } from "./BottomSheet";
import { formatMonthDayWeekday } from "./dateUtils";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { planUndo, statementHistory, statementItems } from "./reconcileLogic";
import { getAccountTransactions, getAll, saveStores } from "./storage";
import { noteTransactionChanged } from "./suggestStore";
import type { ShowToast } from "./Toast";
import { TxRow } from "./TxRow";
import type { Account, CardStatement, Category, Transaction } from "./types";

interface Props {
  card: Account;
  accounts: Account[];
  version: number;
  showToast: ShowToast;
  onBack: () => void;
  onEditTx: (tx: Transaction) => void;
  onChanged: () => void;
}

/** 照合の履歴：カードごとの照合（請求）の一覧。押すとその回の明細。照合を取り消せる（振替は残す） */
export function StatementHistoryView({ card, accounts, version, showToast, onBack, onEditTx, onChanged }: Props) {
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [statements, setStatements] = useState<CardStatement[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAccountTransactions(card.id), getAll("cardStatements"), getAll("categories")])
      .then(([t, s, c]) => {
        if (cancelled) return;
        setTxs(t);
        setStatements(s);
        setCategories(c);
        setLoadError("");
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "読み込めませんでした"));
    return () => {
      cancelled = true;
    };
  }, [card.id, version]);

  const history = useMemo(() => statementHistory(card.id, statements), [card.id, statements]);
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const open = history.find((s) => s.id === openId);
  const items = open && txs ? statementItems(open.id, txs) : [];

  const undo = async () => {
    if (!open || !txs) return;
    setBusy(true);
    try {
      const plan = planUndo(open, txs);
      await saveStores({ transactions: plan.released, cardStatements: [plan.statement] });
      for (const t of plan.released) noteTransactionChanged(t);
      showToast("照合を取り消しました。引き落としの振替は残しています");
      setUndoing(false);
      setOpenId(null);
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "取り消せませんでした（何も変えていません）");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={() => (open ? setOpenId(null) : onBack())}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{open ? `${open.paymentDate} の照合` : `${card.name}の照合の履歴`}</h1>
      </header>
      <main className="content">
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}
        {!open && txs && history.length === 0 && (
          <section className="card">
            <p>照合の履歴はまだありません。</p>
          </section>
        )}
        {!open && history.length > 0 && (
          <section className="card list-card">
            <ul className="list">
              {history.map((s) => (
                <li key={s.id}>
                  <button type="button" className="list-row" onClick={() => setOpenId(s.id)}>
                    <span className="list-main">
                      <span className="list-name">{s.paymentDate}</span>
                      <span className="list-sub">
                        明細 {(txs ? statementItems(s.id, txs) : []).length}件・差額 {s.diff === 0 ? "なし" : `${s.diff > 0 ? "＋" : "−"}${formatYen(Math.abs(s.diff))}`}
                      </span>
                    </span>
                    <span className="list-amount">{formatYen(s.actualAmount)}</span>
                    <Icon name="chevron-right" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {open && (
          <>
            <section className="card summary">
              <p className="summary-label">請求額</p>
              <p className="summary-main">{formatYen(open.actualAmount)}</p>
              <p className="list-sub">
                請求の日付 {open.paymentDate}（{formatMonthDayWeekday(open.paymentDate)}）・差額 {open.diff === 0 ? "なし" : `${open.diff > 0 ? "＋" : "−"}${formatYen(Math.abs(open.diff))}`}
              </p>
            </section>
            <section className="card list-card">
              <h2 className="list-head">
                <span>この回に照合した明細</span>
                <span>{items.length}件</span>
              </h2>
              <ul className="list">
                {items.map((t) => (
                  <li key={t.id}>
                    <TxRow tx={t} accountNames={accountNames} categories={categories} onSelect={onEditTx} />
                  </li>
                ))}
              </ul>
            </section>
            <div className="actions">
              <button type="button" className="danger-btn" onClick={() => setUndoing(true)}>
                この照合を取り消す
              </button>
            </div>
            <p className="field-hint">取り消すと、明細は「照合していない」に戻ります。引き落としの振替と、差額の残高修正は残ります（必要なら明細から消してください）。</p>
          </>
        )}
      </main>
      {undoing && open && (
        <ConfirmSheet
          title="照合を取り消す"
          message={`${open.paymentDate} の照合（請求額 ${formatYen(open.actualAmount)}）を取り消して、明細${items.length}件を照合していない状態に戻します。引き落としの振替は残します。`}
          confirmLabel="取り消す"
          danger
          busy={busy}
          onConfirm={() => void undo()}
          onClose={() => setUndoing(false)}
        />
      )}
    </>
  );
}
