"""convert.py のテスト。架空の小さな SQLite をその場で作って確かめる（実データは使わない）。

実行：tools/convert-mmbak で `python -m unittest`
"""

from __future__ import annotations

import contextlib
import copy
import io
import datetime as dt
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import convert as cv

HERE = Path(__file__).parent
SAMPLE_MAPPING = HERE / "fixtures" / "mapping.sample.json"
NOW = "2026-10-26T00:00:00.000Z"
JST = dt.timezone(dt.timedelta(hours=9))


def ms(y: int, m: int, d: int) -> int:
    return int(dt.datetime(y, m, d, 12, 0, tzinfo=JST).timestamp() * 1000)


SCHEMA = """
CREATE TABLE ASSETGROUP (uid TEXT, ACC_GROUP_NAME TEXT);
CREATE TABLE ASSETS (uid TEXT, NIC_NAME TEXT, ORDERSEQ INTEGER, AMOUNT VARCHAR, CARD_DAY_PAY VARCHAR, cardAssetUid TEXT, groupUid TEXT, A_UTIME INTEGER);
CREATE TABLE ZCATEGORY (uid TEXT, NAME TEXT, TYPE INTEGER, STATUS INTEGER, pUid TEXT);
CREATE TABLE INOUTCOME (AID INTEGER PRIMARY KEY, uid TEXT, DO_TYPE VARCHAR, WDATE VARCHAR, ZCONTENT VARCHAR, ZDATA VARCHAR,
  AMOUNT_ACCOUNT REAL, ZMONEY VARCHAR, assetUid TEXT, toAssetUid TEXT, ctgUid TEXT, txUidTrans TEXT, txUidFee TEXT, UTIME INTEGER, IS_DEL INTEGER);
CREATE TABLE REPEATTRANSACTION (DEVICE_ID INTEGER PRIMARY KEY, IS_DEL INTEGER, USETIME INTEGER, END_DATE INTEGER, NEXT_DATE INTEGER, DO_TYPE INTEGER,
  REPEAT_TYPE INTEGER, AMOUNT_SUB REAL, MEMO VARCHAR, PAYEE VARCHAR, uid TEXT, assetUid TEXT, toAssetUid TEXT, ctgUid TEXT, categoryUid TEXT, subcategoryUid TEXT);
CREATE TABLE FAVTRANSACTION (DEVICE_ID INTEGER PRIMARY KEY, IS_DEL INTEGER, USETIME INTEGER, DO_TYPE INTEGER, AMOUNT_SUB REAL, MEMO VARCHAR, PAYEE VARCHAR,
  ORDERSEQ INTEGER, uid TEXT, assetUid TEXT, toAssetUid TEXT, ctgUid TEXT, categoryUid TEXT, subcategoryUid TEXT);
CREATE TABLE TAG (uid TEXT, name TEXT, isDel INTEGER);
CREATE TABLE TX_TAG (txUid TEXT, tagUid TEXT, isDel INTEGER);
"""


