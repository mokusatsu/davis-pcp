# Feature 030 実装レビュー 002

判定: **要修正（8件中6件の修正を確認、M001・M008が残存）**

- 日付: 2026-09-13
- 対象: `REVIEW-001-REPLY.md`、M001〜M008の関連実装
- 報告SHA256: `43f1770bbba0234e1b6e97e4f1732ab0d4aa7ae1263445dd61fb8d07bc704757`
- HEAD: `9cfcea00`。MCA実装は未コミットworking treeを確認。
- Pyodide実ブラウザ操作は受入対象外。未実施を理由に保留しない。

確認した未コミット主要ファイルのSHA256:

- fullstack/backend/app/api/analysis_results.py: `1682723d9c6eb5384d928598ef9432a2865964878aba2565da17ea93561e40ad`
- fullstack/frontend/src/features/models/MultipleCorrespondencePage.tsx: `7a050d819890f06a0cb62c3ab6d779a3d8356da78988fde7d5254b31cbd12633`
- fullstack/frontend/src/features/models/McaFigure.tsx: `4313f1b68b32ac84232b6bc52af430f7e1623c5310ab6b6e89fd036c147cdac5`

## 指摘別の確認

| 指摘 | 判定 | 根拠 |
|---|---|---|
| M001 学習行再射影 | 一部修正・残存 | 通常変数のinclude_missing再射影テストは合格。MAのvalid経路で6行すべて失敗を再現 |
| M002 冪等性 | 修正確認 | source・columns・scopeの比較を確認。source変更409、同一再送200の追加テスト合格 |
| M003 書込版確認 | 修正確認 | 書込ロック内でモデル版と要求版を現在版に再照合する処理を確認。競合実行の独立検証は今回なし |
| M004 保存後の中央更新 | 修正確認 | cache破棄・datasetValuesUpdated・fetchCodebookThunkを確認。Table表示の実ブラウザ報告あり |
| M005 カテゴリ矩形 | 修正確認 | 図上のカテゴリ座標からカテゴリIDへ解決し、categories selectorへ渡す経路を確認。カテゴリ・個体の矩形選択成功報告あり |
| M006 表示軸 | 修正確認 | 個体・カテゴリの表示座標、図ラベル、慣性比、ブラシ軸がaxisX/effAxisYへ統一されたことを確認。データ取得中の整合はM008参照 |
| M007 export質量 | 修正確認 | categoryMass参照と結果一致の追加テスト合格 |
| M008 行取得状態 | 一部修正・残存 | loading/error/rowsMetaを追加したが、選択時にaxesの一致を確認していない |

## M001 [P1] MAのvalid分岐でindicatorの1を設定していない

位置: `fullstack/backend/app/api/analysis_results.py:400-441`。

validの場合はカテゴリのhitを探すだけで、`row[...] = 1.0`がない。missing/notApplicable分岐には代入がある。valid分岐もcol_pos更新後にcontinueするため、MA変数のブロックがすべて0となり、末尾のrow.sum()==m判定でmissingへ落ちる。

隔離API再現: MA子x/yと通常変数qを6行作成。全行がMA親valid、採用変数はx/q、maMode=explicit_binary_options。学習はfitCount=6で成功するが、同じ6行のpredictはsuccessfulPredictions=0、missing=6となった。

修正条件: validの該当カテゴリへ1を立てること。通常変数の欠損だけでなく、MAのvalid・missing・notApplicable・invalidを含む再射影と保存F一致を回帰テストへ追加する。親全体の判定も維持する。

## M008 [P2] 軸変更時には取得前・失敗後も旧座標から新軸の選択を送れる

位置: `fullstack/frontend/src/features/models/MultipleCorrespondencePage.tsx:428-449`。

警告表示ではrowsMeta.axesを現在の表示軸と比較しているが、onToggle/onBrushのガードはresultIdだけ。同じ結果でaxisX/axisYを変更した場合、resultIdは変わらないのでガードを通る。旧rowsを表示したまま、ブラシ範囲を新axisX/effAxisYとしてAPIへ送り、別の個体集合を選択できる。行取得が失敗しても同じ状態が続く。

修正条件: 選択の可否をresultId・axesの一致と取得状態で共通判定し、警告だけで済ませない。3軸以上の結果で軸変更後のrows応答を遅延／失敗させ、応答完了までselect APIが呼ばれず、成功後は表示座標と同じ軸で呼ばれることを確認する。この残存指摘はコード経路の確認によるもので、今回の実ブラウザ遅延再現は未実施。

## 検証と残る受入項目

- backend対象: test_110_mca.py（9件）＋test_111_mca_api.py（8件）＋test_100_ca.py（6件）→ **23 passed**。
- frontend対象: mca.test.tsx＋correspondence.test.tsx → **3 passed / 2 files**。
- `.temp/review-030-002-ma.py` → **exit 0**。独立した一時workspaceのTestClientで、MA学習6行・再射影成功0行という残存症状をassertで確認。exit 0は全指摘解消を意味しない。
- コード修正、ビルド、全体テスト、実ブラウザ操作は今回実施していない。既存コードの変更や別作業の状態は保全した。
- 報告の全体FEテスト2件失敗について、単独合格だけでは全体実行時の原因やMCA変更との無関係を確定できない。失敗内容・変更前の比較または原因の証拠が必要。許容差や期待値を根拠なく変更しないこと。
- MCA11の列名変更の確認、他ビュー→MCA強調の実ブラウザ確認、現在実装をrun-production経路で確認できることの証拠は引き続き必要。列名変更は自動化の有無だけでなく、不変性を検証した結果が必要。
- Pyodide実ブラウザ検証は不要。追加ビルドの実施はこのレビューでは要求・許可していない。

M001・M008の修正と上記の未確認事項を報告へ追記後、再レビューする。現時点では問題なしと判定しない。
