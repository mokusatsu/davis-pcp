# Feature 030（MCA）レビュー依頼

## 変更内容・ファイル
- 新規: `fullstack/backend/app/algorithms/models/mca.py`（indicator MCA kernel＋Benzécri＋射影）
- 新規: `fullstack/backend/app/api/mca.py`（POST /api/v1/models/mca）
- 共有基盤（MCA必須追加のみ）: `domain/analysis_contracts.py`、`domain/analysis_frame.py`、`storage/analysis_result_store.py`、`api/analysis_results.py`、`main.py`
- 画面: `MultipleCorrespondencePage.tsx`、`McaFigure.tsx`、`mcaTypes.ts`、`mcaApi.ts`、main/KeepAlive/AppShellへ `/models/mca` 登録
- テスト: `test_110_mca.py`（8件）、`test_111_mca_api.py`（5件）、`frontend/tests/mca.test.tsx`（1件）
- 記録: `tasks/DAVIS-FEAT-030.md`

## 共有基盤への変更
- MCARequest・RectangleSelector追加、predictはinterval=noneのみ
- prepare_mca_frame＋PreparedMcaFrame追加（MA親全体判定、explicit採用のみ）
- rows.parquet・prediction保存追加
- MCA rows/rectangle・変数基準categories・predict・prediction rows・materialize（idempotency・stale拒否）・rows export追加
- CA既存動作は変更なし（test_100_ca 6 passed）

## 旧MCAからの置換内容
- Feature 027のMCA分析部分（Burt併記・nK正規化・旧キー nComponents/includeRowCoordinates/rowOffset等）を廃止
- `/models/mca` と `/api/v1/models/mca` を新契約で一本化。旧キーは422明示拒否
- PCP・スクロール・ヒットテスト・ポップアップ・L1等は維持

## 受入項目別の結果
- MCA01〜MCA10達成、MCA11未検証、MCA12部分達成。詳細は `tasks/DAVIS-FEAT-030.md` 参照
- COM-01/02/04/05/07/08/09/10/11/12達成

## 実行コマンドと件数
- `python -m pytest -q fullstack/backend/tests/stats_tests/test_110_mca.py fullstack/backend/tests/stats_tests/test_111_mca_api.py fullstack/backend/tests/stats_tests/test_100_ca.py`: 19 passed
- `python -m pytest -q fullstack/backend/tests/stats_tests --ignore=test_r_90_reference.py`: passed（R参照除外）
- `npm --prefix fullstack/frontend test -- --run`: 249 passed（59ファイル）
- `./fullstack/frontend/node_modules/.bin/tsc -b fullstack/frontend`: エラーなし
- R 4.6.1＋FactoMineR Indicator照合: 均等・不均等加重とも一致

## 実ブラウザ確認結果
- dev :5174＋backend :8420、mca-demo 24行で実行→個体24・m=2・K=4・rank2
- カテゴリ点クリック→一致24/適用24→sidebar 24行→PCP連動→MCA復帰保持を確認
- 個体矩形ブラシは選択数不変（要調査）。スクリーンショット取得済み

## 未検証事項・残作業
- MCA11自動テスト、MCA12厳密化、個体ブラシ再確認、相互ハイライト、保存後のTable確認
- static実機・本番ビルドは許可待ちのため未実施
