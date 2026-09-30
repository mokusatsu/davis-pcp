# Feature 035 通常表示レイアウト横断修正報告

- 対象: 台帳 G06〜G11、G14〜G28、G31〜G51 の42グラフ
- 対象外: G01〜G05、G12〜G13、G29〜G30（別報告で修正・検証済み）
- 日時: 2026-09-19
- branch: master（既存の未コミット変更は保持）
- 状態: 本報告の通常表示レイアウト修正と限定再検証は完了。Feature 035 全体のレビュー承認は未受領。

## 原因と共通修正

通常表示の intrinsic GraphPanel は、固定した描画高さを viewport に押し込んでいた。このため、Card、凡例、説明、表などが描画子と同居するグラフで、内容の末尾が panel 内スクロールになった。また、`width: 100%` の SVG/Canvas に content-box の border を重ねると、2px の横方向超過が生じた。

- 通常表示の intrinsic surface は固定高さではなく `min-height` と `height: auto` を使い、内容高を外側のページへ委譲する。拡大 dialog 中だけ従来の固定論理寸法と scale を使う。
- 通常表示の transform は除外し、ResizeObserver が scroll range を再計測し続ける循環を断つ。
- GraphPanel 配下の SVG/Canvas を `box-sizing: border-box` に統一し、境界線による微小な横スクロールを防ぐ。
- 2列の HTML カードだけは通常時に親列幅へ追従させ、拡大中および座標を持つ SVG/Canvas の論理幅は固定のまま維持する。
- 実描画の外形を別計算していたモザイクは、GraphPanel と描画子が同じ外形寸法を共有するようにした。結果詳細は折返し可能な flex 配置にした。

## 個別修正

| 区分 | 修正 |
|---|---|
| G06 設問別分布、G07 MA分布 | 通常時の HTML Card surface を親列幅へ追従させ、Card の実内容高を panel 内ではなくページへ伸ばす。 |
| G08 記述統計 | ヒストグラムと strip の `width: 100%` SVG を border-box 化し、境界線による横超過を除去する。 |
| G14 共分散 | セル数、軸ラベル、padding、border を含む intrinsic 寸法を算出し、固定最小高を撤去する。 |
| G16 PCA biplot、G17 PCA matrix | 固定 Canvas の外枠を border から inset shadow へ変更し、論理 Canvas の外へ出る2pxを除去する。 |
| G19 Line Mosaic | 描画コンテナの padding/border 込みの寸法を共有し、通常表示で内部 scroll を作らない。説明 Card は横幅不足時に次行へ折り返す。 |
| G28 mRMR、G33 Penalty-Reward | `width: 100%` SVG の表示高を縦横比から導出し、親幅変化で図が歪まないようにする。 |

## 42グラフ監査結果

