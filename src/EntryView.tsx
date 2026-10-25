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
import { formatYen } from "./money";
import { OutstandingPicker } from "./OutstandingView";
import { shortDate } from "./periodLogic";
import { ReimburseSheet } from "./ReimburseSheet";
import { applyReimbFields, checkReimbWithin, isSettleCategory, outstandingGroups, overReturn, remainingFor } from "./reimburseLogic";
import type { OutstandingItem, Reimb } from "./reimburseLogic";
import { getReimburseSet } from "./reimburseStore";
import { getAll, newBase, saveRecord, softDelete } from "./storage";
import { getSuggestIndex, noteTransactionChanged } from "./suggestStore";
import { currentWord, lastUsageOf, replaceCurrentWord, suggestContents, suggestMemoWords } from "./suggestLogic";
import type { SuggestIndex } from "./suggestLogic";
import type { ShowToast } from "./Toast";
import {
  applyTransferHint,
  cardTransferContents,
  checkTransferDraft,
  continueTransferDraft,
  copyTransferDraft,
  emptyTransferDraft,
  feeOf,
  mergeTransferSuggestions,
  recallTransferFavorite,
  swapTransferAccounts,
  toEntryDraftFromTransfer,
  toTransferDraft,
  transferFromTransaction,
  transferToTemplate,
  transferToTransaction,
  transferUsageHint,
} from "./transferLogic";
import type { TransferDraft, TransferFocus, TransferMissing } from "./transferLogic";
import type { Account, Category, Favorite, Id, Transaction } from "./types";

export type EntryMode =
  | { kind: "new"; date: string; type?: EntryType; transfer?: { draft: TransferDraft; focus: TransferFocus } }
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

/** account = 資産（振替では出金）、to = 振替の入金、fee = 振替の手数料 */
type Panel = "account" | "to" | "category" | "amount" | "fee" | null;
type Sheet = null | "discard" | "delete" | "favorites" | "reimb" | "settle";
type ErrorKey = MissingField | "to" | "reimb";

const TYPE_LABELS: Record<EntryType, string> = { income: "収入", expense: "支出" };

interface FormState {
  isTransfer: boolean;
  draft: EntryDraft;
  tdraft: TransferDraft;
  reimb: Reimb | null;
  settlesTxId: Id | null;
}

function initialState(mode: EntryMode): FormState {
  if (mode.kind === "new") {
    return {
      isTransfer: !!mode.transfer,
      draft: emptyDraft(mode.type ?? "expense", mode.date),
      tdraft: mode.transfer ? mode.transfer.draft : emptyTransferDraft(mode.date),
      reimb: null,
      settlesTxId: null,
    };
  }
  const date = mode.kind === "copy" ? mode.today : mode.tx.date;
  const t = mode.tx;
  if (t.type === "transfer") {
    const td = mode.kind === "edit" ? transferFromTransaction(t) : copyTransferDraft(t, mode.today);
    return { isTransfer: true, draft: emptyDraft("expense", date), tdraft: td ?? emptyTransferDraft(date), reimb: null, settlesTxId: null };
  }
  const d = mode.kind === "edit" ? draftFromTransaction(t) : copyDraft(t, mode.today);
  return {
    isTransfer: false,
    draft: d ?? emptyDraft("expense", date),
    tdraft: emptyTransferDraft(date),
    reimb: t.type === "expense" && t.reimbursement ? { counterparty: t.reimbursement.counterparty, amount: t.reimbursement.amount } : null,
    // コピーのときは、返金が指す立替までは引き継がない
    settlesTxId: mode.kind === "edit" && t.type === "income" && t.settles ? t.settles.txId : null,
  };
}

