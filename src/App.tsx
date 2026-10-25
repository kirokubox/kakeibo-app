import { useCallback, useEffect, useRef, useState } from "react";
import { defaultSettings } from "./constants";
import { AssetsView } from "./AssetsView";
import { ensureBudgets } from "./budgetStore";
import { EntriesView } from "./EntriesView";
import { EntryView } from "./EntryView";
import type { EntryMode } from "./EntryView";
import { Fab } from "./Fab";
import { HomeView } from "./HomeView";
import { OutlookView } from "./OutlookView";
import { todayKey } from "./dateUtils";
import { PayrollEntryView } from "./PayrollEntryView";
import { RecurringLabelsContext, generateDueRecurrings, loadRecurringLabels } from "./recurringStore";
import { getSuggestIndex } from "./suggestStore";
import { useToast } from "./Toast";
import { Icon } from "./Icon";
import { SettingsView } from "./SettingsView";
import { TABS, TabBar } from "./TabBar";
import type { TabId } from "./TabBar";
import { getSettings, requestPersistentStorage, saveSettings, seedCategoriesIfEmpty } from "./storage";
import type { PersistenceState } from "./storage";
import type { Id, Settings, Transaction } from "./types";

/** 未実装のタブに出す案内（どの段階で作るか） */
const PLACEHOLDERS: Record<TabId, { title: string; stage: string; body: string }> = {
  home: { title: "ホーム", stage: "", body: "" },
  entries: { title: "明細", stage: "段階3", body: "" },
  summary: { title: "集計", stage: "段階8", body: "分類別の比較や月ごとの推移を見られるようにします。" },
  outlook: { title: "見通し", stage: "", body: "" },
  assets: { title: "資産", stage: "", body: "" },
};

/** 給料明細の入力画面を開く指定（payrollId が null ならひな形を選ぶ。batchId があれば1枚まるごと直す） */
interface PayrollTarget {
  payrollId: Id | null;
  batchId: Id | null;
}

export default function App() {
  const [tab, setTab] = useState<TabId>("home");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [persistence, setPersistence] = useState<PersistenceState>("unsupported");
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entry, setEntry] = useState<EntryMode | null>(null);
  const [payroll, setPayroll] = useState<PayrollTarget | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [recurringLabels, setRecurringLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [toast, showToast] = useToast();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // 日付が変わったら（0時をまたいだ・長く開いたまま・戻ってきた）今日を更新する
  const [today, setToday] = useState(todayKey);
  const bump = useCallback(() => setDataVersion((v) => v + 1), []);
  const openNew = useCallback((date: string) => setEntry({ kind: "new", date }), []);
  const openEntry = useCallback((mode: EntryMode) => setEntry(mode), []);
  const openEdit = useCallback((tx: Transaction) => setEntry({ kind: "edit", tx }), []);
  const openPayroll = useCallback((target: { payrollId?: Id; batchId?: Id }) => {
    setEntry(null);
    setPayroll({ payrollId: target.payrollId ?? null, batchId: target.batchId ?? null });
  }, []);

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

  /** 繰り返しの明細を、今日までに来た分だけ作る（同時に呼ばれても二重に作らない） */
  const runRecurring = useCallback(
    async (day: string) => {
      try {
        const n = await generateDueRecurrings(day);
        if (n > 0) {
          bump();
          showToast(`繰り返しの明細を${n}件入れました`, 4000);
        }
      } catch {
        // 保存できなかったときは何も作られていない。次に開いたときにもう一度試す
      }
    },
    [bump, showToast],
  );

  /** まだ決まっていない今週・今月の予算を決める(二重には作らない)。繰り返しの明細を作ったあとに呼ぶ */
  const runBudgets = useCallback(
    async (day: string, current: Settings) => {
      try {
        if ((await ensureBudgets(current, day)) > 0) bump();
      } catch {
        // 決められなかったときは何も書かれていない。次に開いたときにもう一度試す
      }
    },
    [bump],
  );

  // アプリを開いたとき・日付が変わったとき
  useEffect(() => {
    if (!ready) return;
    void runRecurring(today).then(() => runBudgets(today, settings));
  }, [ready, today, settings, runRecurring, runBudgets]);

  // 画面に戻ったとき・開いたまま日付が変わったとき
  useEffect(() => {
    const refresh = () => {
      const day = todayKey();
      setToday(day);
      if (document.visibilityState === "visible") void runRecurring(day).then(() => runBudgets(day, settingsRef.current));
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(() => setToday(todayKey()), 60_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [runRecurring, runBudgets]);

  // 明細の行の「(毎月)」の材料
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    loadRecurringLabels()
      .then((m) => !cancelled && setRecurringLabels(m))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ready, dataVersion, showSettings]);

  const updateSettings = async (next: Settings) => {
    await saveSettings(next);
    setSettings(next);
  };

  const entryOverlay = entry && (
    <div className="screen-overlay">
      <EntryView
        key={entry.kind === "new" ? `new-${entry.date}-${entry.transfer ? "t" : ""}` : entry.kind === "recurring" ? `rec-${entry.rec.id}` : `${entry.kind}-${entry.tx.id}`}
        mode={entry}
        today={today}
        showToast={showToast}
        onChanged={bump}
        onClose={() => setEntry(null)}
        onOpenPayroll={openPayroll}
      />
    </div>
  );

  const payrollOverlay = payroll && (
    <div className="screen-overlay">
      <PayrollEntryView
        key={`${payroll.payrollId ?? "pick"}-${payroll.batchId ?? "new"}`}
        payrollId={payroll.payrollId}
        batchId={payroll.batchId}
        today={today}
        showToast={showToast}
        onClose={() => setPayroll(null)}
        onSaved={(message) => {
          setPayroll(null);
          bump();
          showToast(message);
        }}
      />
    </div>
  );
  const overlays = (
    <>
      {entryOverlay}
      {payrollOverlay}
    </>
  );

  const body = (() => {
    if (showSettings) {
      return (
        <div className="app">
          <SettingsView
            settings={settings}
            persistence={persistence}
            onPersistenceChange={setPersistence}
            onSettingsChange={updateSettings}
            onClose={() => {
              setShowSettings(false);
              bump();
            }}
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
          overlay={overlays}
          onChanged={bump}
        />
      );
    }

    if (tab === "entries") {
      return (
        <div className="app">
          <EntriesView tabBar={tabBar} today={today} version={dataVersion} onOpenSettings={() => setShowSettings(true)} onAdd={openNew} onEdit={openEdit} onChanged={bump} />
          {overlays}
        </div>
      );
    }

    if (tab === "home") {
      return (
        <div className="app">
          <HomeView
            tabBar={tabBar}
            today={today}
            version={dataVersion}
            settings={settings}
            onOpenSettings={() => setShowSettings(true)}
            onAdd={openNew}
            onEdit={openEdit}
            onOpenPayroll={() => openPayroll({})}
            onGoEntries={() => setTab("entries")}
            onChanged={bump}
          />
          {overlays}
        </div>
      );
    }

    if (tab === "outlook") {
      return (
        <div className="app">
          <OutlookView tabBar={tabBar} today={today} version={dataVersion} settings={settings} onOpenSettings={() => setShowSettings(true)} onAdd={openNew} onChanged={bump} />
          {overlays}
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
        {overlays}
      </div>
    );
  })();

  return (
    <RecurringLabelsContext.Provider value={recurringLabels}>
      {body}
      {toast}
    </RecurringLabelsContext.Provider>
  );
}
