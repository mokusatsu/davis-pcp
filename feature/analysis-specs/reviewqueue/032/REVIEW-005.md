# Feature 032 重回帰 実装レビュー 005

判定: **ソースのL001〜L008は解消。通常本番配布物にL008の修正が未反映。**

- 日付: 2026-09-13（対象回答の日付表記は2026-09-14）。
- 対象: `REVIEW-004-REPLY.md`、SHA256 `3BE8D133ADD281E9B092CB0E8F6448C0E49FE718FC3DEAE0F5A7066ED22E21DE`。
- `LinearRegressionPage.tsx` SHA256: `C0A48CEF5BBC460F639A8FF2983D7F6C0359AEF47F54E1E8A5408658F38B3784`。
- `api/linear_regression.py` SHA256: `C3F1CB03217E20DECB943D71D680C5A8CE7C4A6E9EF86E02BF6FD2CFCEC13E80`。

## 追加の受入証拠

surveyのAPI経由検証について、2層×各3PSU・24行、層間でPSU番号重複、auto=taylor、参照df=3、1PSU除外でfitCount=20・参照df維持、重み100倍で係数・SE不変の報告を受領した。今回レビューアーはそのHTTP検証を再実行していない。

選択要求を保留してコードブックを更新した検証報告を受領した。`.temp/lr-race.png`を閲覧し、中央sidebarの選択0件を確認した。画像単独では通信順序を証明しないが、操作報告と前回確認した応答時の版照合を合わせ、旧選択が適用されない証拠として受け入れる。応答前にサーバーが409を返したか、成功応答をfrontendが破棄したかは報告から確定できない。

## L008 [P2] 通常本番配布物への反映が残る

`fullstack/run-production.ps1:6`は`frontend/dist/index.html`がないときだけビルドし、12行でASGIアプリを起動する。`backend/app/main.py:102`以降は通常`frontend/dist`を配信する。

現在の`frontend/dist/index.html`は`/assets/index-Ha99qH-I.js`を参照する。このbundleの重回帰再分析成功処理は次の形で、保存元だけをfitへ戻し、保存項目を正規化していない。

```javascript
...,Ye(null),tt(null),dt("fit"),Mt(Dt.resultId)
```

dataset切替effectも`dt("fit")`で終わり、項目正規化がない。ソースの207〜211行にある新結果の`materializeFitFields`照合はbundleに含まれない。したがって、通常の本番起動では予測→再分析→fit保存のL008が残る。静的実機とdevでの成功は、この通常配布物への反映を示さない。

- bundle SHA256: `4DBE04CF6B77D30074DE3B6276C9D014A34A6B4F80CF6797D9BE329EC66F0320`。
- 修正条件: 最新のソースから通常本番配布物を更新し、そこに項目正規化が含まれることと、通常本番起動で予測→再分析→fit保存が成功することを確認する。

## 実施範囲

今回は回答、画像、ソースhash、起動スクリプト、ASGI配信先、実bundleの内容を確認した。ソースに変更がないため既に成功したテストは再実行していない。実装修正・ビルド・実ブラウザ操作は行っていない。Pyodide実ブラウザ操作検証は対象外。

残件は上記の通常本番配布物への修正反映と操作確認である。現時点ではレビュー対象範囲全体の「問題なし」は宣言しない。
