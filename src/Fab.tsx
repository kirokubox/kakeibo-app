import { Icon } from "./Icon";

/** 右下の＋ボタン（入力画面を開く） */
export function Fab({ onClick, label = "入力する" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="fab" aria-label={label} onClick={onClick}>
      <Icon name="plus" size={28} />
    </button>
  );
}
