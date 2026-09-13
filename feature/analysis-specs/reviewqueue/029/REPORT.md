# Feature 029（通常のCA）実装結果報告

- HEAD: 9cfcea00（docs: Feature 029 レビュー005の2件実行を記録）
- 履歴: 2a6cbdda（実装）→ 1e112f75（指摘12件修正）→ 6fd247a0（追加指摘4件修正）→ 00ea83bd（記録追記）→ 4a486db6（レビュー001の8件修正）→ 71df4b55（レビュー002残存2件修正）→ 6a305855 / 4dda1a02 / 9cfcea00（最終受入記録）
- 詳細記録: `tasks/DAVIS-FEAT-029.md`
- 前回レビュー: REVIEW-005.md（コード指摘なし、最終受入2件の実行証拠を要求）への対応を含む

## 変更ファイル
- 新規backend 8件: `domain/analysis_contracts.py`、`domain/analysis_frame.py`、`algorithms/analysis_numerics.py`、`services/analysis_service.py`、`storage/analysis_result_store.py`、`algorithms/models/correspondence.py`、`api/correspondence.py`（`POST /api/v1/models/ca`）、`api/analysis_results.py`（GET/DELETE/select/export、predict/materializeは規定422）
- 既存backend 1件: `app/main.py`（2ルータ登録）
- 新規frontend 8件: `CorrespondenceAnalysisPage.tsx`、`caTypes.ts`、`caMap.ts`、`caApi.ts`、`caHelp.tsx`、`caFigure.tsx`、`caTables.tsx`、`caExport.ts`
- 既存frontend 3件: `main.tsx`、`KeepAliveOutlet.tsx`、`AppShell.tsx`（`/models/ca`登録）
- テスト 2件: `tests/stats_tests/test_100_ca.py`（6件）、`tests/correspondence.test.tsx`（2件）

## 受入結果
- CA01〜CA10: すべて達成（`[[30,10],[10,30]]`でλ=0.25、主座標±0.5、χ²=20、df=1。回答者展開一致、定数倍・転置・零周辺不変、全慣性分母、不正拒否、AND=30/OR=50、survey・mass p値なし、rank1一次元、独立表422）
- COM適用項目: 達成（版競合409、scope、重み、保存・stale、KeepAlive、export、有限JSON/CSV対策）。materializeは非該当（422で明示）
- レビュー001（R001〜R008）: すべて解消済み（REVIEW-003で確認）
- レビュー002残存（R001衝突不能キー・R008分割表補完）: 解消済み（`71df4b55`）

## 検証証拠
- `test_100_ca.py`: 6 passed
- 全体回帰（隔離suite除外）: 473 passed
- FE全体: 248 passed（58ファイル）。`tsc --noEmit`: エラーなし
- 実ブラウザ: 80行データで実行→固有値0.25、点選択→一致40/適用40→selection連動、Table連動強調→解除消去、分割表CSV export、版変更後のstale表示・選択無効を確認
- static: `build:static`＋`scripts/build_static.py`はいずれもexit 0。`backend_app.zip`にCA組込。ZIP内kernel取出し実行と同一コードASGI実行で一致を確認
- 外部oracle: R 4.6.1＋FactoMineR 2.17の`CA()`で固有値0.25・行列座標±0.5。base・MASS・独立SVDでも照合し符号除き一致
- 本番相当: `/` 200、openapiに`/models/ca`とanalysis-results 6経路、本番経路でλ=0.25・χ²=20を確認

## 最終受入2件への対応（REVIEW-004/005指摘）
- run-production相当の直接起動: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File fullstack/run-production.ps1` と同一入口を起動し、`/` 200・openapiの`/models/ca`掲載、本番経路でλ=0.25・χ²=20を確認。bat末尾のpauseは起動後の処理であり障害にならない
- Pyodide配信の直接確認: スレッド版サーバでstatic配信し、index.html 200、バンドル内の`models/ca` 3件、pyodide.mjs 200、`backend_app.zip` 200・304952 bytesをHTTP取得。取得ZIP内のCA組込（113 files）とkernel実行（λ=0.25・±0.5）を確認
- 残る未検証はブラウザのPyodide worker内での全操作実行のみ（preview paneの制約で外部URLへ遷移不可）。同一コードの配信・実行は確認済み。報告の「残る未検証はブラウザのみ」は「バッチ未実行」の記載と整合するよう本報告で訂正する（バッチ相当の直接起動は実行済み）

## レビューへのお願い
レビュー結果をこのフォルダ（`reviewqueue/029/`）にご返答ください。OKの返答があれば終了します。指摘がある場合は修正を繰り返します。
