import { useEffect, useMemo, useRef, useState } from "react";
import { computeBalances } from "./accountLogic";
import { BottomSheet } from "./BottomSheet";
import { nextCardPayment } from "./businessDay";
import {
  columnsReady,
  csvTotal,
  decodeCsvBytes,
  detectColumns,
  expenseFromRow,
  findHeaderRow,
  matchStatement,
  matchedTxIds,
  parseCsv,
  readRows,
  splitLeftoverTxs,
} from "./csvImport";
import type { ColumnMap, CsvRow, MatchResult } from "./csvImport";
import { formatMonthDayWeekday, isLocalDate } from "./dateUtils";
import type { EntryMode } from "./EntryView";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import {
  checkConfirm,
  checkedTotal,
  describeReconcileDiff,
  findCardTransferInMonth,
  paymentAccountOf,
  planConfirm,
  reconcileDiff,
  unpaidEffect,
  unreconciledOf,
} from "./reconcileLogic";
import { getAccountTransactions, newBase, saveStores } from "./storage";
import { noteTransactionChanged } from "./suggestStore";
import type { ShowToast } from "./Toast";
import { unpaidAmount } from "./transferLogic";
import type { Account, Transaction } from "./types";
import { YenInput } from "./YenInput";

interface Props {
  card: Account;
  accounts: Account[];
  today: string;
  /** 保存・削除などで増える。変わったら読み直す */
  version: number;
  showToast: ShowToast;
  onBack: () => void;
  /** 明細を直す（入力画面で編集） */
  onEditTx: (tx: Transaction) => void;
  /** 「支出として入れる」：内容・金額・日付が入った入力画面を開く */
  onOpenEntry: (mode: EntryMode) => void;
  onChanged: () => void;
}

interface RawCsv {
  fileName: string;
  rows: string[][];
  headerRow: number;
}
interface LoadedCsv {
  fileName: string;
  rows: CsvRow[];
  skipped: number;
}

function dateWithYear(d: string): string {
  return `${d.slice(0, 4)}/${formatMonthDayWeekday(d)}`;
}

function signed(n: number): string {
  return n < 0 ? `−${formatYen(-n)}` : formatYen(n);
}