def build_db(path: Path, orphan: bool = False, broken_date: bool = False, fractional: bool = False) -> None:
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    con.executemany(
        "INSERT INTO ASSETGROUP VALUES (?,?)",
        [("g1", "現金"), ("g2", "銀行"), ("g3", "カード"), ("g4", "投資")],
    )
    con.executemany(
        "INSERT INTO ASSETS VALUES (?,?,?,?,?,?,?,?)",
        [
            ("W", "テスト財布", 0, "1000", "1", "", "g1", ms(2020, 1, 1)),
            ("B", "テスト銀行", 1, "50000", "1", "", "g2", ms(2020, 1, 1)),
            ("C", "テストカード", 2, "0", "27", "B", "g3", ms(2020, 1, 1)),
            ("O", "旧口座", 3, "300", "1", "", "g2", ms(2020, 1, 1)),
            ("S", "テスト証券", 4, None, "1", "", "g4", ms(2020, 1, 1)),
        ],
    )
    con.executemany(
        "INSERT INTO ZCATEGORY VALUES (?,?,?,?,?)",
        [
            ("p_food", "食費", 1, 0, ""),
            ("c_jisui", "自炊", 1, 2, "p_food"),
            ("c_gaishoku", "外食", 1, 2, "p_food"),
            ("c_conv", "コンビニ", 1, 2, "p_food"),
            ("c_unk", "ほげ", 1, 2, "p_food"),
            ("p_tr", "交通費", 1, 0, ""),
            ("c_train", "電車", 1, 2, "p_tr"),
            ("p_old", "旧特別費", 1, 0, ""),
            ("c_hosp", "病院", 1, 2, "p_old"),
            ("p_fee", "手数料", 1, 0, ""),
            ("p_sal", "給与", 0, 0, ""),
            ("c_sal", "給与", 0, 2, "p_sal"),
            ("c_in_other", "その他", 0, 0, ""),
        ],
    )

    rows = []

    def tx(aid, typ, date, content, amount, asset, ctg="", memo="", to="", trans="", fee="", isdel=0, money=None):
        rows.append((aid, f"u{aid}", typ, date, content, memo, amount, str(money if money is not None else amount), asset, to, ctg, trans, fee, ms(2022, 1, 1), isdel))

    # 2022-03より前（初期残高に繰り込まれる）
    tx(1, "0", "2021-12-31", "前の収入", 10000, "W", "c_sal")
    tx(2, "1", "2021-12-31", "前の支出", 500, "W", "c_jisui")
    tx(3, "3", "2022-02-28", "", 2000, "B", to="W", trans="T0")
    tx(4, "4", "2022-02-28", "", 2000, "W", to="B", trans="T0")
    tx(5, "7", "2022-02-01", "差額", 100, "W")
    # 2022-03以降
    tx(6, "1", "2022-03-01", "ランチ", 300, "W", "c_jisui", memo="ランチ / 満足：おいしい")
    tx(7, "1", "2022-03-02", "テストおやつ店", 200, "W", "c_conv")
    tx(8, "1", "2022-03-02", "ストア", 150, "W", "c_conv")
    tx(9, "1", "2022-03-03", "LUUP", 100, "W", "c_train")
    tx(10, "1", "2022-03-03", "", 160, "W", "c_train")
    tx(11, "1", "2022-03-04", "どこか", 90, "W", "c_unk")
    tx(12, "0", "2022-03-05", "立替の返金", 700, "W", "c_in_other")
    tx(13, "0", "2022-03-25", "給料", 20000, "B", "c_sal")
    tx(14, "3", "2022-03-26", "", 5000, "B", to="W", trans="T1", fee="F1")
    tx(15, "4", "2022-03-26", "", 5000, "W", to="B", trans="T1", fee="F1")
    tx(16, "1", "2022-03-26", "手数料", 110, "B", "p_fee", fee="F1")
    tx(17, "3", "2022-03-27", "", 3000, "B", to="S", trans="T2", fee="F2")
    tx(18, "4", "2022-03-27", "", 3000, "S", to="B", trans="T2", fee="F2")
    tx(19, "1", "2022-03-27", "手数料", 100, "W", "p_fee", fee="F2")  # 出金と違う資産 → 普通の支出のまま
    if orphan:
        tx(20, "3", "2022-03-28", "", 400, "W", to="B", trans="T9")  # 相手のいない片割れ
    tx(21, "7", "2022-04-01", "差額", 50, "W")
    tx(22, "8", "2022-04-02", "差額", 80, "W")
    tx(23, "0", "2022-04-03", "差額", 25, "W", "-4")
    tx(24, "1", "2022-04-04", "差額", 35, "W", "-4")
    tx(25, "1", "2022-04-05", "削除済み", 999, "W", "c_jisui", isdel=1)
    tx(26, "1", "2022-04-06", "カード払い", 4000, "C", "c_gaishoku")
    tx(27, "1", "2022-04-07", "端数", 99.5 if fractional else 100, "W", "c_gaishoku")
    tx(28, "1", "2022-04-08", "病院", 800, "W", "c_hosp")
    tx(29, "1", "2022-04-09", "反省のはず", 120, "W", "c_jisui", memo="反省")
    tx(30, "1", "2022-04-10", "印と表が食い違う", 130, "W", "c_jisui", memo="満足")
    if broken_date:
        tx(31, "1", "2022-13-45", "壊れた日付", 1, "W", "c_jisui")
    con.executemany("INSERT INTO INOUTCOME VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("INSERT INTO TAG VALUES ('tg_reg','反省',0)")
    con.execute("INSERT INTO TX_TAG VALUES ('u30','tg_reg',0)")

    rep = [
        # DEVICE_ID, IS_DEL, USETIME, END_DATE, NEXT_DATE, DO_TYPE, REPEAT_TYPE, AMOUNT_SUB, MEMO, PAYEE, uid, asset, to, ctg
        (1, 0, ms(2026, 9, 27), 0, ms(2026, 10, 27), 1, 1, 500.0, "", "テスト購読", "r1", "W", "", "c_gaishoku"),
        (2, 0, ms(2026, 9, 30), 0, ms(2026, 10, 31), 1, 8, 700.0, "", "テスト月末", "r2", "W", "", "c_gaishoku"),
        (3, 0, ms(2026, 9, 1), 0, ms(2026, 10, 1), 1, 99, 100.0, "", "意味不明", "r3", "W", "", "c_gaishoku"),
        (4, 0, ms(2026, 9, 25), 0, ms(2026, 10, 25), 0, 1, 99999.0, "", "テスト会社", "r4", "B", "", "c_sal"),
        (5, 0, ms(2026, 2, 28), 0, ms(2027, 2, 28), 1, 17, 3000.0, "", "テスト年額", "r5", "W", "", "c_gaishoku"),
        (6, 0, ms(2026, 2, 28), 0, ms(2026, 3, 31), 1, 1, 800.0, "", "テスト末日", "r6", "W", "", "c_gaishoku"),
        (7, 1, ms(2026, 2, 28), 0, ms(2026, 3, 31), 1, 1, 800.0, "", "削除済み", "r7", "W", "", "c_gaishoku"),
        (8, 0, ms(2026, 7, 25), 0, ms(2027, 1, 25), 1, 16, 5000.0, "", "テスト半年", "r8", "W", "", "c_gaishoku"),
    ]
    con.executemany(
        "INSERT INTO REPEATTRANSACTION (DEVICE_ID, IS_DEL, USETIME, END_DATE, NEXT_DATE, DO_TYPE, REPEAT_TYPE, AMOUNT_SUB, MEMO, PAYEE, uid, assetUid, toAssetUid, ctgUid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rep,
    )
    con.executemany(
        "INSERT INTO FAVTRANSACTION (DEVICE_ID, IS_DEL, USETIME, DO_TYPE, AMOUNT_SUB, MEMO, PAYEE, ORDERSEQ, uid, assetUid, toAssetUid, ctgUid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (1, 0, ms(2026, 1, 1), 3, 10000.0, "", "", 0, "f1", "B", "W", ""),
            (2, 0, ms(2026, 1, 1), 1, 300.0, "", "テスト自販機", 1, "f2", "W", "", "c_jisui"),
            (3, 1, ms(2026, 1, 1), 1, 300.0, "", "削除済み", 2, "f3", "W", "", "c_jisui"),
            (4, 0, ms(2026, 1, 1), 1, 300.0, "", "資産なし", 3, "f4", "O", "", "c_jisui"),
        ],
    )
    con.commit()
    con.close()


class ConvertTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.db = self.dir / "MM(2026-09-30-225019).mmbak"
        self.mapping = cv.load_mapping(SAMPLE_MAPPING)

    def tearDown(self):
        self._tmp.cleanup()

    def run_convert(self, orphan=False, mapping=None, broken_date=False, fractional=False):
        build_db(self.db, orphan=orphan, broken_date=broken_date, fractional=fractional)
        return cv.convert(self.db, mapping or self.mapping, NOW)

    @staticmethod
    def by_id(result, store):
        return {x["id"]: x for x in result["backup"][store]}


class TestTransactions(ConvertTestBase):
    def test_kinds_and_counts(self):
        r = self.run_convert()
        counts = r["stats"]["type_counts_import"]
        self.assertEqual(counts["income"], 2)  # 差額の収入は残高修正になる
        self.assertEqual(counts["expense"], 12)
        self.assertEqual(counts["transfer"], 2)
        self.assertEqual(counts["adjustment"], 4)
        self.assertEqual(len(r["backup"]["transactions"]), 20)
        for t in r["backup"]["transactions"]:
            self.assertEqual(t["source"], "import")
            self.assertIsNone(t["deletedAt"])

    def test_deleted_and_old_rows_not_imported(self):
        r = self.run_convert()
        ids = {t["id"] for t in r["backup"]["transactions"]}
        self.assertNotIn("mm-u25", ids)  # 削除済み
        for old in ("mm-u1", "mm-u2", "mm-u3", "mm-u4", "mm-u5"):
            self.assertNotIn(old, ids)  # 2022-03より前

    def test_transfer_pair_becomes_one(self):
        r = self.run_convert()
        txs = self.by_id(r, "transactions")
        t = txs["mm-u14"]  # 振替は「出」の行のuid
        self.assertEqual((t["type"], t["amount"], t["date"]), ("transfer", 5000, "2022-03-26"))
        self.assertEqual(t["accountId"], "mm-asset-B")
        self.assertEqual(t["toAccountId"], "mm-asset-W")
        self.assertNotIn("mm-u15", txs)  # 「入」の行は取り込まない

    def test_fee_joined_to_transfer(self):
        r = self.run_convert()
        txs = self.by_id(r, "transactions")
        self.assertEqual(txs["mm-u14"]["fee"], 110)
        self.assertNotIn("mm-u16", txs)  # 手数料の支出の行は取り込まない
        self.assertEqual(r["stats"]["fee"]["手数料をつけた振替"], 1)

    def test_fee_from_other_account_stays_expense(self):
        r = self.run_convert()
        txs = self.by_id(r, "transactions")
        self.assertNotIn("fee", txs["mm-u17"])
        self.assertEqual(txs["mm-u19"]["type"], "expense")
        self.assertEqual(txs["mm-u19"]["amount"], 100)

    def test_adjustment_signs(self):
        r = self.run_convert()
        txs = self.by_id(r, "transactions")
        self.assertEqual(txs["mm-u21"]["amount"], -50)  # DO_TYPE 7 は減額
        self.assertEqual(txs["mm-u22"]["amount"], 80)  # DO_TYPE 8 は増額
        self.assertEqual(txs["mm-u23"]["amount"], 25)  # 「差額」の収入
        self.assertEqual(txs["mm-u24"]["amount"], -35)  # 「差額」の支出
        for k in ("mm-u21", "mm-u22", "mm-u23", "mm-u24"):
            self.assertEqual(txs[k]["type"], "adjustment")
            self.assertNotIn("categoryId", txs[k])

    def test_rounding_reported_and_shows_as_difference(self):
        r = self.run_convert(fractional=True)
        txs = self.by_id(r, "transactions")
        self.assertEqual(txs["mm-u27"]["amount"], 100)
        self.assertEqual([x["id"] for x in r["stats"]["rounded_rows"]], ["mm-u27"])
        diffs = {row["name"]: row["diff"] for row in r["stats"]["recon"]}
        self.assertEqual(diffs["テスト財布"], -0.5)  # 丸めた分は照合の差に出る
        self.db.unlink()
        self.assertEqual(self.run_convert()["stats"]["rounded_rows"], [])

    def test_unpaired_transfer_excluded_and_reported(self):
        r = self.run_convert(orphan=True)
        ids = {t["id"] for t in r["backup"]["transactions"]}
        self.assertNotIn("mm-u20", ids)
        self.assertEqual([x["uid"] for x in r["stats"]["unpaired_rows"]], ["u20"])

    def test_broken_date_is_skipped(self):
        r = self.run_convert(broken_date=True)
        ids = {t["id"] for t in r["backup"]["transactions"]}
        self.assertNotIn("mm-u31", ids)
        self.assertTrue(any("日付" in a for a in r["stats"]["anomalies"]))


