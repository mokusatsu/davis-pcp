# Feature 034 コンジョイント分析 レビュー001

判定: **要修正。受入条件を満たしていない。**

- 日付: 2026-09-14
- 対象: REPORT.md（SHA256 `892B08B83DF22875A72F50A000E4068BD92EB7378420B1D3DBE7278A262D5EF4`）
- HEAD: `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`。未コミット実装を含む。
- 基準: `feature/analysis-specs/feature/34_conjoint_analysis.md`。符号化、学習・予測・保存API、画面、関連する共通API分岐、対象テストを確認した。

## 指摘

### CJ-R001 [P1] 多水準カテゴリの後続属性の列位置が範囲外になる

`fullstack/backend/app/algorithms/models/conjoint_encoding.py:98-108`。
designColumnsは既にカテゴリの各列に展開されているのに、後続属性のoffset計算で各列のwidthを再加算している。brandが3水準、続いてpriceが線形の場合、nParams=3に対しoffsetは0,1,4となる。encode_rowで `IndexError: index 4 is out of bounds for axis 0 with size 3` を再現した。カテゴリブロック幅を一度だけ数え、複数属性・3水準以上・属性順序変更のケースで学習と予測の符号化一致を確認すること。

### CJ-R002 [P1] 学習で受理した列名を予測で解決できず、行が消える

`fullstack/backend/app/api/conjoint.py:243-274`。
学習側は列名とcolumnIdを解決できるが、manifestには入力の列参照を保存し、予測側はcolumnIdだけの辞書で検索する。既存APIテストと同じ列名指定のfit後にpredictすると、選択1行に対してHTTP 200、requestedCount=0、失敗件数も0となった。欠損IDをstatus_ofに記録してもpred_rowsに追加しないため診断も消える。学習時に参照を正規化するか、予測でも同じ解決規則を使い、要求行を無言で落とさないこと。

### CJ-R003 [P1] 予測時に元タスクの完全性を確認していない

`fullstack/backend/app/api/conjoint.py:266-285, 355-377`。
選択された行だけをby_taskにまとめ、候補数2以上ならその集合で確率を再計算する。元データのタスク構成との照合がないため、3択のうち2行を選ぶと別の2択問題として扱われる。正規columnIdで2択の1行を予測する場合も、CONJOINT_PARTIAL_TASKではなくHTTP 200/unavailableになった。仕様§3・§6に従い、学習と予測でタスク完全性を維持し、部分集合を明示的に拒否すること。

### CJ-R004 [P1] 回答者固定効果の予測に回答者切片を適用していない

`fullstack/backend/app/api/conjoint.py:476-488`。
alphasに既知回答者があればpredictionAssumptionをfitted_respondent_interceptにするが、実際の分岐はpassであり、予測値は共通interceptのまま。既知回答者には保存した切片、新規回答者には回答者平均切片を適用し、学習行への再予測がfit値と一致することを確認すること。

### CJ-R005 [P2] 評価の学習重複を回答者数でなく行数で数えている

`fullstack/backend/app/api/conjoint.py:278-283, 406, 504-518`。
fitOverlapCountはrowIdの一致を加算する。8回答者・16行の全体予測で16と返ることを確認した。同じ回答者の未学習タスクは非重複に分類される。仕様§6の回答者単位の重複数を追加し、未学習タスクと未学習回答者を区別すること。

### CJ-R006 [P1] 保存の版確認が書込ロックの外にある

`fullstack/backend/app/api/conjoint.py:535-571, 653-705`。
staleとexpectedRevisionを確認した後にロックを解放したまま値とscopeを準備し、書込ロック内では版を確認しない。間にデータ編集が完了すると古い結果を新しいデータへ保存できる。書込ロック内で最新revisionと学習版を再確認してから更新すること。共通analysis_results.pyの保存経路に同じ目的の再確認がある。競合時409・副作用なしの対象試験が必要。

### CJ-R007 [P1] 画面の応答を現在のデータセット・版に照合していない

