import { useCallback, useEffect, useMemo, useState } from "react";
import { CategoryEditor } from "./CategoryEditor";
import { CategoryGroupView } from "./CategoryGroupView";
import { buildGroups } from "./categoryLogic";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { changedOrders, moveInOrder } from "./orderUtils";
import { getAll, saveRecords } from "./storage";
import { useToast } from "./Toast";
import type { Category, CategoryKind, Id } from "./types";

type Route = { page: "list" } | { page: "group"; parentId: Id | null } | { page: "leaf"; parentId: Id; leafId: Id | null };

interface Props {
  initialKind: CategoryKind;
  onBack: () => void;
}

/** 分類の画面（設定から開く）：支出・収入の切り替え、大分類の一覧 */
export function CategoriesView({ initialKind, onBack }: Props) {
  const [kind, setKind] = useState<CategoryKind>(initialKind);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [route, setRoute] = useState<Route>({ page: "list" });
  const [reordering, setReordering] = useState(false);
  const [hiddenView, setHiddenView] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    try {
      setCategories(await getAll("categories"));
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "データを開けませんでした");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const all = useMemo(() => categories ?? [], [categories]);
  const groups = useMemo(() => buildGroups(all, kind), [all, kind]);
  const shown = groups.filter((g) => !g.parent.hidden);
  const hiddenGroups = groups.filter((g) => g.parent.hidden);

  const afterChange = async (message?: string) => {
    await load();
    if (message) showToast(message);
  };

  if (route.page === "group") {
    const groupKind = route.parentId ? (all.find((c) => c.id === route.parentId)?.kind ?? kind) : kind;
    return (
      <>
        <CategoryGroupView
          key={route.parentId ?? "new"}
          parentId={route.parentId}
          kind={groupKind}
          categories={all}
          onBack={() => setRoute({ page: "list" })}
          onChanged={(message, openGroup) => {
            // 新しい大分類は、一覧を読み直してからその画面へ移る
            void afterChange(message).then(() => {
              if (openGroup) setRoute({ page: "group", parentId: openGroup });
            });
          }}
          onLeave={(message) => {
            setRoute({ page: "list" });
            void afterChange(message);
          }}
          onOpenLeaf={(leafId) => setRoute({ page: "leaf", parentId: route.parentId!, leafId })}
        />
        {toast}
      </>
    );
  }

  if (route.page === "leaf") {
    const leaf = route.leafId ? (all.find((c) => c.id === route.leafId) ?? null) : null;
    const back = { page: "group", parentId: route.parentId } as const;
    return (
      <>
        <CategoryEditor
          key={route.leafId ?? "new"}
          leaf={leaf}
          kind={all.find((c) => c.id === route.parentId)?.kind ?? kind}
          parentId={route.parentId}
          categories={all}
          onBack={() => setRoute(back)}
          onDone={(message) => {
            setRoute(back);
            void afterChange(message);
          }}
        />
        {toast}
      </>
    );
  }

  const move = async (parentId: Id, direction: "up" | "down") => {
    const siblings = groups.map((g) => g.parent);
    const moved = moveInOrder(siblings, parentId, direction, (c) => !c.hidden);
    if (!moved) return;
    try {
      await saveRecords("categories", changedOrders(siblings, moved));
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "並べ替えを保存できませんでした");
    }
  };

  const canMove = (parentId: Id, direction: "up" | "down") =>
    moveInOrder(
      groups.map((g) => g.parent),
      parentId,
      direction,
      (c) => !c.hidden,
    ) !== null;

  const list = hiddenView && hiddenGroups.length > 0 ? hiddenGroups : shown;
  const showingHidden = list === hiddenGroups && hiddenView;

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={showingHidden ? () => setHiddenView(false) : onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{showingHidden ? "非表示の分類" : "分類"}</h1>
        {!showingHidden &&
          (reordering ? (
            <button type="button" className="text-btn" onClick={() => setReordering(false)}>
              完了
            </button>
          ) : (
            <KebabMenu
              items={[
                { label: "大分類を追加", onSelect: () => setRoute({ page: "group", parentId: null }) },
                { label: "並べ替え", onSelect: () => setReordering(true) },
                { label: "非表示の分類", onSelect: () => setHiddenView(true) },
              ]}
            />
          ))}
      </header>
      <main className="content">
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}
        {!showingHidden && (
          <div className="segmented" role="tablist" aria-label="支出か収入か">
            {(["expense", "income"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={k === kind}
                className={`seg${k === kind ? " on" : ""}`}
                onClick={() => {
                  setKind(k);
                  setReordering(false);
                }}
              >
                {k === "expense" ? "支出" : "収入"}
              </button>
            ))}
          </div>
        )}
        {categories === null && !loadError && <p className="muted">読み込んでいます…</p>}
        {categories !== null && list.length === 0 && (
          <section className="card">
            <p className="muted">{showingHidden ? "非表示の分類はありません。" : "分類はありません。右上の︙から大分類を追加できます。"}</p>
          </section>
        )}
        {list.length > 0 && (
          <section className="card list-card">
            <ul className="list">
              {list.map((g) => {
                const visible = g.children.filter((c) => !c.hidden);
                const hiddenCount = g.children.length - visible.length;
                const sub = visible.length > 0 ? visible.map((c) => c.name).join("、") + (hiddenCount > 0 ? `（ほか非表示 ${hiddenCount}）` : "") : hiddenCount > 0 ? `小分類は非表示 ${hiddenCount}` : "小分類なし";
                const body = (
                  <span className="list-main">
                    <span className="list-name">
                      {g.parent.name} ({visible.length})
                    </span>
                    <span className="list-sub wrap">{sub}</span>
                  </span>
                );
                return reordering ? (
                  <li key={g.parent.id} className="list-row static">
                    {body}
                    <span className="move-btns">
                      <button type="button" className="icon-btn small" aria-label={`${g.parent.name}を上へ`} disabled={!canMove(g.parent.id, "up")} onClick={() => void move(g.parent.id, "up")}>
                        <Icon name="arrow-up" size={18} />
                      </button>
                      <button type="button" className="icon-btn small" aria-label={`${g.parent.name}を下へ`} disabled={!canMove(g.parent.id, "down")} onClick={() => void move(g.parent.id, "down")}>
                        <Icon name="arrow-down" size={18} />
                      </button>
                    </span>
                  </li>
                ) : (
                  <li key={g.parent.id}>
                    <button type="button" className="list-row" onClick={() => setRoute({ page: "group", parentId: g.parent.id })}>
                      {body}
                      <Icon name="chevron-right" size={18} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {!showingHidden && !reordering && hiddenGroups.length > 0 && (
          <button type="button" className="link-row" onClick={() => setHiddenView(true)}>
            <span>非表示の分類 {hiddenGroups.length}件</span>
            <Icon name="chevron-right" size={18} />
          </button>
        )}
      </main>
      {toast}
    </>
  );
}