class TestAccountsAndBalances(ConvertTestBase):
    def test_accounts(self):
        r = self.run_convert()
        accs = self.by_id(r, "accounts")
        self.assertEqual(set(accs), {"mm-asset-W", "mm-asset-B", "mm-asset-C", "mm-asset-S"})  # 旧口座は取り込まない
        self.assertEqual(accs["mm-asset-W"]["group"], "cash")
        self.assertEqual(accs["mm-asset-B"]["group"], "bank")
        self.assertEqual(accs["mm-asset-S"]["group"], "investment")
        self.assertFalse(accs["mm-asset-S"]["includeInUsable"])  # 投資は使える残金に含めない
        self.assertTrue(accs["mm-asset-W"]["includeInUsable"])
        card = accs["mm-asset-C"]["card"]
        self.assertEqual(card, {"paymentDay": 27, "holidayShift": "after", "paymentAccountId": "mm-asset-B"})
        self.assertEqual([accs[k]["order"] for k in ("mm-asset-W",)], [0])

    def test_hidden_and_usable_from_mapping(self):
        m = copy.deepcopy(self.mapping)
        m["assets"]["テスト財布"] = {"hidden": True}
        r = self.run_convert(mapping=m)
        self.assertTrue(self.by_id(r, "accounts")["mm-asset-W"]["hidden"])

    def test_opening_balance_includes_pre_2022(self):
        r = self.run_convert()
        accs = self.by_id(r, "accounts")
        # 財布：初期1000 ＋ 10000 − 500 ＋ 2000（前の振替の入）− 100（前の残高修正）
        self.assertEqual(accs["mm-asset-W"]["openingBalance"], 12400)
        self.assertEqual(accs["mm-asset-B"]["openingBalance"], 48000)  # 50000 − 2000
        self.assertEqual(accs["mm-asset-C"]["openingBalance"], 0)
        self.assertEqual(accs["mm-asset-S"]["openingBalance"], 0)  # AMOUNT が空

    def test_reconciliation_matches_for_every_account(self):
        r = self.run_convert()
        recon = r["stats"]["recon"]
        self.assertEqual(len(recon), 4)
        for row in recon:
            self.assertEqual(row["diff"], 0, row["name"])
        # 財布を手で確かめる：12400 −300−200−150−100−160−90+700 +5000 −100(手数料の別資産の支出) −50+80+25−35 −100(丸め行) −800 −120 −130
        wallet = next(x for x in recon if x["name"] == "テスト財布")
        self.assertEqual(wallet["app"], wallet["mm"])
        self.assertEqual(wallet["app"], 12400 - 300 - 200 - 150 - 100 - 160 - 90 + 700 + 5000 - 100 - 50 + 80 + 25 - 35 - 100 - 800 - 120 - 130)
        card = next(x for x in recon if x["name"] == "テストカード")
        self.assertEqual(card["app"], -4000)

    def test_orphan_row_shows_up_as_difference(self):
        r = self.run_convert(orphan=True)
        diffs = {row["name"]: row["diff"] for row in r["stats"]["recon"]}
        self.assertEqual(diffs["テスト財布"], 400)  # 取り込まなかった出金 400 の分だけ、アプリ側が多い
        self.assertEqual({k for k, v in diffs.items() if v != 0}, {"テスト財布"})

    def test_app_balance_formula_matches_accountLogic(self):
        accs = [{"id": "a", "openingBalance": 100}, {"id": "b", "openingBalance": 0}]
        txs = [
            {"type": "transfer", "accountId": "a", "toAccountId": "b", "amount": 40, "fee": 5, "deletedAt": None},
            {"type": "adjustment", "accountId": "a", "amount": -10, "deletedAt": None},
            {"type": "expense", "accountId": "b", "amount": 3, "deletedAt": None},
            {"type": "income", "accountId": "b", "amount": 7, "deletedAt": None},
            {"type": "expense", "accountId": "b", "amount": 999, "deletedAt": "2026-01-01T00:00:00.000Z"},
        ]
        self.assertEqual(cv.compute_app_balances(accs, txs), {"a": 45, "b": 44})


