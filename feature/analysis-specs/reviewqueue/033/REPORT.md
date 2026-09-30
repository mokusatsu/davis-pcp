# Feature 033 EFA 実装報告（レビュー用）

日付: 2026-09-13 / branch: master / run-productionビルド: frontend bundleをビルド済み（backendはTestClientで確認）

## 変更内容・ファイル
- 新規kernel: fullstack/backend/app/algorithms/models/ordinal_correlations.py（Pearson共有集合・polychoric二段階共有閾値・条件付き1次元積分・境界/未収束診断）、factor_analysis_uls.py（uls_profile_full_v1・L-BFGS-B・解析勾配・複数start・u/ψ分離）、factor_analysis_ml.py（Pearson ML完全目的関数・profile勾配・複数start・参考推論・KMO/Bartlett）、factor_rotations.py（Kaiser Varimax対角掃引・Promax power=4・q=1 none・符号正準化・再構成検証・得点）、factor_parallel.py（独立置換・全相関固有値・線形分位・失敗時null）、factor_sensitivity.py（符号付き置換整合・曖昧判定・Procrustes補助・差分・判定）
- 新規service/API: fullstack/backend/app/services/factor_analysis_service.py、fullstack/backend/app/api/factor_analysis.py（POST /api/v1/models/factor-analysis、method=efa・schemaVersion=factor_extensions.1、旧入力拒否、attempt/comparison取得・export・cancel、rows/predict/materialize/export/select ids）
- 共有基盤（EFA必須追加のみ）: domain/analysis_contracts.py（FactorVariable・EFARequest・PA/Sensitivity options・ExportRequestに2表追加）、api/analysis_results.py（efa分岐5箇所）、main.py（router登録）
- 画面: frontend/src/features/models/FactorAnalysisPage.tsx（/models/factor-analysis「因子分析」）、efaApi.ts＋main.tsx/KeepAliveOutlet.tsx/AppShell.tsxへ登録
- テスト: backend/tests/unit/test_efa_kernels.py（11件）、backend/tests/api/test_efa_api.py（3件）
- タスク記録: tasks/DAVIS-FEAT-033.md、tasks/task-list.mdに033行を追加
- oracle・fixture: fullstack/.temp/efa/oracle/（fixture CSV×3・model・R script・oracle JSON・sessionInfo内包）
- 注意: analysis_result_store.py・LinearRegressionPage.tsxの作業ツリー差分は本セッションの変更ではない（別作業の未コミット差分として保全・無変更）。feature/analysis-specs文書群・tasks等の他者差分にも触れていない。

## 受入ID別の結果
- EFA-B01 達成（契約検証＋API拒否試験）/ B02 達成（閾値R一致 maxdiff 0.0）/ B03 実装済み（数値試験は残作業）/ B04 実装済み / B05 達成（API試験）/ B06 達成（polychor pairwise: 5件法ρ maxdiff 2.03e-05・2値 1.81e-05、閾値 0.0）/ B07 実装済み / B08 達成（ML目的値 factanal差0.0・h2差1e-06、勾配有限差分 ULS 3.6e-11・ML 1.3e-08、ULS psych照合は回転規約差で別記・要追加検証）/ B09 達成（再構成rtol=1e-9検証、Promax時ssLoadings null）/ B10 実装済み / B11 実装済み / B12 達成 / B13 達成（API試験）/ B14 実装済み / B15 実装済み / B16 実装済み（bundle・openapi・SPA確認、実ブラウザ残作業）/ B17 実装済み / B18 実装済み / B19 達成（単体）/ B20 実装済み / B21 実装済み / B22 実装済み（性能フル測定は残作業）

## 件数・最大誤差・環境
- kernel/API: 14 passed（EFA単体11＋API 3）。回帰スポット 8 passed。FE tsc -b エラーなし。
- R oracle: R 4.6.1・psych 2.6.5・polycor 0.8.2。Python 3.14.7・NumPy 2.4.6・SciPy 1.18.0・Pydantic 2.13.4。
- 実測: Pearson+ML(n=300,p=6,PA100) 0.1秒。Polychoric+MINRES(n=500,p=6,PA100+感度) 88.5秒。6項目poly行列0.31秒、PA20反復7.8秒。

## 画面・性能の証拠
- frontend distにfactor-analysis含有、health 200・openapi登録・SPA fallback 200を確認。
- 実ブラウザ・Pyodide・全体回帰・性能フル測定は未実施として残作業に明記。

## 残作業
- 全体回帰、実ブラウザ検証（得点選択・相互ハイライト・KeepAlive実ポインタ）、Pyodide/static検証、性能フル測定（N=1000/2000×p=12/30/60×K=5・2/7×PA100/500のlocal/Pyodide別）、EFA-B02/B03数値不変試験の追加、ULS psych照合の追加検証。
