# Feature 030 レビュー005 修正報告（本番配信経路への対応）

## 本番ビルドの実行結果

ユーザーの許可を得て `npm --prefix fullstack/frontend run build` を実行した。

- 結果: 失敗。エラー28件はすべて別エージェントの未完成FAMDファイル（`FamdPage.tsx` の未使用変数）によるもの。MCAファイル自体にエラーなし（`tsc -b fullstack/frontend` は通過済み）。
- FAMDファイルは他者の作業物のため、こちらで修正・削除していない。
- このため本番配信物でのMCA実行・結果表示は引き続き未確認。

## 代替証拠（維持）

- preview backend相当のopenapiに `/api/v1/models/mca`・`/analysis-results/{result_id}/rows` 掲載を確認。
- dev経路（vite :5174＋backend :8420）でMCA画面を開き、既知fixture（mca-demo 24行）の実行・結果表示（m=3・K=6・rank2・個体24）を確認。
- `run-production.bat` はdist存在時ビルド省略＋uvicorn :8420起動の構成であることを確認済み。

## 対応案（ユーザー確認中）

- FAMD所有者にビルドエラーの解消を依頼する
- 本番確認はdev経路の証拠で代替し、ビルドは見送る
- ビルド対象からFAMDを一時除外する（所有者確認が必要）

実装コードの変更なし（ビルド実行のみ）。M001〜M008の解消・選択連動の確認は維持する。
