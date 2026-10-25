import { useCallback, useEffect, useState } from "react";
import { defaultSettings } from "./constants";
import { AssetsView } from "./AssetsView";
import { EntriesView } from "./EntriesView";
import { EntryView } from "./EntryView";
import type { EntryMode } from "./EntryView";
import { Fab } from "./Fab";
import { todayKey } from "./dateUtils";
import { getSuggestIndex } from "./suggestStore";
import { useToast } from "./Toast";
import { Icon } from "./Icon";
import { SettingsView } from "./SettingsView";
import { TABS, TabBar } from "./TabBar";
import type { TabId } from "./TabBar";
import { getSettings, requestPersistentStorage, saveSettings, seedCategoriesIfEmpty } from "./storage";
import type { PersistenceState } from "./storage";
import type { Settings, Transaction } from "./types";

/** 未実装のタブに出す案内（どの段階で作るか） */
const PLACEHOLDERS: Record<TabId, { title: string; stage: string; body: string }> = {
  home: { title: "ホーム", stage: "段階6", body: "使える額・今週あと◯円・今月の予算をここに出します（段階6）。入力は右下の＋から。" },
  entries: { title: "明細", stage: "段階3", body: "" },
  summary: { title: "集計", stage: "段階8", body: "分類別の比較や月ごとの推移を見られるようにします。" },
  outlook: { title: "見通し", stage: "段階6", body: "給料日ごとに、3〜6か月先のお金の見通しを出します。" },
  assets: { title: "資産", stage: "", body: "" },
};

export default function App() {
  const [tab, setTab] = useState<TabId>("home");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [persistence, setPersistence] = useState<PersistenceState>("unsupported");
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entry, setEntry] = useState<EntryMode | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [toast, showToast] = useToast();
  const today = todayKey();
  const bump = useCallback(() => setDataVersion((v) => v + 1), []);
  const openNew = useCallback((date: string) => setEntry({ kind: "new", date }), []);
  const openEntry = useCallback((mode: EntryMode) => setEntry(mode), []);
  const openEdit = useCallback((tx: Transaction) => setEntry({ kind: "edit", tx }), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await seedCategoriesIfEmpty();
        // 内容・メモの候補の集計を、開いたときに1回だけ作っておく
        void getSuggestIndex().catch(() => undefined);
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

  const entryOverlay = entry && (
    <div className="screen-overlay">
      <EntryView
        key={entry.kind === "new" ? `new-${entry.date}-${entry.transfer ? "t" : ""}` : `${entry.kind}-${entry.tx.id}`}
        mode={entry}
        today={today}
        showToast={showToast}
        onChanged={bump}
        onClose={() => setEntry(null)}
      />
    </div>
  );

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

  const tabBar = <TabBar current={tab} onSelect={setTab} />;

  if (tab === "assets") {
    return (
      <AssetsView
        tabBar={tabBar}
        today={today}
        version={dataVersion}
        onOpenSettings={() => setShowSettings(true)}
        onEdit={openEdit}
        onOpenEntry={openEntry}
        overlay={entryOverlay}
        onChanged={bump}
      />
    );
  }

  if (tab === "entries") {
    return (
      <div className="app">
        <EntriesView tabBar={tabBar} today={today} version={dataVersion} onOpenSettings={() => setShowSettings(true)} onAdd={openNew} onEdit={openEdit} onChanged={bump} />
        {entryOverlay}
        {toast}
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
      <Fab onClick={() => openNew(today)} />
      {tabBar}
      {entryOverlay}
      {toast}
    </div>
  );
}
