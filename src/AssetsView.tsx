import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AccountEditor } from "./AccountEditor";
import { GROUP_ORDER, cardNote, computeBalances, groupSections, summarizeAccounts } from "./accountLogic";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { formatYen } from "./money";
import { byOrder, changedOrders, moveInOrder } from "./orderUtils";
import { getAll, saveRecords } from "./storage";
import { useToast } from "./Toast";
import type { Account, Transaction } from "./types";

interface Props {
  tabBar: ReactNode;
  onOpenSettings: () => void;
}

type Mode = { page: "list" } | { page: "hidden" } | { page: "edit"; account: Account | null; from: "list" | "hidden" };

function Amount({ value }: { value: number }) {
  return <span className={value < 0 ? "neg" : undefined}>{formatYen(value)}</span>;
}

/** 資産タブ：合計の帯、種類ごとの一覧、追加・編集・並べ替え・非表示 */
export function AssetsView({ tabBar, onOpenSettings }: Props) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [mode, setMode] = useState<Mode>({ page: "list" });
  const [reordering, setReordering] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([getAll("accounts"), getAll("transactions")]);
      setAccounts(a);
      setTransactions(t);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "データを開けませんでした");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(() => (accounts ?? []).filter((a) => a.deletedAt === null), [accounts]);
  const balances = useMemo(() => computeBalances(active, transactions), [active, transactions]);
  const totals = useMemo(() => summarizeAccounts(active, balances), [active, balances]);
  const sections = useMemo(() => groupSections(active, balances), [active, balances]);
  const hiddenAccounts = useMemo(() => active.filter((a) => a.hidden).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || byOrder(a, b)), [active]);

  const move = async (account: Account, direction: "up" | "down") => {
    const siblings = active.filter((a) => a.group === account.group).sort(byOrder);
    const moved = moveInOrder(siblings, account.id, direction, (a) => !a.hidden);
    if (!moved) return;
    try {
      await saveRecords("accounts", changedOrders(siblings, moved));
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "並べ替えを保存できませんでした");
    }
  };

  const canMove = (account: Account, direction: "up" | "down") => {
    const siblings = active.filter((a) => a.group === account.group).sort(byOrder);
    return moveInOrder(siblings, account.id, direction, (a) => !a.hidden) !== null;
  };

  const page = mode.page === "hidden" && hiddenAccounts.length === 0 ? "list" : mode.page;

  if (mode.page === "edit") {
    const editing = mode.account;
    return (
      <div className="app">
        <AccountEditor
          account={editing}
          accounts={accounts ?? []}
          balance={editing ? (balances.get(editing.id) ?? 0) : 0}
          onBack={() => setMode({ page: mode.from })}
          onDone={(message) => {
            const from = mode.from;
            setMode({ page: from });
            showToast(message);
            void load();
          }}
        />
        {toast}
      </div>
    );
  }

  const row = (a: Account) => {
    const note = cardNote(a, active);
    const body = (
      <>
        <span className="list-main">
          <span className="list-name">{a.name}</span>
          {note && <span className="list-sub">{note}</span>}
          {!a.includeInUsable && <span className="list-sub">使える資産に含めない</span>}
        </span>
        <span className="list-amount">
          <Amount value={balances.get(a.id) ?? 0} />
        </span>
      </>
    );
    if (reordering && page === "list") {
      return (
        <li key={a.id} className="list-row static">
          {body}
          <span className="move-btns">
            <button type="button" className="icon-btn small" aria-label={`${a.name}を上へ`} disabled={!canMove(a, "up")} onClick={() => void move(a, "up")}>
              <Icon name="arrow-up" size={18} />
            </button>
            <button type="button" className="icon-btn small" aria-label={`${a.name}を下へ`} disabled={!canMove(a, "down")} onClick={() => void move(a, "down")}>
              <Icon name="arrow-down" size={18} />
            </button>
          </span>
        </li>
      );
    }
    return (
      <li key={a.id}>
        <button type="button" className="list-row" onClick={() => setMode({ page: "edit", account: a, from: page === "hidden" ? "hidden" : "list" })}>
          {body}
        </button>
      </li>
    );
  };

  if (page === "hidden") {
    return (
      <div className="app">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="戻る" onClick={() => setMode({ page: "list" })}>
            <Icon name="chevron-left" size={22} />
          </button>
          <h1 className="topbar-title">非表示の資産</h1>
        </header>
        <main className="content">
          <section className="card list-card">
            <ul className="list">{hiddenAccounts.map(row)}</ul>
          </section>
          <p className="muted small">タップすると、表示に戻せます。非表示でも、残高は合計に入っています。</p>
        </main>
        {toast}
      </div>
    );
  }

  const menu = [
    { label: "追加", onSelect: () => setMode({ page: "edit", account: null, from: "list" }) },
    { label: "並べ替え", onSelect: () => setReordering(true) },
    { label: "非表示の資産", onSelect: () => setMode({ page: "hidden" }) },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="topbar-title">資産</h1>
        {reordering ? (
          <button type="button" className="text-btn" onClick={() => setReordering(false)}>
            完了
          </button>
        ) : (
          <>
            <KebabMenu items={menu} />
            <button type="button" className="icon-btn" aria-label="設定" onClick={onOpenSettings}>
              <Icon name="settings" size={22} />
            </button>
          </>
        )}
      </header>
      <main className="content">
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}
        {accounts === null && !loadError && <p className="muted">読み込んでいます…</p>}
        {accounts !== null && active.length === 0 && (
          <section className="card">
            <p>資産はまだありません。らくな家計簿からの取り込み（段階7）で入ります。新しく足すときは右上の︙から追加します。</p>
          </section>
        )}
        {active.length > 0 && (
          <section className="card summary" aria-label="合計">
            <p className="summary-label">使える資産</p>
            <p className="summary-main">
              <Amount value={totals.usable} />
            </p>
            <dl className="summary-sub">
              <div>
                <dt>資産</dt>
                <dd>{formatYen(totals.assets)}</dd>
              </div>
              <div>
                <dt>負債</dt>
                <dd className={totals.liabilities > 0 ? "neg" : undefined}>{formatYen(totals.liabilities)}</dd>
              </div>
              <div>
                <dt>合計</dt>
                <dd>
                  <Amount value={totals.total} />
                </dd>
              </div>
            </dl>
            <p className="summary-note">
              使える資産に含めない資産：<Amount value={totals.excluded} />
            </p>
          </section>
        )}
        {sections.map((s) => (
          <section key={s.group} className="card list-card">
            <h2 className="list-head">
              <span>{s.label}</span>
              <Amount value={s.subtotal} />
            </h2>
            <ul className="list">{s.items.map(row)}</ul>
          </section>
        ))}
        {hiddenAccounts.length > 0 && !reordering && (
          <button type="button" className="link-row" onClick={() => setMode({ page: "hidden" })}>
            <span>非表示の資産 {hiddenAccounts.length}件</span>
            <Icon name="chevron-right" size={18} />
          </button>
        )}
      </main>
      {!reordering && tabBar}
      {toast}
    </div>
  );
}
