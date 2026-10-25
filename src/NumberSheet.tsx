import { useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { YenInput } from "./YenInput";

interface Props {
  title: string;
  description?: string;
  value: number;
  kind: "yen" | "days";
  /** エラーの文章。なければ null */
  validate: (value: number | null) => string | null;
  onSave: (value: number) => Promise<void> | void;
  onClose: () => void;
}

/** 金額・日数を1つ入れるシート（設定の行をタップしたとき） */
export function NumberSheet({ title, description, value, kind, validate, onSave, onClose }: Props) {
  const [n, setN] = useState<number | null>(value);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const error = validate(n);

  const save = async () => {
    if (error || n === null || busy) return;
    setBusy(true);
    try {
      await onSave(n);
      onClose();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  return (
    <BottomSheet title={title} onClose={onClose}>
      {description && <p className="sheet-message">{description}</p>}
      {kind === "yen" ? (
        <YenInput value={n} onChange={setN} autoFocus ariaLabel={title} />
      ) : (
        <div className="yen-input">
          <input
            className="text-input yen-field"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            aria-label={title}
            value={n === null ? "" : String(n)}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^0-9]/g, "").slice(0, 3);
              setN(digits === "" ? null : Number(digits));
            }}
          />
          <span className="unit">日</span>
        </div>
      )}
      {(error || failure) && (
        <p className="field-error" role="alert">
          {failure || error}
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="secondary-btn" onClick={onClose}>
          やめる
        </button>
        <button type="button" className="primary-btn" disabled={busy || error !== null} onClick={() => void save()}>
          保存
        </button>
      </div>
    </BottomSheet>
  );
}
