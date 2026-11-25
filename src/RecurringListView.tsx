import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateJa } from "./dateUtils";
import { categoryNames } from "./entryLogic";
import { EntryView, entryKey } from "./EntryView";
import type { EntryMode } from "./EntryView";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import { estimatedTransactions, isEnded, nextOccurrence, ruleLabel } from "./recurrence";
import { SHIFT_LABELS } from "./accountLogic";
import { getAll } from "./storage";
import { useToast } from "./Toast";
import type { Account, Category, Recurring, Transaction } from "./types";

interface Props {
  today: string;
  onBack: () => void;
}

type View = "list" | "estimated";

/** 設定の「繰り返し」：一覧（次の日付の早い順）、終わった繰り返し、見込みのままの明細 */

type RecOrder = "next" | "category" | "amount";
const REC_ORDERS: Array<[RecOrder, string]> = [
  ["next", "次の日付"],
  ["category", "分類"],
  ["amount", "金額"],
];

export function RecurringListView({ today, onBack }: Props) {
  const [recurrings, setRecurrings] = useState<Recurring[] | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [view, setView] = useState<View>("list");
  const [entry, setEntry] = useState<EntryMode | null>(null);
  const [loadError, setLoadError] = useState("");
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    try {
      const [r, t, a, c] = await Promise.all([getAll("recurrings"), getAll("transactions"), getAll("accounts"), getAll("categories")]);
      setRecurrings(r);
      setTransactions(t);
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

  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  // 探す・並べ替え（v0.19.0。本人「繰り返しの項目が多くなると探しにくくて2重登録してた」）
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<RecOrder>("next");
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (r: Recurring) => {
      if (words.length === 0) return true;
      const n = categoryNames(categories, r.template.categoryId);
      const text = [r.template.content, r.template.memo, n?.parent ?? "", n?.child ?? "", accountNames.get(r.template.accountId) ?? ""].join(" ").toLowerCase();
      return words.every((w) => text.includes(w));
    };
    const active = (recurrings ?? []).filter((r) => r.deletedAt === null && hit(r));
    const withNext = active.map((rec) => ({ rec, next: nextOccurrence(rec, today), ended: isEnded(rec, today) }));
    const catKey = (r: Recurring) => {
      const n = categoryNames(categories, r.template.categoryId);
      return n ? `${n.parent}＞${n.child ?? ""}` : "\uffff";
    };
    const byNext = (a: { rec: Recurring; next: { date: string } | null }, b: { rec: Recurring; next: { date: string } | null }) =>
      (a.next?.date ?? "9999").localeCompare(b.next?.date ?? "9999") || a.rec.id.localeCompare(b.rec.id);
    const running = withNext
      .filter((x) => !x.ended)
      .sort((a, b) =>
        order === "amount"
          ? b.rec.template.amount - a.rec.template.amount || byNext(a, b)
          : order === "category"
            ? catKey(a.rec).localeCompare(catKey(b.rec), "ja") || byNext(a, b)
            : byNext(a, b),
      );
    const ended = withNext.filter((x) => x.ended).sort((a, b) => (b.rec.endDate ?? "").localeCompare(a.rec.endDate ?? ""));
    return { running, ended };
  }, [recurrings, today, query, order, categories, accountNames]);
  const estimated = useMemo(() => estimatedTransactions(transactions), [transactions]);

  const kindLabel = (t: { type: string; categoryId?: string; accountId: string; toAccountId?: string }) => {
    if (t.type === "transfer") return `${accountNames.get(t.accountId) ?? "資産不明"} → ${accountNames.get(t.toAccountId ?? "") ?? "資産不明"}`;
    const n = categoryNames(categories, t.categoryId);
    const kind = t.type === "income" ? "収入" : "支出";
    return n ? `${kind}・${n.child ? `${n.parent}＞${n.child}` : n.parent}` : kind;
  };

  const overlay = entry && (
    <div className="screen-overlay">
      <EntryView
        key={entryKey(entry)}
        mode={entry}
        today={today}
        showToast={showToast}
        onChanged={() => void load()}
        onClose={() => setEntry(null)}
      />
    </div>
  );

  if (view === "estimated") {
    return (
      <>
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="戻る" onClick={() => setView("list")}>
            <Icon name="chevron-left" size={22} />
          </button>
          <h1 className="topbar-title">見込みのままの明細</h1>
        </header>
        <main className="content">
          {estimated.length === 0 ? (
            <section className="card">
              <p>見込みのままの明細はありません。</p>
            </section>
          ) : (
            <section className="card list-card">
              <ul className="list rec-list">
                {estimated.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="list-row" onClick={() => setEntry({ kind: "edit", tx: t })}>
                      <span className="list-main">
                        <span className="list-name">{t.content || kindLabel(t)}</span>
                        <span className="list-sub">{formatDateJa(t.date)}</span>
                      </span>
                      <span className="list-amount">{formatYen(t.amount)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="muted small">請求が確定したら、押して金額を直すと「見込み」の印が消えます。</p>
        </main>
        {overlay}
        {toast}
      </>
    );
  }

  const row = ({ rec, next }: { rec: Recurring; next: { date: string } | null }, ended: boolean) => (
    <li key={rec.id}>
      <button type="button" className="list-row" onClick={() => setEntry({ kind: "recurring", rec })}>
        <span className="list-main">
          <span className="list-name">{rec.template.content || kindLabel(rec.template)}</span>
          <span className="list-sub">
            {ended ? `終わり ${rec.endDate ? formatDateJa(rec.endDate) : ""}` : next ? `次 ${formatDateJa(next.date)}` : "予定なし"}・{ruleLabel(rec.rule)}
            {rec.holidayShift !== "none" ? `（休日なら${SHIFT_LABELS[rec.holidayShift]}）` : ""}
          </span>
          <span className="list-sub">{kindLabel(rec.template)}</span>
        </span>
        <span className="list-amount">
          {rec.estimated && <span className="badge estimated">見込み</span>} {formatYen(rec.template.amount)}
        </span>
      </button>
    </li>
  );

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">繰り返し</h1>
        <button type="button" className="text-btn" onClick={() => setEntry({ kind: "recurringNew" })}>
          追加
        </button>
      </header>
      <main className="content">
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}
        {recurrings === null && !loadError && <p className="muted">読み込んでいます…</p>}
        {estimated.length > 0 && (
          <button type="button" className="link-row" onClick={() => setView("estimated")}>
            <span>
              見込みのままの明細 <strong>{estimated.length}件</strong>
            </span>
            <Icon name="chevron-right" size={18} />
          </button>
        )}
        {recurrings !== null && recurrings.some((r) => r.deletedAt === null) && (
          <div className="rec-tools">
            <input
              type="search"
              className="text-input search-input"
              placeholder="内容・分類・資産で探す"
              aria-label="繰り返しを探す"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="segmented" role="tablist" aria-label="並べ替え">
              {REC_ORDERS.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={order === k} className={`seg${order === k ? " on" : ""}`} onClick={() => setOrder(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {recurrings !== null && query.trim() !== "" && rows.running.length === 0 && rows.ended.length === 0 && <p className="empty-note">見つかりませんでした</p>}
        {recurrings !== null && query.trim() === "" && rows.running.length === 0 && rows.ended.length === 0 && (
          <section className="card">
            <p>繰り返しはまだありません。右上の追加から足せます。入力画面の日付の右にある「繰り返し」からも作れます。</p>
          </section>
        )}
        {rows.running.length > 0 && (
          <section className="card list-card">
            <ul className="list rec-list">{rows.running.map((x) => row(x, false))}</ul>
          </section>
        )}
        {rows.ended.length > 0 && (
          <>
            <h2 className="list-group-title">終わった繰り返し</h2>
            <section className="card list-card">
              <ul className="list rec-list">{rows.ended.map((x) => row(x, true))}</ul>
            </section>
          </>
        )}
        <p className="muted small">日が来たら、アプリを開いたときに明細が自動で入ります。編集すると、これから作る分だけが変わります。</p>
      </main>
      {overlay}
      {toast}
    </>
  );
}
