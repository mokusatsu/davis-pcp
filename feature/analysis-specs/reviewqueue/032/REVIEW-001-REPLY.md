# Feature 032 REVIEW-001 修正報告

日付: 2026-09-13 / 対象REVIEW-001（7指摘 L001〜L007）

## L001 共有登録の欠落 → 修正済み
- main.pyへfamd＋linear_regression router登録を復元。openapiに /api/v1/models/linear-regression 掲載を確認。
- main.tsx・KeepAliveOutlet.tsxへFamdPage・LinearRegressionPage登録、AppShellへFAMD・重回帰ナビ復元。
- test_131 3件が再び合格（修正前はレビュー指摘どおり405）。
## L002 missingCodes無視 → 修正済み
- analysis_frame.py: targetと通常数値の学習で_missingCodes付き_numeric_value(spec)_を使用。
- linear_regression.py予測・評価: 通常数値・target観測にmissingCodes照合を追加。
- 隔離検証: x=98・y=99を欠損定義→fitCount=8・missing=2、予測ok=9・missing=1・評価8件。
## L003 dataset評価の無加重 → 修正済み
- 予測評価の重みを共通resolver・検証経路（weight_mode・survey_weight）で解決。dataset/column/noneに対応。
- 隔離検証: datasetとcolumnの同一survey重みでRMSE・MAE・R2が一致、noneとは異なる。係数は更新しない。
## L004 交互作用の変数2 → 修正済み
- LinearRegressionPage.tsx 376行目: setInterDraft([interDraft[0], v ?? null])へ修正。異なる2変数の追加が可能。
- E2E: interactions=[[x,g]]で係数4列・export coefficients 4件を確認。
## L005 古い診断行の選択 → 修正済み
- rowsResultId・rowsLoading・rowsErrorによるrowsReadyガードを追加。未取得・失敗時は選択抑止と表示。
- 点clickもrow_ids経由の版検証付き選択へ変更。矩形選択に版不一致ガードを追加。
## L006 予測・保存元の残留 → 修正済み
- predictResultId・predictIdを保持し、表示は現在のresultIdと照合。dataset切替・再分析で予測・保存元をリセット。
- 保存元Selectは現在のfit＋現在の予測IDのみを候補化。遅延応答はrunSequence＋dataset照合で破棄。
## L007 列名tags配列 → 修正済み
- onChangeで配列→単一文字列へ正規化しmaxCount=1を追加。変更した列名での保存契約を維持。

## 再検証
- test_130 8＋test_131 3＝11 passed。LR+CA+MCA+FAMD 48 passed。tsc エラーなし。FE linear-regression 2 passed。
- E2E（TestClient）: openapi掲載・fit・rows10・select10/10・predict10/10・materialize10・export3表・stale409を確認。
- 実ブラウザ・staticは未検証（dev占有・ビルド許可なしのため）。
