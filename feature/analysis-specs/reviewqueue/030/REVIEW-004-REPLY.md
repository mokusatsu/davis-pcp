# Feature 030 レビュー004 修正報告（残項目2点への対応）

## 1. 個体図の選択表示の整合確認

dev :5174＋backend :8420、mca-demo 24行・3変数（m=3・K=6・rank2）で実施。

- Tableで1行にチェック→sidebar「選択行 1 / active 24 / 全24」（ROW-000001）
- MCAへ復帰→結果保持（KeepAlive）
- 個体図で `stroke="#2a78d6"` の青枠1点を確認（選択行と対応）
- sidebar解除→選択行0、青枠0点に復帰を確認

前回の「個体図タブでは強調なし」は、カテゴリ図のオレンジ枠（`#fa8c16`、連動強調）と混同した報告だった。個体図の選択表示は中央選択に対する青枠（`#2a78d6`）であり、正常に動作する。カテゴリ図のオレンジ強調3点・解除時消去は前回確認済み。双方向の確認が揃った。

## 2. 本番配信経路の証拠

- preview backend相当のopenapiに `/api/v1/models/mca`・`/analysis-results/{result_id}/rows` 掲載を確認。
- `fullstack/frontend/dist/index.html` は存在するが、現dist（17:05 build）はMCA画面作成前のため `MultipleCorrespondencePage` を含まない（grep 0件）。本番配信物でのMCA実行・結果表示は未確認。
- 代替としてdev経路（vite :5174＋backend :8420）でMCA画面を開き、既知fixture（mca-demo 24行）の実行・結果表示（m=3・K=6・rank2・個体24）を確認。
- 新規ビルドは本レビューで要求・許可されていないため未実施。必要性とコマンド: `npm --prefix fullstack/frontend run build`（dist更新後に `run-production.bat` で起動。batはdist存在時ビルド省略＋uvicorn :8420起動の構成）。
- 実装コードの変更なし。

## 検証

- 実装コードの変更なし（レビュー004はコード指摘なし）。
- backend対象24 passed・FE対象3 passed・tsc エラーなしは前回報告を維持。
- R oracle（FactoMineR Indicator一致）を維持。
