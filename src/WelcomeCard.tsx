import { Icon } from "./Icon";

interface Props {
  onGoAssets: () => void;
  onGoCategories: () => void;
  onAdd: () => void;
  onOpenSettings: () => void;
}

/** ホームの先頭の「はじめに」：資産も明細もないとき（はじめて開いた人）だけ出す */
export function WelcomeCard({ onGoAssets, onGoCategories, onAdd, onOpenSettings }: Props) {
  const steps: Array<{ no: string; label: string; run: () => void }> = [
    { no: "①", label: "資産（財布・銀行・カードなど）を足す", run: onGoAssets },
    { no: "②", label: "分類を確かめる", run: onGoCategories },
    { no: "③", label: "＋から入力する", run: onAdd },
  ];
  return (
    <section className="card welcome-card" aria-label="はじめに">
      <h2 className="welcome-title">はじめに</h2>
      <ul className="list">
        {steps.map((s) => (
          <li key={s.no}>
            <button type="button" className="list-row" onClick={s.run}>
              <span className="welcome-no" aria-hidden="true">
                {s.no}
              </span>
              <span className="list-main">
                <span className="list-name">{s.label}</span>
              </span>
              <Icon name="chevron-right" size={18} />
            </button>
          </li>
        ))}
      </ul>
      <p className="field-hint welcome-note">
        ほかの家計簿のデータやバックアップがあれば、設定の「バックアップから追加」から読み込めます。
        <button type="button" className="text-btn" onClick={onOpenSettings}>
          設定を開く
        </button>
      </p>
    </section>
  );
}
