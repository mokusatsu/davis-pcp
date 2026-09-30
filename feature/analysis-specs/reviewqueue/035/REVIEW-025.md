# Feature 035 ブラウザ実操作の重複除外レビュー025

## 判定

`REVIEW-024.md` のブラウザ確認表を次の内容で置き換える。通常ブラウザで手操作を要求するのは、既存 E2E や unit では代替できない二項目だけとする。R023-01 の popup 実装漏れと R023-04 の配信物識別は引き続き未解決である。

## 手操作が必要な事項

| ID | 実操作 | 手操作が必要な理由 | 記録する結果 |
|---|---|---|---|
| M01 | `run-production.bat` で開いた通常画面で、BoxPlot、Q-Q、FEDF、Loess、Relationships、Surprise、PCP を表示する。横方向のページはみ出し、ページ・図内スクロール、図と説明・凡例の重なりを確認する。 | 今回の修正対象は通常表示の flex・overflow・描画面配置であり、JSDOM と既存 E2E は実際の viewport、CSS レイアウト、スクロールバー、視覚的重なりを判定しない。 | 画面URL、データセット、画面サイズ・表示倍率、操作前後のスクリーンショット、横方向 overflow の有無、到達したスクロール端。 |
| M02 | R023-01 を修正後、BoxPlot、FEDF、Relationships を拡大して右クリック menu と焦点ペア Select を開く。1 回目の Escape で popup のみ、2 回目で拡大 dialog が閉じ、起点へ focus が戻ることを確認する。 | native dialog の top layer と Ant Design の portal・キーボード・focus は簡易 probe や既存 E2E の拡大確認では検証されていない。今回のコード上の popup 接続漏れに直接対応する。 | popup が dialog 前面で操作可能なスクリーンショット、Escape ごとの状態、復帰先要素。 |

## 手操作を重複要求から外す事項

- 拡大倍率ラベル、拡大・復帰、代表グラフの入口は `test_focus_zoom.py` が対象にしている。
- SVG／Canvas の click・brush と rowId 一致は `test_zoom_mouse_precision.py` が対象にしている。修正の影響確認が必要なら、該当 E2E を現在の bundle に対して実行し、その結果を再利用する。手操作で同じケースを二重に実施しない。
- G50/G51 の外側 Modal 入力保持は既存の個別実証記録があるため、今回の通常表示レイアウト修正だけを理由に手操作で再要求しない。
- 配信物の source hash・bundle hash・URL の対応付けは R023-04 の build／配信証拠として残す。これはブラウザ手操作テストではない。

Pyodide 実ブラウザ操作は引き続き免除対象とする。M01 と M02 の確認だけを通常ブラウザの手操作証拠として提出すればよい。
