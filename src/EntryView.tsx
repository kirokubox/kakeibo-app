import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountPanel } from "./AccountPanel";
import { AmountPad } from "./AmountPad";
import { evaluate, formatExpr, pressKey, startPad } from "./calculator";
import type { PadKey, PadState } from "./calculator";
import { CategoryPanel } from "./CategoryPanel";
import { ConfirmSheet } from "./BottomSheet";
import { formatDateJa, isLocalDate, nowIso } from "./dateUtils";
import {
  TAG_LABELS,
  applyHint,
  categoryNames,
  checkDraft,
  continueDraft,
  copyDraft,
  draftFromTransaction,
  draftToTemplate,
  draftToTransaction,
  emptyDraft,
  kindOf,
  nextFavoriteOrder,
  recallFavorite,
  selectableAccounts,
  selectableCategoryGroups,
  tagAfterCategoryChange,
  tagOptions,
  usageHint,
} from "./entryLogic";
import type { EntryDraft, EntryType, MissingField } from "./entryLogic";
import { FavoritesView } from "./FavoritesView";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { PREF_LAST_ACCOUNT, readPref, writePref } from "./localPrefs";
import { getAll, newBase, saveRecord, softDelete } from "./storage";
import { getSuggestIndex, noteTransactionChanged } from "./suggestStore";
import { currentWord, lastUsageOf, replaceCurrentWord, suggestContents, suggestMemoWords } from "./suggestLogic";
import type { SuggestIndex } from "./suggestLogic";
import type { ShowToast } from "./Toast";
import type { Account, Category, Favorite, Id, Transaction } from "./types";

export type EntryMode =
  | { kind: "new"; date: string; type?: EntryType }
  | { kind: "edit"; tx: Transaction }
  | { kind: "copy"; tx: Transaction; today: string };

interface Props {
  mode: EntryMode;
  today: string;
  showToast: ShowToast;
  /** 保存・削除・元に戻すのあと（一覧を読み直してもらう） */
  onChanged: () => void;
  onClose: () => void;
}

type Panel = "account" | "category" | "amount" | null;
type Sheet = null | "discard" | "delete" | "favorites";

const TYPE_LABELS: Record<EntryType, string> = { income: "収入", expense: "支出" };

function initialDraft(mode: EntryMode): EntryDraft {
  if (mode.kind === "new") return emptyDraft(mode.type ?? "expense", mode.date);
  const d = mode.kind === "edit" ? draftFromTransaction(mode.tx) : copyDraft(mode.tx, mode.today);
  return d ?? emptyDraft("expense", mode.kind === "copy" ? mode.today : mode.tx.date);
}

