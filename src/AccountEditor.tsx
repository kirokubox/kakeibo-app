import { useState } from "react";
import {
  GROUP_LABELS,
  GROUP_ORDER,
  SHIFT_LABELS,
  accountUsage,
  cardOpeningToStored,
  defaultIncludeInUsable,
  nextAccountOrder,
  usageSummary,
  validateAccountDraft,
} from "./accountLogic";
import { BottomSheet, ChoiceSheet, ConfirmSheet } from "./BottomSheet";
import { Icon } from "./Icon";
import { KebabMenu } from "./KebabMenu";
import { formatYen } from "./money";
import { getAllData, newBase, saveRecord, softDelete } from "./storage";
import type { Account, AccountGroup, HolidayShift } from "./types";
import { YenInput } from "./YenInput";

interface Props {
  /** 編集する資産。新規は null */
  account: Account | null;
  /** 全部の資産（論理削除済みも含む） */
  accounts: Account[];
  /** 今の残高（非表示にするときの確認で使う） */
  balance: number;
  onBack: () => void;
  /** 保存・削除したあと。メッセージを渡すとトーストに出す */
  onDone: (message: string) => void;
}

const SHIFTS: HolidayShift[] = ["before", "after", "none"];

/** 資産の追加・編集 */
export function AccountEditor({ account, accounts, balance, onBack, onDone }: Props) {
  const isNew = account === null;
  const [name, setName] = useState(account?.name ?? "");
  const [group, setGroup] = useState<AccountGroup>(account?.group ?? "cash");
  const [include, setInclude] = useState(account?.includeInUsable ?? true);
  const [includeTouched, setIncludeTouched] = useState(!isNew);
  const [opening, setOpening] = useState<number | null>(
    account ? (account.group === "card" ? Math.abs(account.openingBalance) : account.openingBalance) : 0,
  );
  const [day, setDay] = useState<number | null>(account?.card?.paymentDay ?? null);
  const [shift, setShift] = useState<HolidayShift>(account?.card?.holidayShift ?? "after");
  const [payId, setPayId] = useState<string>(account?.card?.paymentAccountId ?? "");
  const [hidden, setHidden] = useState(account?.hidden ?? false);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<null | "pay" | "hideConfirm" | "delete" | { blocked: string }>(null);

  const isCard = group === "card";
  const banks = accounts.filter((a) => a.deletedAt === null && a.group === "bank" && a.id !== account?.id);
  const payBank = banks.find((b) => b.id === payId);

  const changeGroup = (g: AccountGroup) => {
    setGroup(g);
    if (!includeTouched) setInclude(defaultIncludeInUsable(g));
    setError("");
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setSheet(null);
      setError(e instanceof Error ? e.message : "保存できませんでした");
      setBusy(false);
    }
  };

  const build = (hiddenValue: boolean): Account => {
    const base = account ?? { ...newBase(), order: 0 };
    const rec: Account = {
      ...(base as Account),
      name: name.trim(),
      group,
      includeInUsable: include,
      hidden: hiddenValue,
      openingBalance: isCard ? cardOpeningToStored(opening ?? 0) : (opening ?? 0),
      order: !account || account.group !== group ? nextAccountOrder(accounts, group) : account.order,
    };
    if (isCard) rec.card = { paymentDay: day ?? 1, holidayShift: shift, paymentAccountId: payId };
    else delete rec.card;
    return rec;
  };

  const validate = (): string | null =>
    validateAccountDraft(
      { name, group, openingBalance: opening, card: isCard ? { paymentDay: day, holidayShift: shift, paymentAccountId: payId } : undefined },
      accounts,
      account?.id,
    );

  const doSave = () =>
    run(async () => {
      await saveRecord("accounts", build(hidden));
      onDone("保存しました");
    });

  const handleSave = () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    // 残高があるまま非表示にするときは確認する
    if (hidden && !account?.hidden && balance !== 0) {
      setSheet("hideConfirm");
      return;
    }
    void doSave();
  };

  const handleDeleteClick = async () => {
    if (!account) return;
    setBusy(true);
    try {
      const usage = accountUsage(account.id, await getAllData());
      setSheet(usage.total > 0 ? { blocked: `${usageSummary(usage)}で使っているので削除できません。使わなくなったなら非表示にしてください` } : "delete");
    } catch (e) {
      setError(e instanceof Error ? e.message : "確認できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = () =>
    run(async () => {
      if (!account) return;
      await softDelete("accounts", account.id);
      onDone("削除しました");
    });

  const doHideInstead = () =>
    run(async () => {
      if (!account) return;
      await saveRecord("accounts", { ...account, hidden: true });
      onDone("非表示にしました");
    });

  return (
    <>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="戻る" onClick={onBack}>
          <Icon name="chevron-left" size={22} />
        </button>
        <h1 className="topbar-title">{isNew ? "資産を追加" : "資産を編集"}</h1>
        {!isNew && <KebabMenu items={[{ label: "削除", danger: true, onSelect: () => void handleDeleteClick() }]} />}
      </header>
      <main className="content">
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <section className="card form">
          <div className="field">
            <label className="field-label" htmlFor="acc-name">
              名前
            </label>
            <input id="acc-name" className="text-input" type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>

          <div className="field">
            <span className="field-label" id="acc-group-label">
              種類
            </span>
            <div className="chips" role="group" aria-labelledby="acc-group-label">
              {GROUP_ORDER.map((g) => (
                <button key={g} type="button" className={`chip${g === group ? " on" : ""}`} aria-pressed={g === group} onClick={() => changeGroup(g)}>
                  {GROUP_LABELS[g]}
                </button>
              ))}
            </div>
          </div>

          <label className="toggle-row">
            <span>使える資産に含める</span>
            <input
              type="checkbox"
              checked={include}
              onChange={(e) => {
                setInclude(e.target.checked);
                setIncludeTouched(true);
              }}
            />
          </label>

          <div className="field">
            <label className="field-label" htmlFor="acc-opening">
              {isCard ? "最初の未払い額" : "初期残高"}
            </label>
            <YenInput key={isCard ? "card" : "normal"} id="acc-opening" value={opening} onChange={setOpening} allowNegative={!isCard} />
            <p className="field-hint">
              {isCard ? "正の数で入れてください（マイナスで保存します）。" : ""}取り込む前からあったお金です。残高は、これに明細を足して計算します
            </p>
          </div>

          {isCard && (
            <>
              <div className="field">
                <label className="field-label" htmlFor="acc-day">
                  引き落とし日
                </label>
                <div className="yen-input">
                  <span className="unit">毎月</span>
                  <input
                    id="acc-day"
                    className="text-input yen-field day-field"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={day === null ? "" : String(day)}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                      setDay(digits === "" ? null : Number(digits));
                    }}
                  />
                  <span className="unit">日</span>
                </div>
                <p className="field-hint">その月にない日（31日など）は月末になります</p>
              </div>

              <div className="field">
                <span className="field-label" id="acc-shift-label">
                  休日なら
                </span>
                <div className="chips" role="group" aria-labelledby="acc-shift-label">
                  {SHIFTS.map((s) => (
                    <button key={s} type="button" className={`chip${s === shift ? " on" : ""}`} aria-pressed={s === shift} onClick={() => setShift(s)}>
                      {SHIFT_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <span className="field-label">引き落とし口座</span>
                {banks.length === 0 ? (
                  <p className="field-hint">先に銀行の資産を足してください</p>
                ) : (
                  <button type="button" className="select-btn" onClick={() => setSheet("pay")}>
                    <span>{payBank ? payBank.name : "選んでください"}</span>
                    <Icon name="chevron-right" size={18} />
                  </button>
                )}
              </div>
            </>
          )}

          {!isNew && (
            <label className="toggle-row">
              <span>
                非表示にする
                <span className="field-hint block">一覧に出なくなります。残高は合計に入ったままです</span>
              </span>
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            </label>
          )}
        </section>

        <div className="actions">
          <button type="button" className="primary-btn wide" disabled={busy} onClick={handleSave}>
            保存
          </button>
        </div>
      </main>

      {sheet === "pay" && (
        <ChoiceSheet
          title="引き落とし口座"
          options={banks.map((b) => ({ value: b.id, label: b.name }))}
          value={payId || null}
          onSelect={setPayId}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "hideConfirm" && (
        <ConfirmSheet
          title="非表示にしますか"
          message={`残高が${formatYen(balance)}あります。合計には入ったままです。`}
          confirmLabel="非表示にして保存"
          busy={busy}
          onConfirm={() => void doSave()}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "delete" && (
        <ConfirmSheet
          title="この資産を削除しますか"
          message={`「${account?.name ?? ""}」を削除します。使っている明細はないので、一覧から消えます。`}
          confirmLabel="削除"
          danger
          busy={busy}
          onConfirm={() => void doDelete()}
          onClose={() => setSheet(null)}
        />
      )}
      {typeof sheet === "object" && sheet !== null && (
        <BottomSheet title="削除できません" onClose={() => setSheet(null)}>
          <p className="sheet-message">{sheet.blocked}</p>
          <div className="sheet-actions">
            <button type="button" className="secondary-btn" onClick={() => setSheet(null)}>
              閉じる
            </button>
            {!account?.hidden && (
              <button type="button" className="primary-btn" disabled={busy} onClick={() => void doHideInstead()}>
                非表示にする
              </button>
            )}
          </div>
        </BottomSheet>
      )}
    </>
  );
}
