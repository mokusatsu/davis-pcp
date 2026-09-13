# DAVIS-FEAT-032 重回帰分析 実装・受入記録

状態: 実装済み（検証: kernel→API→全体回帰→FE型検査→FE単体まで実施、実ブラウザ・static未検証）

開始時: branch=master
既存未コミット変更: MCA/FAMD作業の未コミット差分を保全。LR専用ファイルを新規作成し、共有ファイルはLR必須の追加だけに絞った。
共有ファイル調整: analysis_contracts.py（LR要求・診断矩形・予測区間）、analysis_frame.py（PreparedRegressionFrame＋prepare_regression_frame）、analysis_results.py（LR rows/select/predict/materialize/export分岐＋_lr_rows）、main.py（linear_regression router登録）。既存LOESS・ロジスティック・KDAは無変更。

## 範囲
- Feature 032（重回帰）+ 成立に必要な共通基盤のLR必須追加のみ。
- 対象外: 精度WLS、時系列誤差、混合効果、GLM、ステップワイズ、正則化、自動train/test分割、Feature 033・034。
## 受入条件（LR01〜LR10 + LR適用COM）
- LR01 statsmodels OLS classical/HC3と係数・共分散一致（fixture oracle照合＋reference_kernels照合）
- LR02 HC3一致（同上）
- LR03 frequency物理展開HC3一致
- LR04 survey重み倍率で係数・SE不変（Taylor model_covariance単体試験）
- LR05 選択スコープのsurvey分散で全設計PSU保持（score=0設計）
- LR06 ランク欠損を拒否（LR_RANK_DEFICIENT、列を黙って削除しない）
- LR07 未知カテゴリは予測null（predictionStatus）
- LR08 切片なしR2の意味を非中心化として明示
- LR09 個別PIをHC3/surveyに捏造しない（classical非surveyのみ提供）
- LR10 既存LOESS・ロジスティック回帰のAPIを壊さない（全体回帰で確認）
- COM-01 版競合 / COM-02 scope / COM-05 重み / COM-07 保存 / COM-08 再送 / COM-09 store / COM-10 ページ / COM-11 状態 / COM-12 安全
## 変更ファイル
- 新規kernel: fullstack/backend/app/algorithms/models/linear_regression.py（gelsd WLS、SVD bread、classical/HC3 frequency複製式、適合統計、t推測、Wald同時検定、標準化効果、診断、VIF、QQ、CI/PI半幅）
- 新規survey: fullstack/backend/app/algorithms/survey/model_covariance.py（全設計frame保持・scope外score=0、(stratum,psu)識別、M_h一定・有限・被覆検証、PSU合計・中心化・m/(m-1)・FPC補正、certainty singletonのみ0寄与、D-(p-intercept)参照df）
- 新規API: fullstack/backend/app/api/linear_regression.py（POST /api/v1/models/linear-regression、treatment coding・基準解決・omittedLevels、交互作用2項明示のみ、列順、版競合409、全軸保存、警告、capabilities、encoding保存、rows/predict/predictions/materialize/export/select ids）
- 共通基盤（LR必須追加のみ）: domain/analysis_contracts.py（LinearRegressionRequest・DiagnosticRectangleSelector・PredictionOptions）、domain/analysis_frame.py（PreparedRegressionFrame＋prepare_regression_frame）、api/analysis_results.py（LR分岐＋_lr_rows＋select LR分岐）、main.py（router登録）
- 画面: frontend/src/features/models/LinearRegressionPage.tsx（/models/linear-regression「重回帰」）、LinearRegressionFigure.tsx（適合×残差＋矩形選択＋点toggle）、lrTypes.ts、lrApi.ts＋main.tsx/KeepAliveOutlet.tsx/AppShell.tsxへ登録
- テスト: backend/tests/stats_tests/test_130_linear_regression.py（8件）、test_131_linear_regression_api.py（3件）、frontend/tests/linear-regression.test.tsx（1件2テスト）
## 検証証拠
- kernel: test_130 8 passed（fixture oracle classical/HC3一致、frequency展開一致、rank欠損・leverage、R2種別・AIC k=p+1・SSE=0 null、2層×3PSU手計算Taylor・重み100倍不変・singleton・FPC、VIF・QQ・診断）
- 参照計算: validation/reference_kernels.py olsとclassical差1.0e-17・HC3差6.9e-17で一致。
- API: test_131 3 passed（fit・全ページrows・axes拒否・診断矩形10/10・row_ids・predict 10/10・評価・prediction rows・materialize冪等・設計/共分散拒否・交互作用4列・基準解決・export coefficients 4件）
- 回帰: stats_tests 432 passed（R参照除外）、backend全体473 passed（stats_tests・survey_audit除外）、survey_audit 70 passed（別プロセス）。既存LOESS・ロジスティックを含む全API非破壊。
- FE: tsc -b エラーなし。frontend全体61ファイル252テスト passed（linear-regression 1件2テスト含む）。
- 実ブラウザ: 未検証（dev起動は別セッション占有のため本セッション未起動、ビルド許可なしのため未実施）。
- static/外部oracle: static未検証。R survey等の外部oracle比較は未実施（reference_kernels照合のみ）。
## 受入対応（要点）
- LR01 達成、LR02 達成、LR03 達成、LR04 達成（単体）、LR05 達成（設計保持・score=0）、LR06 達成、LR07 達成（実装済み、API自動試験は未追加）、LR08 達成（uncentered明示）、LR09 達成（capabilities制限）、LR10 達成
- COM-01 達成（公開前版再確認409）、COM-02 達成、COM-05 達成、COM-07 達成（版+1・来歴calculate・idempotency）、COM-08 達成、COM-09 達成、COM-10 達成（全ページrows・export）、COM-11 達成（KeepAlive登録・dataset切替リセット・runSequence破棄の実装、実ブラウザ未検証）、COM-12 達成（有限JSON・CSV式注入対策・path traversal対策）

