# Feature 032 REVIEW-001 追加修正報告（実ブラウザ・static検証）

日付: 2026-09-13夜 / 対象: REVIEW-001修正後の残作業検証

## 保存422の追加修正（ブラウザ検証で発見）
- 現象: 予測後に保存元が予測IDへ自動切替される一方、項目がfittedのまま残りmaterializeが422。
- 修正1: matSource変更時に項目を対応表の先頭へ正規化（handleMatSourceChange）。
- 修正2: 予測直後の自動切替時にも項目を予測表へ切替。
- 確認: ブラウザ保存実行でLR_FITTED列を作成、codebookに反映。tsc正常。

## static実機の追加修正
- 現象: 静的PyodideでLR実行がWASM_DISPATCH_ERROR（polarsのwrite_parquet欠落）。MCA/FAMD共通の問題。
- 修正: analysis_result_store.pyにpyarrow fallback（_write_frame_parquet/_read_frame_parquet、dataset_storeと同方式）。
- 確認: build_static.py再構築→zipにfallback含有→静的実機で有効3列R2=0.8402（local一致）。

## 実ブラウザ証拠
- 実行・係数・矩形選択135件・KeepAlive・予測150/150・保存の各スクリーンショットを.tempに保存。
- test_130＋131: 11 passed、tsc正常。
