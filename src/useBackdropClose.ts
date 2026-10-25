import { useRef } from "react";

/**
 * モーダルの外側（背景）をタップしたら閉じる。
 * 背景の上で押し始めて、背景の上で離したときだけ反応する（シート内のスクロールが背景で終わっても閉じない）。
 */
export function useBackdropClose(onClose: () => void) {
  const downOnBackdrop = useRef(false);
  return {
    onPointerDown: (ev: React.PointerEvent<HTMLDivElement>) => {
      downOnBackdrop.current = ev.target === ev.currentTarget;
    },
    onClick: (ev: React.MouseEvent<HTMLDivElement>) => {
      const hit = downOnBackdrop.current && ev.target === ev.currentTarget;
      downOnBackdrop.current = false;
      if (hit) onClose();
    },
  };
}