`fullstack/frontend/src/features/models/ConjointPage.tsx:64-69, 98-132, 153-175, 190`。
dataset切替でrunSequenceを更新しないため、切替前のfit/rows応答が切替後に結果を再設定する。select応答も無条件でselectionAppliedへ渡すため、応答待ち中のdataset・版変更後に旧rowIdsが中央選択へ入る。simulate/expandにも同種の確認がない。現在のdataset・data/schema版・要求世代との一致を応答反映前に確認すること。stale表示も取得時metaだけに依存せず現在版と照合すること。遅延応答中の切替・版更新を対象に確認すること。

### CJ-R008 [P2] 再分析後に旧行・旧シミュレーションが混在する

`fullstack/frontend/src/features/models/ConjointPage.tsx:98-133, 273, 278-279`。
fit結果を先に置換する一方、前回rowsとsimResultを残す。行取得失敗時は新しい係数に古い行が表示され、成功後も古いシミュレーションは残る。さらに行の評点/確率表示は結果のmodeではなく編集途中のmodeで切り替わる。派生表示をresultIdにひもづけ、再分析時の無効化と結果modeでの表示を行うこと。

### CJ-R009 [P2] 予測ボタンの結果が表示・保存へ接続されていない

`fullstack/frontend/src/features/models/ConjointPage.tsx:181-187, 286`。
predictConjointの返却predictionIdを破棄するため、予測後に結果・評価・失敗理由を確認できない。保存元も常にfit固定で、予測結果を利用する操作がない。予測状態と結果取得・表示を接続し、保存する場合はそのpredictionIdをsourceに渡すこと。エラーも画面に表示すること。

### CJ-R010 [P2] 必須の設定・結果操作が画面から利用できない

`fullstack/frontend/src/features/models/ConjointPage.tsx:76, 112-121, 171-174, 198-291`。
weightMode=none、ratingEffects=pooled、includeWtp=falseが固定され、ウェイト、回答者固定効果、availability、opt-out、価格/WTPの設定経路がない。仕様にあるこれらの分析をGUIから指定できるようにすること。モデルJSON・タスク診断CSVの出力操作も提供すること。

### CJ-R011 [P2] プロフィールの連動表示が先頭50行に制限される

`fullstack/frontend/src/features/models/ConjointPage.tsx:264-279`。
全件取得しても先頭50行のボタンだけを描画し、後続行を参照・選択する操作がない。仕様§7のプロフィール点の残差/確率からの連動図と中央選択の強調表示もない。報告の「PCP L1/L2 tooltip」を裏付ける実装は当該画面に見当たらない。全対象へのアクセスと中央選択との双方向表示を実装・確認すること。

## 検証と残る受入確認

- レビューアー再実行: `test_150_conjoint.py` 10件、`test_conjoint_api.py` 2件成功。API試験は隔離workspaceで実施した。
- 追加再現: `.temp/review-034-probe.py`。CJ-R001のIndexError、CJ-R002の0件予測、CJ-R003の部分タスク応答、CJ-R005の行数集計を確認した。
- 確認環境: Python 3.12.14、NumPy 2.4.6、SciPy 1.18.0、Polars 1.43.2。報告のPython 3.14.7環境で再実行したものではない。
- 既存12件の成功だけでは、多属性符号化、固定効果の予測、部分タスク予測、保存競合、画面の状態遷移を保証しない。各修正に対応する試験と通常ブラウザの操作証拠が必要。
- R mlogit照合、COM追加試験、通常本番配信経路は報告上未確認。今回それらを実施済みとは扱わない。Pyodide実ブラウザ操作は受入条件に含めない。
- 実装コードの修正・ビルド・巨大な全体テストは実施していない。レビューと再現用一時ファイルのみ作成した。

## 確認版

- api/conjoint.py: `8C606623EA652A964CF3E22A0EB91F7DDC27C1F50F33590EE3BE098CB20DA298`
- algorithms/models/conjoint_encoding.py: `D329E12F542B7AC19A6FF10F643FE9EA5445554CEF95B5489863B935837827D5`
- ConjointPage.tsx: `C530C6B02BAAA8307B30C87DBE0A07A281F1CB6C5D325CCA0490EB9DAE36E30A`

以上11件は未解消。全体の問題なし判定は行わない。
