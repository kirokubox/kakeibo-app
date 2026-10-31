import { useEffect, useRef } from "react";
import { canFinish, hasOperator } from "./calculator";
import type { PadKey } from "./calculator";
import { PanelFrame } from "./PanelFrame";

interface Props {
  /** パネルの見出し（振替の手数料では「手数料」）。省略は「金額」 */
  title?: string;
  expr: string;
  onKey: (key: PadKey) => void;
  onFinish: () => void;
  onClose: () => void;
}

type KeyDef = { key: PadKey; label: string; kind?: "op" | "back" };

const LAYOUT: KeyDef[][] = [
  [{ key: "7", label: "7" }, { key: "8", label: "8" }, { key: "9", label: "9" }, { key: "/", label: "÷", kind: "op" }],
  [{ key: "4", label: "4" }, { key: "5", label: "5" }, { key: "6", label: "6" }, { key: "*", label: "×", kind: "op" }],
  [{ key: "1", label: "1" }, { key: "2", label: "2" }, { key: "3", label: "3" }, { key: "-", label: "−", kind: "op" }],
  [{ key: "0", label: "0" }, { key: "00", label: "00" }, { key: "back", label: "⌫", kind: "back" }, { key: "+", label: "＋", kind: "op" }],
];

/** 日数など、計算のいらない数字だけのテンキー */
const DIGITS_LAYOUT: KeyDef[][] = [
  [{ key: "7", label: "7" }, { key: "8", label: "8" }, { key: "9", label: "9" }],
  [{ key: "4", label: "4" }, { key: "5", label: "5" }, { key: "6", label: "6" }],
  [{ key: "1", label: "1" }, { key: "2", label: "2" }, { key: "3", label: "3" }],
  [{ key: "0", label: "0" }, { key: "back", label: "⌫", kind: "back" }],
];

interface KeysProps {
  onKey: (key: PadKey) => void;
  onFinish: () => void;
  finishable: boolean;
  /** 式に演算子があるとき、完了のキーを「＝」にする */
  calc?: boolean;
  /** 完了のキーの文字（設定のシートでは「保存」） */
  finishLabel?: string;
  /** digits：計算のキーを出さない（日数など） */
  variant?: "amount" | "digits";
}

/** テンキーのキーだけ（入力画面の金額・金額の欄・設定の数字で共通。#29） */
export function PadKeys({ onKey, onFinish, finishable, calc = false, finishLabel = "完了", variant = "amount" }: KeysProps) {
  const layout = variant === "digits" ? DIGITS_LAYOUT : LAYOUT;
  return (
    <div className={`pad-grid${variant === "digits" ? " digits" : ""}`}>
      {layout.flat().map((k) => (
        <button
          key={k.key}
          type="button"
          className={`pad-key${k.kind ? ` ${k.kind}` : ""}${variant === "digits" && k.key === "0" ? " wide" : ""}`}
          aria-label={k.kind === "back" ? "1文字消す" : undefined}
          onClick={() => onKey(k.key)}
        >
          {k.label}
        </button>
      ))}
      <button type="button" className="pad-key finish" aria-label={calc ? "計算して完了" : finishLabel} disabled={!finishable} onClick={onFinish}>
        {calc ? "＝" : finishLabel}
      </button>
    </div>
  );
}

const KEY_MAP: Record<string, PadKey> = { "+": "+", "-": "-", "*": "*", "/": "/", Backspace: "back" };

/** PCのキーボードでもテンキーを打てるようにする（数字・＋−×÷・Backspace・Enter・Esc）。開いている間だけ */
export function usePadKeyboard(handlers: { onKey: (key: PadKey) => void; onFinish: () => void; onEscape?: () => void; digitsOnly?: boolean }) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const h = ref.current;
      let key: PadKey | null = null;
      if (/^[0-9]$/.test(e.key)) key = e.key as PadKey;
      else if (KEY_MAP[e.key] && !(h.digitsOnly && e.key !== "Backspace")) key = KEY_MAP[e.key];
      if (key) {
        e.preventDefault();
        h.onKey(key);
      } else if (e.key === "Enter") {
        e.preventDefault();
        h.onFinish();
      } else if (e.key === "Escape" && h.onEscape) {
        // 下にあるシートの Esc（document で聞いている）まで閉じないように、ここで止める
        e.preventDefault();
        e.stopPropagation();
        h.onEscape();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

/** 金額のテンキー（電卓つき）。式は金額の行に出すので、ここにはキーだけ */
export function AmountPad({ title = "金額", expr, onKey, onFinish, onClose }: Props) {
  return (
    <PanelFrame title={title} onClose={onClose}>
      <PadKeys onKey={onKey} onFinish={onFinish} finishable={canFinish(expr)} calc={hasOperator(expr)} />
    </PanelFrame>
  );
}