| ID | グラフ | 判定 | 適用した対策 |
|---|---|---|---|
| G06 | 設問別分布カード | 修正 | 親列幅追従、自然高 |
| G07 | MA分布カード | 修正 | 親列幅追従、自然高 |
| G08 | 記述統計ヒストグラム | 修正 | SVG border-box |
| G09 | Likert比較 | 確認 | 共通の自然高・非変形通常表示 |
| G10 | 棒グラフ | 確認 | 共通の自然高・非変形通常表示 |
| G11 | MA棒グラフ | 確認 | 共通の自然高・非変形通常表示 |
| G14 | 共分散 | 修正 | 実外形を含む intrinsic 寸法 |
| G15 | Scree plot | 確認 | 共通の自然高・非変形通常表示 |
| G16 | PCA biplot | 修正 | Canvas 外枠の寸法超過除去 |
| G17 | PCA matrix | 修正 | Canvas 外枠の寸法超過除去 |
| G18 | TGT | 確認 | 共通の自然高・非変形通常表示 |
| G19 | Line Mosaic | 修正 | 実外形共有、詳細の折返し |
| G20 | Cluster PCA | 確認 | 共通の自然高・非変形通常表示 |
| G21 | Silhouette | 確認 | 共通の自然高・非変形通常表示 |
| G22 | Dendrogram | 確認 | 共通の自然高・非変形通常表示 |
| G23 | Cobweb | 確認 | 共通の自然高・非変形通常表示 |
| G24 | DISC matrix | 確認 | 共通の自然高。実データ表の横スクロールは維持 |
| G25 | 重要度 | 確認 | 共通の自然高・非変形通常表示 |
| G26 | 決定木 | 確認 | 共通の自然高・非変形通常表示 |
| G27 | 特徴量ランキング | 確認 | 共通の自然高・非変形通常表示 |
| G28 | mRMR | 修正 | SVG の縦横比固定 |
| G31 | Robustness | 確認 | 共通の自然高・非変形通常表示 |
| G32 | Key Driver Analysis | 確認 | 共通の自然高・非変形通常表示 |
| G33 | Penalty-Reward scatter | 修正 | 500:400 の縦横比固定 |
| G34 | Penalty-Reward importance | 確認 | 共通の自然高・非変形通常表示 |
| G35 | Logistic ROC | 確認 | 共通の自然高・非変形通常表示 |
| G36 | Logistic coefficient | 確認 | 共通の自然高・非変形通常表示 |
| G37 | Discriminant scatter | 確認 | 共通の自然高・非変形通常表示 |
| G38 | Discriminant structure | 確認 | 共通の自然高・非変形通常表示 |
| G39 | Correspondence analysis | 確認 | 共通の自然高・非変形通常表示 |
| G40 | MCA scree | 確認 | 共通の自然高・非変形通常表示 |
| G41 | MCA map | 確認 | 共通の自然高・非変形通常表示 |
| G42 | FAMD scree | 確認 | 共通の自然高・非変形通常表示 |
| G43 | FAMD individuals | 確認 | 共通の自然高・非変形通常表示 |
| G44 | FAMD variables | 確認 | 共通の自然高・非変形通常表示 |
| G45 | FAMD category | 確認 | 共通の自然高・非変形通常表示 |
| G46 | 線形回帰 | 確認 | 共通の自然高・非変形通常表示 |
| G47 | 因子分析 scree | 確認 | 共通の自然高・非変形通常表示 |
| G48 | 因子分析 loading | 確認 | 共通の自然高・非変形通常表示 |
| G49 | Conjoint | 確認 | 共通の自然高・非変形通常表示 |
| G50 | Binning | 確認 | SVG/Canvas border-box と既存の意図した描画比率を維持 |
| G51 | Imputation | 確認 | 共通の自然高・非変形通常表示 |

## 検証結果

- 42グラフの描画箇所と、該当する GraphPanel 使用箇所について、固定寸法、border、overflow、flex、縦横比を静的に監査した。
- `tests/graphExpansion.test.tsx` に、親列幅 476px へ追従する HTML カードの回帰テストを追加した。
- `npm.cmd test -- tests/graphExpansion.test.tsx tests/distributionProjection.test.tsx tests/mosaicCanvas.test.tsx tests/mosaicRequest.test.tsx tests/pcaBrushScale.test.tsx tests/pcaManual.test.tsx tests/clustersRequest.test.tsx --reporter=verbose`: 7 files、57 tests passed。
- `npm.cmd run build`: license check、TypeScript build、Vite build 成功。
- ローカルの隔離データ環境（Iris、150行、1280px幅）で、設問別分布6件はすべて GraphPanel viewport の横・縦スクロール 0、通常表示の transform なしを確認した。記述統計画面でも GraphPanel viewport の横・縦スクロール 0、ページ横幅の超過 0、console error 0 を確認した。
- `run-production.bat` 起動済みの 127.0.0.1:8420 は、最新 build と同じ asset 名を配信していることを確認した。

既知の Ant Design、React Router、Redux のテスト警告、および Vite の chunk-size 警告はテスト・build の失敗ではない。DISC のような実データ表に必要な横スクロールは、グラフ領域の微小なはみ出しとは区別して維持している。
