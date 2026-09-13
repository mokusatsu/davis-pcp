# Feature 030 実装レビュー 001

判定: **要修正（8件）／受入未完了**

- 日付: 2026-09-13
- 対象報告: `REVIEW_REQUEST.md`
- 報告SHA256: `6e7c8966b104f1acc61cb3d89cc207f765e71faaaf222922f0f79425e0dbec4c`
- HEAD: `4dda1a02bb1954bd1c48c4d93c2db00258a5bafa`。MCA実装は未コミットのtracked変更・新規ファイルを対象とする。
- 確認範囲: MCA詳細設計・受入記録、kernel/API、共有前処理・結果操作、MCA画面・図、既存MCA/CAテスト。実装コードの編集なし。

## 指摘

### M001 [P1] 欠損カテゴリを含む学習行の再射影が失敗する

位置: `fullstack/backend/app/api/analysis_results.py:288-380`。

_mca_predictは学習時のmissingPolicy・MA親判定を使わず、raw値を通常カテゴリcodeへ直接照合している。missing/not_applicableカテゴリは明示的に照合対象外とし、raw=Noneを常にmissing失敗へ落とす。

隔離APIでinclude_missingを指定した7行を学習するとfitCount=7だが、その同じ7行のpredictはsuccessfulPredictions=6、missing=1となった。学習行では保存座標と再射影が一致するという仕様を満たさない。MAの場合も、未採用子を含む親全体判定を経ない点を修正範囲に含めること。

修正条件: 学習時の分類方針・固定カテゴリ順で射影入力を作る。欠損3方針・missingCodes・NA・MA親の状態について、学習行の再射影と保存Fの一致、真に未知のカテゴリの失敗状態を検証する。

### M002 [P1] materializeの冪等性判定が保存元とscopeを比較しない

位置: `fullstack/backend/app/api/analysis_results.py:463-477`。

payload_normにはcolumnsのsourceField/name/labelしか含めていない。同じkey/result/columnsでsourceや書込scopeを変えても成功再送となり、異なる要求を取り違える。

隔離APIでsource=fitの保存成功後、同一key・列指定のままsourceを実在predictionIdへ変更したところ、HTTP200・idempotentReplay=true・source=fitを返した。期待値は異なる実質payloadに対する409 conflict。

修正条件: 冪等性の比較にsource、保存内容を変えるscope/行集合なども含める。再送時だけ変わり得る版情報と、意味が異なるpayloadを区別する。source変更・scope変更と完全同一再送を別々に確認する。

### M003 [P1] materializeの版確認が書込ロック取得より前にしかない

位置: `fullstack/backend/app/api/analysis_results.py:455-481,504-560`。

stale/check_revisionsをロック外で済ませ、ロック内では現在meta/codebookを読むものの版比較をしない。その間に他操作がデータ版を進めると、古いモデルの座標を更新後データへ書き込める。commit_data_changeも現在版を+1する処理であり、期待版との比較を代行しない。

修正条件: 書込ロック内で現版とモデル版・要求版を再照合し、異なる場合は副作用なしの409とする。冪等性確認も並行再送時の競合を含め同じロック境界で検討する。この指摘はコード経路確認によるもので、今回競合実行の再現は未実施。

### M004 [P1] 派生列保存後に中央データ・コードブックを更新しない

位置: `fullstack/frontend/src/features/models/MultipleCorrespondencePage.tsx:550-563`。

materialize成功後はmessage.successだけで、応答のdata/schema revisionを中央storeへ反映せず、新列を含むコードブック・Tableデータの再取得もない。useCodebookはRedux値を参照するため、このままのbuildContextは旧版を送り、保存後の再実行が409となる。10秒ポーリングはローカルなliveRevisionsを変えるだけで中央stateを更新しない。

修正条件: 既存のデータ変更通知・再取得の仕組みに接続し、Tableへの新列表示、中央版更新、同一datasetでの再分析、他ページの再取得まで実ブラウザで確認する。dataset切替や既存selectionを不要にリセットしない。

### M005 [P2] カテゴリ図の矩形が個体座標を検索している

位置: `fullstack/frontend/src/features/models/MultipleCorrespondencePage.tsx:460-462`、`fullstack/backend/app/api/analysis_results.py:170-188`。

カテゴリ図のonBrushも個体図と同じrectangle selectorへ送信するが、APIはarrays['f']（個体座標）を検索する。カテゴリ点を囲んでも、そのカテゴリに属する回答者を選ぶ操作にならず、同じ数値範囲に偶然入る個体を選択する。

