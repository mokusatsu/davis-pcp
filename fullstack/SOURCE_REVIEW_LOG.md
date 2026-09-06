# SOURCE_REVIEW_LOG — DAVIS-PCP Fullstack v2.0.0

規範資料の確認記録(order.txt §1/§2準拠)。過去会話の記憶ではなく現物を根拠とした。

## 参照した現物

| 資料 | 用途 |
|---|---|
| `base/DAVIS-PCP-Iris-Static-v1.0.0.zip` 展開物 | 操作仕様golden master / アルゴリズム比較対象 / migration fixture |
| 同 `app.js`(1222行) 全文 | jitter(472行: legacyRawは正規化前rawへ±0.1)、componentOrder、permuteOrder、hit-test、集合演算、Focus/Delete/Reset意味論 |
| 同 `tests/e2e.py` 245-275行 | JAR golden fixture matrixとIris 5軸期待順、Permute score 9.961958084685977/9.207082574015136 |
| 同 `tests/property_oracle.py` | NumPy独立オラクル(modulo1、Liang–Barsky、set algebra) |
| 同 `FEATURE_TRACEABILITY.csv` F001-F059 | v2トレーサビリティの継承元(F060以降を追加) |
| 同 `DESIGN_AND_TRACEABILITY.md` 全文 | 証拠区分定義、軸順仕様、ブラシ仕様 |
| `base/davis_initial.jar` 由来の解析文書 08/09/11/13 | 初版互換挙動の確定事項(矩形ブラシ・頂点包含OR・二段相関等) |

## 採用判断(§2優先順適用)

1. **jitter**: ユーザー指摘「jitteringの解釈を誤っている」を受けv1 app.js 472行を再照合。
   - pixel jitter: 描画座標へseed|rowId|axisKeyハッシュ由来[-1,1]×amount
   - legacyRaw: 正規化**前**のraw値へ±0.1(v2初版実装はこれが欠落 → geometry.tsにapplyRawJitter追加)
   - 名義尺度にもpixel jitterを適用(v1は全可視軸に適用)
2. **Distribution**: v1 renderBoxPlot(842-893行)参照。Species別3段ボックス+点は自カテゴリ行周辺にjitter。v2はcolorBy列のカテゴリ別行構成として一般化。
3. **ComponentOrder固有ベクトル**: v1 Jacobiは`vectors[row][last]`列をloadingに使用。Python移植時に行と列を取り違えた不具合をgolden fixtureで検出し修正。
4. **PAM cost計算**: クラスタラベル(0/1/2)をメドイド行indexと取り違える不具合をblobs分離テストで検出し修正(`medoids[labels]`)。

## 新規追加の根拠

- シルエット/PCA散布図/ペアプロット/記述統計ページ/決定木SVG: MODERN-EXTENSION(ユーザー指示)。DAVIS初版仕様とは断定しない。
- 配色: dataviz reference palette(CVD検証済み)を採用。初版8色パレットは`groups.py DAVIS_PALETTE`にbackend側で保持(互換目的)。
