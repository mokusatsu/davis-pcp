# DAVIS-FEAT-030 多重対応分析（MCA）実装・受入記録

状態: 実装中（kernel→API・結果保存→選択・射影・materialize→画面→export→全体回帰の順で進行）

開始時: branch=master
既存未コミット変更: feature/27_pcp_mca_ui.md, tasks/task-list.md を保全。feature/analysis-specs/ 以下は設計資料として参照のみ。
共有ファイル調整: CA作業セッション（通常コレスポンデンス分析 CA）へ共有範囲の調整メッセージを送信済み。MCA専用ファイルを先行し、共有部はMCA必須の追加だけに絞った。

## 範囲
- Feature 030（MCA）+ 成立に必要な共通基盤のMCA必須追加（MCARequest・rectangle selector・predict interval=none制限・prepare_mca_frame・rows/prediction保存・rows/predict/materialize/exportのMCA分岐）。
- 対象外: 031〜034分析機能、CAへの無関係な機能追加、既存API全体移行。
- Feature 027のMCA分析部分（旧nK正規化・旧scopeキー・旧入力キー等）を本仕様へ統合し、/models/mca と /api/v1/models/mca を一本化した。Feature 027/028のPCP・スクロール・ヒットテスト・ポップアップ・L1等は変更なし。

## 受入条件（MCA01〜MCA12 + MCA適用COM）
- MCA01 行和m・総和nm / MCA02 全慣性=(K-m)/m / MCA03 m≠Kで旧nK検出 / MCA04 直接indicator CA一致
- MCA05 重み倍率不変 / MCA06 missing/NA 3方針 / MCA07 MA親全体判定 / MCA08 ordinary_onlyのMA拒否
- MCA09 Benzécri閾値とゼロ分母 / MCA10 個体座標保存のrowId一致 / MCA11 改名不変 / MCA12 縮退部分空間
- COM-01 版競合 / COM-02 scope / COM-04 MA / COM-05 重み / COM-07 保存 / COM-08 再送 / COM-09 store / COM-10 ページ / COM-11 状態 / COM-12 安全

## 変更ファイル
- 新規kernel: fullstack/backend/app/algorithms/models/mca.py（indicator MCA、exact SVD、全有効軸、Benzécri別系列、符号・縮退規約、寄与・cos2、射影）
- 新規API: fullstack/backend/app/api/mca.py（POST /api/v1/models/mca、旧キー422拒否、定数変数・零慣性等の規定エラー、全軸個体保存、警告3種）
- 共通基盤（MCA必須追加のみ）: domain/analysis_contracts.py（MCARequest・RectangleSelector・predict none制限）、domain/analysis_frame.py（prepare_mca_frame＋PreparedMcaFrame）、storage/analysis_result_store.py（rows.parquet・prediction保存）、api/analysis_results.py（MCA rows/rectangle・categories変数基準・predict・prediction rows・materialize・rows export）、main.py（mca router登録）
- 画面: frontend/src/features/models/MultipleCorrespondencePage.tsx、McaFigure.tsx、mcaTypes.ts、mcaApi.ts + main.tsx / KeepAliveOutlet.tsx / AppShell.tsx へ /models/mca 登録（表示名「多重対応分析（MCA）」）
- テスト: backend/tests/stats_tests/test_110_mca.py（8件）、test_111_mca_api.py（5件）、frontend/tests/mca.test.tsx（1件）