修正条件: 囲まれたカテゴリIDを図上で解決してcategories selectorへ渡し、変数内OR・変数間AND/ORを適用する。個体図の矩形検索は個体座標のままとする。両図で同じfixtureの選択ID集合を確認する。

### M006 [P2] 軸切替と図のラベル・重ね合わせが一致しない

位置: `fullstack/frontend/src/features/models/McaFigure.tsx:147-151,161-170`、`MultipleCorrespondencePage.tsx:160,287,430-434`。

個体rowsはaxisX/axisYで取得する一方、図の軸名・慣性比は常に第1/第2軸で、categoryPointsも常にprincipalCoordinates[0]/[1]を使う。3軸以上の結果で個体軸を変えると、図ラベルとカテゴリ重ね合わせが別軸を表す。同一X/Y軸も選べるため、取得は1列・図はrank>=2のままとなり、矩形では重複軸を送る。

修正条件: 実際の表示軸を図へ渡し、座標・軸名・寄与率・選択を統一する。同一軸指定を防ぐか、明示した1次元表示にする。rank>=3での切替と重ね合わせを確認する。

### M007 [P2] カテゴリexportの質量が全件nullになる

位置: `fullstack/backend/app/api/analysis_results.py:651-666`、`fullstack/backend/app/api/mca.py:182-188`。

MCA結果はcategoryMassを持つが、共通カテゴリexportはe.get('mass')を使用する。隔離APIで実際のcategoryMassが0.2142857など正数の5カテゴリを出力したところ、JSONのmass列は5件すべてnullだった。CSVにも同じ欠落が生じる。

修正条件: MCAカテゴリの項目名を結果契約に合わせて出力する。質量・確率・人数・座標・寄与・cos2など提供する項目と結果の数値が一致することを検証し、CA側の既存出力を維持する。

### M008 [P2] 行取得失敗時に前回の個体座標を新しい結果として表示できる

位置: `fullstack/frontend/src/features/models/MultipleCorrespondencePage.tsx:150-178`。

結果または軸変更でrowsの全ページ再取得を始めるが、既存rowsを無効化せず、catchもエラーを表示しない。新しい結果の取得が失敗すると、見出しや選択先は新resultIdなのに描画は前回rowsのまま残る。軸変更時の失敗でも旧座標が残り、別軸として矩形選択へ送られる。

修正条件: 個体座標とそれを生成したresultId/axesを一体管理し、取得中・失敗を表示する。古い図を保持する場合は旧結果と明示し、その図と異なるresultId/axesへの選択を許さない。

## 検証

- backend対象: test_110_mca.py、test_111_mca_api.py、test_100_ca.py → **19 passed**。
- frontend対象: mca.test.tsx、correspondence.test.tsx → **3 passed / 2 files**。
- `.temp/review-030-check.py` → **exit 0**。一時workspaceのTestClientでM001、M002、M007の症状を確認するassertを実行した。exit 0は不具合の再現成功を意味する。
- その他の指摘はコード経路の確認。今回の実ポインタ操作、競合実行、本番起動、ビルド、static実機、全体テストは未実施。
- 報告にもMCA11未検証、MCA12部分達成、個体ブラシ選択数不変、相互ハイライト・保存後Table・static実機の未確認が残る。これらも最終受入前に解消・検証すること。既知の個体ブラシ不成立については今回原因を確定していない。

## 確認した主要ファイルのSHA256

未コミット実装の識別用。HEADだけを検証済み実装の識別子として扱わない。

| ファイル | SHA256 |
|---|---|
| backend/app/api/analysis_results.py | 6f837c12ca84403a0c30a23d16e86ad6e05d6948767fa2206bd487967a0ef6bd |
| backend/app/api/mca.py | 995c88ffe534f9bc46ac3420de7b0c9cda890bab524bf2838c57cd15d3485ddb |
| backend/app/domain/analysis_frame.py | d9d4a1565366b47ed69c0b24fa63b93fcc9567e61b30e2d329b2706ea783e280 |
| frontend/src/features/models/MultipleCorrespondencePage.tsx | 57a4704e9ac2af4141ef4475ad18bf2b935c12f9de9273c87d90647791374849 |
| frontend/src/features/models/McaFigure.tsx | c0b6f31ce247c4a6090fee65233dfd0585c019735750d3ae323091da626b42ba |

パスはfullstack/配下。新たな完了報告では指摘別の修正と検証、未確認の受入項目、対象差分を明示すること。現時点では問題なしと判定しない。
