# Feature 035 再レビュー023

## 判定

**承認保留。** 対象の `REPORT-007.md` は通常表示で `GraphPanel` の拡大用 transform を外す変更と限定テストを報告している。しかし、拡大中の popup 契約に実装漏れがあり、通常表示レイアウトの実ブラウザ証拠も保存されていない。前回までの Feature 035 全体の未解決条件も本報告では解消していない。

## 対象と確認版

- 対象報告: `REPORT-007.md`（2026-09-18 23:37:44 更新）
- 確認時刻: 2026-09-18 23:47 JST
- Git HEAD: `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`。対象実装は未追跡ファイルを含むため、コミットIDだけでは版を特定できない。
- 確認した主要ファイルの SHA-256:
  - `GraphPanel.tsx`: `96EF6790B5DEC65ECCBEE2A446FE3473C3F0D205CB18183952C196D19362ADC5`
  - `GraphExpansion.tsx`: `FA7EFF85324519B8106D28FD118D594F4161334976B90FD97DF6E8140F619510`
  - `graphPanel.css`: `E4FBDA2BADCD879D94F4F9F67AAE98AC2207CF4AED69A2152DFF62FB7E75BB84`
  - 確認時の配信候補: `dist/assets/index-CBqfddd1.js`、SHA-256 `31772809E4E45B466F4CF514B829DA138A227879BE4BDD731C16DB8E51ECCD85`、更新時刻 2026-09-18 23:36:51。

## 指摘事項

### R023-01 — [P1] GraphPanel 内の popup が複数画面で dialog 外へ出る

`useGraphPopupContainer` は、呼出元が `getPopupContainer` に明示的に渡した場合だけ、拡大中の popup を dialog 内の受け口へ送る実装である（`GraphPanel.tsx:54-69`、`GraphExpansion.tsx:379, 435`）。ところが、今回の対象には次の未接続箇所がある。

- `DistributionPage.tsx:775`: BoxPlot の右クリック `Dropdown` に `getPopupContainer` がない。
- `FedfPage.tsx:290`: FEDF の右クリック `Dropdown` に `getPopupContainer` がない。
- `RelationshipsPage.tsx:142-147`: 焦点ペアの `Select` と右クリック `Dropdown` のいずれにも `getPopupContainer` がない。

これらは拡大時に Ant Design の既定どおり body 側へ portal される。top layer の dialog 内で操作可能であることを要求する V10 と、設計書 8 節の popup 契約を満たさない。PCP、Q-Q、Loess の一部だけを接続しても対象全体の解消にはならない。

対象となる GraphPanel 内の `Select`、`Dropdown`、`Tooltip`、`Popover` を全件棚卸しし、dialog 内に表示するものを接続すること。その後、通常ブラウザで BoxPlot、FEDF、Relationships を各々拡大し、popup を開く、1 回目の Escape で popup だけが閉じる、2 回目で拡大が終了することを実操作で記録すること。

### R023-02 — [P1] 報告した通常表示レイアウトは実ブラウザで再現可能な証拠がない

`REPORT-007.md` の寸法表には、操作経路、データセット、画面URL、ブラウザ・倍率、スクリーンショット、採取値の保存先、実行ログがない。`reviewqueue/035` と `.temp/graph-expansion` を確認しても、本報告の更新時刻以後に対応する証拠ファイルは存在しない。したがって、BoxPlot、Q-Q、FEDF、Loess、Relationships、Surprise、PCP の記載寸法をレビューで再現・照合できない。

通常ブラウザでの手操作は、重複を除外した `REVIEW-025.md` の M01 と M02 に限定する。Pyodide 操作の免除は維持するが、これは通常ブラウザの確認を免除しない。自動試験と同じ click・座標・拡大復帰を二重に記録せず、実レイアウトと native dialog の popup 動作だけを証拠化すること。

### R023-03 — [P1] 検証コマンドを変更範囲に絞る

こちらでも次を実行し、5 ファイル 13 件成功を確認した。

```text
npm.cmd test -- tests/graphExpansion.test.tsx tests/graphCoordinates.test.ts tests/distributionProjection.test.tsx tests/relationshipProjection.test.tsx tests/surpriseManual.test.tsx
```

この 13 件の結果は確認済みの履歴として残すが、`REPORT-007.md` の通常表示レイアウト修正に対する必要最小限の再検証ではない。今後、この修正のために `graphCoordinates.test.ts`、`distributionProjection.test.tsx`、`relationshipProjection.test.tsx`、`surpriseManual.test.tsx` を再実行・追加する必要はない。いずれも今回変更していない座標変換、選択投影、分析実行を対象としており、CSS／通常時 transform の確認を増やさない。

自動試験が必要な場合も、`GraphPanel.tsx` の変更に直接対応する `tests/graphExpansion.test.tsx` だけに絞る。通常画面の page-level layout test や、`data-graph-scale="1"` の同種テストを追加しない。実レイアウトと popup の未検証部分は、重複しない手操作 M01／M02（`REVIEW-025.md`）で確認する。Feature 035 全体の過去の未解決事項は本報告の追加テストとして取り込まず、各々の修正時に影響する最小の検証だけを行う。

### R023-04 — [P1] 最新ソースと run-production 配信物の対応を確認できない

報告は build 成功と `run-production.bat` での確認を主張するが、コマンド出力、開始・終了時刻、終了コード、ソース hash、bundle hash、配信した `index.html` の参照先を残していない。`run-production.bat` が呼ぶ `run-production.ps1` は `frontend/dist/index.html` が既に存在すれば build を実行しない（`run-production.ps1:6-9`）。そのため、起動成功だけでは修正済みソースの bundle が配信された根拠にならない。

再提出時は、build 前後の対象ソース hash と `git status`、実行コマンドと終了コード、生成された bundle 名・SHA-256、`run-production.bat` の起動ログ、ブラウザが取得した `index.html` と bundle の対応を保存すること。未追跡実装を含む現状では、この対応付けがなければレビュー対象版を固定できない。

## 確認範囲と検証結果

- `REPORT-007.md`、`REVIEW-021.md`、`REVIEW-022.md`、Feature 035 設計書・検証計画・タスク記録を照合した。
- `GraphPanel.tsx`、`GraphExpansion.tsx`、`graphPanel.css`、Distribution、Q-Q、FEDF、Loess、Relationships、Surprise、PCP の呼出元を静的確認した。
- 5 ファイル 13 件の Vitest 成功は初回確認として記録する。ただし範囲が広すぎるため、以後の再提出で同じ 13 件を再実行する必要はない。自動試験を実施する場合も既存の `tests/graphExpansion.test.tsx` だけを対象にし、新規テストは追加しない。実レイアウトと popup は M01／M02 で確認する。
- build、全体テスト、通常ブラウザでの操作、Pyodide 実ブラウザ操作は今回のレビューでは実行していない。Pyodide 操作は免除対象のままとする。

**指摘事項はすべて解消していないため、Feature 035 全体および `REPORT-007.md` の通常表示レイアウト修正は承認できない。**
