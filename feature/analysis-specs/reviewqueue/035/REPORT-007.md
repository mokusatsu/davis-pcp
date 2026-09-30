# Feature 035 通常表示レイアウト修正報告

- 対象: GraphPanel の通常表示と PCP、BoxPlot、Q-Q、FEDF、Loess、Relationships、Surprise
- 日時: 2026-09-18
- branch: master（既存の未コミット変更は保持）
- 状態: 修正・限定再検証済み。既存 Feature 035 全体のレビュー承認は未受領。

## 修正内容

- 通常表示の GraphPanel は拡大用の fit/zoom transform を適用せず、各図の論理寸法をそのまま表示するようにした。拡大中だけ fit/zoom を適用する。
- intrinsic 図の GraphPanel host/viewport が残り高さへ flex 縮小しないようにし、図内の縦スクロールと ResizeObserver の再計測循環を防いだ。PCP の responsive host は親領域を使う設定を維持した。
- 描画内に混在していた凡例、説明、Card/border のレイアウト寸法を整理した。BoxPlot、Q-Q、Loess、FEDF、Relationships、Surprise は surface と描画子を同じ論理寸法に固定し、レイアウトへ加算される border を outline に置換した。
- PCP の hover tooltip は transformed surface から portal へ移し、通常表示は body、拡大表示は dialog 内の popup 受け口へ送るようにした。
- Surprise は主図と詳細を縦に配置し、象限散布図と階層化ヒートマップを独立した intrinsic surface にした。

## 検証結果

ローカルの `run-production.bat` 起動環境（127.0.0.1:8420、1440x900）で確認した。

| 画面 | 確認結果 |
|---|---|
| BoxPlot | surface/SVG 900x1622、viewport 1129x1622、横方向のページはみ出しなし |
| Q-Q | surface/canvas 680x440、viewport 754x440、縦横比保持、内部縦スクロールなし |
| FEDF | surface/SVG/viewport 1097x727、等倍、全幅を使用 |
| Loess | surface/SVG/viewport 高さ 530、幅 790/1097、状態表示は surface 外、内部縦スクロールなし |
| Relationships | heatmap 450x300、焦点ペア 600x420。両方の viewport 高さが surface と一致し、説明文は surface 外 |
| Surprise | 象限 500x400、ヒートマップ 400x300。viewport 高さが surface と一致し、詳細は主図の下に配置 |
| PCP | responsive surface/viewport 1129x598、横方向のページはみ出しなし。popup container の通常/拡大分岐は unit test で確認 |

- `npm.cmd test -- tests/graphExpansion.test.tsx tests/graphCoordinates.test.ts tests/distributionProjection.test.tsx tests/relationshipProjection.test.tsx tests/surpriseManual.test.tsx`: 5 files, 13 tests passed
- `npm.cmd run build`: 成功（license check、TypeScript build、Vite build）
- ブラウザ console error: 0

既知の React Router/Redux/Ant Design 警告および Vite の chunk-size 警告は本修正による失敗ではない。Feature 035 に既存する全対象レビューの未完了項目・レビューOK未受領は、本報告で完了扱いにしない。
