# DAVIS-FEAT-034 コンジョイント分析 実装・受入記録

状態: 実装済み（検証: kernel単体10件・API 2件の計12件・FE型検査・static backend zip確認・HiGHS LP確認・stats全回帰（R依存2件除外）まで実施、実ブラウザ・Pyodide・R mlogit照合は残作業）。

開始時: branch=master
既存未コミット変更: 保全（feature/analysis-specs文書群・tasks等の他者差分に触れず。共有基盤は034必須の追加のみ）。
共有ファイル調整: analysis_contracts.py（ConjointColumns/Attribute/ConjointRequest/ExpandScope/Simulate/RespondentSelectorを追加のみ。SelectRequestにrespondentsを追加）、analysis_results.py（conjoint rows/select/predict/materialize/export分岐を追加）、main.py（conjoint router登録）。LinearRegressionPage.tsxの差分は本セッションの変更ではない（別作業の未コミット差分として保全・無変更）。

## 範囲

- Feature 034 コンジョイント（ratings pooled/respondent_fixed・choice条件付きロジット・ranking逐次選択ロジット、effect coding主効果のみ、opt-out ASC、expand-scope、simulate、PCP連携・保存・画面、local検証）。
- 対象外: 部分順位・同順位・best-worst・階層ベイズ・ランダム係数・個人別属性効用・交互作用・実験計画自動生成。

## 受入条件（CJ01〜CJ11・COM適用分）

- CJ01 入力・long format・部分task拒否・ID重複・availability: API試験で確認（部分選択→422 CONJOINT_PARTIAL_TASK、expand-scopeでタスク全体へ拡張）。
- CJ02 評点・effect code効用和0・pooled/within識別: 単体+API試験で確認（水準効用和0、within rank不足→CONJOINT_WITHIN_RANK_DEFICIENT）。
- CJ03 選択・3対1解析解β=ln(3)/2・P=.75: 単体試験で確認（β=0.549306・P=.75、最大誤差 1e-6以内）。
- CJ04 順位・J−1 stage・積の尤度・ties/partial未対応: 単体試験で確認（3択→2 stage、対数尤度=段階確率の和）。
- CJ05 SE・回答者反復・frequencyブロック複製・survey倍率: 単体試験で確認（CR1=G*/(G*−1)・df=G*−1、仮想回答者ID複製と同値、f_i^2不一致を否定、surveyはTaylor二次スケール・df=D）。
- CJ06 分離・完全/準完全分離LP・非収束・情報行列特異: 単体試験で確認（分離→CONJOINT_SEPARATION、LP失敗→CONJOINT_SEPARATION_CHECK_FAILED、正則化・上限・切替なし）。
- CJ07 simulate・確率和1・ratings第一選好・range固定・WTP符号: API+単体で確認（choice確率和1、ratings確率null・firstChoiceShare等分、重要度は保存utilityRange、WTP不安定はnull/WTP_UNSTABLE）。
- CJ08 タスク内定数加算不変: 単体試験で確認。
- CJ09 ratingsにlogit確率なし: API試験で確認（rows確率null・評点あり、probability保存を422拒否）。
- CJ10 分離/識別不能/欠損タスク/opt-out: 単体+APIで確認（opt-out ASC・最大1件/task・design=0・ASC=1）。
- CJ11 重要度分母0・WTP不安定null: 単体試験で確認（全レンジ0→null、均等配分なし）。
- COM-01 版競合: 実装済み（計算前後の版照合・409 ANALYSIS_INPUT_STALE、expand-scope/simulateも版検証）。試験追加は残作業。
- COM-02 scope: 実装済み（空scopeは空のまま、explicit未知ID 422）。試験追加は残作業。
- COM-07/08 保存・再送: 実装済み（rowId左結合・既存列上書き409・idempotency同一payload再送・別payload 409）。stale再送の回帰試験は残作業。
- COM-10 ページ: 実装済み（全ページ取得・export 2ページ目以降結合）。E2Eは残作業。
- COM-11 状態: 実装済み（KeepAlive登録・設定/結果/スクロール保持・stale表示）。実ブラウザ復帰は残作業。
- COM-12 安全: 実装済み（有限JSON・CSV式注入対策は共通export経路・ID照合）。監査は残作業。

## 変更ファイル

- 新規kernel: algorithms/models/conjoint_encoding.py（effect coding辞書・K−1列・基準−1・linear中心・未観測omitted）、conjoint_ratings.py（pooled/fixed・Feature032純粋WLS core再利用・meanIntercept）、conjoint_choice.py（共有stage尤度kernel・logsumexp・解析score/Hessian・RMS内部スケール・HiGHS LP分離・L-BFGS-B）、conjoint_covariance.py（respondent cluster CR1・frequency複製meat・survey Taylor D参照）、conjoint_simulation.py（in-set logit・ratings firstChoiceShare・重要度・WTP delta法）。
- 新規service: services/conjoint_service.py（prepare・重み/設計一致・段階検証・task完全性）、services/conjoint_fit.py（encoding組立・t推論）、services/conjoint_run.py（推定オーケストレーション・共分散分岐・係数/効用/重要度/WTP・summary/details/rows）。
- 新規API: api/conjoint.py（POST /models/conjoint・expand-scope・{id}/simulate・rows/select/predict/materialize/export）。
- 共通基盤（034必須追加のみ）: domain/analysis_contracts.py、api/analysis_results.py、main.py。
- 画面: ConjointPage.tsx（/models/conjoint「コンジョイント」: mapping・完全性検証・属性・設定・結果・予測・シミュレーション・行選択/回答者全タスク選択・保存・export・stale）、conjointApi.ts（全ページ取得・source付き保存）＋main.tsx/KeepAliveOutlet.tsx/AppShell.tsxへ登録。
- テスト: tests/stats_tests/test_150_conjoint.py（10件）、tests/api/test_conjoint_api.py（2件）。
- oracle・fixture: fullstack/.temp/cj_oracle/（R analytic script・sessionInfo取得はRscript segfaultのため残作業）。

## 検証証拠

- kernel/API: 12 passed（単体10＋API 2）。回帰スポット: test_130・analysis_context・covariance含め28 passed。stats全回帰（R依存2件除外）: 82 passed。FE: tsc -b エラーなし。static backend_app.zipにconjoint 9 module含有を確認。HiGHS最小LP成功を確認。
- R oracle: Rscript直接実行はmsys経由でsegfault（R 4.6.1・Windows PE確認）。cmd経由も出力なし。mlogit照合は未実施のため残作業。製品kernelの3:1解析解はPython側でβ=0.549306・P=.75を確認（許容差1e-6）。
- 数値: effect和0（誤差1e-12）、CR0×G/(G−1)一致（rtol1e-12）、frequency複製同値（rtol1e-12）、survey二次スケール（rtol1e-9）。

## 残作業

- 全体回帰の残り（最初から実行せず対象検証後に実施する方針のため、backend全体・FE vitest・全体statsは部分的）。
- 実ブラウザ検証（mapping・partial拒否と明示拡張・新規回答者ラベル・probability/firstChoiceShare表示・選択と相互ハイライト・KeepAlive・dataset切替）。
- Pyodide/static検証（同一kernelの数値・状態・保存、HiGHSのstatic worker内LP）。
- R mlogit/survival照合（choice/ranking係数・SE、クラスター分散の外部突合せ、入力hash・設定・環境・最大誤差の記録）。
- COM追加試験（版競合・scope・保存再送・ページE2E・安全監査）。
