# Feature 034 レビュー003 対応報告

日付: 2026-09-14／対象: REVIEW-003.md（残件 R007・R009、R011解消維持）。

## 修正内容

- CJ-R007: scope拡張がfitのrunSequenceを進めないよう世代を分離（expandSequence）。fit実行中の拡張でもfitのfinallyがloadingを正しく解除し、拡張の成功・失敗はexpandError/expandInfoで必ず表示する。拡張ボタンはfit実行中も再実行可能のまま残る。
- CJ-R009: 予測開始時のrunSequenceとresultIdを開始値として保存し、応答時に照合する（応答時のrunSequence.currentとの比較を廃止）。再分析・dataset変更ではhandleRun・dataset effectの両方でpredSequenceを進め、旧予測を無効化する。予測行の表示キーと保存はresultId:predictionIdで現在のモデルにひもづけ、異なるモデルの予測表示・保存ボタンは無効化する。
- R011の連動図・ページング・選択連携は維持（変更なし）。

## 検証

- backend: test_150 11件・API 2件合格（計13件、変更なし）。FE tsc -b成功。
- 既存未コミット変更は保全。backendへの変更なし（画面のみ）。

## 残作業

実ブラウザ操作（fit待機→scope拡張成功/失敗→再実行、予測A待機→再分析B→A応答解放、dataset往復中の遅延予測）、Pyodide、R mlogit照合、全体回帰、run-production.bat確認は従来どおり残作業。
