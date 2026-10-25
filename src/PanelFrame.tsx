import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** 入力画面の下に出すパネルの枠（見出しと右上の×） */
export function PanelFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn small" aria-label="閉じる" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>
      {children}
    </section>
  );
}
