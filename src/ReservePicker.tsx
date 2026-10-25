import { BottomSheet } from "./BottomSheet";
import { Icon } from "./Icon";
import { formatYen } from "./money";
import type { ReserveMove } from "./types";
import type { Id, Reserve } from "./types";
import { balanceOf } from "./reserveLogic";

interface Props {
  reserves: Reserve[];
  moves: readonly ReserveMove[];
  selected: Id | null;
  /** 編集中の支出の「使った」は無かったことにして残高を出す */
  excludeTxId?: Id;
  onPick: (id: Id | null) => void;
  onClose: () => void;
}

/** 支出の入力で「取り置きから払う」取り置きを選ぶシート */
export function ReservePicker({ reserves, moves, selected, excludeTxId, onPick, onClose }: Props) {
  return (
    <BottomSheet title="取り置きから払う" onClose={onClose}>
      <ul className="choice-list">
        {reserves.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={`choice${r.id === selected ? " selected" : ""}`}
              aria-pressed={r.id === selected}
              onClick={() => {
                onPick(r.id);
                onClose();
              }}
            >
              <span className="choice-text">
                <span className="choice-label">{r.name}</span>
                <span className="choice-desc">残高 {formatYen(balanceOf(r.id, moves, excludeTxId))}</span>
              </span>
              {r.id === selected && <Icon name="check" size={20} />}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="choice"
            onClick={() => {
              onPick(null);
              onClose();
            }}
          >
            <span className="choice-label">使わない</span>
          </button>
        </li>
      </ul>
    </BottomSheet>
  );
}