/** 入力画面（収入・支出・振替）。新規・編集・コピー */
export function EntryView({ mode, today, showToast, onChanged, onClose }: Props) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [index, setIndex] = useState<SuggestIndex | null>(null);
  const [existing, setExisting] = useState<Transaction | undefined>(mode.kind === "edit" ? mode.tx : undefined);
  const [init] = useState(() => initialState(mode));
  const [isTransfer, setIsTransfer] = useState(init.isTransfer);
  const [draft, setDraft] = useState<EntryDraft>(init.draft);
  const [tdraft, setTdraft] = useState<TransferDraft>(init.tdraft);
  const [reimb, setReimb] = useState<Reimb | null>(init.reimb);
  const [settlesTxId, setSettlesTxId] = useState<Id | null>(init.settlesTxId);
  const [reimburseSet, setReimburseSet] = useState<Transaction[]>([]);
  const [initialJson, setInitialJson] = useState(() => JSON.stringify(init));
  const [panel, setPanel] = useState<Panel>(null);
  const [pad, setPad] = useState<PadState>({ expr: "", fresh: false });
  const [error, setError] = useState<ErrorKey | null>(null);
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
        if (mode.kind === "new") {
          // 新規で開いたら、すぐ資産のパネル。カードの引き落としなどで用意された振替は、そのフォーカスへ
          const focus = mode.transfer?.focus;
          if (focus === "amount") {
            setPad(startPad(init.tdraft.amount));
            setPanel("amount");
          } else if (focus === "to") setPanel("to");
          else setPanel("account");
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "データを開けませんでした");
      }
    })();
    getSuggestIndex()
      .then((i) => !cancelled && setIndex(i))
      .catch(() => undefined);
    getReimburseSet()
      .then((r) => !cancelled && setReimburseSet(r))
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
    const id = window.setTimeout(() => rowRefs.current[panel === "fee" ? "amount" : panel]?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 30);
    return () => window.clearTimeout(id);
  }, [panel]);

  // メモ欄の高さを中身に合わせる
  useEffect(() => {
    const el = memoRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft.memo, tdraft.memo, isTransfer, accounts, sheet]);

  const accountList = accounts ?? [];
  const category = useMemo(() => categories.find((c) => c.id === draft.categoryId), [categories, draft.categoryId]);
  const names = categoryNames(categories, draft.categoryId);
  const account = accountList.find((a) => a.id === draft.accountId);
  const fromAccount = accountList.find((a) => a.id === tdraft.fromId);
  const toAccount = accountList.find((a) => a.id === tdraft.toId);
  const tags = isTransfer ? [] : tagOptions(draft.type, category);
  const dirty = JSON.stringify({ isTransfer, draft, tdraft, reimb, settlesTxId }) !== initialJson;

  const curDate = isTransfer ? tdraft.date : draft.date;
  const curAmount = isTransfer ? tdraft.amount : draft.amount;
  const curContent = isTransfer ? tdraft.content : draft.content;
  const curMemo = isTransfer ? tdraft.memo : draft.memo;

  /** 日付・内容・メモは、収入・支出と振替で同じ行。いまの形のほうへ書く */
  const patchCommon = (patch: Partial<Pick<EntryDraft, "date" | "content" | "memo">>) => {
    if (isTransfer) setTdraft((d) => ({ ...d, ...patch }));
    else setDraft((d) => ({ ...d, ...patch }));
  };

  const entryHint = useMemo(() => {
    if (isTransfer || !index || decided === null || decided === "" || decided !== draft.content.trim()) return null;
    return usageHint(lastUsageOf(index, draft.type, decided), draft, accountList, categories);
  }, [isTransfer, index, decided, draft, accountList, categories]);

  const transferHint = useMemo(() => {
    if (!isTransfer || !index || decided === null || decided === "" || decided !== tdraft.content.trim()) return null;
    return transferUsageHint(lastUsageOf(index, "transfer", decided), tdraft, accountList);
  }, [isTransfer, index, decided, tdraft, accountList]);

  const contentSuggestions = useMemo(() => {
    if (!index || !contentFocused) return [];
    if (isTransfer) {
      const past = suggestContents(index, "transfer", tdraft.content, today, null);
      if (tdraft.content.trim() !== "") return past;
      return mergeTransferSuggestions(cardTransferContents(accountList, tdraft.fromId, tdraft.toId), past, 8);
    }
    return suggestContents(index, draft.type, draft.content, today, draft.categoryId);
  }, [index, contentFocused, isTransfer, tdraft.content, tdraft.fromId, tdraft.toId, accountList, draft.type, draft.content, draft.categoryId, today]);
  const memoSuggestions = useMemo(() => (index && memoFocused && !isTransfer ? suggestMemoWords(index, curMemo) : []), [index, memoFocused, isTransfer, curMemo]);

  const hintLabel = useMemo(() => {
    if (transferHint) {
      const f = accountList.find((x) => x.id === transferHint.fromId);
      const t = accountList.find((x) => x.id === transferHint.toId);
      return `${f?.name ?? ""} → ${t?.name ?? ""}`;
    }
    if (!entryHint) return "";
    const n = categoryNames(categories, entryHint.categoryId);
    const a = accountList.find((x) => x.id === entryHint.accountId);
    const parts = [n ? (n.child ? `${n.parent}＞${n.child}` : n.parent) : "", a?.name ?? "", entryHint.tag ? TAG_LABELS[entryHint.tag] : ""].filter(Boolean);
    return parts.join("・");
  }, [entryHint, transferHint, categories, accountList]);
  const hasHint = isTransfer ? !!transferHint : !!entryHint;

  // 返金の入力：選んだ立替の残り（編集中の返金自身は数えない）
  const settleRow = !isTransfer && draft.type === "income" && isSettleCategory(draft.categoryId);
  const settleTarget = settlesTxId ? reimburseSet.find((t) => t.id === settlesTxId) : undefined;
  const settleRemaining = settlesTxId ? remainingFor(settlesTxId, reimburseSet, existing?.id) : null;
  const settleOver = settleRow ? overReturn(draft.amount, settleRemaining) : 0;

  // ---- パネルの出し入れと自動で次へ ----

  const openPad = (amount: number | null, target: "amount" | "fee" = "amount") => {
    setPad(startPad(amount));
    setPanel(target);
  };

  /** 金額（手数料）のテンキーに打ちかけの式があれば、計算できるときだけ入れる。入れたあとの下書きを返す */
  const commitPad = (): { d: EntryDraft; t: TransferDraft } => {
    if (panel !== "amount" && panel !== "fee") return { d: draft, t: tdraft };
    const r = evaluate(pad.expr);
    if (!r.ok) return { d: draft, t: tdraft };
    if (panel === "fee") {
      const t = { ...tdraft, fee: r.value };
      setTdraft(t);
      return { d: draft, t };
    }
    if (isTransfer) {
      const t = { ...tdraft, amount: r.value };
      setTdraft(t);
      return { d: draft, t };
    }
    const d = { ...draft, amount: r.value };
    setDraft(d);
    return { d, t: tdraft };
  };

  const openPanel = (next: Exclude<Panel, null>) => {
    if (panel === next) return;
    const { d, t } = commitPad();
    if (next === "amount") openPad(isTransfer ? t.amount : d.amount);
    else if (next === "fee") openPad(t.fee, "fee");
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
    if ((from === "account" || from === "category") && d.amount === null) return openPad(d.amount);
    if (from === "amount" && d.content.trim() === "") return focusContent();
    setPanel(null);
  };

  /** 振替：出金 → 入金 → 金額 → 内容 */
  const advanceTransfer = (from: "account" | "to" | "amount", t: TransferDraft) => {
    if (from === "account" && !t.toId) return openPanel("to");
    if ((from === "account" || from === "to") && t.amount === null) return openPad(t.amount);
    if (from === "amount" && t.content.trim() === "") return focusContent();
    setPanel(null);
  };

  const selectAccount = (id: Id) => {
    setLastAccountId(id);
    if (error === "account") setError(null);
    if (isTransfer) {
      // 出金に入金と同じ資産を選んだら、入金を空にする
      const t = { ...tdraft, fromId: id, toId: tdraft.toId === id ? null : tdraft.toId };
      setTdraft(t);
      advanceTransfer("account", t);
      return;
    }
    const d = { ...draft, accountId: id };
    setDraft(d);
    advance("account", d);
  };

  const selectTo = (id: Id) => {
    const t = { ...tdraft, toId: id };
    setTdraft(t);
    if (error === "to") setError(null);
    advanceTransfer("to", t);
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
    if (panel === "fee") {
      setTdraft((t) => ({ ...t, fee: r.value }));
      setPanel(null);
      return;
    }
    if (isTransfer) {
      const t = { ...tdraft, amount: r.value };
      setTdraft(t);
      if (error === "amount") setError(null);
      advanceTransfer("amount", t);
      return;
    }
    const d = { ...draft, amount: r.value };
    setDraft(d);
    if (error === "amount") setError(null);
    advance("amount", d);
  };

  const changeType = (type: EntryType | "transfer") => {
    const { d, t } = commitPad();
    if (type === "transfer") {
      if (isTransfer) return;
      // 日付・金額・内容・メモは残す。資産は出金へ。分類・タグ・入金は空
      const nt = toTransferDraft(d, t);
      setTdraft(nt);
      setIsTransfer(true);
      setReimb(null);
      setSettlesTxId(null);
      setDecided(null);
      setError(null);
      setPanel(nt.fromId ? "to" : "account");
    } else {
      if (!isTransfer && type === draft.type) return;
      const nd: EntryDraft = isTransfer ? toEntryDraftFromTransfer(t, type) : { ...d, type, categoryId: null, tag: null };
      setDraft(nd);
      setIsTransfer(false);
      if (type !== "expense") setReimb(null);
      if (type !== "income") setSettlesTxId(null);
      setDecided(null);
      setError(null);
      setPanel("category");
    }
    contentRef.current?.blur();
    memoRef.current?.blur();
  };

  const chooseTag = (tag: (typeof tags)[number]) => {
    setDraft((d) => ({ ...d, tag }));
    if (error === "tag") setError(null);
  };

  const swapAccounts = () => {
    const { t } = commitPad();
    setTdraft(swapTransferAccounts(t));
    setError(null);
  };

  const clearFee = () => {
    setTdraft((t) => ({ ...t, fee: null }));
    if (panel === "fee") setPanel(null);
  };

  // 立替（支出）・返金した立替（収入）
  const decideReimb = (r: Reimb) => {
    setReimb(r);
    setSheet(null);
    if (error === "reimb") setError(null);
  };

  const pickSettle = (item: OutstandingItem) => {
    setSettlesTxId(item.tx.id);
    setSheet(null);
    const counterparty = item.tx.reimbursement?.counterparty ?? "";
    setDraft((d) => ({
      ...d,
      content: d.content.trim() === "" ? counterparty : d.content,
      amount: d.amount === null ? item.remaining : d.amount,
    }));
  };

  // ---- 保存 ----

  const rejectMissing = (field: MissingField | TransferMissing, message: string) => {
    if (field === "from" || field === "account") {
      setError("account");
      openPanel("account");
    } else if (field === "to") {
      setError("to");
      openPanel("to");
    } else if (field === "category") {
      setError("category");
      openPanel("category");
    } else if (field === "amount") {
      setError("amount");
      openPanel("amount");
    } else {
      setError("tag");
      setShake(true);
      window.clearTimeout(shakeTimer.current);
      shakeTimer.current = window.setTimeout(() => setShake(false), 500);
      showToast(message);
      rowRefs.current.tag?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };

  const save = async (andContinue: boolean) => {
    if (saving) return;
    const { d, t } = commitPad();
    let record: Transaction;
    if (isTransfer) {
      const check = checkTransferDraft(t);
      if (!check.ok) {
        rejectMissing(check.field, check.message);
        return;
      }
      record = transferToTransaction(t, newBase(), existing);
    } else {
      const check = checkDraft(d, categories, source);
      if (!check.ok) {
        rejectMissing(check.field, check.message);
        return;
      }
      const reimbProblem = d.type === "expense" ? checkReimbWithin(d.amount, reimb) : null;
      if (reimbProblem) {
        setError("reimb");
        showToast(reimbProblem);
        rowRefs.current.reimb?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      record = applyReimbFields(draftToTransaction(d, categories, newBase(), existing), reimb, settlesTxId);
    }
    setSaving(true);
    try {
      const saved = await saveRecord("transactions", record);
      noteTransactionChanged(saved);
      const fromId = isTransfer ? t.fromId : d.accountId;
      if (fromId) writePref(PREF_LAST_ACCOUNT, fromId);
      onChanged();
      if (!andContinue) {
        showToast("保存しました");
        onClose();
        return;
      }
      setExisting(undefined);
      if (isTransfer) {
        const next = continueTransferDraft(t);
        setTdraft(next);
        setInitialJson(JSON.stringify({ isTransfer, draft, tdraft: next, reimb: null, settlesTxId: null }));
        setPanel("to");
      } else {
        const next = continueDraft(d);
        setDraft(next);
        setReimb(null);
        setSettlesTxId(null);
        setInitialJson(JSON.stringify({ isTransfer, draft: next, tdraft, reimb: null, settlesTxId: null }));
        setPanel("category");
      }
      setDecided(null);
      setError(null);
      showToast("保存しました（続けて入力）");
      void getReimburseSet().then(setReimburseSet);
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
    const empty = isTransfer
      ? !tdraft.fromId && !tdraft.toId && tdraft.amount === null && tdraft.content.trim() === ""
      : !draft.accountId && !draft.categoryId && draft.amount === null && draft.content.trim() === "";
    if (empty) {
      showToast("先に内容を入れてください");
      return;
    }
    try {
      const all = await getAll("favorites");
      const rec: Favorite = { ...newBase(), template: isTransfer ? transferToTemplate(tdraft) : draftToTemplate(draft), order: nextFavoriteOrder(all) };
      await saveRecord("favorites", rec);
      showToast("よく使う入力に登録しました");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "登録できませんでした");
    }
  };

  const copyAsNew = () => {
    if (!existing) return;
    if (isTransfer) {
      const t = copyTransferDraft(existing, today);
      if (!t) return;
      setTdraft(t);
      setInitialJson(JSON.stringify({ isTransfer, draft, tdraft: t, reimb: null, settlesTxId: null }));
    } else {
      const d = copyDraft(existing, today);
      if (!d) return;
      setDraft(d);
      setSettlesTxId(null); // 返金が指す立替までは引き継がない
      setInitialJson(JSON.stringify({ isTransfer, draft: d, tdraft, reimb, settlesTxId: null }));
    }
    setExisting(undefined);
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
      setSheet(null);
      setDecided(null);
      setError(null);
      if (template.type === "transfer") {
        const r = recallTransferFavorite(template, curDate, accountList);
        if (!r) return;
        setIsTransfer(true);
        setTdraft(r.draft);
        setReimb(null);
        setSettlesTxId(null);
        if (r.focus === "amount") openPad(r.draft.amount);
        else setPanel(r.focus === "from" ? "account" : "to");
        return;
      }
      const r = recallFavorite(template, { ...draft, date: curDate }, accountList, categories);
      if (!r) return;
      setIsTransfer(false);
      setDraft(r.draft);
      setReimb(null);
      setSettlesTxId(null);
      if (r.focus === "amount") openPad(r.draft.amount);
      else setPanel(r.focus);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, curDate, accountList, categories],
  );

  // ---- 表示 ----

  const title = `${isTransfer ? "振替" : TYPE_LABELS[draft.type]}${isEdit ? "を編集" : ""}`;
  const amountText =
    panel === "amount" ? (pad.expr === "" ? "" : formatExpr(pad.expr)) : curAmount === null ? "" : curAmount.toLocaleString("ja-JP");
  const feeNow = feeOf(tdraft);
  const feeText = panel === "fee" ? (pad.expr === "" ? "" : formatExpr(pad.expr)) : feeNow > 0 ? feeNow.toLocaleString("ja-JP") : "";
  const setRowRef = (key: string) => (el: HTMLElement | null) => {
    rowRefs.current[key] = el;
  };
  const settleLabel = settlesTxId
    ? settleTarget
      ? `${settleTarget.reimbursement?.counterparty ?? ""}・${shortDate(settleTarget.date)}${settleTarget.content ? `・${settleTarget.content}` : ""}`
      : "削除された立替"
    : "";

  if (sheet === "favorites") {
    return (
      <FavoritesView accounts={accountList} categories={categories} onPick={recall} onClose={() => setSheet(null)} showToast={showToast} />
    );
  }

  const amountValue = (
    <>
      <span className="entry-label">金額</span>
      <span className={`entry-value amount${panel === "amount" && pad.fresh ? " selected" : ""}`}>
        {amountText === "" ? <span className="entry-ph">0</span> : amountText}
        <span className="unit">円</span>
      </span>
    </>
  );

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
                <button
                  key={t}
                  type="button"
                  className={`seg${!isTransfer && draft.type === t ? " on" : ""}`}
                  aria-pressed={!isTransfer && draft.type === t}
                  onClick={() => changeType(t)}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
              <button type="button" className={`seg${isTransfer ? " on" : ""}`} aria-pressed={isTransfer} onClick={() => changeType("transfer")}>
                振替
              </button>
            </div>

            <section className="entry-rows">
              <div className="entry-row">
                <span className="entry-label">日付</span>
                <label className="entry-value date-label">
                  {isLocalDate(curDate) ? formatDateJa(curDate) : curDate}
                  <input
                    ref={dateRef}
                    type="date"
                    className="date-overlay"
                    aria-label="日付"
                    value={curDate}
                    onChange={(e) => isLocalDate(e.target.value) && patchCommon({ date: e.target.value })}
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

              {isTransfer ? (
                <div className="transfer-pair">
                  <div className="pair-rows">
                    <button
                      type="button"
                      ref={setRowRef("account")}
                      className={`entry-row tap${error === "account" ? " invalid" : ""}${panel === "account" ? " active" : ""}`}
                      onClick={() => openPanel("account")}
                    >
                      <span className="entry-label">出金</span>
                      <span className="entry-value">{fromAccount ? fromAccount.name : <span className="entry-ph">選んでください</span>}</span>
                    </button>
                    <button
                      type="button"
                      ref={setRowRef("to")}
                      className={`entry-row tap${error === "to" ? " invalid" : ""}${panel === "to" ? " active" : ""}`}
                      onClick={() => openPanel("to")}
                    >
                      <span className="entry-label">入金</span>
                      <span className="entry-value">{toAccount ? toAccount.name : <span className="entry-ph">選んでください</span>}</span>
                    </button>
                  </div>
                  <button type="button" className="swap-btn" aria-label="出金と入金を入れ替える" onClick={swapAccounts}>
                    <Icon name="swap" size={22} />
                  </button>
                </div>
              ) : (
                <>
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
                </>
              )}

              {isTransfer ? (
                <div className={`entry-row split-row${error === "amount" ? " invalid" : ""}${panel === "amount" ? " active" : ""}`} ref={setRowRef("amount")}>
                  <button type="button" className="entry-hit" onClick={() => openPanel("amount")}>
                    {amountValue}
                  </button>
                  <button type="button" className={`fee-btn${panel === "fee" || feeNow > 0 ? " on" : ""}`} onClick={() => openPanel("fee")}>
                    手数料
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  ref={setRowRef("amount")}
                  className={`entry-row tap${error === "amount" ? " invalid" : ""}${panel === "amount" ? " active" : ""}`}
                  onClick={() => openPanel("amount")}
                >
                  {amountValue}
                </button>
              )}
              {isTransfer && (panel === "fee" || feeNow > 0) && (
                <div className="fee-line">
                  <span>手数料 {feeText === "" ? "0" : feeText}円</span>
                  {feeNow > 0 && (
                    <button type="button" className="text-btn" onClick={clearFee}>
                      なしにする
                    </button>
                  )}
                </div>
              )}

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
                  placeholder={isTransfer ? "カード引き落としなど（空でも保存できます）" : "店名など（空でも保存できます）"}
                  value={curContent}
                  onFocus={() => {
                    setContentFocused(true);
                    if (panel) closePanel();
                  }}
                  onBlur={(e) => {
                    setContentFocused(false);
                    setDecided(e.currentTarget.value.trim());
                  }}
                  onChange={(e) => patchCommon({ content: e.target.value })}
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
                          patchCommon({ content: s });
                          setDecided(s);
                        }}
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {hasHint && (
                <div className="hint" role="status">
                  <span className="hint-text">前回：{hintLabel}</span>
                  <button
                    type="button"
                    className="secondary-btn hint-btn"
                    onClick={() => {
                      if (transferHint) setTdraft((d) => applyTransferHint(d, transferHint));
                      else if (entryHint) setDraft((d) => applyHint(d, entryHint));
                    }}
                  >
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
                  placeholder={isTransfer ? "自由に書けます" : "人の名前・作品名など"}
                  value={curMemo}
                  onFocus={() => {
                    setMemoFocused(true);
                    if (panel) closePanel();
                  }}
                  onBlur={() => setMemoFocused(false)}
                  onChange={(e) => patchCommon({ memo: e.target.value.replace(/\n/g, " ") })}
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
              {!isTransfer && memoFocused && currentWord(draft.memo) === "" && draft.memo !== "" && <p className="field-hint pad-hint">続きを打つと、過去の語が候補に出ます</p>}

              {!isTransfer && draft.type === "expense" && (
                <button
                  type="button"
                  ref={setRowRef("reimb")}
                  className={`entry-row tap${error === "reimb" ? " invalid" : ""}`}
                  onClick={() => setSheet("reimb")}
                >
                  <span className="entry-label">立替</span>
                  <span className="entry-value">
                    {reimb ? `${reimb.counterparty} ${formatYen(reimb.amount)}` : <span className="entry-ph">うち誰の分かあれば</span>}
                  </span>
                </button>
              )}

              {settleRow && (
                <>
                  <button type="button" ref={setRowRef("settle")} className="entry-row tap settle-row" onClick={() => setSheet("settle")}>
                    <span className="entry-label settle-label">返金した立替</span>
                    <span className="entry-value">
                      {settlesTxId ? (
                        <>
                          {settleLabel}
                          {settleRemaining !== null && settleTarget && <span className="settle-rest">（残り {formatYen(settleRemaining)}）</span>}
                        </>
                      ) : (
                        <span className="entry-ph">未回収の立替から選ぶ</span>
                      )}
                    </span>
                  </button>
                  {settleOver > 0 && settleRemaining !== null && (
                    <p className="field-hint pad-hint settle-over" role="status">
                      残り{formatYen(settleRemaining)}より多い返金です。多い分は収入として数えます。
                    </p>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </main>

      {panel === "account" && (
        <AccountPanel
          title={isTransfer ? "出金" : "資産"}
          accounts={selectableAccounts(accountList, isTransfer ? tdraft.fromId : draft.accountId)}
          selectedId={isTransfer ? tdraft.fromId : draft.accountId}
          lastUsedId={lastAccountId}
          onSelect={selectAccount}
          onClose={closePanel}
        />
      )}
      {panel === "to" && (
        <AccountPanel
          title="入金"
          accounts={selectableAccounts(accountList, tdraft.toId)}
          selectedId={tdraft.toId}
          lastUsedId={null}
          disabledId={tdraft.fromId}
          onSelect={selectTo}
          onClose={closePanel}
        />
      )}
      {panel === "category" && (
        <CategoryPanel groups={selectableCategoryGroups(categories, kindOf(draft.type), draft.categoryId)} selectedId={draft.categoryId} onSelect={selectCategory} onClose={closePanel} />
      )}
      {(panel === "amount" || panel === "fee") && (
        <AmountPad title={panel === "fee" ? "手数料" : "金額"} expr={pad.expr} onKey={padKey} onFinish={finishPad} onClose={closePanel} />
      )}

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

      {sheet === "reimb" && (
        <ReimburseSheet
          initial={reimb}
          expenseAmount={draft.amount}
          history={reimburseSet}
          onDecide={decideReimb}
          onRemove={() => {
            setReimb(null);
            setSheet(null);
            if (error === "reimb") setError(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "settle" && <OutstandingPicker groups={outstandingGroups(reimburseSet, existing?.id)} onPick={pickSettle} onClose={() => setSheet(null)} />}
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
