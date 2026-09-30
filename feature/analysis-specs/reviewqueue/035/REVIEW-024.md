# Feature 035 ブラウザ確認範囲の補足レビュー024

## 判定

`REVIEW-023.md` の承認保留は維持する。ただし、通常ブラウザで要求する確認は、既存の unit／静的確認を繰り返すものではなく、ブラウザでしか判定できない事項だけに限定する。

この補足は `REPORT-007.md` と `REVIEW-023.md` を対象とする。R023-01 の popup 接続漏れと R023-04 の配信物識別の指摘は解消していない。

## 実ブラウザでだけ確認する事項

| ID | 実操作 | 既存テストと重複しない理由 | 記録する結果 |
|---|---|---|---|
| B01 | `run-production.bat` で開いた通常画面で、BoxPlot、Q-Q、FEDF、Loess、Relationships、Surprise、PCP を表示し、横方向のページはみ出し、ページスクロール、図内スクロール、図と説明・凡例の重なりを実際に確認する。 | JSDOM の `data-graph-scale` と DOM 値では CSS の実レイアウト、scroll container、ブラウザの viewport を判定できない。 | 画面URL、データセット、画面サイズ・表示倍率、操作前後のスクリーンショット、横方向 overflow の有無、到達したスクロール端。 |
| B02 | 修正後に BoxPlot、FEDF、Relationships を拡大し、右クリック menu と焦点ペア Select を開く。1 回目の Escape で popup だけ、2 回目で拡大 dialog が閉じ、起点へ focus が戻ることを操作する。 | `graphExpansion.test.tsx` は簡易 probe の container を確認するだけで、native dialog の top layer と Ant Design の実 portal・Escape・focus を確認しない。 | popup が dialog 前面で操作可能なスクリーンショット、Escape ごとの状態、復帰先要素。 |
| B03 | SVG、Canvas、HTML の各代表図で、通常・拡大後・スクロール後に既知の点／セル／要素へポインタ操作を行い、hover 対象と選択 rowId 集合が一致することを確認する。倍率変更またはリサイズ中の drag は取消し、次の操作が成功することも確認する。 | `graphCoordinates.test.ts` は座標変換式の単体試験であり、ブラウザの実 pointer event、Canvas 描画、SVG CTM、scroll、pointer capture を通していない。 | 対象ID・期待 rowId 集合・実 rowId 集合、倍率・DPR・スクロール位置、drag 中と完了後のスクリーンショット。 |
| B04 | G50/G51 で外側 Modal を開いたままグラフを拡大・復帰し、入力値、外側 Modal、確定／取消の状態が変わらないことを操作する。 | 外側 Modal と native dialog の重なり、入力 focus、背面 click は unit test で再現できない。 | 操作前後の入力値、外側 Modal の開閉状態、誤発火の有無。 |
| B05 | build 後に `run-production.bat` から読み込んだ `index.html` と bundle を確認し、報告した source hash・bundle hash と一致する画面を操作する。 | 起動スクリプトは既存 `dist` を再buildしないため、unit 成功や起動成功だけでは配信中の版を示せない。 | build 出力、source/bundle SHA-256、配信URL、ブラウザで取得した bundle 名。 |

## 重複として再要求しない事項

- `graphExpansion.test.tsx`、`graphCoordinates.test.ts`、`distributionProjection.test.tsx`、`relationshipProjection.test.tsx`、`surpriseManual.test.tsx` の 13 件を、ブラウザ確認のためだけに再実行すること。
- 通常時の `data-graph-scale="1"` と inline transform 不在を、ブラウザで改めて単体確認すること。
- B01〜B04 の操作を DOM の直接 click や単なる寸法取得に置き換え、同じ自動試験を二重に記録すること。

Pyodide 実ブラウザ操作は引き続き免除対象とする。上表は通常ブラウザでしか得られない証拠に限ったものであり、既存の自動試験の再実行を完了条件にはしない。
