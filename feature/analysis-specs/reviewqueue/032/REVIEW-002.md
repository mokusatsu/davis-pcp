# Feature 032 重回帰 実装レビュー 002

判定: **L001〜L004・L006・L007は解消。L005は一部未解消。**

- 日付: 2026-09-13
- 対象: `REVIEW-001-REPLY.md`、SHA256 `5499B832D3A0FB626E097BF4F524E360C2D01D2ED021BD33C3FB362BF9D91CAF`
- 対象版: 未コミット変更を含む重回帰実装。
- Pyodide実ブラウザ操作検証は対象外。

## 既存指摘の確認

- **L001 解消**: 共有登録の復元を維持。独立プロセスのtest_131は3件成功し、405は再現しない。
- **L002 解消**: target/数値説明変数の学習にspecを渡すこと、予測/観測評価でmissingCodesを照合する修正を確認。旧再現スクリプトでx、yともfitCount=9・missing除外1となった。target欠損でも予測可能・評価除外という追加報告を受領。
- **L003 解消**: 評価重みのdataset/column/noneを共通resolver・欠損/不正重み検証へ接続したことを確認。datasetとcolumnの一致・noneとの差は隔離検証報告を受領した。レビューアーはこの比較自体を今回再実行していない。
- **L004 解消**: 変数2がinterDraftの第2要素を更新することを確認。TestClientの交互作用成功は画面操作とは区別して扱う。
- **L006 解消**: dataset切替・再分析で予測表示と保存元をリセットし、現在resultIdとの照合を追加。predictionIdを独立保持し、fitへ切り替えても予測の選択肢が残る。
- **L007 解消**: tagsのonChange値を単一文字列へ変換してからmatNameへ保存する。nameに配列を送る経路は解消。

## L005 [P1] 残る版の確認

`fullstack/frontend/src/features/models/LinearRegressionPage.tsx:94`以降のrowsResultId/rowsReady、再分析時の旧rows消去、取得失敗表示、点選択のAPI経由化は確認した。旧診断行を新resultへ重ねる問題は解消している。

ただし369行のstale表示は依然 `result.meta.resultState === 'stale'` だけを参照する。保存や編集で現在のdataRevision/schemaRevisionが変わっても、保持されたfit応答のresultStateは自動更新されず、画面が古い結果であることを示さない。矩形選択の開始時だけには版比較があるが、画面全体のstale表示に反映されていない。

また点選択・矩形選択のawait後はrunSequenceのみを照合する（253行、285行付近）。要求処理後から応答到着までにdatasetの値・schemaが更新されても、再分析やdataset切替がなければsequenceは変わらず、旧版で解決したrowIdsを現在の選択へ適用する。サーバーの要求時チェックだけでは、この応答待ちの間の更新を防げない。

残る修正条件: 現在のdataRevision/schemaRevisionと結果の版からstaleを判定して表示する。選択要求開始時のdataset・dataRevision・schemaRevisionを保持し、応答反映直前に再照合する。保存後のstale表示、応答待ち中のデータ/コードブック更新で旧選択が適用されないことを確認する。

## 検証・受入確認

- backend test_130＋test_131: **11 passed**。
- `.temp/review-032-check.py`: 欠損コードの旧不具合2ケースが期待どおり。
- frontend linear-regression.test.tsx: **2 passed**。
- `tsc --noEmit -p fullstack/frontend/tsconfig.json`: **成功**。
- 実装修正・ビルド・全体テスト・実ブラウザ操作は行っていない。

実ブラウザでの交互作用追加、点/矩形選択、列名変更保存、予測・保存元切替、KeepAlive・dataset切替等は報告上未検証。TestClientのE2Eと実画面を混同しない。survey E2Eと本番配信経路の証拠も残る。現時点で「問題なし」は宣言しない。

## ソースSHA256

- LinearRegressionPage.tsx: `9F7CFF96A0EB62221E537286DB75388D3D584EAA45E2A9C1893D89DA2A9E0B7E`
- api/linear_regression.py: `C3F1CB03217E20DECB943D71D680C5A8CE7C4A6E9EF86E02BF6FD2CFCEC13E80`
- analysis_frame.py: `3E6368E5C53D2F1D3DC617F3C4727221C2E311F3C3C5372F1BB4E7B229554861`
