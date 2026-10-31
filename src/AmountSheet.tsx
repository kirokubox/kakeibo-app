import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PadKeys, usePadKeyboard } from "./AmountPad";
import { formatExpr, hasOperator, padValue, pressKey, startPad } from "./calculator";
import type { PadKey, PadState } from "./calculator";
import { Icon } from "./Icon";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  title: string;
  /** 今の金額（符号なし）。空欄は null */
  value: number | null;
  /** マイナスの欄で、いまマイナスになっているか（表示だけ） */
  negative?: boolean;
  /** 完了・閉じたときの金額（符号なし）。空欄は null */
  onDone: (value: number | null) => void;
  onClose: () => void;
}

/**
 * 金額の欄を押したときに下から出す、電卓つきのテンキー（入力画面の金額と同じキー。#29）。
 * スマホの文字キーボードを出さないので、画面がずれない。ほかのシートの上にも重ねられるよう body の直下に出す。
 * 閉じる（×・背景・Esc）ときも、打った式が計算できれば入れる（入力画面の金額と同じ）。
 */
export function AmountSheet({ title, value, negative = false, onDone, onClose }: Props) {
  const [pad, setPad] = useState<PadState>(() => startPad(value));
  const result = padValue(pad.expr);
  const finishable = result !== undefined;
  const calc = hasOperator(pad.expr);

  // 開いたら、ほかの欄のキーボードを閉じる
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  const key = (k: PadKey) => setPad((p) => pressKey(p, k));
  const finish = () => {
    if (!finishable) return;
    onDone(result);
    onClose();
  };
  const close = () => {
    if (finishable && !pad.fresh) onDone(result);
    onClose();
  };
  usePadKeyboard({ onKey: key, onFinish: finish, onEscape: close });
  const backdrop = useBackdropClose(close);

  const shown = pad.expr === "" ? "" : formatExpr(pad.expr);
  return createPortal(
    <div className="pad-backdrop" {...backdrop}>
      <section className="pad-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn small" aria-label="閉じる" onClick={close}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="pad-display" aria-live="polite">
          <span className={`pad-display-value${pad.fresh ? " selected" : ""}`}>
            {shown === "" ? <span className="entry-ph">0</span> : `${negative ? "−" : ""}${shown}`}
          </span>
          <span className="unit">円</span>
        </div>
        {calc && typeof result === "number" && <p className="pad-preview">＝ {result.toLocaleString("ja-JP")}円</p>}
        <PadKeys onKey={key} onFinish={finish} finishable={finishable} calc={calc} />
      </section>
    </div>,
    document.body,
  );
}
