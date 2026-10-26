# kakeibo-app（家計簿 アプリ本体）フォルダマップ

コード・Git操作・ビルドの正本はここ。

## 正本の場所

- コード・Git操作・ビルド：ここ（`09_開発\01_自分用アプリ\kakeibo-app`）
- 仕様・要件・改善履歴などの資料：`C:\Users\masat\yuki_local_workspace\05_開発・Webアプリ\17_家計簿`（要件の正本は `176_家計簿_要件と経緯.md`、初期仕様は `171_家計簿_初期仕様.md`、段階ごとの実装指示は `172_…`）
- コーディングルール：`09_開発\AGENTS.md`
- Webアプリ開発の共通ルール：`05_開発・Webアプリ\00_共通\`

## ルール

- 仕様書・改善履歴・調査資料をここに増やさない。資料の更新は05側の該当ファイルを直す
- 個人データ（バックアップJSON `kakeibo-backup-*.json`・らくな家計簿の `.mmbak`・変換後のJSON・本人用の初期データ `kakeibo-profile-*.json`・カード明細・実データ入りスクショ）をコミットしない。`public/` にも置かない
- **アプリの初期値は一般向け**（改善1）。本人に特有の分類名・値（副業の種類・交際費や嗜好品の小分類など）をコード・テスト・コメント・README に書かない。本人に合わせた値は、`tools/convert-mmbak/make_profile.py` で作る「本人用の初期データ」（JSON）を「バックアップから追加」で読み込んで入れる
- テストと見本には架空データだけを使う
- アプリを改善したら「05側の現在の仕様（174）の更新＋改善履歴（175）への追記」をワンセットで行う（`00_共通/09_共有_資料整理ルール.md`）。初期仕様（171）は初版公開後は凍結で編集しない
- 検証：`npm run build`（型チェック＋本番ビルド）と `npm test`（純粋ロジックの `node --test`）を通す
- 版番号：`src/constants.ts` の `APP_VERSION` と `package.json` の version をそろえ、変更をpushするたびに上げる
- `package.json` に `"latest"` を書かない。金額は1円単位の整数。削除は論理削除（`deletedAt`）

## コード構成（要点）

- 純粋ロジック（テスト対象）：`src/types.ts`（型）、`src/constants.ts`（DB名・初期設定・版番号）、`src/dateUtils.ts`（暦日 `YYYY-MM-DD`・ISO時刻）、`src/money.ts`（整数の金額）、`src/seedCategories.ts`（分類の初期データ。一般向け。`seed:income:給与` と `seed:income:一時収入/立替返金` は名前もIDも固定）、`src/backup.ts`（書き出し・検証）、`src/importPreview.ts`（追加インポートの差分・「設定も読み込む」）、`src/accountLogic.ts`・`src/categoryLogic.ts`・`src/entryLogic.ts`・`src/transferLogic.ts`・`src/reimburseLogic.ts`・`src/adjustLogic.ts`・`src/periodLogic.ts`・`src/suggestLogic.ts`（資産・分類・入力・振替・立替・残高修正・期間・候補）、段階5：`src/holidays.ts`（祝日。キロクカレンダーから写す）・`src/businessDay.ts`（休日の判定と移動・給料日・カードの引き落とし日）・`src/recurrence.ts`（繰り返しの予定日・自動作成の計画）・`src/payrollLogic.ts`（給料明細のひな形・月の入力・差分）・`src/scheduleLogic.ts`（先の予定の日付）、段階6：`src/budgetLogic.ts`（使える額・変動費・週と月の予算の決め方・ホームの数字）・`src/reserveLogic.ts`（取り置きの残高・出し入れ・支出との同期）・`src/plannedLogic.ts`（予定出費・取り置き済み・済み）・`src/outlookLogic.ts`（見通しの表）、段階8：`src/searchLogic.ts`（検索の正規化・絞り込み・合計）・`src/summaryLogic.ts`（集計の期間・分類別・タグ別・月ごと・予算と実績・残高の推移・残高修正）・`src/subscriptionLogic.ts`（サブスクのまとめ・見直しの記録・90日の判定・解約忘れ）・`src/aiMarkdown.ts`（AI用Markdown）・`src/reconcileLogic.ts`（カードの照合：差額・確定・取り消し）・`src/csvImport.ts`（カード明細CSVの文字コード・列の推定・1対1／まとめ／分けの照合）・`src/dbMigration.ts`（DBの版上げの計画）。テストは `tests/` に同名で置き、`package.json` の `test` と `tsconfig.test.json` に登録する（現在339件。改善1で `tests/weekStart.test.ts`・`tests/profileImport.test.ts` を足した）
- IndexedDB：`src/storage.ts`（DB名 `kakeibo-app`、DB_VERSION 2（版2で `subscriptionReviews` を足した）。ストアは型ごとに1つ＋`settings`。`transactions` に索引 date / accountId / toAccountId / categoryId / updatedAt）
- 画面：`src/App.tsx`（骨組み・繰り返しの自動作成の呼び出し）、`src/EntryView.tsx`（入力画面。繰り返し・給料明細の入口）、`src/RecurrenceSheet.tsx`・`src/RecurringListView.tsx`（繰り返しの設定と一覧）、`src/PayrollTemplateView.tsx`・`src/PayrollEntryView.tsx`・`src/PayrollParts.tsx`（給料明細のひな形と月の入力）、`src/recurringStore.ts`（自動作成の実行と「(毎月)」の材料）、段階6：`src/HomeView.tsx`・`src/BudgetCard.tsx`・`src/UsableCard.tsx`（ホーム）、`src/OutlookView.tsx`・`src/ReservesView.tsx`・`src/ReserveDetailView.tsx`・`src/ReserveEditor.tsx`・`src/ReservePicker.tsx`・`src/PlannedView.tsx`（見通し・取り置き・予定出費）、`src/budgetStore.ts`（予算を決める処理の呼び出しとデータの読み込み）、`src/TabBar.tsx`（下タブ5つ）、`src/SettingsView.tsx`（設定）、`src/Icon.tsx`、段階8：`src/SearchView.tsx`（検索。明細タブの虫めがね）・`src/SummaryView.tsx`・`src/Charts.tsx`（集計とSVGのグラフ）・`src/SubscriptionView.tsx`（サブスク見直し）・`src/AiExportCard.tsx`（設定のAIに渡す書き出し）・`src/ReconcileView.tsx`・`src/StatementHistoryView.tsx`（カードの照合と履歴。資産の明細から）・`src/allData.ts`（検索・集計のために全件を読む）
- 初期分類のIDは `seed:expense:食費/外食` のような固定の文字列（端末が違っても同じ分類は同じIDにして、追加インポートで二重にならないようにする）
- 段階2以降：資産・分類・設定の画面 → 入力と明細 → 振替・カード・立替 → 繰り返し・給料明細 → 使える額と予算 → らくな家計簿の変換（`tools/convert-mmbak`） → 検索・集計・照合（段階8＝v0.8.0） → 改善1（v0.9.0：一般向けの初期値・本人用の初期データ・使い始めの整備）
- 改善1：`src/WelcomeCard.tsx`（ホームの「はじめに」）、`src/FavoritesView.tsx`（よく使う入力の一覧。設定にも入口。追加・編集）、`src/EntryView.tsx` のモード `recurringNew`・`favoriteNew`・`favoriteEdit`、`src/periodLogic.ts`・`src/budgetLogic.ts` の週の始まり（`weekStart`・`weekSpanOf`）、`src/outlookLogic.ts` の1年とまとめ、`src/plannedLogic.ts` の `planSetAside`、`src/budgetLogic.ts` の `isFirstUse`。`tools/convert-mmbak/make_profile.py` が本人用の初期データを作り、`convert.py --profile` が出力に入れる
