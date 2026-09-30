# DAVIS-PCP 追加分析機能：機能仕様・実装詳細化設計 v1.0

作成日：2026-09-12／対象：アンケートを中心とした、非時系列の探索的データ分析。

本書群は設計成果物であり、DAVIS-PCPへの実装パッチではない。添付の`feature.zip`と`package(1).zip`を設計基準とし、実際のコード上の接続箇所を確認した。確認した版と根拠は[ソース照合記録](references/source_audit.md)に記載する。

一括閲覧：[HTML読書版](index.html)／[Markdown連結版](ALL_SPECIFICATIONS.md)。旧029〜034の検証結果：参照数式・入力契約42ケース成功。033 EFA・033c CFAの追加設計は2026-09-13版で、実績は[拡張検証報告](validation/FACTOR_EXTENSIONS_VALIDATION.md)を参照する。新規API本体・画面・静的版への組込み試験は未実施。

文書の配置先は `feature/analysis-specs/`。本書群内の相対リンクは各文書からの相対パスであり、本文中の `fullstack/` はリポジトリルート基準の実装パスを表す。[既存機能仕様](../README.md)／[開発タスク一覧](../../tasks/task-list.md)／[本体README](../../fullstack/README.md)。

## 1. 読む順序と文書の優先順位

最初に[共通機能仕様](feature/00_common_analysis_contract.md)、次に[共通実装設計](tasks/DAVIS-FEAT-029-034-COMMON-DESIGN.md)、担当機能の仕様・実装設計、最後に[受入・実装順序](tasks/ACCEPTANCE_AND_HANDOFF.md)を読む。APIの構文は[実行可能な型契約](contracts/analysis_requests.py)とそこから生成したJSON Schema、数式・意味・処理順序は実装設計を正本とする。型契約だけではデータ依存検証を代替しない。

|新規ID|機能仕様書|実装詳細化設計書|今回の確定範囲|
|---|---|---|---|
|029|[通常のコレスポンデンス分析](feature/29_correspondence_analysis.md)|[CA実装設計](tasks/DAVIS-FEAT-029-DESIGN.md)|回答者データの二元表／既存分割表、χ²距離による配置|
|030|[多重対応分析](feature/30_multiple_correspondence_analysis.md)|[MCA実装設計](tasks/DAVIS-FEAT-030-DESIGN.md)|完全指示行列MCA、明示選択したMA子項目の二値変数化|
|031|[混合データ因子分析](feature/31_famd.md)|[FAMD実装設計](tasks/DAVIS-FEAT-031-DESIGN.md)|カテゴリ＋数値のFAMD、個体・変数・カテゴリの別表示|
|032|[重回帰分析](feature/32_multiple_linear_regression.md)|[重回帰実装設計](tasks/DAVIS-FEAT-032-DESIGN.md)|OLS、カテゴリ説明変数、交互作用、HC3、調査設計分散|
|033|[探索的因子分析（EFA）](feature/33_exploratory_factor_analysis.md)|[EFA実装設計](tasks/DAVIS-FEAT-033-DESIGN.md)|非加重・完全ケース、Pearson ML／MINRES、Polychoric MINRES、平行分析、斜交回転、Pearson／Polychoric感度比較|
|033c|[確認的因子分析（CFA）](feature/33c_confirmatory_factor_analysis.md)|[CFA詳細設計](tasks/DAVIS-FEAT-033C-DESIGN.md)|独立した測定モデル、WLSMV/MLRと追加ULSMV・ML、推論・適合度・独立性|
|034|[コンジョイント分析](feature/34_conjoint_analysis.md)|[コンジョイント実装設計](tasks/DAVIS-FEAT-034-DESIGN.md)|評点型・選択型・完全順位型、効用・重要度・選好シミュレーション|

### 既存仕様との関係