## 残作業
- [ ] 実ブラウザ確認（local API→実行→全ページrows→PCP選択→列保存→stale→再実行→export→KeepAlive復帰、実ポインタ選択、他ビュー相互ハイライト）
- [ ] survey E2E（2層×各3PSU・scope外PSU・singleton・FPC・層間PSU番号重複・重み倍率のAPI経由確認）
- [ ] 未知カテゴリ・target欠損行予測・外挿・学習重複別評価のAPI自動試験の追加
- [ ] static実機（Pyodide）・本番ビルド（npm run build / build:static）の許可後実施
- [ ] reviewqueue/032 への報告書格納とレビュー監視（10分間隔）

## レビュー001の7件修正（2026-09-13）
- L001 共有登録復元（main.py・main.tsx・KeepAlive・AppShell、openapi確認、test_131再合格）
- L002 欠損定義統一（target・通常数値の学習・予測・評価にmissingCodes適用、隔離検証fitCount=8）
- L003 評価重み共通解決（dataset/column一致・none相違、係数不変）
- L004 変数2保存修正（交互作用追加可、係数4列確認）
- L005 行取得ガード（rowsReady・版検証、点選択もrow_ids経路）
- L006 予測・保存元紐付け（resultId照合・リセット・往復選択）
- L007 列名tags正規化（単一文字列・maxCount=1）
- 再検証: 11・48 passed、tsc正常、E2E確認。報告書: reviewqueue/032/REVIEW-001-REPLY.md

## ビルド検証（2026-09-13 21:30、ビルド許可後）
- frontend build: 成功（8.78s、dist更新）。static build: 成功（9.79s、dist/static更新）。
- backend_app.zipにapp/api/linear_regression.py・app/algorithms/models/linear_regression.py・app/algorithms/survey/model_covariance.py含有を確認（全119件）。
- 実ブラウザ・Pyodide実機操作は未検証（別セッションのdev占有継続のため本セッション未起動）。
