import { useEffect } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { useBackdropClose } from "./useBackdropClose";

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** 下から出るシート。選択肢・確認・短い入力で使う（段階3の入力でも使う形） */
export function BottomSheet({ title, onClose, children }: SheetProps) {
  const backdrop = useBackdropClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" {...backdrop}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <h2>{title}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

interface ChoiceProps<T extends string> {
  title: string;
  options: ReadonlyArray<ChoiceOption<T>>;
  value: T | null;
  onSelect: (value: T) => void;
  onClose: () => void;
}

/** 選択肢のボトムシート。選ぶとすぐ閉じる */
export function ChoiceSheet<T extends string>({ title, options, value, onSelect, onClose }: ChoiceProps<T>) {
  return (
    <BottomSheet title={title} onClose={onClose}>
      <ul className="choice-list">
        {options.map((o) => (
          <li key={o.value}>
            <button
              type="button"
              className={`choice${o.value === value ? " selected" : ""}`}
              aria-pressed={o.value === value}
              onClick={() => {
                onSelect(o.value);
                onClose();
              }}
            >
              <span className="choice-text">
                <span className="choice-label">{o.label}</span>
                {o.description && <span className="choice-desc">{o.description}</span>}
              </span>
              {o.value === value && <Icon name="check" size={20} />}
            </button>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}

interface ConfirmProps {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** 確認のシート */
export function ConfirmSheet({ title, message, confirmLabel, danger, busy, onConfirm, onClose }: ConfirmProps) {
  return (
    <BottomSheet title={title} onClose={onClose}>
      <p className="sheet-message">{message}</p>
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" disabled={busy} onClick={onClose}>
          やめる
        </button>
        <button type="button" className={danger ? "danger-btn" : "primary-btn"} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </BottomSheet>
  );
}
