import type { Account, Id } from "./types";
import { PanelFrame } from "./PanelFrame";

interface Props {
  accounts: Account[]; // 選べる資産（並び済み）
  selectedId: Id | null;
  lastUsedId: Id | null;
  /** パネルの見出し（振替の「出金」「入金」など）。省略は「資産」 */
  title?: string;
  /** 押せなくする資産（振替の入金で、出金に選んだ資産） */
  disabledId?: Id | null;
  onSelect: (id: Id) => void;
  onClose: () => void;
}

/** 資産を選ぶパネル：4列のボタン。最後に選んだ資産は少し強調する */
export function AccountPanel({ accounts, selectedId, lastUsedId, title = "資産", disabledId = null, onSelect, onClose }: Props) {
  return (
    <PanelFrame title={title} onClose={onClose}>
      {accounts.length === 0 ? (
        <p className="panel-empty">資産タブで資産を足してください</p>
      ) : (
        <div className="panel-body">
          <div className="account-grid">
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`pick${a.id === selectedId ? " on" : ""}${a.id === lastUsedId ? " last" : ""}${a.id === disabledId ? " dim" : ""}`}
                aria-pressed={a.id === selectedId}
                disabled={a.id === disabledId}
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
