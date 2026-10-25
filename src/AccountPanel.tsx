import type { Account, Id } from "./types";
import { PanelFrame } from "./PanelFrame";

interface Props {
  accounts: Account[]; // 選べる資産（並び済み）
  selectedId: Id | null;
  lastUsedId: Id | null;
  onSelect: (id: Id) => void;
  onClose: () => void;
}

/** 資産を選ぶパネル：4列のボタン。最後に選んだ資産は少し強調する */
export function AccountPanel({ accounts, selectedId, lastUsedId, onSelect, onClose }: Props) {
  return (
    <PanelFrame title="資産" onClose={onClose}>
      {accounts.length === 0 ? (
        <p className="panel-empty">資産タブで資産を足してください</p>
      ) : (
        <div className="panel-body">
          <div className="account-grid">
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`pick${a.id === selectedId ? " on" : ""}${a.id === lastUsedId ? " last" : ""}`}
                aria-pressed={a.id === selectedId}
                onClick={() => onSelect(a.id)}
              >
                {a.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </PanelFrame>
  );
}
