// 金額のテンキーの式の組み立てと計算（画面から切り離した純粋なロジック）。
// 式は "1280+540" のような文字列で持つ（演算子は + - * /）。

export const MAX_DIGITS = 12;
export const MAX_AMOUNT = 999_999_999_999;

export type PadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "00" | "+" | "-" | "*" | "/" | "back";

export interface PadState {
  expr: string;
  /** true の間は、最初に押した数字が今の式を置き換える（編集で開いたとき） */
  fresh: boolean;
}

const OPERATORS = ["+", "-", "*", "/"];

function isOperator(ch: string): boolean {
  return OPERATORS.includes(ch);
}

/** 式の最後の数（演算子より後ろ） */
function lastOperand(expr: string): string {
  let i = expr.length;
  while (i > 0 && !isOperator(expr[i - 1])) i--;
  return expr.slice(i);
}

export function hasOperator(expr: string): boolean {
  return [...expr].some(isOperator);
}

/** 今の金額から始める状態（最初に数字を押すと置き換わる）。金額がなければ空 */
export function startPad(amount: number | null): PadState {
  return amount === null || amount <= 0 ? { expr: "", fresh: false } : { expr: String(amount), fresh: true };
}

/** キーを1つ押した後の状態 */
export function pressKey(state: PadState, key: PadKey): PadState {
  const { expr, fresh } = state;
  if (key === "back") return { expr: expr.slice(0, -1), fresh: false };
  if (isOperator(key)) {
    if (expr === "") return state;
    const last = expr[expr.length - 1];
    if (isOperator(last)) return { expr: expr.slice(0, -1) + key, fresh: false };
    return { expr: expr + key, fresh: false };
  }
  // 数字（00 を含む）
  if (fresh) {
    if (key === "00") return state;
    return { expr: key, fresh: false };
  }
  const operand = lastOperand(expr);
  if (key === "00") {
    if (operand === "" || operand === "0") return state;
  }
  const base = operand === "0" ? expr.slice(0, -1) : expr;
  const currentLen = operand === "0" ? 0 : operand.length;
  if (currentLen + key.length > MAX_DIGITS) return state;
  return { expr: base + key, fresh: false };
}

export type EvalResult = { ok: true; value: number } | { ok: false; reason: "empty" | "incomplete" | "divideByZero" | "notPositive" | "tooLarge" };

/** 式を計算して整数にする。掛け算・割り算を先に、割り算の端数は最後に四捨五入 */
export function evaluate(expr: string): EvalResult {
  if (expr === "") return { ok: false, reason: "empty" };
  if (isOperator(expr[expr.length - 1])) return { ok: false, reason: "incomplete" };
  const numbers: number[] = [];
  const ops: string[] = [];
  let current = "";
  for (const ch of expr) {
    if (isOperator(ch)) {
      numbers.push(Number(current));
      ops.push(ch);
      current = "";
    } else {
      current += ch;
    }
  }
  numbers.push(Number(current));
  // 掛け算・割り算（左から）
  const terms: number[] = [numbers[0]];
  const addOps: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const n = numbers[i + 1];
    const op = ops[i];
    if (op === "*") terms[terms.length - 1] *= n;
    else if (op === "/") {
      if (n === 0) return { ok: false, reason: "divideByZero" };
      terms[terms.length - 1] /= n;
    } else {
      addOps.push(op);
      terms.push(n);
    }
  }
  let total = terms[0];
  for (let i = 0; i < addOps.length; i++) total = addOps[i] === "+" ? total + terms[i + 1] : total - terms[i + 1];
  if (!Number.isFinite(total)) return { ok: false, reason: "tooLarge" };
  const value = Math.round(total);
  if (value <= 0) return { ok: false, reason: "notPositive" };
  if (value > MAX_AMOUNT) return { ok: false, reason: "tooLarge" };
  return { ok: true, value };
}

/** 「完了」を押せるか（式が完成していて、結果が1円以上12桁以内） */
export function canFinish(expr: string): boolean {
  return evaluate(expr).ok;
}

const SYMBOLS: Record<string, string> = { "+": "＋", "-": "−", "*": "×", "/": "÷" };

/** 画面に出す式：1,280＋540 */
export function formatExpr(expr: string): string {
  let out = "";
  let digits = "";
  const flush = () => {
    if (digits !== "") out += Number(digits).toLocaleString("ja-JP");
    digits = "";
  };
  for (const ch of expr) {
    if (isOperator(ch)) {
      flush();
      out += SYMBOLS[ch];
    } else {
      digits += ch;
    }
  }
  flush();
  return out;
}
