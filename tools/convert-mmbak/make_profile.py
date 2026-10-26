#!/usr/bin/env python3
"""本人用の初期データ（kakeibo-profile）を作る。

アプリの初期分類は一般向けにしてある。本人に合わせた分類・タグの設定・設定値は、アプリには入れず、
このスクリプトで「取り込み用のJSON」にして、設定の「バックアップから追加」で読み込む
（「設定も読み込む」がオンで開く。ファイルに profile の印があるため）。

仕様の正本：05_開発・Webアプリ/17_家計簿/172_家計簿_実装指示_改善1_一般向けの初期値と使い始めの整備_2026-10-26.md §3

作り方
  ・本人の分類は、v0.8.0 までの初期分類（git のタグ v0.8.0 の src/seedCategories.ts）を読み取って作る。
    このスクリプトには分類の名前を一つも書かない。
  ・同じIDの分類は、本人用の名前・タグの設定で一般向けの初期分類を上書きする（updatedAt を固定値より新しくして「更新する」にする）。
  ・一般向けにしかない分類（現在の src/seedCategories.ts にだけあるもの）は、本人の端末では非表示にする行（hidden: true）を入れる。消さない。
  ・設定は、v0.8.0 の初期設定（給料日25日・前の平日・生活防衛資金100,000円・月の区切り＝給料日・ホームの数字＝今週あと◯円・
    週の始まり＝月曜・お知らせ14日）。

使い方
  python make_profile.py <出力するJSON> [--repo <kakeibo-appのフォルダ>] [--ref v0.8.0] [--now 2026-10-26T00:00:00.000Z]
  python make_profile.py <出力するJSON> --seed-file <旧い seedCategories.ts> --general-file <今の seedCategories.ts>   # git を使わない（テスト用）

出力のJSONは個人データ。リポジトリに入れない（出力先は資料フォルダ 17_家計簿/80_取り込み/）。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

import convert as cv

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

TAG_MODES = {"D": "defaultDaily", "M": "mustChoose", "N": "none"}
STORE_NAMES = (
    "accounts", "categories", "transactions", "recurrings", "favorites", "payrolls",
    "reserves", "reserveMoves", "plannedExpenses", "budgetSnapshots", "cardStatements", "subscriptionReviews",
)
PROFILE_LABEL = "本人用の初期データ"

# v0.8.0 の初期設定（本人が使っていた値）。アプリの一般向けの初期値とは別に、「設定も読み込む」で入れる
PROFILE_SETTINGS = {
    "payday": 25,
    "paydayHolidayShift": "before",
    "defenseFund": 100000,
    "budgetMonthBoundary": "payday",
    "homeMainFigure": "remaining",
    "weekStart": "monday",
    "backupReminderDays": 14,
    "lastBackupAt": None,
}

_GROUP_RE = re.compile(r'\{\s*kind:\s*"(expense|income)"\s*,\s*name:\s*"([^"]+)"\s*,\s*children:\s*\[(.*?)\]\s*,?\s*\}', re.S)
_LEAF_RE = re.compile(r'\[\s*"([^"]+)"\s*,\s*([DMN])\s*\]')


def parse_seed_ts(text: str) -> list[dict]:
    """seedCategories.ts の大分類の一覧 [{kind, name, children: [(名前, tagMode)]}] を読み取る（並びはファイルの順）"""
    groups = []
    for m in _GROUP_RE.finditer(text):
        kids = [(name, TAG_MODES[mode]) for name, mode in _LEAF_RE.findall(m.group(3))]
        if not kids:
            raise ValueError(f"大分類「{m.group(2)}」の小分類が読み取れませんでした")
        groups.append({"kind": m.group(1), "name": m.group(2), "children": kids})
    if not groups:
        raise ValueError("seedCategories.ts から分類を読み取れませんでした")
    return groups


def seed_id(kind: str, parent: str, child: str | None = None) -> str:
    return f"seed:{kind}:{parent}" if child is None else f"seed:{kind}:{parent}/{child}"


def read_git_file(repo: Path, ref: str, path: str) -> str:
    out = subprocess.run(["git", "-C", str(repo), "show", f"{ref}:{path}"], capture_output=True, check=True)
    return out.stdout.decode("utf-8")


def build_categories(old_groups: list[dict], general_groups: list[dict], now: str) -> list[dict]:
    """本人の分類（old_groups）に、一般向けにしかない分類を非表示の行として足す"""

    def row(kind, parent_id, name, order, tag_mode, hidden):
        return {
            "id": "", "createdAt": now, "updatedAt": now, "deletedAt": None,
            "kind": kind, "parentId": parent_id, "name": name, "order": order, "tagMode": tag_mode, "hidden": hidden,
        }

    rows: list[dict] = []
    old_ids: set[str] = set()
    parent_orders: dict[str, int] = {"expense": -1, "income": -1}
    child_orders: dict[str, int] = {}
    counters = {"expense": 0, "income": 0}
    for g in old_groups:
        pid = seed_id(g["kind"], g["name"])
        r = row(g["kind"], None, g["name"], counters[g["kind"]], "none", False)
        r["id"] = pid
        counters[g["kind"]] += 1
        parent_orders[g["kind"]] = r["order"]
        rows.append(r)
        old_ids.add(pid)
        for i, (name, mode) in enumerate(g["children"]):
            cid = seed_id(g["kind"], g["name"], name)
            c = row(g["kind"], pid, name, i, mode, False)
            c["id"] = cid
            rows.append(c)
            old_ids.add(cid)
            child_orders[pid] = i

    # 一般向けにしかない分類 → 非表示（並び順は本人の分類のあとに続ける）
    extra_parent = 0
    for g in general_groups:
        pid = seed_id(g["kind"], g["name"])
        parent_is_new = pid not in old_ids
        if parent_is_new:
            parent_orders[g["kind"]] += 1
            r = row(g["kind"], None, g["name"], parent_orders[g["kind"]], "none", True)
            r["id"] = pid
            rows.append(r)
            extra_parent += 1
        next_order = child_orders.get(pid, -1)
        for name, mode in g["children"]:
            cid = seed_id(g["kind"], g["name"], name)
            if cid in old_ids:
                continue
            next_order += 1
            c = row(g["kind"], pid, name, next_order, mode, True)
            c["id"] = cid
            rows.append(c)
        child_orders[pid] = next_order
    return rows


def build_profile(old_groups: list[dict], general_groups: list[dict], now: str) -> dict:
    data: dict = {
        "app": cv.BACKUP_APP_NAME,
        "schemaVersion": cv.BACKUP_SCHEMA_VERSION,
        "exportedAt": now,
        "profile": {"label": PROFILE_LABEL, "createdAt": now},
    }
    for name in STORE_NAMES:
        data[name] = []
    data["categories"] = build_categories(old_groups, general_groups, now)
    data["settings"] = dict(PROFILE_SETTINGS)
    return data


def now_iso() -> str:
    t = dt.datetime.now(dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="本人用の初期データ（分類・タグの設定・設定値）のJSONを作る")
    ap.add_argument("out", type=Path, help="出力するJSON（例：80_取り込み/kakeibo-profile-yuki.json）")
    ap.add_argument("--repo", type=Path, default=REPO, help="kakeibo-app のフォルダ（git からタグの内容を読む）")
    ap.add_argument("--ref", default="v0.8.0", help="本人の分類を読み取る git のタグ（初期値 v0.8.0）")
    ap.add_argument("--seed-file", type=Path, help="git を使わず、このファイルから本人の分類（旧い seedCategories.ts）を読む")
    ap.add_argument("--general-file", type=Path, help="一般向けの分類を読むファイル（初期値は --repo の src/seedCategories.ts）")
    ap.add_argument("--now", help="作成日時（テスト・再現用）。分類の updatedAt はこれになる。初期分類の固定値（SEED_TIMESTAMP）より新しくすること")
    args = ap.parse_args(argv)

    try:
        old_text = args.seed_file.read_text(encoding="utf-8") if args.seed_file else read_git_file(args.repo, args.ref, "src/seedCategories.ts")
        general_path = args.general_file or (args.repo / "src" / "seedCategories.ts")
        general_text = general_path.read_text(encoding="utf-8")
        old_groups = parse_seed_ts(old_text)
        general_groups = parse_seed_ts(general_text)
    except (OSError, subprocess.CalledProcessError, ValueError) as e:
        print(f"分類を読み取れませんでした：{e}", file=sys.stderr)
        return 2

    now = args.now or now_iso()
    data = build_profile(old_groups, general_groups, now)
    problem = cv.validate_backup(data)
    if problem is not None:
        print(f"作ったJSONの検証に失敗しました：{problem}", file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    cats = data["categories"]
    visible = [c for c in cats if not c["hidden"]]
    print(f"作りました：分類 {len(cats)} 件（表示 {len(visible)} 件、非表示にする一般向けの分類 {len(cats) - len(visible)} 件）、設定 {len(data['settings'])} 項目")
    print(f"出力：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
