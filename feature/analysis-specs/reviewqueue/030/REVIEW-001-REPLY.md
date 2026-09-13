# Feature 030 レビュー001 修正報告

判定依頼: 要修正8件（M001〜M008）への対応完了

## 指摘別の修正と検証

- M001 [P1] 学習行再射影: manifestにencoding（適合カテゴリ・missing方針・MA親判定・列名）を保存。predictは保存した固定変換で分類し、include_missing 7行の再射影7/7・保存F一致（rtol1e-9）を確認。MA親全体判定も経由。回帰テスト `test_mca_review001_m001_fit_rows_reproject` 追加。
- M002 [P1] 冪等性: payloadにsource・columns・scope集合を含める。source変更は409 IDEMPOTENCY_CONFLICT、完全同一再送は200 idempotentReplay=trueを確認。回帰テスト `test_mca_review001_m002_idempotency_source_scope` 追加。
- M003 [P1] 版確認: 書込ロック内でモデル版・要求版を再照合し、不一致は副作用なし409。CA既存路は無変更。
- M004 [P2] 保存後更新: materialize成功後にinvalidateColumnarCache＋datasetValuesUpdated＋fetchCodebookThunkで中央更新。実ブラウザでTableにMCA1表示を確認。
- M005 [P2] カテゴリ矩形: 囲まれたカテゴリIDを図上で解決してcategories selectorへ渡す。実ブラウザで一致24/適用24・sidebar 24行を確認。個体矩形も一致24/適用24を確認。
- M006 [P2] 軸切替: 表示軸（axisX/effAxisY）を図へ渡し座標・軸名・選択を統一。同一軸指定はYを自動回避。表タブで第1軸66.7%・第2軸33.3%を確認。
- M007 [P2] export質量: MCAはcategoryMassをmass列へ出力。export JSONの質量が正数・結果一致を確認。CA既存出力は維持。回帰テスト `test_mca_review001_m007_categories_export_mass` 追加。
- M008 [P2] 行取得: resultId/axes一体管理・取得中・失敗表示・旧図注意を追加。取得完了前の選択送信を抑止。

## 実行コマンドと件数

- backend対象: test_110（9）＋test_111（8）＋test_100（6）＝ 23 passed
- backend全体（R参照除外）: 407 passed
- FE対象: mca＋correspondence ＝ 3 passed / 2 files
- FE全体: 2 failed（maStatistics・miningVerification）→単独再実行6 passedのため全体同時実行時の不安定失敗と判断。MCA無関係、許容差・テスト変更なし
- tsc -b: エラーなし
- R oracle: 前回照合（FactoMineR Indicator一致）を維持

## 実ブラウザ確認結果（dev :5174＋backend :8420、mca-demo 24行・3変数）

- 実行: m=3・K=6・rank2・個体24
- カテゴリ矩形: 一致24/適用24・sidebar 24行
- 個体矩形: 一致24/適用24
- 保存: TableでMCA1表示、stale表示あり
- 表タブ: 第1軸66.7%・第2軸33.3%、全慣性1.0＝(K−m)/m

## 未検証事項・残作業

- 他ビューからの選択→MCA強調の相互ハイライト確認
- static実機・本番ビルドは許可待ちのため未実施
- MCA11（改名不変のうち列名変更部分）は未自動化、MCA12はprojector同値まで実施済み
