import { canFinish, hasOperator } from "./calculator";
import type { PadKey } from "./calculator";
import { PanelFrame } from "./PanelFrame";

interface Props {
  expr: string;
  onKey: (key: PadKey) => void;
  onFinish: () => void;
  onClose: () => void;
}

const LAYOUT: Array<Array<{ key: PadKey; label: string; kind?: "op" | "back" }>> = [
  [{ key: "7", label: "7" }, { key: "8", label: "8" }, { key: "9", label: "9" }, { key: "/", label: "÷", kind: "op" }],
  [{ key: "4", label: "4" }, { key: "5", label: "5" }, { key: "6", label: "6" }, { key: "*", label: "×", kind: "op" }],
  [{ key: "1", label: "1" }, { key: "2", label: "2" }, { key: "3", label: "3" }, { key: "-", label: "−", kind: "op" }],
  [{ key: "0", label: "0" }, { key: "00", label: "00" }, { key: "back", label: "⌫", kind: "back" }, { key: "+", label: "＋", kind: "op" }],
];

/** 金額のテンキー（電卓つき）。式は金額の行に出すので、ここにはキーだけ */
export function AmountPad({ expr, onKey, onFinish, onClose }: Props) {
  const finishable = canFinish(expr);
  const calc = hasOperator(expr);
  return (
    <PanelFrame title="金額" onClose={onClose}>
      <div className="pad-grid">
        {LAYOUT.flat().map((k) => (
          <button
            key={k.key}
            type="button"
            className={`pad-key${k.kind ? ` ${k.kind}` : ""}`}
            aria-label={k.kind === "back" ? "1文字消す" : undefined}
            onClick={() => onKey(k.key)}
          >
            {k.label}
          </button>
        ))}
        <button type="button" className="pad-key finish" aria-label="完了" disabled={!finishable} onClick={onFinish}>
          {calc ? "＝" : "完了"}
        </button>
      </div>
    </PanelFrame>
  );
}
