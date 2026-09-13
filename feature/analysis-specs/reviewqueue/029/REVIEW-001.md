# Feature 029 実装レビュー 001

判定: **要修正（未解決8件）**

- レビュー日: 2026-09-13
- 対象報告: `REPORT.md`
- 報告 SHA256: `57d7c93056efe7f6258604fc1f5416674686724b499ca762890b262e4c611059`
- 確認HEAD: `00ea83bd010d16f577194b19fef132986a3b9e3a`
- 対象: Feature 029仕様、共通分析契約、029詳細設計、実装・受入記録、CA kernel、前処理、入力契約、結果保存・選択・export API、CA画面と既存CAテスト。
- 実装対象コードに未コミット差分なし。既存の別作業の変更はレビュー対象外。

## 指摘

### R001 [P1] 通常カテゴリ値が欠損用の内部コードと衝突する

位置: `fullstack/backend/app/domain/analysis_frame.py:266-279`、`fullstack/backend/app/api/correspondence.py:90-102`

`_classify_category` は通常値 `__missing__` / `__not_applicable__` を value と判定できるが、catalog生成時に文字列だけで欠損と識別し直している。categoryOrder/valueLabelsのない開いた領域では、exclude時にこの通常値をcatalogから落とすため、他に2カテゴリ以上ある入力では `ri[rc]` が KeyError になる。include_missing時には本当の欠損と通常値が同じカテゴリへ合算され、表・座標・選択集合を変えてしまう。`__a` のID修正だけでは解消していない。

修正条件: kindと通常codeを衝突しない内部キーで保持する。上記2文字列を通常値として含む入力について、exclude/include_missing/separate_not_applicableで欠損と分離され、通常値が消失しないことを確認する。

### R002 [P1] ページ付きexportの先頭5,000件しか使っていない

位置: `fullstack/frontend/src/features/models/CorrespondenceAnalysisPage.tsx:231-245`、`fullstack/frontend/src/features/models/caExport.ts:23-28`。契約: `fullstack/backend/app/domain/analysis_contracts.py:121`、API: `fullstack/backend/app/api/analysis_results.py:184-193,227-250`。

APIは既定limit=5,000とnextOffsetを返すが、中央selectionの強調もダウンロードも1回の応答で終了する。回答者モードは1回答者につき行・列の2つのmembershipを持つため、2,500回答者を超えると全membershipを取得できなくなる。先頭ページに入らない側・回答者の選択が強調されない。分割表も例えば100×100セルでは10,000件のうち5,000件だけを完成したCSV/JSONとして保存する。

修正条件: nextOffsetがなくなるまで取得し、CSVヘッダ重複を除き、JSONを正しく統合する。中央連動には全件取得または選択IDに限定した完全な照合を用いる。複数ページで総件数・末尾の値と両側の強調を確認する。

### R003 [P1] 選択応答の採用時にデータ版・スキーマ版を再確認しない

位置: `fullstack/frontend/src/features/models/CorrespondenceAnalysisPage.tsx:199-208`

handleRunにはrefを使った版確認が追加されたが、handleSelectは世代とクロージャ内のdatasetIdしか見ていない。選択APIが旧版で成功した後、応答が到着するまでに同一datasetのデータまたはschemaが更新されても、runSequenceは版変更では進まず、旧カテゴリ集合をselectionAppliedへ渡す。`datasetId !== startedDataset` は同一クロージャの値同士であり、この確認を代替しない。

修正条件: 選択開始時のdata/schema revisionを保存し、応答採用時に最新refと比較する。遅延した成功応答の到着前に同一datasetの版を変更し、中央selectionが書き換わらないことを検証する。

### R004 [P2] 表示済み結果が版変更後もcurrentのままになる

位置: `fullstack/frontend/src/features/models/CorrespondenceAnalysisPage.tsx:73-88,372-375`

POST応答のresultState=currentをそのまま保持し、GETで再取得も、現在版との比較によるstale更新もしていない。data/schema revision変更はdirty警告にはなるが、stale表示は現れず、選択ボタンも有効なまま。API側が既に古い結果を409で拒否する場合でも、共通契約の「古い版であることを表示」「選択の適用を禁止」を画面で満たしていない。

修正条件: 結果の版と現在版からstaleを導出し、閲覧/exportを保持したまま選択適用を無効化する。KeepAlive中の版変更でも確認する。

### R005 [P2] 分割表の行ラベルに定義済み欠損コードを許している

