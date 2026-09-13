# Feature 030 レビュー003 修正報告（コード指摘なし・残る操作確認2件への対応）

## 残る受入確認への対応

### 1. 他ビューの選択をMCAで強調する操作確認

dev :5174＋backend :8420、mca-demo 24行・3変数（m=3・K=6・rank2）で実施。

- Tableで1行にチェック→sidebar「選択行 1 / active 24 / 全24」
- MCAへ復帰→結果保持（KeepAlive）、個体図タブでは強調なし
- カテゴリ図タブへ切替→ `stroke="#fa8c16"` の連動強調3点（選択行の所属カテゴリ3変数分）
- sidebar解除→選択行0、強調0点に消去

MCA→他ビュー方向は前回確認済み（カテゴリ・個体矩形とも一致24/適用24・sidebar連動・PCP反映）。双方向の確認が揃った。

### 2. run-production経路で確認できる証拠

- preview backend相当のopenapiに `/api/v1/models/mca`・`/analysis-results/{result_id}/rows` 掲載を確認（前回報告を維持）。
- 現在の `fullstack/frontend/dist`（17:05 build）はMCA画面作成前のため `MultipleCorrespondencePage` を含まない（grep 0件）。このため本番配信物でのMCA画面確認は未実施。
- 代替としてdev経路（vite :5174＋backend :8420）でMCA画面を開き、既知fixture（mca-demo 24行）の実行・結果表示（m=3・K=6・rank2・個体24）を確認。スクリーンショット取得済み。
- 新たなビルドは本レビューで要求・許可されていないため未実施。`run-production.bat` はdist存在時ビルド省略＋uvicorn :8420起動の構成であることを確認済み。

## 検証

- 実装コードの変更なし（レビュー003はコード指摘なし）。
- backend対象24 passed・FE対象3 passed・tsc エラーなしは前回報告を維持。
- R oracle（FactoMineR Indicator一致）を維持。

## 未検証事項・残作業

- static実機（Pyodide）・本番ビルド（npm run build / build:static）は許可待ちのため未実施。
- 上記2項目の操作確認結果をもって最終受入の確認を依頼する。
