# Feature 032 REVIEW-005/006 修正報告

日付: 2026-09-14 / 対象REVIEW-005・REVIEW-006（通常本番配布物での操作確認）

## L008 本番相当での操作確認 → 実施済み

- 環境: 本番レイアウトそのまま（ASGIが`frontend/dist`を配信＋同一backend）。`dist/index.html`は`index-BKgwgYIp.js`（SHA256一致、L008修正含有）。
- 実ブラウザ（実マウス）: 分析実行→予測（保存元が予測IDへ）→再分析→保存元・項目が`fit`へ戻ることを画面表示で確認（FIELD=fit）。
- HTTP（同一サーバ）: fit→predict 150件→refit→`source=fit`＋`sourceField=fitted`の保存が成功（例: LR_PROD_12056、150行）。旧バグ payload（fit×predicted）は422 ANALYSIS_REQUEST_INVALIDで拒否されることを確認。
- 8420番の既存プロセスには触れていない（他セッション所有のため）。起動中の8420は旧backendのため、本検証は同一構成の別ポート（8425）で実施した。

## 再検証

- test_130＋131: 11 passed、MCA/FAMD API 12 passed（計23 passed）、tsc正常。
