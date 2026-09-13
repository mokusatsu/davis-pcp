# Feature 032 実装報告（レビュー用）

日付: 2026-09-13 / branch: master / run-productionビルド: 未実施（明示許可なし）

## 変更内容・ファイル
- 新規: backend/app/algorithms/models/linear_regression.py、backend/app/algorithms/survey/model_covariance.py、backend/app/api/linear_regression.py、frontend/src/features/models/LinearRegressionPage.tsx・LinearRegressionFigure.tsx・lrTypes.ts・lrApi.ts、tests test_130・test_131、frontend/tests/linear-regression.test.tsx、tasks/DAVIS-FEAT-032.md
- 共有基盤（LR必須追加のみ）: domain/analysis_contracts.py、domain/analysis_frame.py、api/analysis_results.py、main.py、frontend main.tsx・KeepAliveOutlet.tsx・AppShell.tsx
- survey分散への変更: 新規model_covariance.pyのみ。既存algorithms/survey/design.py・covariance.py・クロス集計等の分散処理は無変更。
- 既存LOESS・ロジスティック回帰・KDAは置き換えなし。
## 受入項目別の結果
- LR01/LR02: 達成（fixture oracle＋reference_kernels照合、classical差1.0e-17・HC3差6.9e-17）
- LR03: 達成（frequency整数展開と係数・HC3・自由度・診断が一致）
- LR04: 達成（単体試験で重み100倍の係数・共分散不変）
- LR05: 達成（全設計PSU保持・scope外score=0の設計で実装、単体試験）
- LR06: 達成（LR_RANK_DEFICIENT＋rankTol・依存候補列、黙って削除しない）
- LR07: 達成（実装済みpredictionStatus＋null、API自動試験は残作業）
- LR08: 達成（rSquaredType=uncentered＋見出し注意）
- LR09: 達成（個別PIはclassical非surveyのみ、capabilities制限）
- LR10: 達成（stats 432・backend 473・survey_audit 70・FE 252の全体回帰で非破壊確認）
- COM: COM-01/02/05/07/08/09/10/12は達成。COM-11は実装済み・実ブラウザ未検証。
## 実行コマンドと件数
- test_130: 8 passed / test_131: 3 passed（計11 passed）
- stats_tests（R参照除外）: 432 passed
- backend全体（stats_tests・survey_audit除外）: 473 passed
- survey_audit別プロセス: 70 passed
- LR+CA+MCA+FAMD: 48 passed
- frontend全体: 61ファイル252テスト passed / tsc -b エラーなし / linear-regression 1件2テスト passed

## 実ブラウザ確認結果
- 未検証。理由: 別セッションのdevサーバ占有＋ビルド明示許可なし。openapiに /api/v1/models/linear-regression 掲載はTestClient経由で確認済み。

## 未検証事項・残作業
- 実ブラウザE2E、survey E2E、未知カテゴリ等のAPI自動試験追加、static実機、本番ビルド。詳細はtasks/DAVIS-FEAT-032.md残作業。
- 矛盾報告: 資料間の結果を左右する矛盾は検出なし（SE/t/CI等の略記はJSONキー不採用で実装済み）。