class TestCategories(ConvertTestBase):
    def cat(self, r, tid):
        return self.by_id(r, "transactions")[tid].get("categoryId")

    def test_rename_and_deleted_category(self):
        r = self.run_convert()
        self.assertEqual(self.cat(r, "mm-u6"), "seed:expense:食費/ごはん")  # 自炊 → ごはん
        self.assertEqual(self.cat(r, "mm-u26"), "seed:expense:食費/外食")
        self.assertEqual(self.cat(r, "mm-u28"), "seed:expense:生活費/病院・薬")  # 旧の大分類の病院

    def test_content_rule(self):
        r = self.run_convert()
        self.assertEqual(self.cat(r, "mm-u7"), "seed:expense:食費/おやつ")  # 店名で振り分け
        self.assertEqual(self.cat(r, "mm-u9"), "seed:expense:交通費/LUUP")

    def test_default_and_review(self):
        r = self.run_convert()
        self.assertEqual(self.cat(r, "mm-u8"), "seed:expense:食費/ごはん")  # 表にない内容は既定
        self.assertEqual(self.cat(r, "mm-u10"), "seed:expense:交通費/公共交通")
        review = r["stats"]["resolver"].review
        self.assertEqual(sum(review[("expense", "食費/コンビニ", "食費/ごはん")].values()), 1)
        self.assertEqual(review[("expense", "食費/コンビニ", "食費/ごはん")]["ストア"], 1)
        self.assertIn(("expense", "交通費/電車", "交通費/公共交通"), review)
        self.assertNotIn(("expense", "食費/コンビニ", "食費/おやつ"), review)  # 表に合ったものは要確認に出ない

    def test_unmapped_goes_to_fallback(self):
        r = self.run_convert()
        self.assertEqual(self.cat(r, "mm-u11"), "seed:expense:特別費/その他")
        self.assertEqual(r["stats"]["resolver"].unmapped[("expense", "食費/ほげ")], 1)

    def test_income_other_becomes_tatekae_henkin(self):
        r = self.run_convert()
        self.assertEqual(self.cat(r, "mm-u12"), "seed:income:一時収入/立替返金")
        self.assertEqual(self.cat(r, "mm-u13"), "seed:income:給与/給与")

    def test_bad_mapping_target_is_rejected(self):
        m = copy.deepcopy(self.mapping)
        m["expense"]["食費/自炊"] = "食費/存在しない"
        with self.assertRaises(cv.ConvertError):
            cv.validate_mapping(m)


