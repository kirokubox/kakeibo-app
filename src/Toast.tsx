import { useCallback, useEffect, useRef, useState } from "react";

/** 画面の下に短く出すお知らせ。`const [toast, showToast] = useToast()` で、toast を画面のどこかに置く */
export function useToast(): [React.ReactNode, (text: string, ms?: number) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((message: string, ms = 2400) => {
    window.clearTimeout(timer.current);
    setText(message);
    timer.current = window.setTimeout(() => setText(null), ms);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const node = text === null ? null : (
    <div className="toast" role="status" aria-live="polite">
      {text}
    </div>
  );
  return [node, show];
}
