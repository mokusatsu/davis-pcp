# Feature 033 レビュー003 指摘対応報告

日付: 2026-09-14 / HEAD: `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`、未コミット変更を含む。

## E006 [P1] 対応済み

連続項目の `missingCodes` を無回答 (missing)／非該当 (notApplicable) に分離した。`missingReasons`＋`is_not_applicable_reason` で判定し、両経路（連続・順序）で同一基準を使う。100行検証（q1=-999を無回答、q2=-888を非該当スキップ）で `fitCount=98・invalid0/missing1/NA1`、分布も `missing/NA/invalid` 別件数になることを確認した。共通契約の missing bucket は合算（`scopeCount=fit+excluded` 維持）し、内訳は `meta.exclusionBreakdown` と分布プロファイルへ記録する。invalid優先で行の二重計上はない。API回帰試験 `test_continuous_na_split_and_basis_gate` を追加した。

## E009 [P2] 対応済み

同一因子（figX===figY）の矩形はX/Y範囲の**共通部分**を単軸条件として送り、空共通は空選択（「一致0（X/Y範囲の共通部分が空です）」）として扱う。Y範囲無視は解消した。異なる因子の矩形・点選択・中央ハイライトは実ブラウザ試験で確認した（下記）。

## E011 [P1] 対応（一部制約あり）

主結果を先に公開し、感度比較をバックグラウンドスレッド化した。PAは25反復chunkごとに進捗（`completedIterations/totalIterations/progress/stage`）を永続化し、cancelイベントで割込み可能にした。主結果と独立に GET poll・POST cancel・画面表示（進捗％・中断ボタン）ができることを確認した。実測：主結果先行12.1秒で200返却、比較は `running`→pollで確定。cancelは queued/running のみ遷移・主結果不変。比較の失敗経路は失敗側・start・PA状態を `diagnostics` へ保持し全経路で永続化する。artifactはファイル単位の原子置換、永続失敗は `ANALYSIS_ARTIFACT_PERSIST_FAILED`（500）で伝播させる。副解析の実行中割込みはchunk境界粒度であり、OSレベルの即時killではない。Pyodide/WASM・単体試験では同期実行（決定性確保）のままである。

## E012 [P2] 対応（一部残件あり）

分布表に連続近似の判断材料（カテゴリ件数・割合・最小件数・最大割合・床／天井・歪度・欠損／非該当／不正）を追加した。無関係なCFA機能は含めない。分布等の全文表示は引き続き残件。

## E013 [P1] 対応済み

名義・水準不明に `scaleBasis` 契約（`FactorVariable.scaleBasis`）を追加した。根拠なしは `FA_SCALE_BASIS_REQUIRED`（422）で拒否し、根拠付き（`codebook_order_verified`／`pre_registered_instrument`／`analyst_verified_order` のみ受理）のみ尺度ゲートを通過する。コードブック尺度・根拠は `measurementResolution`（`codebookScale`・`scaleBasis`）へ保存し明示検証できる。名義列の素の ordinal 偽装・continuous 偽装はいずれも422となることを確認し、API回帰試験を追加した。画面の重み既定は `dataset` のまま維持する。

## 実ブラウザ試験（E009/E016系・初回）

Playwright sync_api・headless Chromium 1440x900・実ポインタ `page.mouse` で実施。バックエンドは試験用に8425で起動、隔離データ `efa_iso`（合成5連続列×150行をAPI import、実データ不変）。実装の修正なし。

- 成功：pcp-canvas待機・隔離データ切替（ヘッダ150行）／Segmented経由で `/models/factor-analysis` 遷移・5列選択／Pearson+MINRES・因子数2・Varimax・regression・PA100で実行（負荷量表・PA候補・得点図150点）／実ポインタ点クリックtoggle（選択0→1→0、中央パネル連動）／実ポインタドラッグ矩形（選択0→146件、アラート「一致146」、サイドバーSelected(146)連動）／KeepAlive（PCP往復後も設定・結果・得点図保持）／因子数1で再実行し resultId 交替・旧結果残留なし。
- 選択件数変化：クリック 0→1（toggle戻しで0）、ブラシ 0→146。
- 証拠：`.temp/review-033-e2e/`（PNG 10点・`e2e_log.txt`・`api_events.json`・`efa_e2e.py`・`efa_iso.csv`、計14ファイル）。
- 未実施・注意：ML抽出・none回転・bartlett得点の組合せは未実施（MINRES/Varimax/regressionのみ）。スクロール保持は両端0のため自明。手順6の自動待機がタイムアウトしたが新旧ID差替の直接確認で代替検証済み。

## 検証と受入証拠

- EFA: **22 passed**（単体13＋API 9）。回帰スポット8 passed。FE `tsc -b` 成功。bundle に factor-analysis＋efa-score-figure 含有、health 200・openapi登録・SPA fallback 200を確認。
- R oracle: polychoric pairwise maxdiff 2.03e-05（5件法）・1.81e-05（2値）、閾値 0.0。初期基準 atol1e-5 単独では超過のため**未達扱い**とし、rtol=1e-5 併用でも最悪比1.755／1.307で超過する。差は最適点近傍の平坦差（0.001SE・Δnll≈0）だが許容差拡大では通さない。ML目的値差0.0（factanal）、h2差1e-06。ULS psych照合は回転規約差で別記・要追加検証。
- E002の掃引法維持は設計SVD反復と異なるため、実装方式・収束基準の差として記録を残す。今回のfixture一致を全条件のoracle合格とは扱わない。
- B02/B03不変性、失敗・境界・比較・中断、代表サイズ性能は未完了。既存22件＋実ブラウザ初回の成功はこれらの完了を示さない。現時点で問題なしとは判定しない。
- 実装修正・ビルドは行った。全体試験は行っていない。Pyodide実ブラウザ操作検証は対象外。
