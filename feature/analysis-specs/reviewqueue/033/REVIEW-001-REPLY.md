# Feature 033 レビュー001 指摘対応報告

日付: 2026-09-13 / HEAD: `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`、未コミット変更を含む。

## E001 [P1] 対応済み

`factor_parallel.py`の反復置換を shape `(iterations, n, p)`（反復×列の独立置換）に修正し、2次元入力の後方互換分岐を削除して形状検証を追加した。感度比較の両側PAへ同一置換群を共有する。隔離検証（200行4列・100反復）で参照-観測最大差は`0.183`となり、帰無が成立することを確認した。回帰試験 `test_parallel_uses_independent_column_permutation` を追加した。

## E002 [P1] 対応済み

Varimax対角掃引の角度に Kaiser 列平均補正（`A = sum(u²-v²) - (sum u)²/p + (sum v)²/p`、`B = 2sum(uv) - 2(sum u)(sum v)/p`、`phi = atan2(B,A)/4`）を追加した。真のVarimax解での SVD 目的値は`2.618494`で固定点条件（`C`対角・`U V'`単位）を満たし、掃引解の正規化後 `sum(var)` は`0.436419`となった。回転法の正しさは再現相関だけでなくこの目的関数で確認する。SVD反復への置換は行っていない。

## E003 [P1] 対応済み

`canonicalize_columns` を単一H（符号＋SS降順置換）で返すよう修正し、`varimax_rotation`・`promax_rotation` の最終出力で pattern・Phi・structure・変換行列へ同一Hを適用した上で最終再構成を再検証する。固定seed 6×2での旧再現差`0.325`は解消し、最終再構成差は`0.0`となった。回帰試験 `test_varimax_kaiser_mean_correction_and_final_reconstruction` を追加した。

## E004 [P2] 対応済み

`fit_single_q` に `fit_n` を追加し、ML参考推論の標本数を得点計算から分離した。APIの主q・候補q・感度比較の全呼出しでfit集合nを渡す。200行MLで scoreMethod を regression から none へ変更しても `inferenceStatus=available` のままであることを確認し、API回帰試験を追加した。

## E005 [P1] 対応済み

空scopeのフォールバックを削除し、明示空は空のまま完全ケースなし（`n<=p` で422・attempt保存）として処理する。`selectedRowIds=[]` で200行200が再現しないことを確認し、API回帰試験を追加した。画面の sampled scope は中央 `obs.sampling.sampledRowIds` を送信するよう修正した。

## E006 [P1] 対応済み

連続項目で列の `missingCodes`（コード＋数値）をfit／predictの同一判定で適用する。先頭値 missingCodes の200行検証で `fitCount=199・missing=1` となることを確認した。mask／補完来歴は共通規約（使用列＋fit行に限定した entries 集計）で `maskRevision・imputedCell/RowCount` をmetaへ記録する。

## E007 [P1] 対応済み

`_efa_check_fresh` を追加し、predict／materialize は所有dataset・fit版・現在版を照合して古いfitでの新規操作を409とする。materialize は同一payload再送の確認を先に行い、保存済み応答を返す。fit→保存（版更新）→最新contextで旧resultIdへ predict／materialize を要求するとどちらも409となることを確認し、API回帰試験を追加した。predict の他dataset context も拒否する。

## E008 [P1] 対応済み

冪等キーは user key＋resultId＋source のみとし、payload hash は別保存・比較して同キー別payloadは `IDEMPOTENCY_CONFLICT`（409）とする。保存元は `source=fit` でfit rows、`source=予測ID` で prediction rows を解決する。再送応答に保存時の dataRevision／schemaRevision と作成列情報を保持し、UI は版を推測加算しない。同じキーで列名変更の保存が409となることを確認し、API回帰試験を追加した。

## E009 [P1] 対応済み

`EfaScoreFigure.tsx`（実ポインタ矩形＋点toggle・中央選択の相互ハイライト・`user-select:none`・circle ガード）を新設し、得点タブにX/Y因子選択と全件表示を組み込んだ。rows は `nextOffset` が null になるまで全ページ取得し、200行固定の選択を廃止した。選択応答は sequence・dataset・data/schema版・結果IDを照合してから適用し、rows取得前に旧rowsを消す。実ブラウザの実ポインタ確認は残作業。

## E010 [P2] 対応済み

保存する因子（`score:N`）と出力列名を別々に選択・保持するよう修正した。列名末尾数字からの推測を廃止した。

## E011 [P1] 対応済み

attempt／comparison を `workspace/analysis-attempts・analysis-comparisons` の永続artifact（一時dir＋rename原子公開）として保存し、取得APIはメモリ→artifactの順で読む。attempt に data/schema版を付与し、comparison は dataset削除・版driftを stale 報告する。メモリ消去後も attempt が200で取得できることを確認し、API回帰試験を追加した。cancel は完了／失敗／取消済み以外を cancelled へ永続化し、主結果には触れない。副解析は同期実行のため実行中割込みはなく、その旨を明記する。

## E012 [P2] 対応済み

結果タブに structure・独自性・因子間相関Φ・観測／再現／残差の全セル表、感度タブに差分表（相関・負荷量・共通性・Φの最大／中央値・割当変更・PA差）を追加した。stale は応答の resultState だけでなく中央data／schema版と照合して表示・操作制御へ反映する。分布・相関対別・start履歴・ML参考推論の全文表示とスクリープロット・因子表示名は残作業。

## E013 [P1] 対応済み

service で要求の measurement／treatment をコードブック（scaleType・role・MA・順序order一致）と照合し、対象外列を `FA_SCALE_UNSUPPORTED` で拒否する。名義列の continuous 指定が422となることを確認し、API回帰試験を追加した。画面は dataset／none 重み選択を提供し、dataset有効重みは `FA_WEIGHT_UNSUPPORTED` で拒否・明示noneは別試行の経路を維持する。

## 検証と受入証拠

- EFA: **19 passed**（単体13＋API 6）。回帰スポット8 passed。FE `tsc -b` 成功。bundle に factor-analysis＋efa-score-figure 含有、health 200・openapi登録・SPA fallback 200を確認。
- R oracle: polychoric pairwise maxdiff 2.03e-05（5件法）・1.81e-05（2値）、閾値 0.0。初期基準 atol1e-5 単独では超過のため**未達扱い**とし、rtol=1e-5 併用でも最悪比1.755／1.307で超過する。差は最適点近傍の平坦差（0.001SE・Δnll≈0）だが許容差拡大では通さない。ML目的値差0.0（factanal）、h2差1e-06。ULS psych照合は回転規約差で別記・要追加検証。
- B02/B03の再符号化・逆転・列順不変性、失敗反復、境界・回転失敗、比較指標／中断、通常ブラウザ統合、代表サイズでの性能測定は未完了。既存19件の成功はこれらの完了を示さない。
- 実装修正・ビルドは行った。全体試験・実ブラウザ操作は行っていない。Pyodide実ブラウザ操作検証は対象外。