/** 入力画面（収入・支出）。新規・編集・コピー */
export function EntryView({ mode, today, showToast, onChanged, onClose }: Props) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [index, setIndex] = useState<SuggestIndex | null>(null);
  const [existing, setExisting] = useState<Transaction | undefined>(mode.kind === "edit" ? mode.tx : undefined);
  const [draft, setDraft] = useState<EntryDraft>(() => initialDraft(mode));
  const [initialJson, setInitialJson] = useState(() => JSON.stringify(initialDraft(mode)));
  const [panel, setPanel] = useState<Panel>(null);
  const [pad, setPad] = useState<PadState>({ expr: "", fresh: false });
  const [error, setError] = useState<MissingField | null>(null);
  const [shake, setShake] = useState(false);
  const [decided, setDecided] = useState<string | null>(null);
  const [contentFocused, setContentFocused] = useState(false);
  const [memoFocused, setMemoFocused] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [saving, setSaving] = useState(false);
  const [lastAccountId, setLastAccountId] = useState<Id | null>(() => readPref(PREF_LAST_ACCOUNT));
  const [loadError, setLoadError] = useState("");

  const contentRef = useRef<HTMLInputElement>(null);
  const memoRef = useRef<HTMLTextAreaElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const shakeTimer = useRef<number | undefined>(undefined);

  const source = existing?.source ?? "manual";
  const isEdit = existing !== undefined;

  // 資産・分類・候補の集計を読む
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [a, c] = await Promise.all([getAll("accounts"), getAll("categories")]);
        if (cancelled) return;
        setAccounts(a);
        setCategories(c);
        if (mode.kind === "new") setPanel("account"); // 新規で開いたら、すぐ資産のパネル
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "データを開けませんでした");
      }
    })();
    getSuggestIndex()
      .then((i) => !cancelled && setIndex(i))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearTimeout(shakeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // パネルを開いたとき、入力中の行が隠れない位置までずらす
  useEffect(() => {
    if (!panel) return;
    const id = window.setTimeout(() => rowRefs.current[panel]?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 30);
    return () => window.clearTimeout(id);
  }, [panel]);

  // メモ欄の高さを中身に合わせる
  useEffect(() => {
    const el = memoRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft.memo, accounts, sheet]);

  const accountList = accounts ?? [];
  const category = useMemo(() => categories.find((c) => c.id === draft.categoryId), [categories, draft.categoryId]);
  const names = categoryNames(categories, draft.categoryId);
  const account = accountList.find((a) => a.id === draft.accountId);
  const tags = tagOptions(draft.type, category);
  const dirty = JSON.stringify(draft) !== initialJson;

  const hint = useMemo(() => {
    if (!index || decided === null || decided === "" || decided !== draft.content.trim()) return null;
    return usageHint(lastUsageOf(index, draft.type, decided), draft, accountList, categories);
  }, [index, decided, draft, accountList, categories]);

  const contentSuggestions = useMemo(
    () => (index && contentFocused ? suggestContents(index, draft.type, draft.content, today, draft.categoryId) : []),
    [index, contentFocused, draft.type, draft.content, draft.categoryId, today],
  );
  const memoSuggestions = useMemo(() => (index && memoFocused ? suggestMemoWords(index, draft.memo) : []), [index, memoFocused, draft.memo]);

  const hintLabel = useMemo(() => {
    if (!hint) return "";
    const n = categoryNames(categories, hint.categoryId);
    const a = accountList.find((x) => x.id === hint.accountId);
    const parts = [n ? (n.child ? `${n.parent}＞${n.child}` : n.parent) : "", a?.name ?? "", hint.tag ? TAG_LABELS[hint.tag] : ""].filter(Boolean);
    return parts.join("・");
  }, [hint, categories, accountList]);

  // ---- パネルの出し入れと自動で次へ ----

  const openPad = (d: EntryDraft) => {
    setPad(startPad(d.amount));
    setPanel("amount");
  };

  /** 金額のテンキーに打ちかけの式があれば、計算できるときだけ金額に入れる */
  const commitPad = (): EntryDraft => {
    if (panel !== "amount") return draft;
    const r = evaluate(pad.expr);
    if (!r.ok) return draft;
    const d = { ...draft, amount: r.value };
    setDraft(d);
    return d;
  };

  const openPanel = (next: Exclude<Panel, null>) => {
    if (panel === next) return;
    const d = commitPad();
    if (next === "amount") openPad(d);
    else setPanel(next);
    contentRef.current?.blur();
    memoRef.current?.blur();
  };

  const closePanel = () => {
    commitPad();
    setPanel(null);
  };

  const focusContent = () => {
    setPanel(null);
    window.setTimeout(() => contentRef.current?.focus(), 30);
  };

  /** 選んだ項目の次の、まだ空いている項目へ進む。金額のあとだけ内容へ（選び直しでキーボードが勝手に出ないように） */
  const advance = (from: "account" | "category" | "amount", d: EntryDraft) => {
    if (from === "account" && !d.categoryId) return openPanel("category");
    if ((from === "account" || from === "category") && d.amount === null) return openPad(d);
    if (from === "amount" && d.content.trim() === "") return focusContent();
    setPanel(null);
  };

  const selectAccount = (id: Id) => {
    const d = { ...draft, accountId: id };
    setDraft(d);
    setLastAccountId(id);
    if (error === "account") setError(null);
    advance("account", d);
  };

  const selectCategory = (id: Id) => {
    const c = categories.find((x) => x.id === id);
    const d = { ...draft, categoryId: id, tag: tagAfterCategoryChange(draft.tag, draft.type, c) };
    setDraft(d);
    if (error === "category" || error === "tag") setError(null);
    advance("category", d);
  };

  const padKey = (key: PadKey) => setPad((p) => pressKey(p, key));

  const finishPad = () => {
    const r = evaluate(pad.expr);
    if (!r.ok) return;
    const d = { ...draft, amount: r.value };
    setDraft(d);
    if (error === "amount") setError(null);
    advance("amount", d);
  };

  const changeType = (type: EntryType | "transfer") => {
    if (type === "transfer") {
      showToast("振替は段階4で使えます");
      return;
    }
    if (type === draft.type) return;
    commitPad();
    setDraft((d) => ({ ...d, type, categoryId: null, tag: null }));
    setDecided(null);
    openPanel("category");
  };

  const chooseTag = (tag: (typeof tags)[number]) => {
    setDraft((d) => ({ ...d, tag }));
    if (error === "tag") setError(null);
  };

  // ---- 保存 ----

  const rejectMissing = (field: MissingField, message: string) => {
    setError(field);
    if (field === "account") openPanel("account");
    else if (field === "category") openPanel("category");
    else if (field === "amount") openPanel("amount");
    else {
      setShake(true);
      window.clearTimeout(shakeTimer.current);
      shakeTimer.current = window.setTimeout(() => setShake(false), 500);
      showToast(message);
      rowRefs.current.tag?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };

  const save = async (andContinue: boolean) => {
    if (saving) return;
    const d = commitPad();
    const check = checkDraft(d, categories, source);
    if (!check.ok) {
      rejectMissing(check.field, check.message);
      return;
    }
    setSaving(true);
    try {
      const record = draftToTransaction(d, categories, newBase(), existing);
      const saved = await saveRecord("transactions", record);
      noteTransactionChanged(saved);
      if (d.accountId) writePref(PREF_LAST_ACCOUNT, d.accountId);
      onChanged();
      if (!andContinue) {
        showToast("保存しました");
        onClose();
        return;
      }
      const next = continueDraft(d);
      setExisting(undefined);
      setDraft(next);
      setInitialJson(JSON.stringify(next));
      setDecided(null);
      setError(null);
      showToast("保存しました（続けて入力）");
      setPanel("category");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      setSaving(false);
    }
  };

  const goBack = () => {
    if (dirty) setSheet("discard");
    else onClose();
  };

  const remove = async () => {
    if (!existing) return;
    setSaving(true);
    try {
      await softDelete("transactions", existing.id);
      const now = nowIso();
      noteTransactionChanged({ ...existing, deletedAt: now, updatedAt: now });
      onChanged();
      const original = existing;
      showToast("削除しました", 5000, {
        label: "元に戻す",
        onClick: () => {
          saveRecord("transactions", { ...original, deletedAt: null })
            .then((restored) => {
              noteTransactionChanged(restored);
              onChanged();
              showToast("元に戻しました");
            })
            .catch((e) => showToast(e instanceof Error ? e.message : "元に戻せませんでした"));
        },
      });
      onClose();
    } catch (e) {
      setSheet(null);
      setSaving(false);
      showToast(e instanceof Error ? e.message : "削除できませんでした");
    }
  };

  const registerFavorite = async () => {
    if (!draft.accountId && !draft.categoryId && draft.amount === null && draft.content.trim() === "") {
      showToast("先に内容を入れてください");
      return;
    }
    try {
      const all = await getAll("favorites");
      const rec: Favorite = { ...newBase(), template: draftToTemplate(draft), order: nextFavoriteOrder(all) };
      await saveRecord("favorites", rec);
      showToast("よく使う入力に登録しました");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "登録できませんでした");
    }
  };

  const copyAsNew = () => {
    if (!existing) return;
    const d = copyDraft(existing, today);
    if (!d) return;
    setExisting(undefined);
    setDraft(d);
    setInitialJson(JSON.stringify(d));
    setDecided(null);
    setPanel(null);
    showToast("コピーして新しく入力します");
  };

  const menu = [
    { label: "よく使う入力に登録", onSelect: () => void registerFavorite() },
    ...(isEdit
      ? [
          { label: "コピーして新しく入力", onSelect: copyAsNew },
          { label: "削除", onSelect: () => setSheet("delete"), danger: true },
        ]
      : []),
  ];

  const recall = useCallback(
    (template: Favorite["template"]) => {
      const r = recallFavorite(template, draft, accountList, categories);
      if (!r) return;
      setSheet(null);
      setDraft(r.draft);
      setDecided(null);
      setError(null);
      if (r.focus === "amount") openPad(r.draft);
      else setPanel(r.focus);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, accountList, categories],
  );

  // ---- 表示 ----

  const title = `${TYPE_LABELS[draft.type]}${isEdit ? "を編集" : ""}`;
  const amountText =
    panel === "amount" ? (pad.expr === "" ? "" : formatExpr(pad.expr)) : draft.amount === null ? "" : draft.amount.toLocaleString("ja-JP");
  const setRowRef = (key: string) => (el: HTMLElement | null) => {
    rowRefs.current[key] = el;
  };

  if (sheet === "favorites") {
    return (
      <FavoritesView accounts={accountList} categories={categories} onPick={recall} onClose={() => setSheet(null)} showToast={showToast} />
    );
  }

  return (
    <div className="entry-screen">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={goBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{title}</h1>
        <button type="button" className="icon-btn" aria-label="よく使う入力" onClick={() => setSheet("favorites")}>
          <Icon name="star" size={22} />
        </button>
        <KebabMenu items={menu} />
      </header>

      <main className="entry-body">
        {loadError && (
          <p className="notice danger" role="alert">
            {loadError}
          </p>
        )}
        {accounts === null && !loadError && <p className="muted">読み込んでいます…</p>}
        {accounts !== null && (
          <>
            <div className="segmented entry-types" role="group" aria-label="種類">
              {(["income", "expense"] as const).map((t) => (
                <button key={t} type="button" className={`seg${draft.type === t ? " on" : ""}`} aria-pressed={draft.type === t} onClick={() => changeType(t)}>
                  {TYPE_LABELS[t]}
                </button>
              ))}
              <button type="button" className="seg" onClick={() => changeType("transfer")}>
                振替
              </button>
            </div>

            <section className="entry-rows">
              <div className="entry-row">
                <span className="entry-label">日付</span>
                <label className="entry-value date-label">
                  {isLocalDate(draft.date) ? formatDateJa(draft.date) : draft.date}
                  <input
                    ref={dateRef}
                    type="date"
                    className="date-overlay"
                    aria-label="日付"
                    value={draft.date}
                    onChange={(e) => isLocalDate(e.target.value) && setDraft((d) => ({ ...d, date: e.target.value }))}
                    onClick={(e) => {
                      try {
                        e.currentTarget.showPicker?.();
                      } catch {
                        // 開けなくても、入力欄そのものは使える
                      }
                    }}
                  />
                </label>
                <button type="button" className="text-btn repeat-btn" onClick={() => showToast("繰り返しは段階5で使えます")}>
                  繰り返し
                </button>
              </div>

              <button
                type="button"
                ref={setRowRef("account")}
                className={`entry-row tap${error === "account" ? " invalid" : ""}${panel === "account" ? " active" : ""}`}
                onClick={() => openPanel("account")}
              >
                <span className="entry-label">資産</span>
                <span className="entry-value">{account ? account.name : <span className="entry-ph">選んでください</span>}</span>
              </button>

              <button
                type="button"
                ref={setRowRef("category")}
                className={`entry-row tap${error === "category" ? " invalid" : ""}${panel === "category" ? " active" : ""}`}
                onClick={() => openPanel("category")}
              >
                <span className="entry-label">分類</span>
                <span className="entry-value">
                  {names ? (names.child ? `${names.parent}＞${names.child}` : names.parent) : <span className="entry-ph">選んでください</span>}
                </span>
              </button>

              <button
                type="button"
                ref={setRowRef("amount")}
                className={`entry-row tap${error === "amount" ? " invalid" : ""}${panel === "amount" ? " active" : ""}`}
                onClick={() => openPanel("amount")}
              >
                <span className="entry-label">金額</span>
                <span className={`entry-value amount${panel === "amount" && pad.fresh ? " selected" : ""}`}>
                  {amountText === "" ? <span className="entry-ph">0</span> : amountText}
                  <span className="unit">円</span>
                </span>
              </button>

              <div className="entry-row content-row" ref={setRowRef("content")}>
                <label className="entry-label" htmlFor="entry-content">
                  内容
                </label>
                <input
                  id="entry-content"
                  ref={contentRef}
                  className="entry-input"
                  type="text"
                  autoComplete="off"
                  placeholder="店名など（空でも保存できます）"
                  value={draft.content}
                  onFocus={() => {
                    setContentFocused(true);
                    if (panel) closePanel();
                  }}
                  onBlur={(e) => {
                    setContentFocused(false);
                    setDecided(e.currentTarget.value.trim());
                  }}
                  onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                />
              </div>
              {contentSuggestions.length > 0 && (
                <ul className="suggest" aria-label="内容の候補">
                  {contentSuggestions.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        className="chip"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          contentRef.current?.blur(); // 先に離れてから内容を入れる（離れたときの「決めた内容」を上書きするため）
                          setDraft((d) => ({ ...d, content: s }));
                          setDecided(s);
                        }}
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {hint && (
                <div className="hint" role="status">
                  <span className="hint-text">前回：{hintLabel}</span>
                  <button type="button" className="secondary-btn hint-btn" onClick={() => setDraft((d) => applyHint(d, hint))}>
                    合わせる
                  </button>
                </div>
              )}

              {tags.length > 0 && (
                <div className={`entry-row tag-row${error === "tag" ? " invalid" : ""}${shake ? " shake" : ""}`} ref={setRowRef("tag")}>
                  <span className="entry-label">タグ</span>
                  <div className="tag-buttons" role="group" aria-label="タグ">
                    {tags.map((t) => (
                      <button key={t} type="button" className={`chip tag-chip${draft.tag === t ? " on" : ""}`} aria-pressed={draft.tag === t} onClick={() => chooseTag(t)}>
                        {TAG_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="entry-row memo-row">
                <label className="entry-label" htmlFor="entry-memo">
                  メモ
                </label>
                <textarea
                  id="entry-memo"
                  ref={memoRef}
                  className="entry-input memo-input"
                  rows={1}
                  placeholder="人の名前・作品名など"
                  value={draft.memo}
                  onFocus={() => {
                    setMemoFocused(true);
                    if (panel) closePanel();
                  }}
                  onBlur={() => setMemoFocused(false)}
                  onChange={(e) => setDraft((d) => ({ ...d, memo: e.target.value.replace(/\n/g, " ") }))}
                />
              </div>
              {memoSuggestions.length > 0 && (
                <ul className="suggest" aria-label="メモの語の候補">
                  {memoSuggestions.map((w) => (
                    <li key={w}>
                      <button
                        type="button"
                        className="chip"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setDraft((d) => ({ ...d, memo: replaceCurrentWord(d.memo, w) }))}
                      >
                        {w}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {memoFocused && currentWord(draft.memo) === "" && draft.memo !== "" && <p className="field-hint pad-hint">続きを打つと、過去の語が候補に出ます</p>}
            </section>
          </>
        )}
      </main>

      {panel === "account" && (
        <AccountPanel
          accounts={selectableAccounts(accountList, draft.accountId)}
          selectedId={draft.accountId}
          lastUsedId={lastAccountId}
          onSelect={selectAccount}
          onClose={closePanel}
        />
      )}
      {panel === "category" && (
        <CategoryPanel groups={selectableCategoryGroups(categories, kindOf(draft.type), draft.categoryId)} selectedId={draft.categoryId} onSelect={selectCategory} onClose={closePanel} />
      )}
      {panel === "amount" && <AmountPad expr={pad.expr} onKey={padKey} onFinish={finishPad} onClose={closePanel} />}

      {panel === null && (
        <footer className="entry-footer">
          <button type="button" className="secondary-btn" disabled={saving} onClick={() => void save(true)}>
            続ける
          </button>
          <button type="button" className="primary-btn save-btn" disabled={saving} onClick={() => void save(false)}>
            保存
          </button>
        </footer>
      )}

      {sheet === "discard" && (
        <ConfirmSheet
          title="入力した内容を捨てますか"
          message="ここまでの入力は保存されません。"
          confirmLabel="捨てる"
          danger
          onConfirm={onClose}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "delete" && (
        <ConfirmSheet
          title="この明細を削除しますか"
          message="削除したあと、数秒のあいだは「元に戻す」で戻せます。"
          confirmLabel="削除する"
          danger
          busy={saving}
          onConfirm={() => void remove()}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}
