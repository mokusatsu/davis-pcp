# Feature 034 レビュー001 対応報告

日付: 2026-09-14／対象: REVIEW-001.md（11件 CJ-R001〜R011）。

## 修正内容

- CJ-R001: `conjoint_encoding.py`のoffset計算を修正（各展開列+1、block幅は別途設定）。3水準brand+線形price・属性順序逆転の両方で符号化一致を確認。単体試験`test_multi_attribute_offsets_and_order_invariance`を追加。
- CJ-R002: 予測側の列解決を列名・columnId両対応に修正（fitと同じ規則）。要求行は全件出力し、欠損IDもmissing行として診断に残す。
- CJ-R003: 予測で全データのタスク索引と照合し、部分集合はCONJOINT_PARTIAL_TASKで422拒否。API試験に部分scope予測422を追加。
- CJ-R004: 固定効果予測で既知回答者に保存α_i、新規回答者にmeanInterceptを適用。学習行再予測がfit値と一致することを隔離検証で確認（差0件）。
- CJ-R005: evaluationにfitOverlapRespondentCount・回答者一覧・newTaskKnownRespondentCountを追加。全体予測でfitOverlapCount=16・回答者数=8を確認。
- CJ-R006: materializeのscope解決と版再確認を書込ロック内へ移動。競合時409・副作用なし。idempotent replay・別payload 409の試験を追加。
- CJ-R007: 画面の全非同期応答にdataset・data/schema版・要求世代の照合を追加。dataset切替でrunSequenceを進め旧応答を破棄。stale表示も現在版と照合。
- CJ-R008: 再分析時にrows/sim/predを無効化し、resultIdにひもづけて表示。行の評点/確率は編集途中のmodeではなく結果modeで表示。
- CJ-R009: 予測ボタンがpredictionId・評価・失敗理由・予測行を表示し、予測sourceでの列保存に接続。エラーを画面表示。
- CJ-R010: availability・opt-out・ウェイト・回答者固定効果・価格/WTP・includeWtpの設定経路を追加。モデルJSON・タスク診断CSVの出力を追加。
- CJ-R011: 行一覧をページ送りにし、全件アクセス可能に。選択行の強調表示・tooltip・選択件数表示を追加。

## 検証

- backend: test_150_conjoint 11件・test_conjoint_api 2件・LR 8件の計21件合格。stats全回帰443 passed（R依存2件除外）。FE tsc -b成功。
- 隔離検証: 固定効果refit一致、列名指定predict 16/16、回答者重複8、部分予測422を確認。
- 既存未コミット変更は保全。共有基盤への変更はconjoint分岐・契約追加のみ。

## 残作業

実ブラウザ操作、Pyodide、R mlogit照合、全体回帰、run-production.bat確認は従来どおり残作業。
