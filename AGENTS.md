# kakeibo-app（家計簿 アプリ本体）フォルダマップ

コード・Git操作・ビルドの正本はここ。

## 正本の場所

- コード・Git操作・ビルド：ここ（`09_開発\01_自分用アプリ\kakeibo-app`）
- 仕様・要件・改善履歴などの資料：`C:\Users\masat\yuki_local_workspace\05_開発・Webアプリ\17_家計簿`（要件の正本は `176_家計簿_要件と経緯.md`、初期仕様は `171_家計簿_初期仕様.md`、段階ごとの実装指示は `172_…`）
- コーディングルール：`09_開発\AGENTS.md`
- Webアプリ開発の共通ルール：`05_開発・Webアプリ\00_共通\`

## ルール

- 仕様書・改善履歴・調査資料をここに増やさない。資料の更新は05側の該当ファイルを直す
- 個人データ（バックアップJSON `kakeibo-backup-*.json`・らくな家計簿の `.mmbak`・変換後のJSON・カード明細・実データ入りスクショ）をコミットしない。`public/` にも置かない
- テストと見本には架空データだけを使う
- アプリを改善したら「05側の現在の仕様（174）の更新＋改善履歴（175）への追記」をワンセットで行う（`00_共通/09_共有_資料整理ルール.md`）。初期仕様（171）は初版公開後は凍結で編集しない
- 検証：`npm run build`（型チェック＋本番ビルド）と `npm test`（純粋ロジックの `node --test`）を通す
- 版番号：`src/constants.ts` の `APP_VERSION` と `package.json` の version をそろえ、変更をpushするたびに上げる
- `package.json` に `"latest"` を書かない。金額は1円単位の整数。削除は論理削除（`deletedAt`）

## コード構成（要点）

- 純粋ロジック（テスト対象）：`src/types.ts`（型）、`src/constants.ts`（DB名・初期設定・版番号）、`src/dateUtils.ts`（暦日 `YYYY-MM-DD`・ISO時刻）、`src/money.ts`（整数の金額）、`src/seedCategories.ts`（分類の初期データ）、`src/backup.ts`（書き出し・検証）、`src/importPreview.ts`（追加インポートの差分）
- IndexedDB：`src/storage.ts`（DB名 `kakeibo-app`、DB_VERSION 1。ストアは型ごとに1つ＋`settings`。`transactions` に索引 date / accountId / toAccountId / categoryId / updatedAt）
- 画面：`src/App.tsx`（骨組み）、`src/TabBar.tsx`（下タブ5つ）、`src/SettingsView.tsx`（設定）、`src/Icon.tsx`
- 初期分類のIDは `seed:expense:食費/ごはん` のような固定の文字列（端末が違っても同じ分類は同じIDにして、追加インポートで二重にならないようにする）
- 段階2以降：資産・分類・設定の画面 → 入力と明細 → 振替・カード・立替 → 繰り返し・給料明細 → 使える額と予算 → らくな家計簿の変換 → 検索・集計
