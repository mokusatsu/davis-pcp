# Feature 031 REVIEW-003 修正報告（F007）

対象: REVIEW-003.md（F001〜F006解消確認、追加指摘F007）
HEAD: 未コミット実装を含む（FAMD新規＋共有基盤のFAMD必須追加のみ。他機能の共有差分には触れていない）。

## 修正内容（F007）

- 射影表示に `predictMeta {datasetId, resultId, axes}` を保持し、取得時の軸名で表見出しを表示する（現在のaxisXを使わない）。軸変更時は再取得せず取得軸名を維持する。
- 再分析成功時とdataset切替時に射影状態（rows/info/warnings/meta/total/ok）を消去する。別分析・別datasetの座標を現在結果として表示しない。不一致時は警告を表示する。
- 進行中の射影が無効化された場合（sequence不一致・dataset不一致）はloadingを解除して終了する（finallyでの再有効化なし）。

## 確認

- 実ブラウザ（独自backend :8421＋独自FE :5175、Iris 150行）:
  - 第1軸で射影→「取得軸：第1軸」「成功 150/150」。個体図X軸を第3軸へ変更→射影タブは「取得軸：第1軸」を維持し「座標 第3軸」表示なし。
  - 再分析実行→射影タブは「対象 0行」に消去。
  - dataset切替→設定リセット・射影状態なし。
  - 証拠: .temp/famd-fix-f007-axis.png, .temp/famd-fix-f007-rerun.png。
- 遅延応答の無効化はコード経路（sequence/dataset不一致でloading解除）のみ。実時間での競合再現は未実施。

## 回帰

- backend FAMD＋MCA＋CA（test_100/110/111/120/121）: 37 passed
- frontend famd.test.tsx: 1 passed
- tsc: FAMDファイルのエラーなし（LinearRegressionPageの他者エラーあり、FAMD無関係）

## ソースSHA256

- FamdPage.tsx: `fbc71bafff0419ddc0b55b24b991f385b5f7274d646cfb998a2e303806b5a753`
- FamdFigure.tsx: `2c1c1ba2bdcdaf8fc3d0f37a1da6d66a7eb17590159de4d43d9121a6566ec4A0`（F007では無変更）
- analysis_frame.py: `0c549d687b9b4471238ee5d245b8cbe4206de1944b36a1146bf55fe8ab3ae364`（F007では無変更）
- analysis_results.py: `e3166ecbbabff2412e10ee825862e103ec01c51325975618f8a4077fa53cc880`（F007では無変更）

## 残作業（REVIEW-003 §検証と残る受入項目のまま）

- カテゴリ点の実ポインタclick、FactoMineR oracle比較、本番配信経路の確認。
- 相関円の3軸/rank1操作の画面証拠（今回はF007の軸維持のみ確認）。
