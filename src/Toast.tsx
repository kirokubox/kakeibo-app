import { useCallback, useEffect, useRef, useState } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export type ShowToast = (text: string, ms?: number, action?: ToastAction) => void;

/** 画面の下に短く出すお知らせ。`const [toast, showToast] = useToast()` で、toast を画面のどこかに置く。action を渡すと「元に戻す」などのボタンが付く */
export function useToast(): [React.ReactNode, ShowToast] {
  const [state, setState] = useState<{ text: string; action?: ToastAction } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback<ShowToast>((message, ms = 2400, action) => {
    window.clearTimeout(timer.current);
    setState({ text: message, action });
    timer.current = window.setTimeout(() => setState(null), ms);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const node =
    state === null ? null : (
      <div className="toast" role="status" aria-live="polite">
        <span>{state.text}</span>
        {state.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              const act = state.action;
              window.clearTimeout(timer.current);
              setState(null);
              act?.onClick();
            }}
          >
            {state.action.label}
          </button>
        )}
      </div>
    );
  return [node, show];
}