033 EFA・033c CFAは[拡張契約](contracts/FACTOR_EXTENSIONS_CONTRACT.md)と[専用受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)を併読する。現行033はEFAの唯一の正本であり、旧033と033bは移動案内である。初期版の両機能は非加重・完全ケースのみ。CFAはローカルlavaanを検証対象とし、静的CFA実行は別段階。旧42件の参照試験は、新しい順序EFA/CFAの数値受入済みを意味しない。

追加成果物：[入力Python契約](contracts/factor_extension_requests.py)、[EFA Schema](contracts/schemas/efa.schema.json)、[CFA Schema](contracts/schemas/cfa.schema.json)、[fixture仕様](fixtures/FACTOR_EXTENSIONS_FIXTURES.md)、[一次資料](references/FACTOR_EXTENSIONS_SOURCES.md)、[接続確認](references/FACTOR_EXTENSIONS_SOURCE_AUDIT.md)。033 EFA/033cの構文正本はこの追加Python契約、意味・計算の正本は各詳細設計とする。既存のFactorAnalysisRequestとfactor_analysis.schema.jsonは旧連続ML資料の参照検証資産であり、現行入力契約ではない。

033 EFA/033cの個別仕様は版1.1。主要用途を5件法中心・N=1000〜2000程度とし、良好分布でのPearson＋ML/MINRESを主要経路に含める。033の順序尺度感度分析は、共通条件・因子の順序/符号整合の下で相関・負荷量・共通性・因子相関・因子数候補の差を表示する。CFAはEFA比較の一致を独立検証や推論の同等性として扱わない。

新規IDは添付のFeature 28までに続けて29〜34を採番した設計上の提案番号であり、既存リポジトリの採番を変更済みという意味ではない。Feature 30はFeature 27のMCA分析部分を置き換える。Feature 27/28のPCP、スクロール、ヒットテスト、ポップアップ、L1等の仕様は置き換えない。`/models/mca`はこの新契約で一本化し、同名の別エンドポイントを増やさない。

既存MCA詳細設計にある`P=Z/(N×Q)`のQを「指示行列の列数」とする記述を廃止する。新仕様では設問数をm、カテゴリ総数をKとし、非加重では`P=Z/(n m)`である。欠損方針、調査ウェイト、`selectedRowIds`、探索ラベル、比率単位も共通契約に統一する。

## 2. 設計上の判断

「多重応答分析」はMCA（多重対応分析）として定義した。ただし複数回答設問（MA）との混同を避けるため、MAは別の入力モードとして明示的に扱う。FAMDはカテゴリと数値を同時に扱う次元縮約であり、Feature 33の共通因子モデルとは別手法である。

コンジョイントは「評点を回帰する方式」だけに限定せず、選択型の条件付きロジット、完全順位型の逐次選択モデルも対象にした。階層ベイズ、混合ロジット、個人別効用の自動推定、実験計画の自動生成、適応型質問票は本版に含めない。代わりに対象内の識別可能性、回答単位、ウェイト、標準誤差、シミュレーションの意味を確定している。

推定値と標準誤差のウェイト対応は別に定義した。特にsurveyウェイトを精度重みや複製度数として処理しない。Feature 033 EFAは初期版で解決済みdatasetウェイトを受け付けず、FA_WEIGHT_UNSUPPORTEDを返す。ユーザーがnoneを明示した場合は別の非加重試行として保存する。

## 3. 付属成果物

- `contracts/`：Pydantic v2入力契約、JSON Schema、入力例、結果契約・データ辞書。
- `fixtures/`：CA/MCA/FAMD/回帰/因子/コンジョイントの小規模合成データと、数式検証から作成した期待値。
- `validation/`：独立した参照計算・自動検証、実行記録。アプリの実装用統計ライブラリではない。
- `references/`：原典の最小引用、採用理由、ソース確認箇所・ハッシュ。
- `ALL_SPECIFICATIONS.md`：文書を一括で読める連結版。編集・実装時の正本は分割ファイル。

本体ソース、既存のユーザーデータ、node_modules、Python実行環境は再配布ZIPに含めない。検証状況と未実施事項は[検証報告](validation/VALIDATION_REPORT.md)を参照する。
