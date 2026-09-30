# Feature 032 重回帰 実装レビュー 003

判定: **L001〜L007のコード上の修正を確認。新規L008が未解消。受入検証にも残項目あり。**

- 日付: 2026-09-13
- 対象: `REVIEW-001-REPLY2.md`（SHA256 `E2624BBBADD909079F7F222BF5CBCC90520253D529F9FDD4B62B9A130AD0BEA4`）および過去の指摘。
- HEAD: `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`。未コミット変更を含むソースを確認した。
- 範囲: 選択応答の版照合、保存元と項目の状態遷移、共通結果ストアのParquet変更、追加の操作証拠。

## 既存指摘

L001〜L004・L006・L007は解消状態を維持している。共有登録、欠損処理、評価重み、交互作用の第2変数、予測IDと結果IDの対応、列名の文字列化を確認した。

L005の残っていたコード上の問題は解消。`LinearRegressionPage.tsx:259`・293で選択開始時の版を検証し、273・311で応答反映直前にdatasetId・dataRevision・schemaRevisionを再照合する。400行のstale表示も現在の版との差を反映する。応答待ち中のデータ／コードブック更新を再現する操作・自動試験の証拠は未提示であり、この競合操作自体は今回実行していない。

## L008 [P2] 予測後の再分析・dataset切替で保存項目がfit用に戻らない

- 位置: `fullstack/frontend/src/features/models/LinearRegressionPage.tsx:203`（同様に148行）。
- 手順: 分析を実行 → 予測・評価 → 再度分析を実行 → 保存・出力でそのまま保存する。
- 予測成功時の359〜363行で保存元は予測ID、項目は`predicted`になる。再分析成功時は203行で保存元だけを`fit`へ戻し、`matField`を更新しない。dataset切替でも同じ状態が残る。
- したがって376行は`source=fit`と`sourceField=predicted`を送る。APIのfit許可項目は`fitted`・`residual`・leverage系であり、`api/linear_regression.py:1738`で`ANALYSIS_REQUEST_INVALID`・422となる。これはコードの状態遷移とAPI検証から確認したもので、今回ブラウザで再現したものではない。
- 修正条件: 再分析成功時とdataset切替時にも保存元・項目の整合性を保つ。新しい結果のfit許可項目から有効な項目を選ぶ。予測 → 再分析 → fit保存、および予測 → dataset切替 → 分析 → fit保存の確認を追加する。

手動で保存元を切り替える114〜118行と予測成功時の正規化は正しいが、プログラムから保存元を戻す経路が残っている。

## 検証と証拠

- 重回帰backend `test_130`＋`test_131`: **11 passed**。
- 共通ストア変更の影響先 `test_111_mca_api`＋`test_121_famd_api`: **12 passed**。
- frontend `linear-regression.test.tsx`: **2 passed**。図の範囲計算の試験であり、ページの状態遷移試験ではない。
- `tsc --noEmit -p fullstack/frontend/tsconfig.json`: **成功**。
- `analysis_result_store.py`のParquet書込・読込の置換と呼出箇所を確認した。上記API試験は通常のPolars経路であり、fallback強制実行の検証ではない。
- 追加報告とタスク記録から、通常ブラウザでの分析・交互作用・矩形選択135件・KeepAlive・予測150件・列保存の操作結果を受領した。`.temp/lr-saved.png`を閲覧し、予測元と`predicted`項目の表示を確認した。画像だけで列作成完了を独立証明したものではない。
- `.temp/lr-l005-stale.png`も閲覧したが、stale警告が表示されていないため、保存後stale表示の成功証拠としては扱わない。
- 実装修正・ビルド・全体テスト・実ブラウザ操作は今回行っていない。Pyodide実ブラウザ操作検証はレビュー対象外。

surveyのAPI経由E2E、選択応答待ち中の版変更、通常の本番配信経路での操作証拠は引き続き未確認。タスク記録のビルド成功とdevサーバでの操作は確認できるが、本番配信での操作とは区別する。L008および残る受入確認があるため、問題なしとは判定しない。

## ソースSHA256

- `LinearRegressionPage.tsx`: `387F536E36C27378FA00B9392816815329861C76556E40735AFD81D6AF332F39`
- `api/linear_regression.py`: `C3F1CB03217E20DECB943D71D680C5A8CE7C4A6E9EF86E02BF6FD2CFCEC13E80`
- `storage/analysis_result_store.py`: `6BE984D105EEA08C57DC7404E1F1836BF9A01921EB20D3B498CDDE169D0398E5`
