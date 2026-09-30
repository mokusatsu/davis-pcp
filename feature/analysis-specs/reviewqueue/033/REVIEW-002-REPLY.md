# Feature 033 レビュー002 指摘対応報告

日付: 2026-09-14 / HEAD: `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`、未コミット変更を含む。

## E006 [P1] 対応済み

`specs[name_by_cid[cid]]` のキー誤参照を修正した。`specs` は要求columnIdキー、`name_by_cid` は cid→列名のため、列名でspecsを引いて KeyError→空集合化していた。使用列ID集合は `specs[cid]` から `columnId・要求cid・列名` の3種で解決し、解決失敗は例外伝播させる（集計失敗を成功の0件にしない）。columnId指定のmask entry 1件の隔離検証で `imputedCellCount=1・imputedRowCount=1` となることを確認した。行除外数は invalid 優先で集計し、同一行の二重計上を排除した。無回答／非該当は `missingReasons`＋`is_not_applicable_reason` で区別し、分布プロファイルへ `missing・notApplicable・invalid` として記録する（fit除外理由の大枠は invalid→missing のまま）。

## E008 [P1] 対応済み

冪等キーを user key＋resultId のみにし、source・scope・rowIds（正規化済みソート集合）・columns をpayload側で比較する。同じ利用者キーで保存元を変えても、同source・同columnsでcontextだけ変えても、別payloadとして `IDEMPOTENCY_CONFLICT`（409）となることを確認した（異sourceの実測409）。保存時の版を再送応答に保持し、UIの版推測加算はしない。

## E009 [P1] 対応済み

新結果の受領時に旧rowsを先に消去し、軸（figX／figY）と保存因子を新因子数範囲へ補正する（1因子ではY=F1）。1因子図の矩形は単軸の範囲条件へ変換し、`axes=[1,1]` を送らない（APIの重複軸422と整合）。得点図は `rowsReady`（結果ID一致）でのみ描画し、行取得失敗後に旧図は残らない。通常ブラウザでの実ポインタ・相互ハイライトは未検証。

## E011 [P1] 対応（一部制約あり）

`save_artifact` をファイル単位の原子置換（temp sibling＋rename）に変更し、更新途中の読込失敗や置換失敗で旧記録が消えないようにした。`_remember_attempt`／`_remember_comparison` の永続失敗は `ANALYSIS_ARTIFACT_PERSIST_FAILED`（500）で伝播させ、メモリだけの成功にしない。失敗時を含む全比較経路で永続化し（Pearson／Polychoric失敗側・start・PA状態を `diagnostics` へ保持。残り2箇所の直接辞書代入も `_remember_comparison` へ置換済み）、取得APIはメモリ→artifactの順で読む。cancel は queued のみ遷移し、完了／失敗／取消済みと主結果には触れない。副解析は同期実行のため主結果の先行表示・実行中cancelは未実装であり、「対応済み」とはしない。

## E012 [P2] 対応（一部残件あり）

分布（欠損／非該当／不正付き）・対別相関診断（ρ・状態・0／少数セル・境界）・start履歴（目的値・射影勾配）・ML参考推論（χ²・df・p・RMSEA・KMO・Bartlett）・スクリープロット（観測／参照分位）・mask stale（結果mask版と現在版の照合表示）・因子表示名（`factorLabels` の型重複を解消）を追加した。分布等の全文表示・CFA関連は引き続き残件。

## E013 [P1] 対応済み

コードブックordinal列への素の continuous 指定は `FA_APPROXIMATION_ACK_REQUIRED`（422）で拒否する。Pearson利用には `continuous_approximation` と項目別同意が必須となり、同意なしcontinuous要求の旧再現（200・latent_estimate）は解消した。名義／MA等の拒否は維持する。画面の重み既定は `dataset` に戻し、有効重みは `FA_WEIGHT_UNSUPPORTED` で拒否された後に利用者が明示noneを選ぶ経路とした。API回帰試験 `test_ordinal_continuous_disguise_refused` を追加した。

## 検証と受入証拠

- EFA: **20 passed**（単体13＋API 7）。回帰スポット8 passed。FE `tsc -b` 成功。bundle に factor-analysis＋efa-score-figure 含有、health 200・openapi登録・SPA fallback 200を確認。
- R oracle: polychoric pairwise maxdiff 2.03e-05（5件法）・1.81e-05（2値）、閾値 0.0。初期基準 atol1e-5 単独では超過のため**未達扱い**とし、rtol=1e-5 併用でも最悪比1.755／1.307で超過する。差は最適点近傍の平坦差（0.001SE・Δnll≈0）だが許容差拡大では通さない。ML目的値差0.0（factanal）、h2差1e-06。ULS psych照合は回転規約差で別記・要追加検証。
- E002の掃引法維持は設計SVD反復と異なるため、実装方式・収束基準の差として記録を残す。今回のfixture一致を全条件のoracle合格とは扱わない。
- B02/B03不変性、失敗・境界・比較・中断、通常ブラウザ統合、代表サイズ性能は未完了。既存20件の成功はこれらの完了を示さない。現時点で問題なしとは判定しない。
- 実装修正・ビルドは行った。全体試験・実ブラウザ操作は行っていない。Pyodide実ブラウザ操作検証は対象外。
