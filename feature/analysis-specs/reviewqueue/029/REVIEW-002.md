# Feature 029 実装レビュー 002

判定: **要修正（前回8件中6件の修正を確認、2件残存）**

- レビュー日: 2026-09-13
- 対象: `REPORT.md`、`REVIEW-001.md`のR001〜R008
- 報告 SHA256: `a50e8f7cf830aa66743d523f1b9c07f4c0fa134e62be6fbf7474db9eaa83dcff`
- 確認HEAD: `4a486db6`。比較元: `00ea83bd`。
- 確認範囲: 当該コミットのbackend/frontend変更、既存CAテスト、前回指摘の関連経路。実装コードは変更していない。

## 前回指摘の判定

| 指摘 | 判定 | 確認内容 |
|---|---|---|
| R001 通常値と欠損の衝突 | 未解消 | 衝突する文字列が変わっただけで、同じ問題をAPIで再現 |
| R002 ページング | 修正確認 | 中央連動のnextOffsetループを確認。実際のcaExport.tsを変換・実行し、模擬APIの5,001件をCSV/JSONの2ページから統合、末尾値・ヘッダを確認 |
| R003 選択応答の版確認 | 修正確認 | handleSelectの成功・失敗応答に最新dataset/data/schema refとの比較を確認。遅延応答のブラウザ操作は今回未実施 |
| R004 stale表示・選択無効化 | 修正確認 | 現在store版との比較、サーバ版取得、警告・ボタン無効化を確認。報告の実ブラウザ証拠あり。今回の実ブラウザ再操作は未実施 |
| R005 行ラベル欠損 | 修正確認 | missingCodes=R1の分割表をAPIへ渡し422 CA_TABLE_INVALIDを確認 |
| R006 row_ids拒否 | 修正確認 | CA結果へrow_idsを渡し422 ANALYSIS_SELECTOR_UNSUPPORTEDを確認 |
| R007 除外優先順位 | 修正確認 | 同一回答者の欠損＋invalidで、行列入替の両方がinvalid=1、missing=0となることをAPIで確認 |
| R008 補完件数 | 一部修正・残存 | 回答者モードでは重複セル・fit除外行・対象外列を除き1セル/1行を確認。分割表は0/nullのまま |

## 残存指摘

### R001 [P1] 固定文字列の変更では通常値との衝突を解消できない

位置: `fullstack/backend/app/domain/analysis_frame.py:26-27`、catalog生成時のMISSING_M/MISSING_NA判定。

内部キーを `MISSING_SENTINEL __missing__` / `NOTAPPLICABLE_SENTINEL __not_applicable__` へ変更しているが、通常値も任意の文字列を取れるため、この文字列に一致する値で再び衝突する。

API再現: brand/needの7行を作成し、brandに通常値 `MISSING_SENTINEL __missing__` を2行、真の欠損を1行、A/Bを各2行入れ、include_missingでCA実行。HTTP200だが、通常値2行が欠損に合算され、`code=null, kind=missing, physicalCount=3` となった。通常値カテゴリは返らない。もう一方の内部文字列では通常値2行がkind=not_applicableへ変わった。

修正条件: 固定の別文字列へ再変更するのではなく、通常codeとkindを区別する衝突不能なキーを使用する。通常値はcodeを保ち、真の欠損とは異なるカテゴリ・membershipになること。両内部文字列、従来の`__missing__`/`__not_applicable__`、実際の欠損を混在させて確認する。

### R008 [P2] 分割表モードの補完セル・行数とmaskRevisionが欠落する

位置: `fullstack/backend/app/api/correspondence.py` の `_run_contingency`、`_publish` のframeなし分岐とtable_recordのbuild_meta呼出。

今回の補完集計はprepare_category_frameを通る回答者モードだけに追加されている。分割表はその経路を通らず、mask_rev=None、imputedCellCount/imputedRowCountの既定値0を維持する。

API再現: 2×2表 `[[30,10],[10,30]]` の使用セルC1/先頭行に補完マスク1件、maskRevision=1を用意。DatasetStore.load_maskをそのマスクへ差し替えた隔離API実行ではHTTP200となるが、metaは `maskRevision=null, imputedCellCount=0, imputedRowCount=0`。同じマスク取得方法を使う回答者モードの確認では正しく件数が増える。

修正条件: 分割表でも使用した入力セルとscopeに対応する補完マスク・版を取得し、補完件数を返す。対象外の行・列を数えず、同一行の複数セルをセル数と行数で区別する。共通契約のuse_current_valuesを両モードで満たすこと。

## 今回の検証

- backend: `.temp/feature19-venv/Scripts/python.exe -m pytest fullstack/backend/tests/stats_tests/test_100_ca.py -q -o cache_dir=.temp/review-029-pytest` → **6 passed**。一時領域を`.temp`へ設定した独立プロセスで実行。
- frontend: `npm.cmd test -- --run tests/correspondence.test.tsx` → **2 passed / 1 file**。
- 型検査: `npx.cmd tsc --noEmit` → **exit 0**。
- 隔離API確認: `.temp/review-029-002-check.py` → **exit 0**。R001・R008の残存症状、およびR005・R006・R007・回答者補完集計の修正を確認。このスクリプトの一部assertは残存症状を確認するためのものであり、exit 0は全指摘解消を意味しない。
- export確認: `node .temp/review-029-002-export.cjs` → **exit 0**。実際のcaExport.tsをTypeScript変換して実行。模擬API・ダウンロード先を用い、JSONは5,001行と末尾5000、CSVはヘッダ1件＋5,001行と末尾5000を確認。
- 回帰テストファイル自体は今回コミットで追加・変更されておらず、既存6件/2件のみでは上記境界条件を保証しない。
- 全体テスト、ビルド、run-production.bat起動、Pyodide実ブラウザ操作は今回未実施。報告にも後者2項目の未検証が残る。

## 再レビュー条件

R001・R008の修正と対象条件の検証証拠を報告へ追記すること。local/staticの未確認項目も明示したまま管理する。現時点では全指摘解消・受入完了とは判定しない。
