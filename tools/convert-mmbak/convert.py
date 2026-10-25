#!/usr/bin/env python3
"""らくな家計簿のバックアップ（.mmbak＝SQLite）を、kakeibo-app の「バックアップから追加」で読めるJSONに変換する。

標準ライブラリだけで動く。.mmbak は読み取り専用（mode=ro）で開き、動かさない・書き換えない。
仕様の正本：05_開発・Webアプリ/17_家計簿/172_家計簿_実装指示_段階7_らくな家計簿の取り込み_2026-10-26.md

使い方：
  python convert.py <.mmbak> <mapping.json> --json-dir <JSONの出力先> --report-dir <レポートの出力先>

個人データ（.mmbak・変換後のJSON・レポート・mapping.json）はリポジトリに入れない。このファイルには実データの名前・金額を書かない。
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

JST = dt.timezone(dt.timedelta(hours=9))
UTC = dt.timezone.utc

# ---------------------------------------------------------------------------
# アプリの初期分類（src/seedCategories.ts と同じ。アプリ側を変えたらここも合わせる）
# ---------------------------------------------------------------------------
SEED_GROUPS = {
    "expense": {
        "食費": ["ごはん", "外食", "作業カフェ", "おやつ", "飲料", "酒"],
        "生活費": ["日用品", "美容", "雑貨", "病院・薬"],
        "衣服費": ["服", "靴", "小物", "クリーニング"],
        "趣味・娯楽費": ["本・漫画", "映画", "音楽", "ゲーム", "サウナ", "シーシャ", "グッズ", "イベント", "配信", "その他"],
        "嗜好品": ["タバコ", "アダルト"],
        "交通費": ["公共交通", "タクシー", "LUUP", "車"],
        "交際費": ["友達", "マチアプ", "デート", "飲み会", "プレゼント"],
        "特別費": ["旅行・帰省", "家具・家電", "手続き", "自己投資", "その他"],
        "固定費": ["家賃", "水道光熱費", "通信", "サブスク", "返済", "天引き"],
        "税金・保険": ["所得税", "住民税", "国民健康保険", "健康保険料", "厚生年金保険料", "雇用保険料", "民間保険", "車両税"],
    },
    "income": {
        "給与": ["給与", "手当", "賞与"],
        "副業": ["ホスト", "保険", "転売", "ブログ", "ファッション同行", "ライター"],
        "一時収入": ["立替返金", "返金", "売却", "ポイント換金", "仕送り", "お祝い金", "残高調整", "その他"],
        "公的給付": ["失業手当", "給付金", "還付金"],
    },
}
SEED_LEAVES = {(kind, f"{parent}/{child}") for kind, groups in SEED_GROUPS.items() for parent, kids in groups.items() for child in kids}

ACCOUNT_GROUPS = ("cash", "emoney", "bank", "card", "investment", "other")
HOLIDAY_SHIFTS = ("before", "after", "none")
BACKUP_APP_NAME = "kakeibo-app"
BACKUP_SCHEMA_VERSION = 1
SYSTEM_ADJUST_CATEGORY_UID = "-4"  # らくな家計簿の「差額」（残高修正を収入・支出の形で記録したもの）

DEFAULT_SETTINGS = {
    "payday": 25,
    "paydayHolidayShift": "before",
    "defenseFund": 100000,
    "budgetMonthBoundary": "payday",
    "homeMainFigure": "remaining",
    "weekStart": "monday",
    "backupReminderDays": 7,
    "lastBackupAt": None,
}


class ConvertError(Exception):
    pass


# ---------------------------------------------------------------------------
# 小さな道具
# ---------------------------------------------------------------------------
def iso_from_ms(ms, fallback: str) -> str:
    try:
        v = int(ms)
        if v <= 0:
            return fallback
        d = dt.datetime.fromtimestamp(v / 1000, UTC)
        return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{v % 1000:03d}Z"
    except (TypeError, ValueError, OverflowError, OSError):
        return fallback


def date_from_ms(ms) -> str | None:
    try:
        v = int(ms)
        if v <= 0:
            return None
        return dt.datetime.fromtimestamp(v / 1000, JST).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def to_decimal(v) -> Decimal:
    if v is None or v == "":
        return Decimal(0)
    try:
        return Decimal(str(v).strip().replace(",", ""))
    except Exception:
        return Decimal(0)


def to_yen(v) -> tuple[int, bool]:
    """金額を整数にする。（整数, 丸めたか）"""
    d = to_decimal(v)
    r = int(d.quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return r, d != r


def is_local_date(s) -> bool:
    if not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return False
    try:
        dt.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def month_add(y: int, m: int, k: int) -> tuple[int, int]:
    t = y * 12 + (m - 1) + k
    return t // 12, t % 12 + 1


def last_day(y: int, m: int) -> int:
    return calendar.monthrange(y, m)[1]


def date_shift_months(d: str, k: int, day: int | str | None = None) -> str:
    """日付を k か月ずらす。日が存在しなければ月末に寄せる。day を渡すとその日（"last" は月末）を使う"""
    y, m, dd = (int(x) for x in d.split("-"))
    y2, m2 = month_add(y, m, k)
    want = dd if day is None else day
    ld = last_day(y2, m2)
    nd = ld if want == "last" else min(int(want), ld)
    return f"{y2:04d}-{m2:02d}-{nd:02d}"


def months_between(d1: str, d2: str) -> int:
    y1, m1, a = (int(x) for x in d1.split("-"))
    y2, m2, b = (int(x) for x in d2.split("-"))
    k = (y2 - y1) * 12 + (m2 - m1)
    if b - a < -15:
        k -= 1
    elif b - a > 15:
        k += 1
    return k


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def yen_text(n) -> str:
    return f"{int(n):,}"


# ---------------------------------------------------------------------------
# メモの満足・反省
# ---------------------------------------------------------------------------
_MARK_RE = re.compile(r"(^|\s*[/／]\s*|\s+)(満足|反省)(?:[:：]\s*([^\n]*))?\s*\Z")


def split_memo_tag(memo: str) -> tuple[str, str | None]:
    """メモの末尾の「満足」「反省」「満足：理由」「反省：理由」を外す。（印を外したメモ, タグ）。理由の一言はメモの末尾に残す"""
    text = (memo or "").rstrip()
    m = _MARK_RE.search(text)
    if not m:
        return (memo or "").strip(), None
    tag = "satisfied" if m.group(2) == "満足" else "regret"
    prefix = text[: m.start()].rstrip()
    reason = (m.group(3) or "").strip()
    if reason:
        new_memo = f"{prefix} / {reason}" if prefix else reason
    else:
        new_memo = prefix
    return new_memo.strip(), tag


# ---------------------------------------------------------------------------
# mapping.json
# ---------------------------------------------------------------------------
def load_mapping(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        mapping = json.load(f)
    validate_mapping(mapping)
    return mapping


def validate_mapping(mapping: dict) -> None:
    problems: list[str] = []
    for kind in ("expense", "income"):
        table = mapping.get(kind)
        if not isinstance(table, dict):
            problems.append(f"{kind} がオブジェクトではありません")
            continue
        for key, entry in table.items():
            targets = []
            if isinstance(entry, str):
                targets.append(entry)
            elif isinstance(entry, dict):
                targets.append(entry.get("to", ""))
                for rule in entry.get("rules", []):
                    targets.append(rule.get("to", ""))
                    if not isinstance(rule.get("contains"), list) or not rule["contains"]:
                        problems.append(f"{kind}[{key}] の rules に contains（文字列の配列）がありません")
            else:
                problems.append(f"{kind}[{key}] が文字列でもオブジェクトでもありません")
            for t in targets:
                if (kind, t) not in SEED_LEAVES:
                    problems.append(f"{kind}[{key}] の付け替え先「{t}」が初期分類にありません")
    fb = mapping.get("fallback", {})
    for kind in ("expense", "income"):
        if (kind, fb.get(kind, "")) not in SEED_LEAVES:
            problems.append(f"fallback.{kind}「{fb.get(kind)}」が初期分類にありません")
    for g, v in (mapping.get("assetGroups") or {}).items():
        if v not in ACCOUNT_GROUPS:
            problems.append(f"assetGroups[{g}]「{v}」は {'/'.join(ACCOUNT_GROUPS)} のどれかにしてください")
    if problems:
        raise ConvertError("mapping.json に問題があります：\n  " + "\n  ".join(problems))


class CategoryResolver:
    def __init__(self, mapping: dict, cats: dict[str, dict]):
        self.mapping = mapping
        self.cats = cats
        self.unmapped: Counter = Counter()  # (kind, 旧の分類) → 件数
        self.review: dict[tuple, Counter] = defaultdict(Counter)  # (kind, 旧の分類, 仮の行き先) → {内容: 件数}
        self.by_target: Counter = Counter()  # (kind, 新の小分類) → 件数

    def key_of(self, uid: str | None) -> str:
        info = self.cats.get(uid or "")
        if info is None:
            return f"(分類なし:{uid or ''})"
        parent = self.cats.get(info["pUid"]) if info["pUid"] else None
        return f"{parent['name']}/{info['name']}" if parent else info["name"]

    def resolve(self, kind: str, uid: str | None, content: str, count: bool = True) -> str:
        """新の分類のID（seed:...）を返す"""
        key = self.key_of(uid)
        entry = self.mapping[kind].get(key)
        if entry is None:
            if count:
                self.unmapped[(kind, key)] += 1
            to = self.mapping["fallback"][kind]
        else:
            if isinstance(entry, str):
                entry = {"to": entry}
            to = entry["to"]
            matched = False
            low = (content or "").casefold()
            for rule in entry.get("rules", []):
                if any(s.casefold() in low for s in rule["contains"]):
                    to = rule["to"]
                    matched = True
                    break
            if entry.get("review") and not matched and count:
                self.review[(kind, key, to)][content or "（内容なし）"] += 1
        if count:
            self.by_target[(kind, to)] += 1
        return f"seed:{kind}:{to}"


# ---------------------------------------------------------------------------
# 読み込み
# ---------------------------------------------------------------------------
def open_readonly(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def table_exists(con: sqlite3.Connection, name: str) -> bool:
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


EFFECT_SQL = """
CASE DO_TYPE WHEN '0' THEN 1 WHEN '1' THEN -1 WHEN '3' THEN -1 WHEN '4' THEN 1 WHEN '7' THEN -1 WHEN '8' THEN 1 ELSE 0 END
"""


def mm_balances(con: sqlite3.Connection) -> dict[str, Decimal]:
    """らくな家計簿の今の残高：初期残高 ＋ 有効な全明細（全期間）の影響。アプリ側の計算とは別の経路（SQL）で出す"""
    out: dict[str, Decimal] = {}
    for r in con.execute("SELECT uid, AMOUNT FROM ASSETS"):
        out[r["uid"]] = to_decimal(r["AMOUNT"])
    sql = f"""
        SELECT assetUid AS a, SUM(({EFFECT_SQL}) * COALESCE(AMOUNT_ACCOUNT, CAST(ZMONEY AS REAL))) AS s
        FROM INOUTCOME WHERE IS_DEL IS NULL OR IS_DEL = 0 GROUP BY assetUid
    """
    for r in con.execute(sql):
        if r["a"] in out and r["s"] is not None:
            out[r["a"]] += Decimal(repr(round(r["s"], 4)))
    return out


# ---------------------------------------------------------------------------
# 本体
# ---------------------------------------------------------------------------
def convert(db_path: Path, mapping: dict, now_iso: str, source_file_name: str | None = None) -> dict:
    """変換して {'backup': ..., 'stats': ...} を返す"""
    con = open_readonly(db_path)
    try:
        return _convert(con, mapping, now_iso, source_file_name or db_path.name)
    finally:
        con.close()


def _convert(con: sqlite3.Connection, mapping: dict, now_iso: str, source_file_name: str) -> dict:
    start = mapping.get("importFrom", "2022-03-01")
    stats: dict = {"importFrom": start, "anomalies": [], "notes": []}
    anomalies: list[str] = stats["anomalies"]

    # --- 資産グループ・資産・分類 ---
    group_names = {r["uid"]: r["ACC_GROUP_NAME"] for r in con.execute("SELECT uid, ACC_GROUP_NAME FROM ASSETGROUP")}
    mm_assets = {}
    for r in con.execute("SELECT * FROM ASSETS"):
        mm_assets[r["uid"]] = dict(r)
    cats = {}
    for r in con.execute("SELECT uid, NAME, TYPE, STATUS, pUid FROM ZCATEGORY"):
        cats[r["uid"]] = {"name": r["NAME"] or "", "type": r["TYPE"], "status": r["STATUS"], "pUid": r["pUid"] or ""}
    resolver = CategoryResolver(mapping, cats)

    # --- 有効な明細 ---
    rows = []
    for r in con.execute(
        "SELECT AID, uid, DO_TYPE, WDATE, ZCONTENT, ZDATA, AMOUNT_ACCOUNT, ZMONEY, assetUid, toAssetUid, ctgUid, "
        "txUidTrans, txUidFee, UTIME FROM INOUTCOME WHERE IS_DEL IS NULL OR IS_DEL = 0 ORDER BY AID"
    ):
        d = dict(r)
        d["DO_TYPE"] = str(d["DO_TYPE"])
        d["content"] = (d["ZCONTENT"] or "").strip()
        d["memo"] = (d["ZDATA"] or "").strip()
        d["amount"], d["rounded"] = to_yen(d["AMOUNT_ACCOUNT"] if d["AMOUNT_ACCOUNT"] is not None else d["ZMONEY"])
        d["id"] = "mm-" + (d["uid"] or f"aid{d['AID']}")
        rows.append(d)
    stats["mm_row_counts_all_time"] = Counter(r["DO_TYPE"] for r in rows)
    bad_date = [r for r in rows if not is_local_date(r["WDATE"])]
    if bad_date:
        anomalies.append(f"日付の形が YYYY-MM-DD でない行が {len(bad_date)} 件あり、取り込みません")
        rows = [r for r in rows if is_local_date(r["WDATE"])]
    seen_ids: Counter = Counter()
    for r in rows:
        seen_ids[r["id"]] += 1
        if seen_ids[r["id"]] > 1:
            r["id"] = f"{r['id']}-dup{seen_ids[r['id']]}"
            anomalies.append("uid が重複する明細があり、IDに連番を付けました")

    by_uid = {r["uid"]: r for r in rows if r["uid"]}

    # --- 振替の組 ---
    trans_groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r["DO_TYPE"] in ("3", "4") and r["txUidTrans"]:
            trans_groups[r["txUidTrans"]].append(r)
    pairs = []  # (out_row, in_row)
    paired_ids: set[str] = set()
    for key, grp in trans_groups.items():
        outs = [x for x in grp if x["DO_TYPE"] == "3"]
        ins = [x for x in grp if x["DO_TYPE"] == "4"]
        if len(outs) == 1 and len(ins) == 1:
            pairs.append((outs[0], ins[0]))
            paired_ids.add(outs[0]["id"])
            paired_ids.add(ins[0]["id"])
    unpaired = [r for r in rows if r["DO_TYPE"] in ("3", "4") and r["id"] not in paired_ids]
    stats["pairs_total_all_time"] = len(pairs)

    # --- 手数料（txUidFee） ---
    fee_groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r["txUidFee"]:
            fee_groups[r["txUidFee"]].append(r)
    pair_by_fee: dict[str, list[tuple]] = defaultdict(list)
    for o, i in pairs:
        key = o["txUidFee"] or i["txUidFee"]
        if key:
            pair_by_fee[key].append((o, i))
    fee_stats = Counter()
    fee_of_pair: dict[str, int] = {}  # 出の行の id → 手数料
    consumed: set[str] = set()  # 取り込む明細に吸収された行（初期残高に入れない）
    for key, grp in fee_groups.items():
        exp = [x for x in grp if x["DO_TYPE"] == "1"]
        prs = pair_by_fee.get(key, [])
        if not exp:
            if prs:
                fee_stats["手数料の支出の行がない振替の組"] += 1
            continue
        if len(prs) != 1:
            fee_stats["振替の組と結べない手数料の支出の行（普通の支出のまま）"] += len(exp)
            continue
        o, i = prs[0]
        if o["WDATE"] < start:
            fee_stats["古い（取り込み期間より前）の振替の手数料"] += 1
            continue
        if any(x["assetUid"] != o["assetUid"] for x in exp):
            fee_stats["出金の資産と違う資産の手数料（普通の支出のまま）"] += len(exp)
            continue
        fee_of_pair[o["id"]] = sum(x["amount"] for x in exp)
        for x in exp:
            consumed.add(x["id"])
            if x["WDATE"] != o["WDATE"]:
                fee_stats["手数料の日付が振替と違う"] += 1
        fee_stats["振替に結べた手数料（支出の行を取り込まない）"] += len(exp)
        fee_stats["手数料をつけた振替"] += 1
    stats["fee"] = fee_stats

    # --- 取り込む明細を作る ---
    transactions: list[dict] = []
    tag_stats = Counter()
    tag_conflicts: list[str] = []
    rounded_rows: list[dict] = []
    pair_problems = Counter()
    folded_pair_row_ids: set[str] = set()  # 取り込み期間より前の組（初期残高に入れる）

    # メモの印の突き合わせ用：TAG テーブルの行（あれば）
    tag_by_tx: dict[str, str] = {}
    if table_exists(con, "TAG") and table_exists(con, "TX_TAG"):
        tag_names = {r["uid"]: r["name"] or "" for r in con.execute("SELECT uid, name FROM TAG WHERE isDel IS NULL OR isDel = 0")}
        for r in con.execute("SELECT txUid, tagUid FROM TX_TAG WHERE isDel IS NULL OR isDel = 0"):
            nm = tag_names.get(r["tagUid"], "")
            if "満足" in nm:
                tag_by_tx[r["txUid"]] = "satisfied"
            elif "反省" in nm:
                tag_by_tx[r["txUid"]] = "regret"

    def base(row: dict, now: str) -> dict:
        created = iso_from_ms(row["UTIME"], now)
        return {"id": row["id"], "createdAt": created, "updatedAt": created, "deletedAt": None}

    def tag_for(row: dict, memo: str) -> tuple[str, str | None]:
        new_memo, tag = split_memo_tag(memo)
        table_tag = tag_by_tx.get(row["uid"])
        if tag is not None:
            tag_stats["メモの印から移した（満足）" if tag == "satisfied" else "メモの印から移した（反省）"] += 1
            if table_tag is not None and table_tag != tag:
                tag_conflicts.append(f"{row['WDATE']} {row['content']}：メモは{'満足' if tag == 'satisfied' else '反省'}、タグの表は{'満足' if table_tag == 'satisfied' else '反省'}（メモを優先）")
            return new_memo, tag
        if table_tag is not None:
            tag_stats["タグの表から移した（満足）" if table_tag == "satisfied" else "タグの表から移した（反省）"] += 1
            return memo, table_tag
        return memo, None

    for r in rows:
        if r["id"] in consumed or r["WDATE"] < start:
            continue
        t = r["DO_TYPE"]
        if t in ("3", "4"):
            continue
        if r["rounded"]:
            rounded_rows.append(r)
        amount = r["amount"]
        tx = base(r, now_iso)
        tx.update({"date": r["WDATE"], "accountId": "mm-asset-" + (r["assetUid"] or ""), "content": r["content"], "memo": r["memo"], "source": "import"})
        if t in ("0", "1"):
            kind_type = "income" if t == "0" else "expense"
            if r["ctgUid"] == SYSTEM_ADJUST_CATEGORY_UID:
                tx["type"] = "adjustment"
                tx["amount"] = amount if t == "0" else -amount
                stats["adjust_from_diff_rows"] = stats.get("adjust_from_diff_rows", 0) + 1
                stats.setdefault("diff_counts", Counter())[t] += 1
                transactions.append(tx)
                continue
            if amount < 0:
                anomalies.append(f"{r['WDATE']} 金額がマイナスの{'収入' if t == '0' else '支出'}の行を、逆の種類に直して取り込みました")
                kind_type = "expense" if t == "0" else "income"
                amount = -amount
            tx["type"] = kind_type
            tx["amount"] = amount
            tx["categoryId"] = resolver.resolve(kind_type, r["ctgUid"], r["content"])
            if kind_type == "expense":
                tx["memo"], tag = tag_for(r, r["memo"])
                if tag:
                    tx["tag"] = tag
            transactions.append(tx)
        elif t in ("7", "8"):
            tx["type"] = "adjustment"
            tx["amount"] = -amount if t == "7" else amount
            transactions.append(tx)
        else:
            anomalies.append(f"{r['WDATE']} 知らない種類（DO_TYPE={t}）の行を取り込みませんでした")

    imported_pairs = 0
    for o, i in pairs:
        if o["WDATE"] < start:
            folded_pair_row_ids.add(o["id"])
            folded_pair_row_ids.add(i["id"])
            continue
        tx = base(o, now_iso)
        if o["rounded"] or i["rounded"]:
            rounded_rows.append(o)
        if o["WDATE"] != i["WDATE"]:
            pair_problems["日付が違う組"] += 1
        if o["amount"] != i["amount"]:
            pair_problems["金額が違う組"] += 1
        if o["toAssetUid"] and o["toAssetUid"] != i["assetUid"]:
            pair_problems["出の行の相手先と入の行の資産が違う組"] += 1
        tx.update(
            {
                "type": "transfer",
                "date": o["WDATE"],
                "amount": o["amount"],
                "accountId": "mm-asset-" + (o["assetUid"] or ""),
                "toAccountId": "mm-asset-" + (i["assetUid"] or ""),
                "content": o["content"],
                "memo": o["memo"],
                "source": "import",
            }
        )
        fee = fee_of_pair.get(o["id"])
        if fee:
            tx["fee"] = fee
        transactions.append(tx)
        consumed.add(o["id"])
        consumed.add(i["id"])
        imported_pairs += 1
    stats["pairs_imported"] = imported_pairs
    stats["pair_problems"] = pair_problems
    stats["unpaired_rows"] = [r for r in unpaired if r["WDATE"] >= start]
    stats["unpaired_rows_before"] = len([r for r in unpaired if r["WDATE"] < start])

    # --- 資産 ---
    used_assets: set[str] = set()
    for tx in transactions:
        used_assets.add(tx["accountId"][len("mm-asset-") :])
        if "toAccountId" in tx:
            used_assets.add(tx["toAccountId"][len("mm-asset-") :])
    map_groups = mapping.get("assetGroups", {})
    map_assets = mapping.get("assets", {})
    default_shift = mapping.get("cardHolidayShift", "after")

    # 初期残高：MM の初期残高 ＋ 取り込む明細に吸収されなかった「取り込み期間より前」の行の影響
    effect_sign = {"0": 1, "1": -1, "3": -1, "4": 1, "7": -1, "8": 1}
    pre_effect: Counter = Counter()
    for r in rows:
        if r["id"] in consumed:
            continue
        if r["WDATE"] < start or r["id"] in folded_pair_row_ids:
            if r["DO_TYPE"] in effect_sign:
                pre_effect[r["assetUid"]] += effect_sign[r["DO_TYPE"]] * r["amount"]

    accounts: list[dict] = []
    ordered = sorted(used_assets, key=lambda u: (int(mm_assets[u]["ORDERSEQ"] or 0) if u in mm_assets else 0, u))
    group_counter: Counter = Counter()
    used_names: Counter = Counter()
    asset_info: dict[str, dict] = {}
    skipped_assets = []
    for uid in ordered:
        a = mm_assets.get(uid)
        if a is None:
            anomalies.append("資産の表にない資産IDを使う明細があります（その明細は資産が見つかりません）")
            continue
        gname = group_names.get(a["groupUid"], "")
        agroup = map_assets.get(a["NIC_NAME"], {}).get("group") or map_groups.get(gname)
        if agroup is None:
            agroup = "other"
            stats["notes"].append(f"資産グループ「{gname}」が mapping.json の assetGroups にないため other にしました")
        name = a["NIC_NAME"] or "(名前なし)"
        used_names[name] += 1
        if used_names[name] > 1:
            name = f"{name}({used_names[name]})"
            anomalies.append("同じ名前の資産があり、名前に番号を付けました")
        opt = map_assets.get(a["NIC_NAME"], {})
        base_open, _ = to_yen(a["AMOUNT"])
        opening = base_open + pre_effect.get(uid, 0)
        acc = {
            "id": "mm-asset-" + uid,
            "createdAt": iso_from_ms(a.get("A_UTIME"), now_iso),
            "updatedAt": iso_from_ms(a.get("A_UTIME"), now_iso),
            "deletedAt": None,
            "name": name,
            "group": agroup,
            "order": group_counter[agroup],
            "includeInUsable": bool(opt.get("includeInUsable", agroup != "investment")),
            "hidden": bool(opt.get("hidden", False)),
            "openingBalance": opening,
        }
        group_counter[agroup] += 1
        accounts.append(acc)
        asset_info[uid] = {"acc": acc, "mm": a, "groupName": gname}

    # カード：引き落とし日・引き落とし口座
    for uid, info in asset_info.items():
        acc, a = info["acc"], info["mm"]
        if acc["group"] != "card":
            continue
        pay_uid = a.get("cardAssetUid") or ""
        try:
            day = int(str(a.get("CARD_DAY_PAY") or "").strip())
        except ValueError:
            day = 0
        shift = map_assets.get(a["NIC_NAME"], {}).get("holidayShift", default_shift)
        if pay_uid in asset_info and 1 <= day <= 31 and shift in HOLIDAY_SHIFTS:
            acc["card"] = {"paymentDay": day, "holidayShift": shift, "paymentAccountId": "mm-asset-" + pay_uid}
        else:
            stats["notes"].append(f"カード「{acc['name']}」は引き落とし口座か引き落とし日が分からない（または口座を取り込まない）ため、card の設定を付けませんでした")

    # 明細が参照する資産が見つからないものを除く
    known = {a["id"] for a in accounts}
    kept = []
    dropped_missing_account = 0
    for tx in transactions:
        if tx["accountId"] not in known or tx.get("toAccountId", tx["accountId"]) not in known:
            dropped_missing_account += 1
            continue
        kept.append(tx)
    transactions = sorted(kept, key=lambda t: (t["date"], t["id"]))
    if dropped_missing_account:
        anomalies.append(f"資産が見つからない明細を {dropped_missing_account} 件取り込みませんでした")

    # --- 繰り返し・よく使う入力 ---
    recurrings, favorites, rep_stats = convert_recurrings_and_favorites(con, mapping, resolver, rows, known, now_iso, start)
    stats["recurring"] = rep_stats

    backup = {
        "app": BACKUP_APP_NAME,
        "schemaVersion": BACKUP_SCHEMA_VERSION,
        "exportedAt": now_iso,
        "source": {
            "type": "rakuna-kakeibo-mmbak",
            "label": "らくな家計簿",
            "fileName": source_file_name,
            "convertedAt": now_iso,
            "importFrom": start,
        },
        "accounts": accounts,
        "categories": [],
        "transactions": transactions,
        "recurrings": recurrings,
        "favorites": favorites,
        "payrolls": [],
        "reserves": [],
        "reserveMoves": [],
        "plannedExpenses": [],
        "budgetSnapshots": [],
        "cardStatements": [],
        "settings": dict(DEFAULT_SETTINGS),
    }

    # --- 統計 ---
    _FALLBACK.update(mapping["fallback"])
    stats["tag_stats"] = tag_stats
    stats["tag_conflicts"] = tag_conflicts
    stats["rounded_rows"] = rounded_rows
    stats["resolver"] = resolver
    stats["asset_info"] = asset_info
    stats["unused_assets_with_balance"] = []
    mm_bal = mm_balances(con)
    stats["mm_balances"] = mm_bal
    for uid, a in mm_assets.items():
        if uid not in asset_info and mm_bal.get(uid, Decimal(0)) != 0:
            stats["unused_assets_with_balance"].append((a["NIC_NAME"], mm_bal[uid]))
    stats["type_counts_import"] = Counter(t["type"] for t in transactions)
    stats["mm_counts_in_range"] = Counter(r["DO_TYPE"] for r in rows if r["WDATE"] >= start)
    stats["monthly"] = monthly_table(rows, transactions, start)
    stats["period"] = (min((t["date"] for t in transactions), default=""), max((t["date"] for t in transactions), default=""))
    stats["recon"] = reconcile(backup, mm_bal, asset_info)
    stats["excluded_counts"] = {
        "手数料の支出の行（振替の手数料にした）": len([r for r in rows if r["id"] in consumed and r["DO_TYPE"] == "1"]),
        "振替の行（組にして1件に）": len([r for r in rows if r["DO_TYPE"] in ("3", "4") and r["WDATE"] >= start and r["id"] in paired_ids]),
        "組のない振替の行": len(stats["unpaired_rows"]),
    }
    return {"backup": backup, "stats": stats}


def monthly_table(rows: list[dict], transactions: list[dict], start: str) -> list[dict]:
    out: dict[str, dict] = defaultdict(lambda: Counter())
    for r in rows:
        if r["WDATE"] < start:
            continue
        m = r["WDATE"][:7]
        if r["DO_TYPE"] == "0":
            out[m]["mm_in_n"] += 1
            out[m]["mm_in_y"] += r["amount"]
        elif r["DO_TYPE"] == "1":
            out[m]["mm_ex_n"] += 1
            out[m]["mm_ex_y"] += r["amount"]
    for t in transactions:
        m = t["date"][:7]
        if t["type"] == "income":
            out[m]["im_in_n"] += 1
            out[m]["im_in_y"] += t["amount"]
        elif t["type"] == "expense":
            out[m]["im_ex_n"] += 1
            out[m]["im_ex_y"] += t["amount"]
    return [{"month": m, **dict(v)} for m, v in sorted(out.items())]


# ---------------------------------------------------------------------------
# 繰り返し・よく使う入力
# ---------------------------------------------------------------------------
def convert_recurrings_and_favorites(con, mapping, resolver, rows, known_accounts, now_iso, start):
    rep_types = mapping.get("repeatTypes", {})
    skip_payees = set(mapping.get("skipRecurringPayees", []))
    skip_tops = set(mapping.get("skipRecurringCategoryTops", []))
    holiday_shift = mapping.get("recurringHolidayShift", "none")
    stats = {"imported": 0, "skipped": [], "evidence": defaultdict(Counter), "favorites_imported": 0, "favorites_skipped": []}

    index: dict[tuple, list[str]] = defaultdict(list)
    for r in rows:
        index[(r["assetUid"], r["DO_TYPE"], r["amount"], r["content"])].append(r["WDATE"])

    def template_of(rec, kind_code: str, content_key: str) -> tuple[dict | None, str]:
        asset = rec["assetUid"] or ""
        if "mm-asset-" + asset not in known_accounts:
            return None, "資産を取り込まない（または見つからない）"
        amount, _ = to_yen(rec["AMOUNT_SUB"])
        if amount < 0:
            return None, "金額がマイナス"
        content = (rec[content_key] or "").strip()
        tpl = {"amount": amount, "accountId": "mm-asset-" + asset, "content": content, "memo": (rec["MEMO"] or "").strip()}
        if kind_code == "3":
            to = rec["toAssetUid"] or ""
            if "mm-asset-" + to not in known_accounts:
                return None, "振替の相手先の資産を取り込まない（または見つからない）"
            tpl.update({"type": "transfer", "toAccountId": "mm-asset-" + to})
        elif kind_code in ("0", "1"):
            kind = "income" if kind_code == "0" else "expense"
            cuid = rec["ctgUid"] or rec["subcategoryUid"] or rec["categoryUid"] or ""
            if cuid == SYSTEM_ADJUST_CATEGORY_UID:
                tpl["type"] = "adjustment"
                tpl["amount"] = amount if kind_code == "0" else -amount
            else:
                tpl["type"] = kind
                tpl["categoryId"] = resolver.resolve(kind, cuid, content, count=False)
        else:
            return None, f"知らない種類（DO_TYPE={kind_code}）"
        return tpl, ""

    recurrings = []
    for rec in con.execute("SELECT * FROM REPEATTRANSACTION WHERE IS_DEL IS NULL OR IS_DEL = 0 ORDER BY DEVICE_ID"):
        label = f"繰り返し#{rec['DEVICE_ID']}"
        rtype = str(rec["REPEAT_TYPE"])
        next_date = date_from_ms(rec["NEXT_DATE"])
        kind_code = str(rec["DO_TYPE"])
        payee = (rec["PAYEE"] or "").strip()
        # 繰り返しの間隔の裏取り：同じ内容・資産・金額の実際の明細のうち、NEXT_DATE より前で一番新しいものとの月の差
        if next_date:
            prev = [d for d in index.get((rec["assetUid"], kind_code, to_yen(rec["AMOUNT_SUB"])[0], payee), []) if d < next_date]
            if prev:
                stats["evidence"][rtype][months_between(max(prev), next_date)] += 1
            else:
                stats["evidence"][rtype]["比べる明細なし"] += 1
        top = resolver.key_of(rec["ctgUid"]).split("/")[0]
        if payee in skip_payees or top in skip_tops:
            stats["skipped"].append((label, rtype, "給料の繰り返しのため取り込まない（給料明細のひな形に置き換える）"))
            continue
        spec = rep_types.get(rtype)
        if spec is None:
            stats["skipped"].append((label, rtype, f"REPEAT_TYPE={rtype} の意味が mapping.json の repeatTypes にない"))
            continue
        if not next_date:
            stats["skipped"].append((label, rtype, "次の予定日（NEXT_DATE）が読めない"))
            continue
        tpl, why = template_of(rec, kind_code, "PAYEE")
        if tpl is None:
            stats["skipped"].append((label, rtype, why))
            continue
        y, m, d = (int(x) for x in next_date.split("-"))
        every = spec["every"]
        if every == "month" and spec.get("day") == "last":
            rule = {"every": "month", "day": "last"}
            generated = date_shift_months(next_date, -1, "last")
        elif every == "month":
            rule = {"every": "month", "day": d}
            generated = date_shift_months(next_date, -1, d)
        elif every == "nMonths":
            n = int(spec["n"])
            rule = {"every": "nMonths", "n": n, "day": d}
            generated = date_shift_months(next_date, -n, d)
        elif every == "year":
            rule = {"every": "year", "month": m, "day": d}
            generated = date_shift_months(next_date, -12, d)
        elif every == "week":
            rule = {"every": "week", "day": dt.date(y, m, d).isoweekday()}
            generated = (dt.date(y, m, d) - dt.timedelta(days=7)).isoformat()
        else:
            stats["skipped"].append((label, rtype, f"repeatTypes の every「{every}」が不正"))
            continue
        created = iso_from_ms(rec["USETIME"], now_iso)
        item = {
            "id": "mm-rep-" + (rec["uid"] or str(rec["DEVICE_ID"])),
            "createdAt": created,
            "updatedAt": created,
            "deletedAt": None,
            "template": tpl,
            "rule": rule,
            "startDate": generated,
            "generatedThrough": generated,
            "holidayShift": holiday_shift,
            "estimated": False,
        }
        end = date_from_ms(rec["END_DATE"])
        if end and end >= generated:
            item["endDate"] = end
        recurrings.append(item)
        stats["imported"] += 1

    favorites = []
    favs = list(con.execute("SELECT * FROM FAVTRANSACTION WHERE IS_DEL IS NULL OR IS_DEL = 0 ORDER BY ORDERSEQ, DEVICE_ID"))
    for n, rec in enumerate(favs):
        label = f"よく使う入力#{rec['DEVICE_ID']}"
        tpl, why = template_of(rec, str(rec["DO_TYPE"]), "PAYEE")
        if tpl is None:
            stats["favorites_skipped"].append((label, why))
            continue
        created = iso_from_ms(rec["USETIME"], now_iso)
        favorites.append(
            {
                "id": "mm-fav-" + (rec["uid"] or str(rec["DEVICE_ID"])),
                "createdAt": created,
                "updatedAt": created,
                "deletedAt": None,
                "template": tpl,
                "order": len(favorites),
            }
        )
        stats["favorites_imported"] += 1
    return recurrings, favorites, stats


# ---------------------------------------------------------------------------
# 残高の照合（アプリの accountLogic.ts の computeBalances と同じ式）
# ---------------------------------------------------------------------------
def compute_app_balances(accounts: list[dict], transactions: list[dict]) -> dict[str, int]:
    bal = {a["id"]: a["openingBalance"] for a in accounts}

    def add(i, delta):
        if i is not None and i in bal:
            bal[i] += delta

    for t in transactions:
        if t.get("deletedAt") is not None:
            continue
        ty = t["type"]
        if ty == "income":
            add(t["accountId"], t["amount"])
        elif ty == "expense":
            add(t["accountId"], -t["amount"])
        elif ty == "transfer":
            add(t["accountId"], -(t["amount"] + t.get("fee", 0)))
            add(t.get("toAccountId"), t["amount"])
        elif ty == "adjustment":
            add(t["accountId"], t["amount"])
    return bal


def reconcile(backup: dict, mm_bal: dict[str, Decimal], asset_info: dict) -> list[dict]:
    app = compute_app_balances(backup["accounts"], backup["transactions"])
    out = []
    for acc in backup["accounts"]:
        uid = acc["id"][len("mm-asset-") :]
        mm = mm_bal.get(uid, Decimal(0))
        diff = Decimal(app[acc["id"]]) - mm
        out.append({"name": acc["name"], "group": acc["group"], "hidden": acc["hidden"], "mm": mm, "app": app[acc["id"]], "diff": diff})
    return out


# ---------------------------------------------------------------------------
# 出力の検証（src/backup.ts の validateBackup と同じ必須項目・型）
# ---------------------------------------------------------------------------
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def _is_iso(v) -> bool:
    if not isinstance(v, str) or not _ISO_RE.match(v):
        return False
    try:
        dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_str(v) -> bool:
    return isinstance(v, str)


def _is_id(v) -> bool:
    return isinstance(v, str) and v != ""


def _is_bool(v) -> bool:
    return isinstance(v, bool)


def _first(*problems):
    for p in problems:
        if p is not None:
            return p
    return None


def _req(v: dict, key: str, ok, what: str, at: str):
    return None if ok(v.get(key)) else f"{at}.{key} が{what}ではありません"


def _opt(v: dict, key: str, ok, what: str, at: str):
    return None if key not in v or ok(v[key]) else f"{at}.{key} が{what}ではありません"


def _check_template(t, at: str):
    if not isinstance(t, dict):
        return f"{at} がオブジェクトではありません"
    return _first(
        _req(t, "type", lambda x: x in ("income", "expense", "transfer", "adjustment"), " income/expense/transfer/adjustment のどれか", at),
        _req(t, "amount", _is_int, "整数の金額", at),
        _req(t, "accountId", _is_id, "空でない文字列", at),
        _opt(t, "toAccountId", _is_id, "文字列", at),
        _opt(t, "fee", _is_int, "整数の金額", at),
        _opt(t, "categoryId", _is_id, "文字列", at),
        _req(t, "content", _is_str, "文字列", at),
        _req(t, "memo", _is_str, "文字列", at),
        _opt(t, "tag", lambda x: x in ("daily", "satisfied", "regret"), " daily/satisfied/regret のどれか", at),
    )


def _check_account(v, at):
    card = v.get("card")
    cp = None
    if "card" in v:
        if not isinstance(card, dict):
            cp = f"{at}.card がオブジェクトではありません"
        else:
            cp = _first(
                _req(card, "paymentDay", _is_int, "整数", f"{at}.card"),
                _req(card, "holidayShift", lambda x: x in HOLIDAY_SHIFTS, " before/after/none のどれか", f"{at}.card"),
                _req(card, "paymentAccountId", _is_id, "空でない文字列", f"{at}.card"),
            )
    return _first(
        _req(v, "name", _is_str, "文字列", at),
        _req(v, "group", lambda x: x in ACCOUNT_GROUPS, " cash/emoney/bank/card/investment/other のどれか", at),
        _req(v, "order", _is_int, "整数", at),
        _req(v, "includeInUsable", _is_bool, " true/false", at),
        _req(v, "hidden", _is_bool, " true/false", at),
        _req(v, "openingBalance", _is_int, "整数の金額", at),
        cp,
    )


def _check_tx(v, at):
    return _first(
        _req(v, "type", lambda x: x in ("income", "expense", "transfer", "adjustment"), " income/expense/transfer/adjustment のどれか", at),
        _req(v, "date", is_local_date, " YYYY-MM-DD 形式の実在する日付", at),
        _req(v, "amount", _is_int, "整数の金額", at),
        _req(v, "accountId", _is_id, "空でない文字列", at),
        _opt(v, "toAccountId", _is_id, "文字列", at),
        _opt(v, "fee", _is_int, "整数の金額", at),
        _opt(v, "categoryId", _is_id, "文字列", at),
        _req(v, "content", _is_str, "文字列", at),
        _req(v, "memo", _is_str, "文字列", at),
        _opt(v, "tag", lambda x: x in ("daily", "satisfied", "regret"), " daily/satisfied/regret のどれか", at),
        _req(v, "source", lambda x: x in ("manual", "recurring", "import"), " manual/recurring/import のどれか", at),
    )


def _check_recurring(v, at):
    rule = v.get("rule")
    rp = None
    if not isinstance(rule, dict):
        rp = f"{at}.rule がオブジェクトではありません"
    else:
        every, day = rule.get("every"), rule.get("day")
        p = f"{at}.rule"
        if every == "week":
            dp = None if _is_int(day) and 1 <= day <= 7 else f"{p}.day が 1〜7 の整数ではありません"
        else:
            dp = None if (_is_int(day) and 1 <= day <= 31) or day == "last" else f"{p}.day が 1〜31 の整数または last ではありません"
        rp = _first(
            None if every in ("month", "nMonths", "year", "week") else f"{p}.every が不正です",
            (None if _is_int(rule.get("n")) and 2 <= rule["n"] <= 12 else f"{p}.n が 2〜12 の整数ではありません") if every == "nMonths" else None,
            (None if _is_int(rule.get("month")) and 1 <= rule["month"] <= 12 else f"{p}.month が 1〜12 の整数ではありません") if every == "year" else None,
            dp,
        )
    return _first(
        _check_template(v.get("template"), f"{at}.template"),
        rp,
        _req(v, "startDate", is_local_date, " YYYY-MM-DD 形式の実在する日付", at),
        _opt(v, "endDate", is_local_date, " YYYY-MM-DD 形式の実在する日付", at),
        _opt(v, "generatedThrough", is_local_date, " YYYY-MM-DD 形式の実在する日付", at),
        _req(v, "holidayShift", lambda x: x in HOLIDAY_SHIFTS, " before/after/none のどれか", at),
        _req(v, "estimated", _is_bool, " true/false", at),
    )


def _check_favorite(v, at):
    return _first(_check_template(v.get("template"), f"{at}.template"), _req(v, "order", _is_int, "整数", at))


def _check_settings(s):
    if not isinstance(s, dict):
        return "settings がオブジェクトではありません"
    return _first(
        None if _is_int(s.get("payday")) and 1 <= s["payday"] <= 31 else "settings.payday が 1〜31 の整数ではありません",
        _req(s, "paydayHolidayShift", lambda x: x in HOLIDAY_SHIFTS, " before/after/none のどれか", "settings"),
        _req(s, "defenseFund", _is_int, "整数の金額", "settings"),
        _req(s, "budgetMonthBoundary", lambda x: x in ("payday", "calendar"), " payday/calendar のどれか", "settings"),
        _req(s, "homeMainFigure", lambda x: x in ("remaining", "spent"), " remaining/spent のどれか", "settings"),
        _req(s, "weekStart", lambda x: x == "monday", " monday", "settings"),
        None if _is_int(s.get("backupReminderDays")) and s["backupReminderDays"] >= 0 else "settings.backupReminderDays が 0 以上の整数ではありません",
        None if s.get("lastBackupAt") is None or _is_iso(s.get("lastBackupAt")) else "settings.lastBackupAt が null または時刻つきの日時ではありません",
    )


STORE_CHECKS = {
    "accounts": _check_account,
    "categories": lambda v, at: None,
    "transactions": _check_tx,
    "recurrings": _check_recurring,
    "favorites": _check_favorite,
    "payrolls": lambda v, at: None,
    "reserves": lambda v, at: None,
    "reserveMoves": lambda v, at: None,
    "plannedExpenses": lambda v, at: None,
    "budgetSnapshots": lambda v, at: None,
    "cardStatements": lambda v, at: None,
}


def validate_backup(data) -> str | None:
    """backup.ts の validateBackup と同じ必須項目・型を確かめる。問題があれば理由、なければ None"""
    if not isinstance(data, dict):
        return "オブジェクトではありません"
    if data.get("app") != BACKUP_APP_NAME:
        return "app が kakeibo-app ではありません"
    if data.get("schemaVersion") != BACKUP_SCHEMA_VERSION:
        return "schemaVersion が 1 ではありません"
    if not _is_iso(data.get("exportedAt")):
        return "exportedAt が時刻つきの日時ではありません"
    for store, check in STORE_CHECKS.items():
        lst = data.get(store)
        if not isinstance(lst, list):
            return f"{store} が配列ではありません"
        seen = set()
        for i, item in enumerate(lst):
            at = f"{store}[{i}]"
            if not isinstance(item, dict):
                return f"{at} がオブジェクトではありません"
            p = _first(
                _req(item, "id", _is_id, "空でない文字列", at),
                _req(item, "createdAt", _is_iso, "時刻つきの日時", at),
                _req(item, "updatedAt", _is_iso, "時刻つきの日時", at),
                None if item.get("deletedAt") is None or _is_iso(item.get("deletedAt")) else f"{at}.deletedAt が null または時刻つきの日時ではありません",
                check(item, at),
            )
            if p is not None:
                return p
            if item["id"] in seen:
                return f"{at}.id「{item['id']}」が同じ {store} の中で重複しています"
            seen.add(item["id"])
    return _check_settings(data.get("settings"))


# ---------------------------------------------------------------------------
# レポート
# ---------------------------------------------------------------------------
TYPE_LABEL = {"0": "収入", "1": "支出", "3": "振替の出", "4": "振替の入", "7": "残高修正（減額）", "8": "残高修正（増額）"}


def render_report(result: dict, mmbak_name: str, mmbak_exported: str, converted_at: str, mmbak_size: int, mmbak_sha: str, validation: str | None) -> str:
    s = result["stats"]
    b = result["backup"]
    L: list[str] = []
    w = L.append
    resolver: CategoryResolver = s["resolver"]
    recon = s["recon"]
    all_match = all(r["diff"] == 0 for r in recon)

    w(f"# 取り込みレポート（{mmbak_exported}）")
    w("")
    w("> 個人データを含みます。GitHub・`public/`・発信には置かないこと。")
    w("")
    w("## 1. 元のファイルと変換")
    w("")
    w(f"- 元のファイル：`{mmbak_name}`（{mmbak_size:,} バイト、SHA-256 `{mmbak_sha[:16]}…`）")
    w(f"- 書き出し日時（ファイル名から）：{mmbak_exported}")
    w(f"- 変換した日時：{converted_at}")
    w(f"- 対象期間：{s['importFrom']} 以降（取り込んだ明細は {s['period'][0]} 〜 {s['period'][1]}）。それより前は資産の初期残高に繰り込み済み")
    w(f"- 出力のJSONの検証（backup.ts と同じ必須項目・型）：{'通過' if validation is None else '**失敗：' + validation + '**'}")
    w(f"- 残高の照合：{'**全資産で一致**' if all_match else '**一致しない資産あり（下の 3 を参照）**'}")
    w("")

    w("## 2. 件数")
    w("")
    w("### 2-1. 種類ごと")
    w("")
    w("| らくな家計簿の種類 | 全期間の有効な行 | 取り込み期間内の行 | 取り込んだ件数 | 取り込まなかった件数と理由 |")
    w("|---|---:|---:|---:|---|")
    tc = s["type_counts_import"]
    mmr = s["mm_counts_in_range"]
    mma = s["mm_row_counts_all_time"]
    diff_rows = s.get("adjust_from_diff_rows", 0)
    w(f"| 収入（0） | {mma['0']:,} | {mmr['0']:,} | {tc['income']:,} | 「差額」（残高修正の形の収入）{_count_diff(s, '0')} 件は残高修正にした |")
    w(f"| 支出（1） | {mma['1']:,} | {mmr['1']:,} | {tc['expense']:,} | 手数料の支出 {s['excluded_counts']['手数料の支出の行（振替の手数料にした）']} 件は振替の手数料にした／「差額」{_count_diff(s, '1')} 件は残高修正にした |")
    w(f"| 振替（3＋4） | {mma['3'] + mma['4']:,} | {mmr['3'] + mmr['4']:,} | {tc['transfer']:,} 件（2行で1件） | 組のない行 {len(s['unpaired_rows'])} 件 |")
    w(f"| 残高修正（7・8） | {mma['7'] + mma['8']:,} | {mmr['7'] + mmr['8']:,} | {mmr['7'] + mmr['8']:,}（残高修正） | なし |")
    w(f"| 「差額」から作った残高修正 | － | － | {diff_rows:,} | 収入・支出の形で記録されていたもの |")
    w(f"| **残高修正の合計** | | | **{tc['adjustment']:,}** | |")
    w(f"| 合計 | {sum(mma.values()):,} | {sum(mmr.values()):,} | {len(b['transactions']):,} | |")
    w("")
    w(f"- 資産：{len(b['accounts'])} 件（うち非表示 {sum(1 for a in b['accounts'] if a['hidden'])} 件）")
    w(f"- 繰り返し：{len(b['recurrings'])} 件、よく使う入力：{len(b['favorites'])} 件")
    w("")
    w("### 2-2. 手数料（実装指示 §0 の確認点）")
    w("")
    if s["fee"]:
        for k, v in s["fee"].items():
            w(f"- {k}：{v} 件")
    else:
        w("- 手数料の行なし")
    w("- 結び方：**手数料は別の支出の行として記録され、振替の出・入の2行と、同じ `txUidFee` で結ばれている**ことを実データで確認した（`txUidTrans` ではなく `txUidFee`）。結べた支出は振替の `fee` にし、支出の行は取り込まない。")
    w("")
    w("### 2-3. 振替の組")
    w("")
    w(f"- 組になった数（全期間）：{s['pairs_total_all_time']:,}、取り込んだ数：{s['pairs_imported']:,}")
    if s["pair_problems"]:
        for k, v in s["pair_problems"].items():
            w(f"- {k}：{v} 件")
    else:
        w("- 日付・金額・相手先が食い違う組：なし")
    w(f"- 組のない行（取り込み期間内）：{len(s['unpaired_rows'])} 件、取り込み期間より前：{s['unpaired_rows_before']} 件")
    for r in s["unpaired_rows"]:
        w(f"  - {r['WDATE']} {TYPE_LABEL.get(r['DO_TYPE'], r['DO_TYPE'])} {yen_text(r['amount'])}円 {r['content']}")
    w("")
    if s["rounded_rows"]:
        w(f"### 2-4. 金額を整数に丸めた行：{len(s['rounded_rows'])} 件")
        w("")
        for r in s["rounded_rows"][:50]:
            w(f"- {r['WDATE']} {r['content']}")
        w("")
    if s["anomalies"]:
        w("### 2-5. そのほかの気づき")
        w("")
        for k, v in Counter(s["anomalies"]).items():
            w(f"- {k}" + (f"（{v} 件）" if v > 1 else ""))
        w("")
    w("### 2-6. 月ごとの収入・支出（らくな家計簿の月次と見比べる用）")
    w("")
    w("「らくな」はらくな家計簿の収入（0）・支出（1）の行。「取込」は変換後の収入・支出（「差額」と手数料の支出を除く）。月の差は「差額」と手数料の分。")
    w("")
    w("| 月 | らくな 収入 件数 | 金額 | 取込 収入 件数 | 金額 | らくな 支出 件数 | 金額 | 取込 支出 件数 | 金額 |")
    w("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for m in s["monthly"]:
        g = m.get
        w(f"| {m['month']} | {g('mm_in_n', 0)} | {yen_text(g('mm_in_y', 0))} | {g('im_in_n', 0)} | {yen_text(g('im_in_y', 0))} | {g('mm_ex_n', 0)} | {yen_text(g('mm_ex_y', 0))} | {g('im_ex_n', 0)} | {yen_text(g('im_ex_y', 0))} |")
    w("")

    w("## 3. 残高の照合（受け入れ条件）")
    w("")
    w("「らくな家計簿の今の残高」＝初期残高＋全期間の有効な明細（SQLで別に計算）。「取り込んだJSONでの残高」＝初期残高（繰り込み後）＋取り込んだ明細（アプリの `computeBalances` と同じ式）。")
    w("")
    w("| 資産 | 種類 | 表示 | らくな家計簿の今の残高 | 取り込んだJSONでの残高 | 差 |")
    w("|---|---|---|---:|---:|---:|")
    for r in recon:
        w(f"| {r['name']} | {r['group']} | {'非表示' if r['hidden'] else '表示'} | {_dec(r['mm'])} | {yen_text(r['app'])} | {_dec(r['diff'])} |")
    w("")
    n_ok = sum(1 for r in recon if r["diff"] == 0)
    w(f"**結果：{n_ok} / {len(recon)} 資産で一致。**" + ("全部一致です。" if all_match else "差のある資産があります。原因の候補：組のない振替、手数料の結び、丸め、残高修正の符号。"))
    w("")
    if s["unused_assets_with_balance"]:
        w("取り込まない資産（取り込み期間に明細がない）のうち、残高が0でないもの：")
        for n, bl in s["unused_assets_with_balance"]:
            w(f"- {n}：{_dec(bl)}")
        w("")
    else:
        w("取り込まない資産（取り込み期間に明細がない）の残高は、すべて0でした。")
        w("")

    w("## 4. 分類")
    w("")
    w("### 4-1. 新の小分類ごとの件数")
    w("")
    for kind, label in (("expense", "支出"), ("income", "収入")):
        w(f"**{label}**")
        w("")
        w("| 新の小分類 | 件数 |")
        w("|---|---:|")
        for (k, name), n in sorted(((k, n) for k, n in resolver.by_target.items() if k[0] == kind), key=lambda x: -x[1]):
            w(f"| {name} | {n:,} |")
        w("")
    w("### 4-2. 付け替えられなかった分類（「その他」系に入れた）")
    w("")
    if resolver.unmapped:
        for (kind, key), n in sorted(resolver.unmapped.items(), key=lambda x: -x[1]):
            w(f"- {'支出' if kind == 'expense' else '収入'}「{key}」：{n} 件 → {mapping_fallback(b, kind)}")
    else:
        w("- なし")
    w("")
    w("### 4-3. 要確認（仮の小分類に入れたもの。表を直して変換し直す）")
    w("")
    if resolver.review:
        total_review = sum(sum(c.values()) for c in resolver.review.values())
        w(f"合計 {total_review:,} 件。`mapping.json` の該当する分類の `rules`（`contains` に店名の一部、`to` に新の小分類）に足して変換し直すと、ここから減ります。")
        w("")
        for (kind, key, to), contents in sorted(resolver.review.items(), key=lambda x: -sum(x[1].values())):
            n = sum(contents.values())
            w(f"#### 旧「{key}」→ 仮に「{to}」：{n:,} 件（{len(contents)} 種類の内容）")
            w("")
            top = contents.most_common(60)
            w("、".join(f"{c}（{k}）" for c, k in top) + (f"、ほか {len(contents) - len(top)} 種類（{n - sum(k for _, k in top)} 件）" if len(contents) > len(top) else ""))
            w("")
    else:
        w("- なし")
        w("")

    w("## 5. タグ（満足・反省）")
    w("")
    if s["tag_stats"]:
        for k, v in s["tag_stats"].items():
            w(f"- {k}：{v} 件")
    else:
        w("- メモの末尾の印・タグの表とも、移す対象はありませんでした（この書き出しには印がありません）。")
    if s["tag_conflicts"]:
        w("- メモとタグの表の食い違い（メモを優先）：")
        for c in s["tag_conflicts"]:
            w(f"  - {c}")
    else:
        w("- メモとタグの表の食い違い：なし")
    w("")

    rs = s["recurring"]
    w("## 6. 繰り返し・よく使う入力")
    w("")
    w(f"- 繰り返し：取り込み {rs['imported']} 件、取り込まなかった {len(rs['skipped'])} 件")
    w(f"- よく使う入力：取り込み {rs['favorites_imported']} 件、取り込まなかった {len(rs['favorites_skipped'])} 件")
    w("")
    w("### 6-1. REPEAT_TYPE の意味（実装指示 §0 の確認点）")
    w("")
    w("有効な繰り返しごとに、NEXT_DATE と、同じ内容・資産・金額で実際に作られた明細のうち NEXT_DATE より前で一番新しいものとの間隔（月）を数えた。")
    w("")
    w("| REPEAT_TYPE | 間隔（月）ごとの件数 | 判断 |")
    w("|---|---|---|")
    for t, cnt in sorted(rs["evidence"].items(), key=lambda x: int(x[0]) if x[0].isdigit() else 0):
        w(f"| {t} | {', '.join(f'{k}か月：{v}件' if isinstance(k, int) else f'{k}：{v}件' for k, v in sorted(cnt.items(), key=lambda x: str(x[0])))} | {_repeat_judgement(t)} |")
    w("")
    if rs["skipped"]:
        w("### 6-2. 取り込まなかった繰り返し")
        w("")
        for label, rtype, why in rs["skipped"]:
            w(f"- {label}（REPEAT_TYPE={rtype}）：{why}")
        w("")
    if rs["favorites_skipped"]:
        w("### 6-3. 取り込まなかったよく使う入力")
        w("")
        for label, why in rs["favorites_skipped"]:
            w(f"- {label}：{why}")
        w("")

    if s["notes"]:
        w("## 7. 注意")
        w("")
        for n in dict.fromkeys(s["notes"]):
            w(f"- {n}")
        w("")
    w("## 8. 本人がすること")
    w("")
    w("1. このレポートの「要確認」を見て、`mapping.json` に内容（店名）の表を足す → 変換し直す。")
    w("2. 立替は取り込んでいません（らくな家計簿に立替の項目がないため）。切り替えのときに未回収の立替があれば、手で付けてください。")
    w("3. アプリの設定「バックアップから追加」でJSONを読む → 資産タブの残高を、らくな家計簿の資産画面と見比べる。")
    w("4. 切り替えの直前に、新しいバックアップを書き出して変換し直す。試しの読み込みは、取り込む前の端末か別のブラウザのプロファイルで行う（アプリにはデータを全部消す操作がない）。")
    w("")
    return "\n".join(L)


def _count_diff(s: dict, t: str) -> int:
    return s.get("diff_counts", {}).get(t, 0)


def _dec(v) -> str:
    d = Decimal(v)
    if d == d.to_integral_value():
        return f"{int(d):,}"
    return f"{d:,.2f}"


_FALLBACK = {"expense": "特別費/その他", "income": "一時収入/その他"}


def mapping_fallback(b, kind):
    return _FALLBACK[kind].replace("/", "＞")


def _repeat_judgement(t: str) -> str:
    return {
        "1": "毎月（同じ日）",
        "8": "毎月の月末",
        "16": "6か月ごと",
        "17": "毎年（同じ月日）",
    }.get(t, "mapping.json の repeatTypes にある場合はそのとおりに変換。ない場合は取り込まない")


# ---------------------------------------------------------------------------
# コマンドライン
# ---------------------------------------------------------------------------
def export_date_from_name(name: str) -> str | None:
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", name)
    return f"{m.group(1)}{m.group(2)}{m.group(3)}" if m else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="らくな家計簿の .mmbak を kakeibo-app のバックアップJSONに変換する")
    ap.add_argument("mmbak", type=Path)
    ap.add_argument("mapping", type=Path)
    ap.add_argument("--out-dir", type=Path, default=Path("."), help="JSONとレポートの出力先（--json-dir・--report-dir を渡さないとき）")
    ap.add_argument("--json-dir", type=Path)
    ap.add_argument("--report-dir", type=Path)
    ap.add_argument("--now", help="変換日時（テスト・再現用。例 2026-10-26T00:00:00.000Z）")
    args = ap.parse_args(argv)

    if not args.mmbak.is_file():
        print(f"ファイルがありません: {args.mmbak}", file=sys.stderr)
        return 2
    mapping = load_mapping(args.mapping)
    now = args.now or dt.datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.datetime.now(UTC).microsecond // 1000:03d}Z"
    ymd = export_date_from_name(args.mmbak.name) or now[:10].replace("-", "")
    json_dir = args.json_dir or args.out_dir
    report_dir = args.report_dir or args.out_dir
    json_dir.mkdir(parents=True, exist_ok=True)
    report_dir.mkdir(parents=True, exist_ok=True)

    result = convert(args.mmbak, mapping, now, args.mmbak.name)
    s = result["stats"]
    problem = validate_backup(result["backup"])

    json_path = json_dir / f"kakeibo-import-from-mmbak-{ymd}.json"
    json_path.write_text(json.dumps(result["backup"], ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    report = render_report(
        result,
        args.mmbak.name,
        f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}",
        now,
        args.mmbak.stat().st_size,
        sha256_of(args.mmbak),
        problem,
    )
    report_path = report_dir / f"{ymd}_取り込みレポート.md"
    report_path.write_text(report, encoding="utf-8")

    recon = s["recon"]
    n_ok = sum(1 for r in recon if r["diff"] == 0)
    print(f"変換しました：明細 {len(result['backup']['transactions'])} 件、資産 {len(result['backup']['accounts'])} 件")
    print(f"残高の照合：{n_ok} / {len(recon)} 資産で一致")
    print(f"JSONの検証：{'通過' if problem is None else '失敗 ' + problem}")
    print(f"出力：{json_path}")
    print(f"出力：{report_path}")
    return 0 if (problem is None and n_ok == len(recon)) else 1


if __name__ == "__main__":
    sys.exit(main())
