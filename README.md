# 家計簿（開発名 kakeibo-app）

**使える額を見ながら、収入・支出・資産を記録する、自分用の家計簿。** らくな家計簿の後継。スマホ主体のPWA。

- 公開URL（予定）：https://kirokubox.github.io/kakeibo-app/
- 要件の正本：`05_開発・Webアプリ/17_家計簿/176_家計簿_要件と経緯.md`、初期仕様：`171_家計簿_初期仕様.md`
- 現在は v0.1.0（段階1：土台）。全8段階のうち、後の段階が全部この上に乗る「データの器」まで

## できること（段階1）

- 下タブ5つ（ホーム・明細・集計・見通し・資産）と設定画面の骨組み。中身は「段階◯で作ります」の表示
- データの型（`src/types.ts`）、IndexedDB への保存（全ストア・transactions の索引・論理削除・更新日時）
- 分類の初期データ（大分類→小分類、タグの設定つき）。初回起動時に分類が0件なら入る
- バックアップ：全データの書き出しと、追加インポート（形式の検証→件数のプレビュー→「足す」「新しい方で更新」を選んで実行。1回のトランザクションで書く。既存データは消さない）
- 起動時に永続ストレージを要求し、設定画面に状態と説明を出す
- PWA（ホーム画面に追加、オフラインで開ける、更新は自動で反映）

## 開発

```
npm install
npm run dev        # http://127.0.0.1:5173/kakeibo-app/
npm run build      # 型チェック＋本番ビルド（変更後は必ず通す）
npm test           # 純粋ロジックのテスト（node --test）
npm run preview    # ビルド結果の確認
```

スマホ実機確認（PCと同一Wi-Fi）：`npm.cmd run dev -- --host 0.0.0.0`

## データ保存とバックアップ

- 保存先はブラウザの IndexedDB（DB名 `kakeibo-app`）。**この端末のブラウザ内だけ**で、サーバー・クラウド・ログイン・自動同期はない
- 起動時に `navigator.storage.persist()` を要求する（ブラウザの自動削除を防ぐだけ。「Cookieとサイトデータ」の削除や機種変更では消える。同じ kirokubox.github.io の他のアプリもまとめて消える）
- 設定画面の「バックアップを保存」で `kakeibo-backup-YYYY-MM-DD.json` を書き出す。定期的に保存する
- **バックアップのJSONは個人データ。リポジトリ・`public/` に置かない・gitに入れない**（`.gitignore` で `kakeibo-backup-*.json` を除外）。置き場所は `05_開発・Webアプリ/17_家計簿/backup_json/`
- テストは架空データだけを使う

## 公開（GitHub Pages＋PWA）

- `main` に push すると GitHub Actions（`.github/workflows/deploy.yml`）が Pages へ自動デプロイ
- Vite の `base` は `/kakeibo-app/`（リポジトリ名に一致させる）
- Service Worker はビルドごとに版番号を刻印（`vite.config.ts` のプラグイン）。新しい版を検知したら自動で切り替えてリロードする
- `robots.txt` は `Allow: /`（公開前提・検索インデックス許可）
