# 開発タスク

| ID | 内容 | 状態 | 詳細 |
|---|---|---|---|
| DAVIS-FEAT-019-019B | 設問別分布カードとコードブック全系伝播 | 実装済み・既存テスト失敗2件 | [詳細](DAVIS-FEAT-019-019B.md) |
| DAVIS-FEAT-027 | PCP拡張・MCA・DPR/Portal・小標本警告 | 未着手（ribbon、MCA API/画面、回帰証跡未実装） | [詳細・引き継ぎ](DAVIS-FEAT-027-028.md#feature-27-実装仕様) |
| DAVIS-FEAT-028 | 列名の設問文表示・numericを含む20水準L1色分け | 完了（Feature 27の共有PCP変更後に回帰再確認） | [詳細・引き継ぎ](DAVIS-FEAT-027-028.md#feature-28-実装仕様) / [実施記録](DAVIS-FEAT-028.md) |
| DAVIS-FEAT-020-DESIGN | MA表示・分析・メモリ制御の詳細設計 | 設計書作成済み（実装は020Aで追跡） | [詳細](DAVIS-FEAT-020-DESIGN.md) |
| DAVIS-FEAT-020 | MA設問表示・集計・ページ間連携・限定読込 | 実装中 | [詳細](DAVIS-FEAT-020.md) / [引き継ぎ](DAVIS-FEAT-020-HANDOFF.md) |
| DAVIS-FEAT-020A | 20a MAスケーラビリティ設計の実装・受入 | 未完了（AC-06一部・AC-07・AC-09一部・AC-10がNo） | [詳細・引き継ぎ](DAVIS-FEAT-020A.md) |
| DAVIS-FEAT-021 | 調査ウェイト指定・加重集計・非加重n併記 | 未完了（21-AC07・AC10がPartial、他Yes） | [詳細・引き継ぎ](DAVIS-FEAT-021-022.md#feature-21-調査ウェイト) |
| DAVIS-FEAT-022 | 順序尺度分析・Likert比較ビュー・PCP連携 | 未完了（22-AC10・AC12がPartial、他Yes） | [詳細・引き継ぎ](DAVIS-FEAT-021-022.md#feature-22-順序尺度分析とlikertビュー) |
| DAVIS-FEAT-023 | 手法名称の正確化・MDI/Permutation分離 | 未完了（名称監査・重要度分離・2列表示・実環境証跡が未完了） | [詳細・引き継ぎ](DAVIS-FEAT-023-024.md#feature-23-実装仕様) |
| DAVIS-FEAT-024 | 探索/検証分離・数値的外れ度に基づく感度分析 | 未完了（推論モード・候補固定・感度比較・実環境証跡が未完了） | [詳細・引き継ぎ](DAVIS-FEAT-023-024.md#feature-24-実装仕様) |
| DAVIS-FEAT-025 | データ来歴・補完マスク・共通分析コンテキスト・再現パッケージ | 未完了（来歴、raw復元、補完マスク、共通コンテキスト、package roundtrip未実装） | [詳細・引き継ぎ](DAVIS-FEAT-025-026.md#feature-25-実装仕様) |
| DAVIS-FEAT-026 | 2変量クロス集計・ASR・ウェイト・PCP連携 | 未完了（Crosstabページ、統計、ウェイト、scope、Selection連携未実装） | [詳細・引き継ぎ](DAVIS-FEAT-025-026.md#feature-26-実装仕様) |

| DAVIS-FEAT-032 | 重回帰分析（OLS・HC3・調査設計分散・予測・保存・画面） | 実装済み（実ブラウザ・static未検証） | [詳細](DAVIS-FEAT-032.md) |

## 追加分析の設計資料

[Feature 029〜034の機能仕様・実装詳細化設計](../feature/analysis-specs/README.md)（CA・MCA・FAMD・重回帰・最尤因子分析・コンジョイント分析）。設計資料の参照先であり、上記タスクの実装状態を変更するものではない。
