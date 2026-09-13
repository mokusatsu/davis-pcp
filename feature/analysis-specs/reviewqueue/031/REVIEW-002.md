# Feature 031 FAMD 実装レビュー 002

判定: **要修正。F001〜F006は未解消。画面操作の証拠を追加受領。**

- 日付: 2026-09-13
- 対象: 更新された `REPORT.md`
- 報告SHA256: `89E8B00046B8DF3C6C36E1E3E152792E47A12EEB56FBA709EDE1820AD4AEF99B`
- HEAD: `9cfcea003b132df3ac4b0876af44aed6b5caae20`。未コミット実装を含む。

## 既存指摘の確認

- **F001 未解消**: `.temp/review-031-check.py`を独立一時データセットで再実行。age=20をmissingCodesへ指定してもfitCount=24・missing除外0、予測成功24行のまま。
- **F002 未解消**: 同スクリプトでcategoryOrder=[]、valueLabels={a:A}、観測値a/b/cを再確認。422 FAMD_CONSTANT_VARIABLEを引き続き再現。
- **F003 未解消**: FamdFigure.tsxは前回と同じハッシュで、相関円の軸名固定は未変更。
- **F004 未解消**: FamdPage.tsxは前回と同じハッシュ。追加画像 `.temp/famd-verify-relation.png` を目視し、関係強度の数値表のみで、要求された[0,1]の関係図がないことも確認した。
- **F005 未解消**: 同画面ファイルは未変更で、射影操作の追加はない。
- **F006 未解消**: analysis_results.pyは前回と同じハッシュで、FAMDカテゴリexportのmass/principal列名は未変更。

修正条件・重要度・根拠はREVIEW-001を維持する。

## 追加の操作証拠

Iris 150行での実行、個体矩形による35行選択、FAMD1保存とstale、KeepAlive、dataset切替、exportの確認報告を受領した。列挙された画像ファイルの存在を確認し、変数関係の画像を目視した。他の操作は実装者の報告として扱い、レビューアーが再操作したとは記録しない。

カテゴリ点の実ポインタclickは報告上未達。JS合成clickの成功だけでは通常操作の受入を満たさない。ブラシガードが原因との記述は今回独立確認していないため、確定した原因とは扱わない。実ポインタでの点選択、原行への解決、中央選択の反映を確認する残項目として維持する。

FactoMineR oracle比較と本番配信経路の確認も未完了。Pyodide実ブラウザ操作検証は対象外であり、追加要求しない。

## 確認した版と検証範囲

- analysis_frame.py SHA256: `EF1A5C58A01703BA8FB90B41BE6E38B67CB2AC49D1C9515347CB2FC91719B631`
- analysis_results.py SHA256: `4CC7C161076D77D00744C87187C9BB437D6974DAF88FFCD212ADEB68B8D7FD2F`
- FamdPage.tsx SHA256: `19A5F9689C432CA13D2063BC016AF0311DA6A23BB3121DA4123616CD9BA75CF5`
- FamdFigure.tsx SHA256: `74D2C791771D5CC30AD5DC7F9F279F579366D6A6FAFCD57EB96E3E1ACEF5E174`

今回は報告・ファイル識別・画像・F001/F002再現を確認した。既存テスト群・ビルドは再実行せず、実装コードは変更していない。全指摘解消には至っていないため「問題なし」は宣言しない。