/** カードの照合：請求額と、照合していない明細のチェックを合わせる。確定で引き落としの振替を作れる */
export function ReconcileView({ card, accounts, today, version, showToast, onBack, onEditTx, onOpenEntry, onChanged }: Props) {
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => (card.card ? nextCardPayment(card.card, today) : today));
  const [requested, setRequested] = useState<number | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [adjustDiff, setAdjustDiff] = useState(false);
  const [csv, setCsv] = useState<LoadedCsv | null>(null);
  const [mapping, setMapping] = useState<{ raw: RawCsv; map: ColumnMap } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [debitChoice, setDebitChoice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getAccountTransactions(card.id)
      .then((t) => {
        if (cancelled) return;
        setTxs(t);
        setLoadError("");
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "明細を読み込めませんでした"));
    return () => {
      cancelled = true;
    };
  }, [card.id, version]);

  const unreconciled = useMemo(() => (txs ? unreconciledOf(card.id, txs) : []), [card.id, txs]);
  const checkedTxs = useMemo(() => unreconciled.filter((t) => checked.has(t.id)), [unreconciled, checked]);
  const balance = useMemo(() => (txs ? (computeBalances([card], txs).get(card.id) ?? 0) : 0), [card, txs]);
  const match: MatchResult | null = useMemo(() => (csv ? matchStatement(csv.rows, unreconciled) : null), [csv, unreconciled]);
  const leftover = useMemo(() => (csv && match ? splitLeftoverTxs(csv.rows, match.leftoverTxs) : null), [csv, match]);
  const matchedIds = useMemo(() => new Set(match ? matchedTxIds(match) : []), [match]);
  // 明細を直す・足すなどで新しく合ったものは、チェックに足す（外したものを勝手に戻さないよう、前に合っていたものは数えない）
  const seenMatched = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = [...matchedIds].filter((id) => !seenMatched.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seenMatched.current.add(id);
    setChecked((prev) => new Set([...prev, ...fresh]));
  }, [matchedIds]);
  const existingTransfer = useMemo(() => (txs && isLocalDate(paymentDate) ? findCardTransferInMonth(card.id, paymentDate, txs) : undefined), [txs, paymentDate, card.id]);
  const payAcc = paymentAccountOf(card, accounts);
  const createDebit = (debitChoice ?? !existingTransfer) && payAcc !== null;

  const diff = requested !== null ? reconcileDiff(requested, checkedTxs) : null;
  const total = checkedTotal(checkedTxs);
  const confirmCheck = checkConfirm({ requested: requested ?? 0, checked: checkedTxs, adjustDiff, createDebit, paymentAccountId: payAcc?.id ?? null });
  const canConfirm = confirmCheck.ok && isLocalDate(paymentDate) && !busy;

  const toggle = (id: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAdjustDiff(false);
  };

  const applyCsv = (loaded: LoadedCsv) => {
    setCsv(loaded);
    const m = matchStatement(loaded.rows, unreconciled);
    seenMatched.current = new Set(matchedTxIds(m));
    setChecked(new Set(matchedTxIds(m)));
    const sum = csvTotal(loaded.rows);
    if (sum > 0) setRequested(sum);
    setAdjustDiff(false);
    showToast(`ファイルの${loaded.rows.length}行を読みました`);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
      const rows = parseCsv(text);
      if (rows.length === 0) {
        showToast("ファイルに行がありませんでした");
        return;
      }
      const headerRow = findHeaderRow(rows);
      const map = detectColumns(rows[headerRow]);
      const raw: RawCsv = { fileName: file.name, rows, headerRow };
      if (!columnsReady(map)) {
        setMapping({ raw, map });
        return;
      }
      const parsed = readRows(rows, headerRow, map);
      applyCsv({ fileName: file.name, rows: parsed.rows, skipped: parsed.skipped });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "ファイルを読めませんでした");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const confirm = async () => {
    if (!card || !canConfirm || requested === null) return;
    setBusy(true);
    try {
      const plan = planConfirm({ card, paymentDate, requested, checked: checkedTxs, adjustDiff, createDebit, paymentAccountId: payAcc?.id ?? null, makeBase: () => newBase() });
      const written = [...plan.reconciled, ...(plan.adjustment ? [plan.adjustment] : []), ...(plan.transfer ? [plan.transfer] : [])];
      await saveStores({ transactions: written, cardStatements: [plan.statement] });
      for (const t of written) noteTransactionChanged(t);
      showToast(plan.transfer ? "照合を確定して、引き落としを記録しました" : "照合を確定しました");
      setConfirming(false);
      onChanged();
      onBack();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "確定できませんでした（何も保存していません）");
    } finally {
      setBusy(false);
    }
  };

  const openFromRow = (row: CsvRow) => {
    onOpenEntry({
      kind: "new",
      date: row.date,
      type: row.amount < 0 ? "income" : "expense",
      prefill: { content: row.shop, amount: expenseFromRow(row).amount, accountId: card.id },
    });
  };

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{card.name}の照合</h1>
      </header>
      <main className="content recon-content">
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}

        <section className="card recon-form">
          <div className="field">
            <label className="field-label" htmlFor="recon-date">
              請求の日付（初期値：次の引き落とし日）
            </label>
            <input id="recon-date" className="text-input" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">請求額（明細の金額）</span>
            <YenInput value={requested} onChange={(v) => { setRequested(v); setAdjustDiff(false); }} ariaLabel="請求額" />
          </div>
          <p className="list-sub">アプリが把握している未払い額：{formatYen(unpaidAmount(balance))}</p>
          <div className="actions">
            <button type="button" className="secondary-btn" onClick={() => fileInput.current?.click()}>
              <Icon name="upload" size={18} />
              明細のファイルから
            </button>
            <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(e) => void handleFile(e.target.files?.[0])} />
          </div>
          <p className="field-hint">楽天e-NAVIなどの明細CSVを選ぶと、金額と日付（±3日）で自動でチェックします。ファイルはアプリに保存しません。</p>
          <p className="field-hint">請求には、利用日から2〜3か月遅れて載るものがあります。アプリ側だけにある明細は、次の請求に載ることがあります。</p>
        </section>

        {csv && match && (
          <section className="card recon-csv" aria-label="ファイルとの照合の結果">
            <h2>ファイルとの照合</h2>
            <p className="list-sub">
              {csv.fileName}・{csv.rows.length}行・合計 {signed(csvTotal(csv.rows))}
              {csv.skipped > 0 ? `・読めなかった行 ${csv.skipped}` : ""}
            </p>
            <dl className="rows">
              <div className="row">
                <dt>1対1で合ったもの</dt>
                <dd>{match.pairs.length}件</dd>
              </div>
              <div className="row">
                <dt>まとめて入れたもの（複数行＝1件）</dt>
                <dd>{match.bundles.length}件</dd>
              </div>
              <div className="row">
                <dt>分けて入れたもの（1行＝複数件）</dt>
                <dd>{match.splits.length}件</dd>
              </div>
            </dl>
            {match.bundles.map((b) => (
              <p key={b.tx.id} className="list-sub wrap">
                まとめ：{b.rows.map((r) => `${r.shop || "（店名なし）"} ${signed(r.amount)}`).join("、")} ＝ {b.tx.content || "（内容なし）"} {signed(unpaidEffect(b.tx))}
              </p>
            ))}
            {match.splits.map((s) => (
              <p key={s.row.index} className="list-sub wrap">
                分け：{s.row.shop || "（店名なし）"} {signed(s.row.amount)} ＝ {s.txs.map((t) => `${t.content || "（内容なし）"} ${signed(unpaidEffect(t))}`).join("、")}
              </p>
            ))}
            <h3>合わなかったもの</h3>
            {match.leftoverRows.length === 0 && (leftover?.within.length ?? 0) === 0 ? (
              <p className="list-sub">すべて合いました。</p>
            ) : (
              <>
                {match.leftoverRows.length > 0 && (
                  <>
                    <p className="list-sub">ファイルだけにある行（入力漏れかもしれません）</p>
                    <ul className="list">
                      {match.leftoverRows.map((r) => (
                        <li key={r.index} className="list-row static recon-left">
                          <span className="list-main">
                            <span className="list-name">{r.shop || "（店名なし）"}</span>
                            <span className="list-sub">{formatMonthDayWeekday(r.date)}</span>
                          </span>
                          <span className="list-amount">{signed(r.amount)}</span>
                          <button type="button" className="text-btn" onClick={() => openFromRow(r)}>
                            {r.amount < 0 ? "収入として入れる" : "支出として入れる"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {leftover && leftover.within.length > 0 && (
                  <>
                    <p className="list-sub">アプリだけにある明細（請求に載っていない候補）</p>
                    <ul className="list">
                      {leftover.within.slice(0, 50).map((t) => (
                        <li key={t.id} className="list-row static">
                          <span className="list-main">
                            <span className="list-name">{t.content || "（内容なし）"}</span>
                            <span className="list-sub">{dateWithYear(t.date)}</span>
                          </span>
                          <span className="list-amount">{signed(unpaidEffect(t))}</span>
                        </li>
                      ))}
                    </ul>
                    {leftover.within.length > 50 && <p className="field-hint">ほか{leftover.within.length - 50}件</p>}
                  </>
                )}
                {leftover && (leftover.before.length > 0 || leftover.after.length > 0) && (
                  <p className="list-sub wrap">
                    ファイルの期間の外にある、照合していない明細：{leftover.before.length > 0 ? `前 ${leftover.before.length}件（前の請求のぶん）` : ""}
                    {leftover.before.length > 0 && leftover.after.length > 0 ? "・" : ""}
                    {leftover.after.length > 0 ? `後 ${leftover.after.length}件（次の請求に載る候補）` : ""}。下の一覧で見られます。
                  </p>
                )}
              </>
            )}
          </section>
        )}

        <section className={`card recon-summary${diff === 0 ? " ok" : ""}`} aria-live="polite" aria-label="請求額との差額">
          <div className="recon-sums">
            <div>
              <p className="band-label">請求額</p>
              <p className="band-value">{requested !== null ? formatYen(requested) : "未入力"}</p>
            </div>
            <div>
              <p className="band-label">チェックした合計（{checkedTxs.length}件）</p>
              <p className="band-value">{formatYen(total)}</p>
            </div>
            <div>
              <p className="band-label">差額</p>
              <p className={`band-value${diff !== null && diff !== 0 ? " expense" : ""}`}>{diff === null ? "—" : diff === 0 ? "0円" : signed(diff)}</p>
            </div>
          </div>
          {diff !== null && <p className="recon-diff-note">{adjustDiff && diff !== 0 ? `差額 ${signed(diff)} は、確定のとき残高修正にします` : describeReconcileDiff(diff)}</p>}
          {diff !== null && diff !== 0 && checkedTxs.length > 0 && (
            <div className="actions">
              <button type="button" className={adjustDiff ? "primary-btn" : "secondary-btn"} aria-pressed={adjustDiff} onClick={() => setAdjustDiff((v) => !v)}>
                {adjustDiff ? "差額を残高修正にする（選択中）" : "差額を残高修正にする"}
              </button>
            </div>
          )}
        </section>

        <section className="card list-card" aria-label="照合していない明細">
          <h2 className="list-head">
            <span>照合していない明細（古い順）</span>
            <span>{unreconciled.length}件</span>
          </h2>
          {txs && unreconciled.length === 0 && <p className="empty-note">照合していない明細はありません</p>}
          <div className="recon-bulk">
            <button type="button" className="text-btn" onClick={() => setChecked(new Set(unreconciled.map((t) => t.id)))}>
              すべてチェック
            </button>
            <button type="button" className="text-btn" onClick={() => { setChecked(new Set()); setAdjustDiff(false); }}>
              すべて外す
            </button>
          </div>
          <ul className="list">
            {unreconciled.map((t) => (
              <li key={t.id} className="recon-item">
                <label className="recon-row">
                  <input type="checkbox" checked={checked.has(t.id)} onChange={() => toggle(t.id)} aria-label={`${t.content || "内容なし"} ${signed(unpaidEffect(t))}をチェック`} />
                  <span className="list-main">
                    <span className="list-name">
                      {t.type === "adjustment" ? "残高修正" : t.content || "（内容なし）"}
                      {t.estimated && <span className="tag-mark estimated">見込み</span>}
                      {t.type === "income" && <span className="tag-mark">返金</span>}
                      {matchedIds.has(t.id) && <span className="tag-mark satisfied">ファイルと一致</span>}
                    </span>
                    <span className="list-sub">
                      {dateWithYear(t.date)}
                      {t.memo ? `・${t.memo}` : ""}
                    </span>
                  </span>
                  <span className={`list-amount${unpaidEffect(t) < 0 ? " income" : ""}`}>{signed(unpaidEffect(t))}</span>
                </label>
                {t.type !== "adjustment" && (
                  <button type="button" className="text-btn recon-fix" onClick={() => onEditTx(t)}>
                    直す
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <div className="actions recon-confirm">
          <button type="button" className="primary-btn wide" disabled={!canConfirm} onClick={() => setConfirming(true)}>
            確定
          </button>
        </div>
        {!confirmCheck.ok && requested !== null && <p className="field-hint center">{confirmCheck.message}</p>}
        <div className="fab-space" aria-hidden="true" />
      </main>

      {confirming && requested !== null && (
        <BottomSheet title="照合を確定する" onClose={() => !busy && setConfirming(false)}>
          <p className="sheet-message">
            請求額 {formatYen(requested)}、明細 {checkedTxs.length}件（請求の日付 {paymentDate}）を照合済みにします。
            {adjustDiff && diff !== 0 && diff !== null ? ` 差額 ${signed(diff)} は残高修正として記録します。` : ""}
          </p>
          {existingTransfer && (
            <p className="notice">
              同じ月にカードへの振替がすでにあります（{formatMonthDayWeekday(existingTransfer.date)} {formatYen(existingTransfer.amount)}）。二重にならないよう、初期値は「作らない」にしています。
            </p>
          )}
          {payAcc ? (
            <label className="check">
              <input type="checkbox" checked={createDebit} onChange={(e) => setDebitChoice(e.target.checked)} />
              引き落としの振替を作る（{payAcc.name} → {card.name}、{paymentDate}、{formatYen(requested)}）
            </label>
          ) : (
            <p className="field-hint">引き落とし口座が見つからないため、振替は作れません。</p>
          )}
          <div className="sheet-actions">
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => setConfirming(false)}>
              やめる
            </button>
            <button type="button" className="primary-btn" disabled={busy} onClick={() => void confirm()}>
              確定する
            </button>
          </div>
        </BottomSheet>
      )}

      {mapping && (
        <BottomSheet title="列を選んでください" onClose={() => setMapping(null)}>
          <p className="sheet-message">見出しから列を見つけられませんでした。どの列が何かを選んでください。</p>
          <div className="form">
            {(
              [
                ["date", "利用日の列"],
                ["shop", "利用店名・内容の列（なくてもよい）"],
                ["amount", "金額の列（支払総額か利用金額）"],
              ] as const
            ).map(([key, label]) => (
              <div className="field" key={key}>
                <label className="field-label" htmlFor={`map-${key}`}>
                  {label}
                </label>
                <select
                  id={`map-${key}`}
                  className="text-input"
                  value={mapping.map[key] ?? ""}
                  onChange={(e) => setMapping({ ...mapping, map: { ...mapping.map, [key]: e.target.value === "" ? null : Number(e.target.value) } })}
                >
                  <option value="">選ばない</option>
                  {mapping.raw.rows[mapping.raw.headerRow].map((h, i) => (
                    <option key={i} value={i}>
                      {i + 1}列目：{h || "（空）"}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="sheet-actions">
            <button type="button" className="secondary-btn" onClick={() => setMapping(null)}>
              やめる
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={!columnsReady(mapping.map)}
              onClick={() => {
                const parsed = readRows(mapping.raw.rows, mapping.raw.headerRow, mapping.map);
                applyCsv({ fileName: mapping.raw.fileName, rows: parsed.rows, skipped: parsed.skipped });
                setMapping(null);
              }}
            >
              この列で読む
            </button>
          </div>
        </BottomSheet>
      )}
    </>
  );
}
