# Feature 034 レビュー002 対応報告

日付: 2026-09-14／対象: REVIEW-002.md（残件 R007・R009・R011）。

## 修正内容

- CJ-R007: fit実行のfinallyを「live要求だけ解除＋同世代なら解除」へ修正し、破棄された要求が画面を永久busyにしないようにした。dataset切替effectでloading・errorもリセットする。materialize応答にもdataset・版・世代の照合を追加し、旧dataset向けfetchCodebookThunk・キャッシュ更新・エラー表示を防ぐ。
- CJ-R009: 予測に独自世代カウンタ（predSequence）を導入し、predictionIdと行取得を世代で照合。新予測開始時に旧表示を無効化する。予測行は全ページ取得＋ページ送りに接続し、取得失敗はpredErrorとして画面表示する（catch隠しを廃止）。
- CJ-R011: プロフィール連動図（確率/評点×残差の散布図）を追加。点クリックで行選択toggle、回答者全タスク選択ボタンと区別、中央選択の強調・hover・tooltip（rowId・回答者・値）で双方向表示する。

## 検証

- backend: test_150 11件・API 2件合格（計13件）。FE tsc -b成功。
- 既存未コミット変更は保全。共有基盤への追加変更なし（画面のみ）。

## 残作業

実ブラウザ操作（遅延応答中の切替・版更新・scope拡張後の再実行、予測ページング、連動図の中央選択往復）、Pyodide、R mlogit照合、全体回帰、run-production.bat確認は従来どおり残作業。
