# Feature 032 REVIEW-002 修正報告

日付: 2026-09-13夜 / 対象REVIEW-002（L005残件のみ、他は解消確認）

## L005残件への対応
- stale表示を保存応答のresultState参照から、現在のdataRevision/schemaRevisionと結果版の live 比較へ変更。保存後の版更新で即時バナーが出る。
- 点選択・矩形選択の応答反映前に、要求開始時のdataset・dataRevision・schemaRevisionを再照合。応答待ち中の更新では旧版rowIdsを適用しない。
- 列名入力をtags SelectからInputへ置換（L007の根本対応）。配列混入の経路を除去し、変更した列名での保存を確認。

## 実ブラウザ証拠
- 保存実行でLR_L005_8854列を作成、codebook反映、staleバナー「古い版の結果です（stale）。保存・予測・選択はできません。」の表示を確認（lr-l005-stale3.png）。
- test_130＋131: 11 passed、tsc正常、FE linear-regression 2 passed。
