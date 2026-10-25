import { useState } from "react";
import { CategoryDeleteDialog } from "./CategoryEditor";
import { TAG_MODE_LABELS, buildGroups, isDuplicateCategoryName, nextCategoryOrder } from "./categoryLogic";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { changedOrders, moveInOrder } from "./orderUtils";
import { newBase, saveRecord, saveRecords } from "./storage";
import type { Category, CategoryKind, Id } from "./types";

interface Props {
  /** 大分類の id。新規は null */
  parentId: Id | null;
  kind: CategoryKind;
  categories: Category[];
  onBack: () => void;
  /** 変更を保存したあと（一覧を読み直す）。leaveTo を渡すとその大分類の画面へ移る */
  onChanged: (message?: string, openGroup?: Id) => void;
  /** 一覧へ戻る（削除したとき） */
  onLeave: (message: string) => void;
  onOpenLeaf: (leafId: Id | null) => void;
}

/** 大分類の画面：名前・非表示、小分類の一覧・追加・並べ替え */
export function CategoryGroupView({ parentId, kind, categories, onBack, onChanged, onLeave, onOpenLeaf }: Props) {
  const group = parentId ? buildGroups(categories, kind).find((g) => g.parent.id === parentId) : undefined;
  const parent = group?.parent ?? null;
  const isNew = parentId === null;

  const [name, setName] = useState(parent?.name ?? "");
  const [hidden, setHidden] = useState(parent?.hidden ?? false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const leaves = group?.children ?? [];

  const handleSave = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return setError("名前を入れてください");
    if (isDuplicateCategoryName(categories, trimmed, kind, null, parent?.id)) return setError("同じ名前の大分類があります");
    setBusy(true);
    setError("");
    try {
      if (parent) {
        await saveRecord("categories", { ...parent, name: trimmed, hidden });
        onChanged("保存しました");
      } else {
        const record: Category = {
          ...newBase(),
          kind,
          parentId: null,
          name: trimmed,
          order: nextCategoryOrder(categories, kind, null),
          tagMode: "none",
          hidden: false,
        };
        await saveRecord("categories", record);
        onChanged("大分類を追加しました", record.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const move = async (leaf: Category, direction: "up" | "down") => {
    const moved = moveInOrder(leaves, leaf.id, direction);
    if (!moved) return;
    try {
      await saveRecords("categories", changedOrders(leaves, moved));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "並べ替えを保存できませんでした");
    }
  };

  const unchanged = parent !== null && name.trim() === parent.name && hidden === parent.hidden;

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{isNew ? "大分類を追加" : parent?.name ?? "大分類"}</h1>
        {!isNew &&
          (reordering ? (
            <button type="button" className="text-btn" onClick={() => setReordering(false)}>
              完了
            </button>
          ) : (
            <KebabMenu
              items={[
                { label: "並べ替え", onSelect: () => setReordering(true) },
                { label: "削除", danger: true, onSelect: () => setDeleting(true) },
              ]}
            />
          ))}
      </header>
      <main className="content">
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <section className="card form">
          <div className="field">
            <label className="field-label" htmlFor="grp-name">
              名前
            </label>
            <input id="grp-name" className="text-input" type="text" value={name} maxLength={30} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </div>
          {!isNew && (
            <label className="toggle-row">
              <span>
                非表示にする
                <span className="field-hint block">入力の候補に出なくなります。過去の明細と集計には残ります</span>
              </span>
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            </label>
          )}
          <div className="actions">
            <button type="button" className="primary-btn" disabled={busy || unchanged} onClick={() => void handleSave()}>
              {isNew ? "追加" : "名前などを保存"}
            </button>
          </div>
        </section>

        {!isNew && (
          <section className="card list-card">
            <h2 className="list-head">
              <span>小分類</span>
            </h2>
            {leaves.length === 0 && <p className="muted small pad">小分類はまだありません。</p>}
            <ul className="list">
              {leaves.map((leaf) => {
                const body = (
                  <>
                    <span className="list-main">
                      <span className="list-name">{leaf.name}</span>
                      {kind === "expense" && <span className="list-sub">{TAG_MODE_LABELS[leaf.tagMode]}</span>}
                    </span>
                    {leaf.hidden && <span className="badge">非表示</span>}
                  </>
                );
                return reordering ? (
                  <li key={leaf.id} className={`list-row static${leaf.hidden ? " dim" : ""}`}>
                    {body}
                    <span className="move-btns">
                      <button type="button" className="icon-btn small" aria-label={`${leaf.name}を上へ`} disabled={moveInOrder(leaves, leaf.id, "up") === null} onClick={() => void move(leaf, "up")}>
                        <Icon name="arrow-up" size={18} />
                      </button>
                      <button type="button" className="icon-btn small" aria-label={`${leaf.name}を下へ`} disabled={moveInOrder(leaves, leaf.id, "down") === null} onClick={() => void move(leaf, "down")}>
                        <Icon name="arrow-down" size={18} />
                      </button>
                    </span>
                  </li>
                ) : (
                  <li key={leaf.id}>
                    <button type="button" className={`list-row${leaf.hidden ? " dim" : ""}`} onClick={() => onOpenLeaf(leaf.id)}>
                      {body}
                      <Icon name="chevron-right" size={18} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {!isNew && !reordering && (
          <div className="actions">
            <button type="button" className="secondary-btn" onClick={() => onOpenLeaf(null)}>
              <Icon name="plus" size={18} />
              小分類を追加
            </button>
          </div>
        )}
      </main>
      {deleting && parent && <CategoryDeleteDialog category={parent} categories={categories} onDone={onLeave} onClose={() => setDeleting(false)} />}
    </>
  );
}