## 検証証拠
- kernel: test_110_mca 8 passed（行和・総和、全慣性、寄与和・重み付き中心、直接indicator CA一致、重み倍率不変・zero拒否、Benzécri閾値・全0、射影一致、縮退ブロック）。
- 参照計算: feature/analysis-specs/validation/reference_kernels.py の mca/benzecri と固有値・F・G・補正比率が一致（差分0）。
- API・保存: test_111_mca_api 5 passed（正規化・全ページrows、rectangle・categories AND/OR、predict再射影一致・materialize冪等・stale拒否、旧キー・重複・1変数拒否、欠損3方針・frequency複製一致・survey×100不変・MA境界）。
- 外部oracle: R 4.6.1＋FactoMineR（Indicator法）で照合。2x2x2均等は固有値0.667・0.333・個体±0.816/±0.577・カテゴリ±1.0で符号込み一致。不均等・加重ケースも固有値・個体・カテゴリ座標が約1e-6で一致。Burt値は未使用。
- FE: tsc -b エラーなし。mca 1件・correspondence 2件 passed。FE全体 249 passed（59ファイル）。
- 全体回帰: stats_tests（R参照除外）passed。R参照はRscript不在のため除外（環境にR 4.6.1あり、別途手動oracle実施）。
- 実ブラウザ: dev :5174＋backend :8420でmca-demo（24行）→変数ダイアログでq1/q2選択→実行→m=2・K=4・rank2・個体24・警告表示→カテゴリ点クリック→選択解決→一致24/適用24→sidebar 24行→PCP移動で連動→MCA復帰で結果保持。個体矩形ブラシは選択数が変わらず（要調査）。スクリーンショット取得済み。
- 本番相当: openapiに /api/v1/models/mca 掲載確認。rows/predictions/materialize経路も掲載。static配布はapp全体zipのため追加作業なし（ビルド未実施）。run-production.batはdist存在時ビルド省略＋uvicorn :8420起動を確認（バッチ自体は未実行）。

## 受入対応
- MCA01 達成、MCA02 達成、MCA03 達成（m=3・K=6〜9のfixture、旧nKは不使用）、MCA04 達成、MCA05 達成（frequency複製一致・survey×100不変・zero除外）、MCA06 達成（exclude 7行・include 8行・K+1）、MCA07 達成（未採用子invalidで除外1）、MCA08 達成（ordinary_onlyでMCA_MA_UNSUPPORTED）、MCA09 達成（閾値・全0で比率null＋理由、raw不変）、MCA10 達成（rowId結合・対象外null・上書き禁止）、MCA11 未検証（改名不変の自動テストなし）、MCA12 部分達成（縮退ブロック検出＋再射影一致、projector同値の厳密検証なし）
- COM-01 達成（公開前版再確認409）、COM-02 達成（scope必須・explicit未知は共通路）、COM-04 達成、COM-05 達成、COM-07 達成（版+1・来歴calculate・idempotency）、COM-08 達成（staleでも同一key/payloadは成功再送）、COM-09 達成（原子保存・明示deleteは共通路）、COM-10 達成（全ページrows・export）、COM-11 達成（KeepAlive復帰・dataset切替リセット・runSequence破棄）、COM-12 達成（有限JSON・CSV式注入対策・path traversal対策）
- Feature 027置換: 旧MCA仕様（Burt併記・nK正規化・旧キー）の期待値は新仕様へ更新。PCP関連試験は削除・変更なし。

## レビュー001の8件修正（2026-09-13）
- M001 学習行再射影: manifestにencoding（適合カテゴリ・missing方針・MA親判定・列名）を保存し、predictは固定変換で分類。include_missing 7行の再射影7/7・保存F一致を確認。MA親全体判定も経由。
- M002 冪等性: payloadにsource・columns・scope集合を含め、source変更は409 IDEMPOTENCY_CONFLICT、完全同一再送は200 idempotentReplay=trueを確認。
- M003 版確認: 書込ロック内でモデル版・要求版を再照合し、不一致は副作用なし409。CA既存路は無変更。
- M004 保存後更新: materialize成功後にinvalidateColumnarCache＋datasetValuesUpdated＋fetchCodebookThunkで中央更新。実ブラウザでTableにMCA1表示を確認。
- M005 カテゴリ矩形: 囲まれたカテゴリIDを図上で解決してcategories selectorへ渡す。実ブラウザで一致24/適用24・sidebar 24行を確認。個体矩形も一致24/適用24を確認。
- M006 軸切替: 表示軸を図へ渡し座標・軸名・選択を統一。同一軸指定はYを自動回避。表タブで第1軸66.7%・第2軸33.3%を確認。
- M007 export質量: MCAはcategoryMassをmass列へ出力。export JSONの質量が正数・結果一致を確認。CA既存出力は維持。
- M008 行取得: resultId/axes一体管理・取得中・失敗表示・旧図注意を追加。取得完了前の選択送信を抑止。
- MCA11/MCA12も追加検証: 行順不変・複製変数の有限性、縮退群のprojector同値（F F'・G G'不変）。
- 再検証: test_110 9・test_111 8・test_100 6の計23 passed、backend全体407 passed、FE対象3 passed、tsc エラーなし。FE全体は2件失敗（maStatistics・miningVerification）→単独再実行では6 passedのため全体再実行時の不安定失敗と判断（MCA無関係、許容差・テスト変更なし）。
- 実ブラウザ再確認: mca-demo 24行・3変数でm=3・K=6・rank2。カテゴリ矩形・個体矩形とも一致24/適用24。保存後にTableでMCA1表示。R oracleは前回照合を維持。

