# DAVIS-FEAT-031 混合データ因子分析（FAMD）実装・受入記録

状態: 実装中（kernel→API・結果保存→選択・射影・materialize→画面→export→全体回帰の順で進行）

開始時: branch=master
既存未コミット変更: MCA作業の未コミット差分（mca.py/api等untracked、共有3FEファイルのmca+famd登録行）を保全。MCA専用ファイルは編集せず、共有ファイルはFAMD登録行の重複追加がないことをgit diffで確認。CA側セッションと共有範囲をメッセージ調整済み。
共有ファイル調整: main.tsx / KeepAliveOutlet.tsx / AppShell.tsx のFAMD登録は各2行内の1行追加のみ。analysis_contracts.py（FAMDRequest＋predict文言一般化）、analysis_frame.py（PreparedFamdFrame＋prepare_famd_frame＋numpy import）、analysis_result_store.py（既存rows/prediction保存を再利用、新規変更なし）、analysis_results.py（famd分岐＋_famd_predict＋_famd_materialize＋variables export）、main.py（famd router登録）。

## 範囲
- Feature 031（FAMD）+ 成立に必要な共通基盤のFAMD必須追加のみ。
- 対象外: 032〜034、補助変数、欠損補完モデル、クラスタ自動生成、既存API全体移行、FAMDの共通因子モデル化。

## 受入条件（FAMD01〜FAMD10 + FAMD適用COM）
- FAMD01 全慣性=p+Σ(Kj-1) / FAMD02 数値アフィン不変 / FAMD03 カテゴリ改名不変 / FAMD04 √p正規化（√p(1-p)不一致） / FAMD05 重心一致 / FAMD06 変数寄与合計1 / FAMD07 r²・η²範囲 / FAMD08 固定標準化予測 / FAMD09 survey倍率不変 / FAMD10 混合入力・尺度・MA・定数拒否
- COM-01 版競合 / COM-02 scope / COM-04 MA / COM-05 重み / COM-07 保存 / COM-08 再送 / COM-09 store / COM-10 ページ / COM-11 状態 / COM-12 安全

## 変更ファイル
- 新規kernel: fullstack/backend/app/algorithms/models/famd.py（加重ddof0二段階分散、B=(G-p)/√p、exact薄型SVD、全有効軸、符号・縮退規約、個体/数値/カテゴリ幾何、η²恒等式、射影）
- 新規API: fullstack/backend/app/api/famd.py（POST /api/v1/models/famd、規定エラー、全軸個体保存、coordinateConvention、警告2種）
- 共通基盤（FAMD必須追加のみ）: 上記「共有ファイル調整」参照
- 画面: frontend/src/features/models/FamdPage.tsx（/models/famd「混合データ因子分析（FAMD）」）、FamdFigure.tsx（個体/重心図＋相関円）、famdTypes.ts、famdApi.ts + main.tsx / KeepAliveOutlet.tsx / AppShell.tsx へ登録
- テスト: backend/tests/stats_tests/test_120_famd.py（10件）、test_121_famd_api.py（3件）、frontend/tests/famd.test.tsx（1件）

## 検証証拠
- kernel: test_120_famd 10 passed（全慣性5.0・√p分散1-pk・√p(1-p)不一致、アフィン・符号反転距離不変、水準順逆転、survey×100不変・frequency複製一致、重心直接平均・λV/√p恒等式・λ²規約、変数寄与合計1・η²恒等式、cos2全空間分母、再射影一致・加重中心0・相関恒等式、定数・1水準拒否、大平均安定性）。
- 参照計算: feature/analysis-specs/validation/reference_kernels.py の famd と固有値・F・重心・相関・η²が差分0で一致（slice blocksで照合）。
- API・保存: test_121_famd_api 3 passed（正規化・全ページrows、categories AND=4/OR=16・rectangle全件、predict再射影一致・materialize冪等・stale拒否・variables/categories export・重複/尺度拒否）。
- 回帰: test_120+121+110+111+100 の計37 passed。stats_tests全体（R参照除外）421 passed。CA 6 passed、MCA 18 passedを維持。
- FE: famd 1件・mca 1件・correspondence 2件 passed。tscはfrontendプロジェクト指定でエラーなし（サブエージェント報告）。
- 実ブラウザ: 検証済み（独自backend :8421＋独自FE :5175、Iris 150行。数値sepal_width/petal_length＋species、p2 m1 K3 rank4、全慣性4.0、固有値2.332/1.183/0.461/0.024、r²/η²表、相関円viewBox 340、実ポインタ矩形35行選択、カテゴリ点JS clickで解決ボタン有効化、保存後FAMD1列・stale表示、KeepAlive PCP往復で結果保持、dataset切替で設定リセット）。
- static/外部oracle: 未検証（FactoMineR比較は未実施、reference_kernels照合のみ）。

