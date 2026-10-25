import { useEffect, useState } from "react";
import { defaultSettings } from "./constants";
import { Icon } from "./Icon";
import { SettingsView } from "./SettingsView";
import { TABS, TabBar } from "./TabBar";
import type { TabId } from "./TabBar";
import { getSettings, requestPersistentStorage, saveSettings, seedCategoriesIfEmpty } from "./storage";
import type { PersistenceState } from "./storage";
import type { Settings } from "./types";

/** 未実装のタブに出す案内（どの段階で作るか） */
const PLACEHOLDERS: Record<TabId, { title: string; stage: string; body: string }> = {
  home: { title: "ホーム", stage: "段階6", body: "使える額・今週あと◯円・今月の予算をここに出します。入力ボタンは段階3で付けます。" },
  entries: { title: "明細", stage: "段階3", body: "日別・週別・月別の明細を見て、タップして直せるようにします。" },
  summary: { title: "集計", stage: "段階8", body: "分類別の比較や月ごとの推移を見られるようにします。" },
  outlook: { title: "見通し", stage: "段階6", body: "給料日ごとに、3〜6か月先のお金の見通しを出します。" },
  assets: { title: "資産", stage: "段階2", body: "資産ごとの残高と、使える資産の合計を出します。" },
};

export default function App() {
  const [tab, setTab] = useState<TabId>("home");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [persistence, setPersistence] = useState<PersistenceState>("unsupported");
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await seedCategoriesIfEmpty();
        const loaded = await getSettings();
        if (!cancelled) setSettings(loaded);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "データを開けませんでした");
      }
      // 起動時に永続ストレージを求める（拒否されても動く）
      const state = await requestPersistentStorage();
      if (!cancelled) {
        setPersistence(state);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = async (next: Settings) => {
    await saveSettings(next);
    setSettings(next);
  };

  if (showSettings) {
    return (
      <div className="app">
        <SettingsView
          settings={settings}
          persistence={persistence}
          onPersistenceChange={setPersistence}
          onSettingsChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      </div>
    );
  }

  const current = TABS.find((t) => t.id === tab)!;
  const placeholder = PLACEHOLDERS[tab];

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="topbar-title">{current.label}</h1>
        <button type="button" className="icon-btn" aria-label="設定" onClick={() => setShowSettings(true)}>
          <Icon name="settings" size={22} />
        </button>
      </header>
      <main className="content">
        {loadError && <p className="notice danger" role="alert">{loadError}</p>}
        <section className="placeholder">
          <p className="placeholder-stage">{placeholder.stage}で作ります</p>
          <p className="placeholder-body">{placeholder.body}</p>
          {!ready && !loadError && <p className="muted">データを準備しています…</p>}
        </section>
      </main>
      <TabBar current={tab} onSelect={setTab} />
    </div>
  );
}