class TestTags(ConvertTestBase):
    def test_split_memo_tag(self):
        f = cv.split_memo_tag
        self.assertEqual(f("満足"), ("", "satisfied"))
        self.assertEqual(f("反省"), ("", "regret"))
        self.assertEqual(f("反省：つい買った"), ("つい買った", "regret"))
        self.assertEqual(f("満足:おいしい"), ("おいしい", "satisfied"))  # 半角コロン
        self.assertEqual(f("友達と / 満足"), ("友達と", "satisfied"))  # 区切りつき
        self.assertEqual(f("友達と / 反省：高かった"), ("友達と / 高かった", "regret"))
        self.assertEqual(f("映画 満足"), ("映画", "satisfied"))
        self.assertEqual(f("とても満足"), ("とても満足", None))  # 語の途中は印ではない
        self.assertEqual(f("メモだけ"), ("メモだけ", None))
        self.assertEqual(f("満足のメモ"), ("満足のメモ", None))  # 末尾でなければ印ではない
        self.assertEqual(f(""), ("", None))

    def test_tags_moved_from_memo(self):
        r = self.run_convert()
        txs = self.by_id(r, "transactions")
        self.assertEqual((txs["mm-u6"]["tag"], txs["mm-u6"]["memo"]), ("satisfied", "ランチ / おいしい"))
        self.assertEqual((txs["mm-u29"]["tag"], txs["mm-u29"]["memo"]), ("regret", ""))
        self.assertNotIn("tag", txs["mm-u7"])  # 印のない明細のタグは空のまま

    def test_conflict_prefers_memo_and_is_reported(self):
        r = self.run_convert()
        txs = self.by_id(r, "transactions")
        self.assertEqual(txs["mm-u30"]["tag"], "satisfied")  # メモは満足、タグの表は反省 → メモを優先
        self.assertEqual(len(r["stats"]["tag_conflicts"]), 1)


