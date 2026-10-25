import { useState } from "react";
import { Icon } from "./Icon";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** 右上の︙メニュー */
export function KebabMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button type="button" className="icon-btn" aria-label="メニュー" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="more" size={22} />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <ul className="menu" role="menu">
            {items.map((item) => (
              <li key={item.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={item.danger ? "danger" : undefined}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
