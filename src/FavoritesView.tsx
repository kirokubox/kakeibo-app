import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmSheet } from "./BottomSheet";
import { categoryNames, favoriteProblems, isFavoriteCallable } from "./entryLogic";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { formatYen } from "./money";
import { byOrder, changedOrders, moveInOrder } from "./orderUtils";
import { getAll, saveRecords, softDelete } from "./storage";
import type { ShowToast } from "./Toast";
import type { Account, Category, Favorite, TransactionTemplate } from "./types";

interface Props {
  accounts: Account[];
  categories: Category[];
  onPick: (template: TransactionTemplate) => void;
  onClose: () => void;
  showToast: ShowToast;
}

const TYPE_LABELS = { income: "収入", expense: "支出", transfer: "振替", adjustment: "残高修正" } as const;

/** よく使う入力の一覧。1タップで入力画面に呼び出す */
export function FavoritesView({ accounts, categories, onPick, onClose, showToast }: Props) {
  const [items, setItems] = useState<Favorite[] | null>(null);
  const [mode, setMode] = useState<"normal" | "reorder" | "delete">("normal");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await getAll("favorites");
      setItems(all.filter((f) => f.deletedAt === null).sort(byOrder));
    } catch (e) {
      setItems([]);
      showToast(e instanceof Error ? e.message : "読み込めませんでした");
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const list = useMemo(() => items ?? [], [items]);

  const move = async (id: string, direction: "up" | "down") => {
    const moved = moveInOrder(list, id, direction);
    if (!moved) return;
    try {
      await saveRecords("favorites", changedOrders(list, moved));
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "並べ替えを保存できませんでした");
    }
  };

  const remove = async () => {
    if (!confirmId) return;
    setBusy(true);
    try {
      await softDelete("favorites", confirmId);
      setConfirmId(null);
      await load();
      showToast("削除しました");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "削除できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const menu = [
    { label: "並べ替え", onSelect: () => setMode("reorder") },
    { label: "削除", onSelect: () => setMode("delete"), danger: true },
  ];

  return (
    <div className="entry-screen">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onClose}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">よく使う入力</h1>
        {mode === "normal" ? (
          <KebabMenu items={menu} />
        ) : (
          <button type="button" className="text-btn" onClick={() => setMode("normal")}>
            完了
          </button>
        )}
      </header>
      <main className="content">
        {items !== null && list.length === 0 && (
          <section className="card">
            <p>よく使う入力はまだありません。入力画面の右上の︙から「よく使う入力に登録」で足せます。</p>
          </section>
        )}
        {list.length > 0 && (
          <section className="card list-card">
            <ul className="list">
              {list.map((f) => {
                const t = f.template;
                const callable = isFavoriteCallable(t);
                const problems = callable ? favoriteProblems(t, accounts, categories) : { account: false, category: false };
                const n = categoryNames(categories, t.categoryId);
                const account = accounts.find((a) => a.id === t.accountId);
                const body = (
                  <>
                    <span className="badge">{TYPE_LABELS[t.type]}</span>
                    <span className="list-main">
                      <span className="list-sub">{n ? (n.child ? `${n.parent}/${n.child}` : n.parent) : t.type === "transfer" ? "振替" : "分類なし"}</span>
                      <span className="list-name">{t.content || "（内容なし）"}</span>
                      <span className="list-sub">{account ? account.name : "資産なし"}</span>
                      {problems.account && <span className="list-sub warn">資産を選び直してください</span>}
                      {problems.category && <span className="list-sub warn">分類を選び直してください</span>}
                    </span>
                    <span className="list-amount">{t.amount > 0 ? formatYen(t.amount) : ""}</span>
                  </>
                );
                if (mode === "reorder") {
                  return (
                    <li key={f.id} className="list-row static">
                      {body}
                      <span className="move-btns">
                        <button type="button" className="icon-btn small" aria-label="上へ" disabled={moveInOrder(list, f.id, "up") === null} onClick={() => void move(f.id, "up")}>
                          <Icon name="arrow-up" size={18} />
                        </button>
                        <button type="button" className="icon-btn small" aria-label="下へ" disabled={moveInOrder(list, f.id, "down") === null} onClick={() => void move(f.id, "down")}>
                          <Icon name="arrow-down" size={18} />
                        </button>
                      </span>
                    </li>
                  );
                }
                if (mode === "delete") {
                  return (
                    <li key={f.id} className="list-row static">
                      {body}
                      <button type="button" className="icon-btn small danger-icon" aria-label="削除" onClick={() => setConfirmId(f.id)}>
                        <Icon name="trash" size={18} />
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={f.id}>
                    <button type="button" className={`list-row${callable ? "" : " dim"}`} disabled={!callable} onClick={() => onPick(t)}>
                      {body}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {list.some((f) => !isFavoriteCallable(f.template)) && <p className="muted small">薄く表示している振替は、段階4から呼び出せます。</p>}
      </main>
      {confirmId && (
        <ConfirmSheet
          title="よく使う入力を削除しますか"
          message="この一覧から消えます。すでに入力した明細は変わりません。"
          confirmLabel="削除する"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onClose={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}
