# Feature 029 実装レビュー 003

判定: **コード指摘R001〜R008はすべて解消。全体の受入判定は未検証項目のため保留。**

- レビュー日: 2026-09-13
- 対象報告: `REPORT.md`
- 報告 SHA256: `09465120798434a609fe956726ee000ba98f13e83ea34f8f52c879cd4a23348c`
- 確認HEAD: `71df4b55287b85229b2a81b3c6eb5584012a675c`
- 比較元: `4a486db6`。前回結果: `REVIEW-002.md`。
- 対象: 残存R001/R008の修正、関連前処理・結果保存・選択経路、既存CAテスト。実装コードの編集なし。

## 指摘の確認結果

### R001 解消

欠損キーが文字列と等値にならないfrozen dataclassへ変更されたことを確認した。以下5種類の通常値について、exclude/include_missing/separate_not_applicableの3方針、計15入力を隔離APIで実行し、通常値2行がcodeを維持して返ることを確認した。

- `__missing__`
- `__not_applicable__`
- `MISSING_SENTINEL __missing__`
- `NOTAPPLICABLE_SENTINEL __not_applicable__`
- `MissingKey(kind=missing)`

include_missingでは真の欠損1行が別カテゴリとなる。exclude/separate_not_applicableでは通常値カテゴリのselect APIも実行し、一致数が2行であることを確認した。従来の通常値の消失・欠損への合算は再現しなかった。

### R008 解消

分割表の使用セル列とscopeから補完マスクを集計し、結果metaとfingerprintへmaskRevisionを渡す経路を確認した。2×2表の使用セル1件にmaskRevision=1を与えた隔離API実行で、`imputedCellCount=1, imputedRowCount=1, maskRevision=1`を確認した。

集計関数の追加確認では、同一行2セル、重複マスク1件、scope外ID、対象外列を与え、結果が2セル/1行/版3となることを確認した。回答者モードの補完件数、欠損行ラベル422、非対応row_idsの422、欠損＋invalidの除外優先順位と行列入替も再確認した。

### R002〜R007

REVIEW-002の修正確認を維持する。今回のコミットは当該frontendやselect/export APIを変更していない。今回再確認したR005〜R007にも回帰はなかった。

## 検証証拠

- `test_100_ca.py`: **6 passed**。`.temp/feature19-venv/Scripts/python.exe`を使用し、TEMP/TMPおよびpytest cacheを`.temp`へ設定した独立プロセスで実行。
- `.temp/review-029-003-check.py`: **exit 0**。前述のAPI入力、選択集合、補完集計をassertで確認。データは`.temp`内の一時workspaceへ隔離した。補完確認はDatasetStore.load_maskの返値を既知のマスクへ差し替えて行った。
- 出力: `.temp/review-029-003-output.json`。
- `git diff 4a486db6 HEAD --check`: **exit 0**。
- フロントコードに今回変更なし。前回レビューの2テスト・型検査・5,001件CSV/JSON確認の結果を引き継ぎ、同じ検査は再実行していない。
- 全体テスト、ビルド、実ブラウザ操作は今回実施していない。

## 残る受入確認

既出のコード指摘はすべて解消しており、今回確認した修正範囲に新たな不具合は見つからなかった。ただし、REPORT.mdには次の未検証が残っている。

1. Pyodideブラウザ実機での操作確認。同一コードのZIP内実行・ASGI実行だけではブラウザ実行環境を含む確認にはならない。
2. `run-production.bat`の起動確認自体。本番相当経路での成功と、起動バッチが使えることの確認は別である。

このため、Feature 029全体について「指摘事項はすべて解消し、レビュー対象範囲に問題はありません」という最終受入の宣言はまだ行わない。上記の実施結果、対象版、操作内容、証拠をREPORT.mdへ追記後に最終確認する。コード指摘の再修正要求はない。
