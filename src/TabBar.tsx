import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export type TabId = "home" | "entries" | "summary" | "outlook" | "assets";

export const TABS: ReadonlyArray<{ id: TabId; label: string; icon: IconName }> = [
  { id: "home", label: "ホーム", icon: "home" },
  { id: "entries", label: "明細", icon: "list" },
  { id: "summary", label: "集計", icon: "pie-chart" },
  { id: "outlook", label: "見通し", icon: "trending-up" },
  { id: "assets", label: "資産", icon: "wallet" },
];

interface Props {
  current: TabId;
  onSelect: (id: TabId) => void;
}

export function TabBar({ current, onSelect }: Props) {
  return (
    <nav className="tabbar" aria-label="画面の切り替え">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tab${tab.id === current ? " active" : ""}`}
          aria-current={tab.id === current ? "page" : undefined}
          onClick={() => onSelect(tab.id)}
        >
          <span className="tab-icon">
            <Icon name={tab.icon} size={22} />
          </span>
          <span className="tab-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
