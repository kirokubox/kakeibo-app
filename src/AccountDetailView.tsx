import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdjustSheet } from "./AdjustSheet";
import type { AdjustMode } from "./AdjustSheet";
import { cardNote, nextDebitText } from "./accountLogic";
import { initialMonthCount, monthBlocks, runningBalances } from "./adjustLogic";
import { DayGroup } from "./DayGroup";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { formatYen } from "./money";
import { groupByDay, monthTitle } from "./periodLogic";
import { getAccountTransactions, getAll } from "./storage";
import type { ShowToast } from "./Toast";
import { unpaidAmount } from "./transferLogic";
import type { Account, Category, Transaction } from "./types";

interface Props {
  account: Account;
  accounts: Account[];
  /** 今の残高（資産タブで計算したもの） */
  balance: number;
  today: string;
  /** 保存・削除などで増える。変わったら読み直す */
  version: number;
  showToast: ShowToast;
  onBack: () => void;
  /** 明細の行を押した（収入・支出・振替は入力画面で編集） */
  onEditTx: (tx: Transaction) => void;
  onEditAccount: () => void;
  /** カードの「引き落としを記録」 */
  onRecordDebit: () => void;
  /** 残高修正を保存・削除したあと */
  onChanged: () => void;
}

/** 資産の明細：その資産の残高と、その資産が出てくる明細を月ごとに新しい順で */
export function AccountDetailView({ account, accounts, balance, today, version, showToast, onBack, onEditTx, onEditAccount, onRecordDebit, onChanged }: Props) {
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadError, setLoadError] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  const [adjust, setAdjust] = useState<AdjustMode | null>(null);
  const [tick, setTick] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const isCard = account.group === "card";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, c] = await Promise.all([getAccountTransactions(account.id), getAll("categories")]);
        if (cancelled) return;
        setTxs(t);
        setCategories(c);
        setLoadError("");
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "明細を読み込めませんでした");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.id, version, tick]);

  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const blocks = useMemo(() => (txs ? monthBlocks(account.id, txs) : []), [account.id, txs]);
  const balances = useMemo(() => (txs ? runningBalances(account, txs) : new Map<string, number>()), [account, txs]);
  const count = shown ?? initialMonthCount(blocks, today.slice(0, 7));
  const visible = blocks.slice(0, count);
  const hasMore = count < blocks.length;

  const more = useCallback(() => setShown((n) => Math.min(blocks.length, (n ?? initialMonthCount(blocks, today.slice(0, 7))) + 1)), [blocks, today]);

  // 下までスクロールしたら、次の月を読み込む
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, more, count]);

  const select = (tx: Transaction) => {
    if (tx.type === "adjustment") setAdjust({ kind: "edit", tx });
    else onEditTx(tx);
  };

  const note = cardNote(account, accounts);
  const unpaid = unpaidAmount(balance);

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{account.name}</h1>
        <KebabMenu items={[{ label: "編集", onSelect: onEditAccount }]} />
      </header>
      <main className="content">
        <section className="card summary account-head" aria-label="残高">
          <p className="summary-label">{isCard ? "残高" : "今の残高"}</p>
          <p className={`summary-main${balance < 0 ? " neg" : ""}`}>{formatYen(balance)}</p>
          {isCard && <p className="account-unpaid">未払い {formatYen(unpaid)}</p>}
          {note && <p className="list-sub">{note}</p>}
          {isCard && nextDebitText(account, today) && <p className="list-sub">{nextDebitText(account, today)}</p>}
          {isCard && <p className="field-hint">請求額は、利用日から2〜3か月遅れて載るものがあります。照合は段階8で作ります。</p>}
          <div className="actions">
            <button type="button" className="secondary-btn" onClick={() => setAdjust({ kind: "new" })}>
              残高を合わせる
            </button>
            {isCard && (
              <button type="button" className="primary-btn" onClick={onRecordDebit}>
                引き落としを記録
              </button>
            )}
          </div>
        </section>
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}
        {txs !== null && blocks.length === 0 && (
          <section className="card">
            <p>この資産の明細はまだありません。</p>
          </section>
        )}
        {visible.map((b) => (
          <section key={b.month} className="account-month" aria-label={monthTitle(b.month)}>
            <h2 className="month-head">{monthTitle(b.month)}</h2>
            {groupByDay(b.items).map((g) => (
              <DayGroup key={g.date} group={g} accountNames={accountNames} categories={categories} onSelect={select} balances={balances} hideSums />
            ))}
          </section>
        ))}
        {hasMore && (
          <div ref={sentinel} className="more-row">
            <button type="button" className="secondary-btn" onClick={more}>
              前の月を読み込む
            </button>
          </div>
        )}
      </main>
      {adjust && (
        <AdjustSheet
          account={account}
          mode={adjust}
          today={today}
          showToast={showToast}
          onChanged={() => {
            setTick((n) => n + 1);
            onChanged();
          }}
          onClose={() => setAdjust(null)}
        />
      )}
    </>
  );
}
