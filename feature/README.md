# 機能仕様

既存機能の仕様はこのディレクトリの `01_`〜`28_` の各文書を参照する。進捗は[開発タスク一覧](../tasks/task-list.md)で管理する。

## 追加分析機能（Feature 029〜034）

[機能仕様・実装詳細化設計 v1.0](analysis-specs/README.md)に、CA・MCA・FAMD・重回帰・探索的因子分析（EFA）・コンジョイント分析の仕様と詳細設計を収録している。

- [共通機能仕様](analysis-specs/feature/00_common_analysis_contract.md)
- [共通実装設計](analysis-specs/tasks/DAVIS-FEAT-029-034-COMMON-DESIGN.md)
- [受入条件・実装順序](analysis-specs/tasks/ACCEPTANCE_AND_HANDOFF.md)
- [HTML一括閲覧](analysis-specs/index.html)／[Markdown一括閲覧](analysis-specs/ALL_SPECIFICATIONS.md)

入力契約・Schema・入力例・合成データ・参照計算・検証記録は `analysis-specs/` 内に同梱する。これらは設計資料であり、本体の実装状況は開発タスク一覧を参照する。

## グラフ拡大表示の共通化（Feature 035）

- [詳細設計](35_graph_expansion_design.md)
- [グラフ移行・対象外の拡大撤去台帳](35a_graph_expansion_inventory.md)
- [検証計画](35b_graph_expansion_validation.md)
- [35→35a→35bの順次実装プロンプト](35_graph_expansion_implementation_prompt.md)
- [設計記録](../tasks/DAVIS-FEAT-035-DESIGN.md) / [実装タスク](../tasks/DAVIS-FEAT-035.md)

描画方式・選択仕様を維持して拡大表示とポインタ座標を共通管理する。対象外の表・情報パネルの拡大は撤去する。通常ビルド・テスト・本番起動確認・実装後レビュー対応までをスコープとする。実装は未着手。

## ヘッダ機能ナビゲーション（Feature 036）

- [Menu／SubMenu詳細設計・31機能対応表・検証計画](36_header_navigation_design.md)
- [実装・検証・30分間隔レビュー対応プロンプト](36_header_navigation_implementation_prompt.md)
- [設計記録](../tasks/DAVIS-FEAT-036-DESIGN.md) / [実装タスク](../tasks/DAVIS-FEAT-036.md)

6分類のMenu／SubMenu、現在地表示、狭幅でのinline表示を定義する。状態は計画書作成済み・実装未着手。
