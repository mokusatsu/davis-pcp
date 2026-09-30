# Feature 034 コンジョイント分析 実装報告

日付: 2026-09-14／branch: master／既存未コミット変更は保全（他者差分に触れず、共有基盤は追加のみ）。

## 実装内容

- 数値kernel（5件）: effect coding辞書・pooled/fixed ratings（Feature032純粋WLS core再利用）・choice/ranking共有stage尤度kernel（logsumexp・解析score/Hessian・RMS内部スケール・HiGHS LP分離・L-BFGS-B）・回答者クラスタCR1/frequency複製/survey Taylor（D参照）・simulation/重要度/WTP。
- サービス・API: prepare・段階検証・推定オーケストレーション、POST /models/conjoint・expand-scope・{id}/simulate、共通rows/select/predict/materialize/export分岐、main登録。
- 画面: /models/conjoint（mapping・完全性検証・属性・設定・結果・予測・シミュレーション・行/回答者選択・保存・export）、3箇所登録、中央selection・L1/L2・tooltip・KeepAlive・stale対応。
- 契約: ConjointColumns/Attribute/Request/ExpandScope/Simulate/RespondentSelectorを追加、SelectRequestにrespondentsを追加。SE/t/CI等の略記キーは不使用（standardError/statistic/ciLower/ciUpper）。

## 受入ID別結果

- CJ01 部分task拒否・expand-scope: API試験で合格。
- CJ02 効用和0・pooled/within: 単体+APIで合格。
- CJ03 3:1解析解β=ln(3)/2=0.549306・P=.75: 単体で合格（誤差1e-6以内）。
- CJ04 ranking J−1 stage・尤度積: 単体で合格。
- CJ05 回答者集約・frequency複製同値・CR1 oracle・survey二次スケール・df=D: 単体で合格。
- CJ06 分離LP・非収束・特異: 単体で合格（救済なし）。
- CJ07 simulate確率和1・ratings第一選好・range固定・WTP: API+単体で合格。
- CJ08 定数加算不変: 単体で合格。
- CJ09 ratings確率なし: APIで合格（probability保存422拒否）。
- CJ10 分離/識別不能/欠損/opt-out: 単体+APIで合格。
- CJ11 重要度分母0・WTP不安定null: 単体で合格。
- COM-01/02/07/08/10/11/12: 実装済み、追加試験は残作業。

## 件数・最大誤差・環境

- 12 passed（単体10＋API 2）、回帰スポット28 passed、stats全回帰82 passed（R依存2件除外）。
- 最大誤差: 効用和1e-12、解析解1e-6、CR1 oracle rtol1e-12、frequency複製 rtol1e-12、surveyスケール rtol1e-9。
- 環境: Python 3.14.7・numpy 2.4.6・scipy 1.18.0（HiGHS LP成功）・polars 1.43.2・pydantic 2.13.4、FE tsc -b成功、static backend_app.zipにconjoint 9 module含有を確認。
- R oracle: Rscript直接実行はmsys経由でsegfault（R 4.6.1確認）、mlogit照合は未実施。

## 実ブラウザとHiGHSの証拠

- HiGHS最小LP成功（local）。Pyodide内LP・実ブラウザ操作は未実施。
- run-production.bat確認は未実施（local API・FE型・static zipまで実施）。

## 残作業

- 全体回帰（backend全体・FE vitest）、実ブラウザ検証、Pyodide/static検証、R mlogit照合、COM追加試験、run-production.bat確認。
- 全体完了扱いにしない。未実施項目を明記した。

## 共有基盤への変更

- analysis_contracts.py（追加のみ）、analysis_results.py（conjoint分岐6箇所追加）、main.py（router 2行追加）。
- Feature033の共有ファイル差分（factor_analysis登録等）とは競合なし（別router・別分岐・別契約）。
