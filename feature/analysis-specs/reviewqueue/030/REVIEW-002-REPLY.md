# Feature 030 レビュー002 修正報告

判定依頼: 残存2件（M001・M008）への対応完了

## 指摘別の修正と検証

- M001 [P1] MA valid: `analysis_results.py` のpredict MA valid分岐で該当カテゴリへ1を立てる（欠落修正）。MA子x/y＋通常qの6行で学習fitCount=6・再射影6/6・保存F一致（rtol1e-9）を確認。`.temp/review-030-002-ma.py` で隔離確認。回帰テスト `test_mca_review002_m001_ma_valid_reproject` 追加。
- M008 [P2] 軸選択ガード: rowsReady（resultId・axes一致・非loading・非error）を共通判定化し、onToggle/onBrushとも取得完了前はselect APIを呼ばず案内表示。警告表示は維持。3軸以上の遅延再現は未実施（コード経路の修正）。

## 実行コマンドと件数

- backend対象: test_110（9）＋test_111（9）＋test_100（6）＝ 24 passed
- FE対象: mca＋correspondence ＝ 3 passed / 2 files
- tsc -b: エラーなし
- 全体回帰の扱い: 前回backend全体407 passed。FE全体の2件失敗は単独再実行6 passedのため同時実行時の不安定失敗と判断（MCA無関係、許容差・テスト変更なし）。今回の差分はM001の1行追加＋M008のガード共通化のみで、失敗テスト（maStatistics・miningVerification）とは無関係。

## 実ブラウザ確認結果（前回維持＋今回の関連確認）

- M004: 保存後にTableでMCA1表示
- M005: カテゴリ・個体矩形とも一致24/適用24・sidebar 24行
- M006: 表タブで第1軸66.7%・第2軸33.3%、全慣性1.0＝(K−m)/m

## 未検証事項・残作業

- 他ビューからの選択→MCA強調の相互ハイライト確認
- static実機・本番ビルドは許可待ちのため未実施（レビュー002で要求・許可なし）
- MCA11列名変更: 隔離APIで固有値一致・全慣性一致を確認（自動テストは行順・複製変数まで）
- run-production経路の証拠: preview backend相当のopenapiに /api/v1/models/mca・rows掲載を確認。起動バッチ自体は未実行