class TestRecurringsAndFavorites(ConvertTestBase):
    def test_recurrings(self):
        r = self.run_convert()
        recs = self.by_id(r, "recurrings")
        self.assertEqual(set(recs), {"mm-rep-r1", "mm-rep-r2", "mm-rep-r5", "mm-rep-r6", "mm-rep-r8"})
        r1 = recs["mm-rep-r1"]
        self.assertEqual(r1["rule"], {"every": "month", "day": 27})
        self.assertEqual(r1["generatedThrough"], "2026-09-27")  # NEXT_DATE の前の予定日
        self.assertEqual(r1["template"]["amount"], 500)
        self.assertEqual(r1["template"]["categoryId"], "seed:expense:食費/外食")
        self.assertEqual(recs["mm-rep-r2"]["rule"], {"every": "month", "day": "last"})
        self.assertEqual(recs["mm-rep-r2"]["generatedThrough"], "2026-09-30")
        self.assertEqual(recs["mm-rep-r5"]["rule"], {"every": "year", "month": 2, "day": 28})
        self.assertEqual(recs["mm-rep-r5"]["generatedThrough"], "2026-02-28")
        self.assertEqual(recs["mm-rep-r6"]["rule"], {"every": "month", "day": 31})
        self.assertEqual(recs["mm-rep-r6"]["generatedThrough"], "2026-02-28")  # 前の月に31日がなければ月末
        self.assertEqual(recs["mm-rep-r8"]["rule"], {"every": "nMonths", "n": 6, "day": 25})
        self.assertEqual(recs["mm-rep-r8"]["generatedThrough"], "2026-07-25")

    def test_skipped_recurrings_are_reported(self):
        r = self.run_convert()
        skipped = {label: why for label, _t, why in r["stats"]["recurring"]["skipped"]}
        self.assertIn("給料", skipped["繰り返し#4"])
        self.assertIn("REPEAT_TYPE=99", skipped["繰り返し#3"])
        self.assertNotIn("繰り返し#7", skipped)  # 削除済みは対象外

    def test_favorites(self):
        r = self.run_convert()
        favs = r["backup"]["favorites"]
        self.assertEqual([f["id"] for f in favs], ["mm-fav-f1", "mm-fav-f2"])  # 削除済み・資産なしは除く
        self.assertEqual(favs[0]["template"]["type"], "transfer")
        self.assertEqual(favs[0]["template"]["toAccountId"], "mm-asset-W")
        self.assertEqual([f["order"] for f in favs], [0, 1])
        self.assertEqual(len(r["stats"]["recurring"]["favorites_skipped"]), 1)


