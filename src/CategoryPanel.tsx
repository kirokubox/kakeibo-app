import { useState } from "react";
import type { CategoryChoiceGroup } from "./entryLogic";
import { PanelFrame } from "./PanelFrame";
import type { Id } from "./types";

interface Props {
  groups: CategoryChoiceGroup[];
  selectedId: Id | null;
  onSelect: (id: Id) => void;
  onClose: () => void;
}

/** 分類を選ぶパネル：左に大分類、押すと右に小分類。小分類を押すと決まる */
export function CategoryPanel({ groups, selectedId, onSelect, onClose }: Props) {
  const selectedParent = groups.find((g) => g.children.some((c) => c.id === selectedId))?.parent.id;
  const [activeParent, setActiveParent] = useState<Id | null>(selectedParent ?? groups[0]?.parent.id ?? null);
  const active = groups.find((g) => g.parent.id === activeParent) ?? groups[0];

  return (
    <PanelFrame title="分類" onClose={onClose}>
      {groups.length === 0 ? (
        <p className="panel-empty">表示中の分類がありません。設定の分類で足してください</p>
      ) : (
        <div className="category-panel">
          <ul className="parent-list">
            {groups.map((g) => (
              <li key={g.parent.id}>
                <button
                  type="button"
                  className={`parent-btn${g.parent.id === active?.parent.id ? " on" : ""}`}
                  onClick={() => setActiveParent(g.parent.id)}
                >
                  {g.parent.name}
                </button>
              </li>
            ))}
          </ul>
          <div className="child-grid">
            {active?.children.map((c) => (
              <button key={c.id} type="button" className={`pick${c.id === selectedId ? " on" : ""}`} aria-pressed={c.id === selectedId} onClick={() => onSelect(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </PanelFrame>
  );
}
