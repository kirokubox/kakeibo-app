import { useEffect, useState } from "react";
import { BottomSheet, ChoiceSheet, ConfirmSheet } from "./BottomSheet";
import {
  TAG_MODE_DESCRIPTIONS,
  TAG_MODE_LABELS,
  checkCategoryDelete,
  defaultTagModeForNew,
  isDuplicateCategoryName,
  moveToParent,
  nextCategoryOrder,
} from "./categoryLogic";
import type { DeleteCheck } from "./categoryLogic";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { getAllData, newBase, saveRecord, softDelete } from "./storage";
import type { Category, CategoryKind, Id, TagMode } from "./types";

const TAG_MODES: TagMode[] = ["defaultDaily", "mustChoose", "none"];

interface DeleteProps {
  category: Category;
  categories: Category[];
  onDone: (message: string) => void;
  onClose: () => void;
}

/** 削除の確認。使われている・小分類が残っているときは理由を出し、使われているなら非表示を案内する */
export function CategoryDeleteDialog({ category, categories, onDone, onClose }: DeleteProps) {
  const [check, setCheck] = useState<DeleteCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    let cancelled = false;
    getAllData()
      .then((data) => {
        if (!cancelled) setCheck(checkCategoryDelete(category, categories, data));
      })
      .catch((e) => {
        if (!cancelled) setFailure(e instanceof Error ? e.message : "確認できませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, [category, categories]);

  const act = async (action: () => Promise<void>, message: string) => {
    setBusy(true);
    try {
      await action();
      onDone(message);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  if (failure) {
    return (
      <BottomSheet title="できませんでした" onClose={onClose}>
        <p className="sheet-message">{failure}</p>
        <div className="sheet-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>
            閉じる
          </button>
        </div>
      </BottomSheet>
    );
  }
  if (check === null) return null;
  if (check.ok) {
    return (
      <ConfirmSheet
        title="この分類を削除しますか"
        message={`「${category.name}」を削除します。使っている明細はないので、一覧から消えます。`}
        confirmLabel="削除"
        danger
        busy={busy}
        onConfirm={() => void act(() => softDelete("categories", category.id), "削除しました")}
        onClose={onClose}
      />
    );
  }
  return (
    <BottomSheet title="削除できません" onClose={onClose}>
      <p className="sheet-message">{check.reason}</p>
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" onClick={onClose}>
          閉じる
        </button>
        {check.suggestHide && !category.hidden && (
          <button
            type="button"
            className="primary-btn"
            disabled={busy}
            onClick={() => void act(() => saveRecord("categories", { ...category, hidden: true }).then(() => undefined), "非表示にしました")}
          >
            非表示にする
          </button>
        )}
      </div>
    </BottomSheet>
  );
}

interface Props {
  /** 編集する小分類。新規は null */
  leaf: Category | null;
  kind: CategoryKind;
  /** 新規のときの大分類（編集のときは今の大分類） */
  parentId: Id;
  categories: Category[];
  onBack: () => void;
  onDone: (message: string) => void;
}

/** 小分類の追加・編集 */
export function CategoryEditor({ leaf, kind, parentId, categories, onBack, onDone }: Props) {
  const isNew = leaf === null;
  const [name, setName] = useState(leaf?.name ?? "");
  const [parent, setParent] = useState<Id>(leaf?.parentId ?? parentId);
  const [tagMode, setTagMode] = useState<TagMode>(leaf?.tagMode ?? defaultTagModeForNew(kind));
  const [hidden, setHidden] = useState(leaf?.hidden ?? false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<null | "parent" | "delete">(null);

  const parents = categories.filter((c) => c.deletedAt === null && c.kind === kind && c.parentId === null && (!c.hidden || c.id === parent));
  const parentName = categories.find((c) => c.id === parent)?.name ?? "";

  const handleSave = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return setError("名前を入れてください");
    if (isDuplicateCategoryName(categories, trimmed, kind, parent, leaf?.id)) return setError("同じ大分類の中に同じ名前の小分類があります");
    setBusy(true);
    setError("");
    try {
      let record: Category;
      if (leaf) {
        const moved = moveToParent(categories, leaf.id, parent);
        if (!moved) throw new Error("大分類を移せませんでした");
        record = { ...moved, name: trimmed, hidden, tagMode: kind === "expense" ? tagMode : "none" };
      } else {
        record = {
          ...newBase(),
          kind,
          parentId: parent,
          name: trimmed,
          order: nextCategoryOrder(categories, kind, parent),
          tagMode: kind === "expense" ? tagMode : "none",
          hidden: false,
        };
      }
      await saveRecord("categories", record);
      onDone("保存しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{isNew ? "小分類を追加" : "小分類を編集"}</h1>
        {!isNew && <KebabMenu items={[{ label: "削除", danger: true, onSelect: () => setSheet("delete") }]} />}
      </header>
      <main className="content">
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <section className="card form">
          <div className="field">
            <label className="field-label" htmlFor="cat-name">
              名前
            </label>
            <input id="cat-name" className="text-input" type="text" value={name} maxLength={30} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field">
            <span className="field-label">大分類</span>
            <button type="button" className="select-btn" onClick={() => setSheet("parent")}>
              <span>{parentName}</span>
              <Icon name="chevron-right" size={18} />
            </button>
            {!isNew && <p className="field-hint">移すと、移した先の末尾に並びます</p>}
          </div>

          {kind === "expense" && (
            <div className="field">
              <span className="field-label" id="cat-tag-label">
                タグ
              </span>
              <div className="radio-list" role="radiogroup" aria-labelledby="cat-tag-label">
                {TAG_MODES.map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={m === tagMode} className={`radio${m === tagMode ? " on" : ""}`} onClick={() => setTagMode(m)}>
                    <span className="choice-text">
                      <span className="choice-label">{TAG_MODE_LABELS[m]}</span>
                      <span className="choice-desc">{TAG_MODE_DESCRIPTIONS[m]}</span>
                    </span>
                    {m === tagMode && <Icon name="check" size={20} />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!isNew && (
            <label className="toggle-row">
              <span>
                非表示にする
                <span className="field-hint block">入力の候補に出なくなります。過去の明細と集計には残ります</span>
              </span>
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            </label>
          )}
        </section>
        <div className="actions">
          <button type="button" className="primary-btn wide" disabled={busy} onClick={() => void handleSave()}>
            保存
          </button>
        </div>
      </main>

      {sheet === "parent" && (
        <ChoiceSheet title="大分類" options={parents.map((p) => ({ value: p.id, label: p.name }))} value={parent} onSelect={setParent} onClose={() => setSheet(null)} />
      )}
      {sheet === "delete" && leaf && (
        <CategoryDeleteDialog category={leaf} categories={categories} onDone={onDone} onClose={() => setSheet(null)} />
      )}
    </>
  );
}