## 残作業
- FactoMineR FAMD oracle比較（row.w・加重ddof0・欠損処理・行列順・重心規約を揃える）。
- カテゴリ点の実ポインタclick選択の改善（brushガードがclickを吸収し、JS合成clickでは有効・実ポインタclickでは解決ボタンが有効化されない）。
- 相関円の3軸切替・rank1画面の実操作確認。
- tasks/task-list.md と本記録の受入対応付け更新。

## レビュー対応（REVIEW-001 F001〜F006、2026-09-13）
- F001 数値missingCodes適用（学習・射影）: fitCount 23・missing除外1・予測23/1を確認。
- F002 valueLabels単独の閉領域化を除去: labels_onlyでfitCount 24・予測24成功を確認。
- F003 相関円の軸名を選択軸に連動（rank1は第2軸名なし）。
- F004 relationタブに[0,1]関係図（famd-relation-svg）を追加。
- F005 predictタブ（射影）を追加。Iris 150行・成功150行を確認。
- F006 FAMD categories exportをprobability/barycenter列名に変更（CA/MCA無変更）。
- 回帰: FAMD 13・FAMD+MCA+CA 37・stats全体421・famd FE 1のpassed。tscはFAMDエラーなし。
- 報告: feature/analysis-specs/reviewqueue/031/REPLY-001.md。

## レビュー対応（REVIEW-003 F007、2026-09-13）
- 射影表示にpredictMeta（datasetId/resultId/axes）を保持し、取得軸名で表見出しを表示。軸変更時は再取得せず取得軸名を維持。
- 再分析・dataset切替で射影状態を消去。進行中射影の無効化時はloading解除。
- 確認: 実ブラウザで第1軸射影→第3軸切替後も「取得軸：第1軸」維持、再分析で「対象 0行」に消去。証拠 .temp/famd-fix-f007-axis.png, famd-fix-f007-rerun.png。
- 回帰: FAMD+MCA+CA 37 passed、famd FE 1 passed、tscはFAMDエラーなし。
- 報告: feature/analysis-specs/reviewqueue/031/REPLY-003.md。

## ビルド・配布確認（2026-09-13）
- `npm run build` 成功（8.83s）。本番バンドルにmodels/famd・famd-run・famd-relation-svgを含む。:8421のSPA配信で/models/famdとopenapiのfamd掲載を確認。
- `build_static.py` はパス連結不備で完走せず（共有スクリプト未編集）。同等のbackend_app.zip（119ファイル・FAMD同梱）を再構築しdist/staticへ配置、openapi掲載とkernel実行を確認。`build:static`再構築とPyodide実実行は残作業。
- 報告: feature/analysis-specs/reviewqueue/031/REPLY-003d.md。

## 最終受入確認（REVIEW-004/005残項目、2026-09-13）
- 本番配信経路: `npm run build` をF007込みで再ビルド成功。バンドルにmodels/famd・関係図・F007文言を含む。:8421のSPA配信で/models/famdとopenapi掲載、既知fixtureでrank5・全慣性5.0の実行を確認。
- rank1画面: 2行fixtureでrank1・p1 m1 K2を確認。個体図はX軸のみ、相関円は第1軸名のみ、関係図を表示。証拠 .temp/famd-rank1-*.png。
- 報告: feature/analysis-specs/reviewqueue/031/REPLY-005.md。
- 残作業: `build_static.py` 完走とPyodide内FAMD実実行（共有スクリプトのパス不備のため）。

## FactoMineR oracle比較（2026-09-13、R 4.6.1＋FactoMineR 2.17）
- test_120同一24行fixtureで非加重・加重（row.w=1,2交互）を照合。固有値・個体・数値相関・カテゴリ重心はいずれもmaxdiff 1e-14以下。本体×100は差分0。
- Rスクリプトと出力は.temp/famd-oracle*.R・.csvに保存。報告はfeature/analysis-specs/reviewqueue/031/REPLY-003c.md。
- R側のvar/v.testは取得のみで照合対象外。

## 残作業の追加対応（REVIEW-003残項目、2026-09-13）
- カテゴリ実ポインタclick: scrollIntoView後の実ポインタclickで解決ボタン有効→sidebar 50行を確認（達成）。証拠 .temp/famd-catclick-fixed.png, famd-catclick-resolve.png。
- 相関円3軸: Y軸第3軸へ変更→相関円「第1軸/第3軸」表示、関係図も第1・第3軸r²表示を確認（達成）。証拠 .temp/famd-axis3-evidence.png。rank1実操作は未実施。
- FactoMineR oracle: Rscript不在のため未検証（reference_kernels照合のみ）。
- 本番経路: dist/staticのbackend_app.zipはFAMDなし旧版を確認。再ビルドが必要（`npm run build`、`python fullstack/scripts/build_static.py`）だが明示許可なしのため未実施。
- 報告: feature/analysis-specs/reviewqueue/031/REPLY-003b.md。