## レビュー002の残存2件修正（2026-09-13）
- M001 MA valid: predictのMA valid分岐で該当カテゴリへ1を立てる（欠落修正）。MA子x/y＋通常qの6行で再射影6/6・保存F一致を確認。回帰テスト `test_mca_review002_m001_ma_valid_reproject` 追加。
- M008 軸選択ガード: rowsReady（resultId・axes一致・非loading・非error）を共通判定化し、onToggle/onBrushとも取得完了前はAPIを呼ばず案内表示。警告表示は維持。
- 追加検証: MCA11列名変更の不変性（固有値一致・全慣性1.0）を隔離APIで確認。run-production経路の証拠としてopenapiに /api/v1/models/mca・rows掲載を確認。
- 再検証: test_110 9・test_111 9・test_100 6の計24 passed、FE対象3 passed、tsc エラーなし。
- 実ブラウザ: M004/M005/M006の確認済み内容を維持（保存後Table MCA1表示、矩形選択一致24/適用24、軸ラベル66.7%/33.3%）。

## レビュー003の残る2件確認（2026-09-13、コード変更なし）
- 他ビュー→MCA強調: Table1行選択→MCA復帰で結果保持→カテゴリ図で連動強調3点→解除で0点に消去を確認。MCA→他ビュー方向は前回確認済み。
- run-production経路: openapi掲載は維持。現dist（17:05）はMCA前のため画面確認はdev経路で実施（m=3・K=6・rank2・個体24、スクリーンショット取得）。新規ビルドは要求・許可なしのため未実施。
- 報告書: reviewqueue/030/REVIEW-003-REPLY.md に格納。

## レビュー004の残る2件確認（2026-09-13、コード変更なし）
- 個体図の選択表示: Table1行選択→MCA復帰で結果保持→個体図に青枠1点→解除で0点に復帰を確認。前回の「強調なし」はオレンジ枠との混同だった。
- run-production経路: openapi掲載は維持。現distはMCA前のため画面確認はdev経路で実施。新規ビルドは要求・許可なしのため未実施（必要コマンドを報告に記録）。
- 報告書: reviewqueue/030/REVIEW-004-REPLY.md に格納。

## レビュー006の本番配信経路確認（2026-09-13、実装コード変更なし）
- ユーザー指示で本番ビルドを再実行: exit 0（built in 9.55s）。前回のFAMD型エラー28件は再現せず。
- dist更新（20:12）＋新バンドルに models/mca 含有を確認。
- 本番相当経路（dist配信＋openapi掲載＋既知fixture実行）で m=3・K=6・rank2 を確認。
- 報告書: reviewqueue/030/REVIEW-006-REPLY.md に格納。

## 残作業
- [x] MCA11の自動テスト化（行順・複製変数）＋列名変更の隔離確認
- [x] MCA12の厳密化（projector同値）
- [x] 実ブラウザの個体・カテゴリ矩形選択の確認
- [x] 派生列保存後のTable表示・版更新の実ブラウザ確認
- [x] 他ビューからの選択→MCA強調の相互ハイライト確認（個体青枠・カテゴリ橙枠とも）
- [x] 本番ビルド・本番相当経路のMCA実行確認
- [ ] static実機（Pyodide）は受入対象外のため未実施
- [ ] reviewqueue/030 への修正報告とレビュー監視（10分間隔）
