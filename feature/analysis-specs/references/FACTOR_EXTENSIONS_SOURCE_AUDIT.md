# Feature 033b・033c：既存構成・接続箇所の確認

確認日：2026-09-13。現ワークスペースの文書構成と接続先を静的に確認した。過去の添付ZIPに対する[source_audit.md](source_audit.md)のhashは更新せず、今回の確認とは区別する。

## 1. 文書配置と優先関係

既存analysis-specsはfeature/、tasks/、contracts/、fixtures/、validation/、references/、README、Markdown/HTML一括閲覧、SHA256SUMSからなる。033bと033cも同じ配置を使う。

|既存文書|033b/033cでの扱い|
|---|---|
|33_maximum_likelihood_factor_analysis.md|連続MLの基礎資料として保持。033bは対象を順序EFAへ拡張|
|DAVIS-FEAT-033-DESIGN.md|ML目的・回転・連続得点を明示参照。ML専用・PAなし・frequency対応は033bでは個別規約優先|
|00_common_analysis_contract.md / COMMON-DESIGN|scope、版、欠損分類、選択、保存、KeepAliveを継承|
|RESULT_CONTRACT.md|efa/cfa method、状態・結果・exportは拡張契約で追加|
|analysis_requests.py|既存型を変更せず新factor_extension_requests.pyが共通contextを再利用|
|VALIDATION_REPORT.md|2026-09-12の42件は旧設計の参照実績として保持。新統計実装の実績にしない|

033cのR/lavaanローカル境界と静的実行未対応は、共通設計の全分析local/static同一kernel方針に対する033c固有の追加設計。自動互換レイヤーや旧APIの並行運用は追加しない。

## 2. 現ソースで確認した接続先

|既存ファイル（リポジトリ基準）|確認対象|
|---|---|
|fullstack/backend/app/api/analysis_results.py|GET結果、select、predict、materialize、exportの既存route|
|fullstack/backend/app/main.py|API登録の接続先|
|fullstack/frontend/src/app/KeepAliveOutlet.tsx|ページ保持登録|
|fullstack/frontend/src/app/AppShell.tsx|ナビとKeepAlive表示|
|fullstack/frontend/src/main.tsx|ページroute登録|
|fullstack/backend/requirements.txt|SciPy宣言。新統計エンジンの利用可能性・Pyodide一致をこれだけで保証しない|
|fullstack/frontend/src/engine/pyodide.worker.ts|NumPy/SciPyのロード、直列実行、IDBFS。R実行環境の既存提供とはみなさない|
|fullstack/backend/app/domain/codebook_adapter.py|analysis_seriesの順序得点化とisReversed処理。新順序相関では変換順序と二重逆転に注意|

新EFA/CFAの予定ファイル名は詳細設計内に列挙する。現存する関連routeがあることと、追加契約に対応済みであることは別。API本体・FE・依存・run-productionの動作確認は今回の設計検証に含めない。

## 3. 変更範囲

成果物はfeature/analysis-specs以下の文書・設計入力契約・契約検証と、既存案内の更新。既存本体の変更、他分析の実装、開発タスクの進捗変更、ビルド・配布は行わない。新しい資料の整合性は[拡張検証報告](../validation/FACTOR_EXTENSIONS_VALIDATION.md)で報告する。