class TestOutputShape(ConvertTestBase):
    def test_backup_passes_validation(self):
        r = self.run_convert()
        self.assertIsNone(cv.validate_backup(r["backup"]))
        self.assertEqual(r["backup"]["app"], "kakeibo-app")
        self.assertEqual(r["backup"]["schemaVersion"], 1)
        self.assertEqual(r["backup"]["source"]["label"], "らくな家計簿")

    def test_validation_catches_bad_values(self):
        r = self.run_convert()
        bad = copy.deepcopy(r["backup"])
        bad["transactions"][0]["amount"] = 1.5
        self.assertIn("amount", cv.validate_backup(bad))
        bad = copy.deepcopy(r["backup"])
        bad["transactions"][0]["date"] = "2022-02-30"
        self.assertIn("date", cv.validate_backup(bad))
        bad = copy.deepcopy(r["backup"])
        bad["transactions"][1]["id"] = bad["transactions"][0]["id"]
        self.assertIn("重複", cv.validate_backup(bad))
        bad = copy.deepcopy(r["backup"])
        bad["accounts"][0]["group"] = "bank2"
        self.assertIn("group", cv.validate_backup(bad))
        bad = copy.deepcopy(r["backup"])
        del bad["settings"]
        self.assertIsNotNone(cv.validate_backup(bad))

    def test_all_amounts_are_integers_and_dates_valid(self):
        r = self.run_convert()
        for t in r["backup"]["transactions"]:
            self.assertIsInstance(t["amount"], int)
            self.assertTrue(cv.is_local_date(t["date"]))
            if t["type"] != "adjustment":
                self.assertGreaterEqual(t["amount"], 0)

    def test_same_input_gives_same_ids(self):
        r1 = self.run_convert()
        r2 = cv.convert(self.db, self.mapping, "2030-01-01T00:00:00.000Z")
        for store in ("accounts", "transactions", "recurrings", "favorites"):
            self.assertEqual([x["id"] for x in r1["backup"][store]], [x["id"] for x in r2["backup"][store]])
        self.assertTrue(all(t["id"].startswith("mm-") for t in r1["backup"]["transactions"]))
        # 明細の時刻は UTIME 由来なので、変換した日時が変わっても変わらない
        self.assertEqual(r1["backup"]["transactions"][0]["createdAt"], r2["backup"]["transactions"][0]["createdAt"])

    def test_source_file_is_not_modified(self):
        build_db(self.db)
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        mtime = self.db.stat().st_mtime_ns
        cv.convert(self.db, self.mapping, NOW)
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), before)
        self.assertEqual(self.db.stat().st_mtime_ns, mtime)
        self.assertEqual([p.name for p in self.dir.iterdir()], [self.db.name])  # 余計なファイル（-journal など）も作らない

    def test_readonly_connection_rejects_writes(self):
        build_db(self.db)
        con = cv.open_readonly(self.db)
        with self.assertRaises(sqlite3.OperationalError):
            con.execute("DELETE FROM INOUTCOME")
        con.close()

    def test_cli_writes_json_and_report(self):
        build_db(self.db)
        out_json = self.dir / "j"
        out_rep = self.dir / "r"
        with contextlib.redirect_stdout(io.StringIO()):
            code = cv.main([str(self.db), str(SAMPLE_MAPPING), "--json-dir", str(out_json), "--report-dir", str(out_rep), "--now", NOW])
        self.assertEqual(code, 0)  # 残高が全部一致して、JSONの検証も通れば 0
        j = out_json / "kakeibo-import-from-mmbak-20260930.json"
        rep = out_rep / "20260930_取り込みレポート.md"
        self.assertTrue(j.is_file() and rep.is_file())
        data = json.loads(j.read_text(encoding="utf-8"))
        self.assertIsNone(cv.validate_backup(data))
        text = rep.read_text(encoding="utf-8")
        self.assertIn("4 / 4 資産で一致", text)
        self.assertIn("要確認", text)

    def test_cli_returns_nonzero_when_balances_differ(self):
        build_db(self.db, orphan=True)
        with contextlib.redirect_stdout(io.StringIO()):
            code = cv.main([str(self.db), str(SAMPLE_MAPPING), "--out-dir", str(self.dir / "o"), "--now", NOW])
        self.assertEqual(code, 1)


class TestHelpers(unittest.TestCase):
    def test_date_shift_months(self):
        self.assertEqual(cv.date_shift_months("2026-03-31", -1), "2026-02-28")
        self.assertEqual(cv.date_shift_months("2026-03-31", -1, 31), "2026-02-28")
        self.assertEqual(cv.date_shift_months("2026-10-31", -1, "last"), "2026-09-30")
        self.assertEqual(cv.date_shift_months("2027-01-25", -6, 25), "2026-07-25")
        self.assertEqual(cv.date_shift_months("2028-02-29", -12, 29), "2027-02-28")

    def test_months_between(self):
        self.assertEqual(cv.months_between("2026-09-30", "2026-10-31"), 1)
        self.assertEqual(cv.months_between("2026-07-24", "2027-01-25"), 6)
        self.assertEqual(cv.months_between("2025-12-11", "2026-12-11"), 12)

    def test_to_yen(self):
        self.assertEqual(cv.to_yen("1000"), (1000, False))
        self.assertEqual(cv.to_yen(99.5), (100, True))
        self.assertEqual(cv.to_yen(None), (0, False))
        self.assertEqual(cv.to_yen(""), (0, False))

    def test_export_date_from_name(self):
        self.assertEqual(cv.export_date_from_name("MM(2026-09-30-225019).mmbak"), "20260930")
        self.assertIsNone(cv.export_date_from_name("backup.mmbak"))


if __name__ == "__main__":
    unittest.main()