位置: `fullstack/backend/app/api/correspondence.py:177-187`

行ラベルはnormalize_code後のNoneと重複しか検査しない。例えば行ラベルのmissingCodesに `99` を定義しても、実値99は有効なカテゴリとして計算に含まれる。セル側のmissingCodes対応はあるが、行ラベルには適用されていない。029詳細設計では欠損行ラベルは除外ではなく422。

修正条件: label_spec.missingCodesも判定し、該当行IDを含めCA_TABLE_INVALIDを返す。Noneとコードブック欠損の両方を検証する。

### R006 [P2] 非対応のrow_ids selectorが分析対象外の行を選択できる

位置: `fullstack/backend/app/api/analysis_results.py:83-85,122-127`

CAのcapabilities.selectionKindsはcategoriesだけだが、row_idsを受理している。この分岐はpoolにfit側のmembershipを読むものの、wantedとの積集合を取らず、最終的にwantedと現在scopeだけを交差させる。そのため一部行でCAを実行後、scope=allでfit外の実在IDをrow_ids指定すると、そのIDをCA結果の選択として返す。matchedCount/fitMatchedCountも要求IDとの一致数ではなくpool全体の数になる。

修正条件: CAで未対応のselectorをcapabilitiesに従って422拒否する。対応させる場合は別途仕様を満たすfit集合との交差と件数定義が必要。カテゴリ選択の既存AND/ORも回帰確認する。

### R007 [P2] 除外理由の優先順位が入力列順に依存する

位置: `fullstack/backend/app/domain/analysis_frame.py:205-214`

最初に見つかった非ok理由だけを保存している。行変数が欠損、列変数が閉じた領域外invalidである同一回答者はmissingに数えられ、変数を入れ替えるとinvalidに変わる。共通契約のinvalid→missing→missing_weight→zero_weightの優先順位を満たさず、除外診断が転置で変化する。

修正条件: 全入力列の分類を集めた後、定義された優先順位で行の理由を決定する。上記の複合条件と行列入替で内訳が一致することを検証する。

### R008 [P2] 補完済みセルを使用しても補完件数が常に0になる

位置: `fullstack/backend/app/api/correspondence.py:408-410`、`fullstack/backend/app/services/analysis_service.py:74-75,111-112`、`fullstack/backend/app/domain/analysis_frame.py:287-297`

前処理はmaskRevisionのみ取得し、対象scope・使用列・fit行について補完マスクの使用件数を算出していない。build_meta呼出もimputedCellCount/imputedRowCountを渡さないため、補完値を計算に使用していても既定値0を返す。共通契約のuse_current_valuesは、使用した補完セル・行件数を返すことまで含む。

修正条件: 実際に使用した補完セル数と重複を除いた行数をマスクから算出しmetaへ渡す。対象列外・scope外・fit除外行を数えないことも確認する。

## 検証と確認範囲

- 実行: `npm.cmd test -- --run tests/correspondence.test.tsx`（fullstack/frontend）。**2 passed / 1 file**。
- この2件は座標変換と軸ラベルの純粋関数テストであり、画面の非同期応答、ページング、中央selectionを実行しない。
- backendのtest_100_ca.py再実行を試みたが、確認した同梱Pythonおよびuvが解決した既存Pythonにはpytestがなく、テスト開始前に停止。依存の追加は実施していない。報告の6 passed/473 passedを本レビューで再現したとは扱わない。
- 上記8件は仕様とコード経路の照合による指摘。記載した入力条件のAPI実行、遅延応答の画面再現は今回未実施。修正後の検証条件として明示した。
- CA基本式、全慣性分母、rank1、survey/massの参考p値抑止、回答者と表レコードの件数区別、カテゴリAND/OR、保存前の版再確認、所有dataset確認、CSV式対策、GET結果復元の実装を確認した。これらの全条件を実機再検証したという意味ではない。
- ビルド、全体テスト、run-production.bat起動、Pyodideブラウザ操作は実施していない。報告にもrun-production.bat起動自体とPyodide実機操作の未検証が残るため、local/static全操作の受入完了は確認できない。

## 再レビュー条件

R001〜R008の対応コミット、対象条件の再現・検証結果をREPORT.mdに追記すること。既存の16件に加え、特にカテゴリID衝突と古い応答対策には上記の残存経路がある。未解決指摘および未確認の受入項目が残るため、現時点では「問題なし」と判定しない。
