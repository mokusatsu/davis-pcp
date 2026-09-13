# Feature 031 FAMD 実装レビュー 001

判定: **要修正。6指摘と未完了の受入確認がある。**

- 日付: 2026-09-13
- 対象: `REPORT.md`（SHA256 `2034F2CAED1073724313C34E5709F773F254CB25B94901D7943DCB0B72F349F6`）
- HEAD: `9cfcea003b132df3ac4b0876af44aed6b5caae20`。未コミットFAMD実装と共有基盤への追加を対象とする。
- 照合仕様: `feature/analysis-specs/feature/31_famd.md`、`tasks/DAVIS-FEAT-031-DESIGN.md`、共通分析契約。
- Pyodide実ブラウザ操作検証は受入対象外。

## F001 [P1] 数値列の欠損コードを実測値として学習・射影する

位置: `fullstack/backend/app/domain/analysis_frame.py:920`、`fullstack/backend/app/api/analysis_results.py:1100`付近の数値入力処理。

数値入力は `_numeric_value(raw)` の有限値変換だけを行い、対象列のmissingCodesを照合しない。24行fixtureでage=20を欠損コードとして保存しても、fitCount=24・missing除外0で成功し、再射影も24行成功した。期待は学習23行と該当行の欠損扱い。標準化の平均・分散から座標まで変わるため、解析結果の誤りにつながる。

修正条件: 学習と射影の数値分類に列の欠損定義を適用する。数値コードと文字列表現の正規化を既存規約に合わせ、missingPolicyにかかわらず数値欠損は完全ケースから外す。欠損行を除いた直接計算との一致、予測のmissing状態を確認する。

## F002 [P1] valueLabelsだけで有効カテゴリ領域を閉じる

位置: `fullstack/backend/app/domain/analysis_frame.py:1001`〜1025。

categoryOrderが空の場合にvalueLabelsのキーをdeclaredへ入れ、ラベル未定義の観測値をseenへ追加しない。q1にa/b/cを含む24行fixtureでcategoryOrder=[]、valueLabels={a:A}を保存すると、422 FAMD_CONSTANT_VARIABLEとなった。共通契約ではvalueLabels単独は閉領域の宣言ではなく、3水準を使用すべき。

修正条件: 有効領域の判定と表示ラベルの参照を分離する。categoryOrderに有効値がない場合はラベル未定義の観測カテゴリも採用する。部分的なラベル設定の有無で行数・幾何が変わらないことを確認する。

## F003 [P2] 相関円の軸名が第1・第2軸に固定される

位置: `fullstack/frontend/src/features/models/FamdFigure.tsx:63`〜64、`FamdPage.tsx:528`。

corrPointsはaxisX/effAxisYで相関配列を参照するが、CorrelationCircleの軸名は固定文字列。個体図で第3軸等へ変更して相関円へ移ると、第3軸の相関を第1軸と表示する。rank1でも存在しない第2軸を表示する。

修正条件: 選択軸とrankを相関円へ渡し、実際の相関と軸名を一致させる。3軸以上の切替とrank1を確認する。

## F004 [P2] 変数と軸の関係図が未実装

位置: `fullstack/frontend/src/features/models/FamdPage.tsx:533`以降のrelationタブ。

数値r²・カテゴリη²を数値表に示すのみで、仕様31の第4節と詳細設計第6節が要求する各軸[0,1]の関係図がない。表の寄与列と区別する説明はあるが、要求された図による変数間比較はできない。

修正条件: relationStrengthを選択軸の[0,1]で表示する図を追加し、r²/η²の意味を区別する。contributionを座標として流用しない。

## F005 [P2] 新規行の射影操作が画面にない

位置: `fullstack/frontend/src/features/models/FamdPage.tsx:609`以降の保存・出力タブ。

画面はfit座標の保存とexportのみで、predict APIの呼出し、対象範囲の指定、成功/未計算理由の表示がない。仕様31第5節の新規行射影はAPIでは実装されているが画面から利用できない。末尾の「予測はできません」というstale文言は通常時の射影操作の代わりにはならない。

修正条件: 学習済み結果に対する対象行の射影、行状態・外挿警告の確認を画面から利用できるようにする。学習時の標準化を固定する既存APIを使い、再学習操作と区別する。

## F006 [P2] カテゴリexportでFAMDの量をCAの列名へ置き換える

位置: `fullstack/backend/app/api/analysis_results.py:792`〜804。

FAMDのprobabilityをmass列、barycenterCoordinatesをprincipal1等の列へ出力する。詳細設計第4節はカテゴリ確率をmassへ省略してMCAのp/mと混同しないことを明記している。表を単独で保存すると確率と重心という規約が失われる。

修正条件: FAMDのカテゴリCSV/JSONではprobabilityと重心を明示した列名を使用する。既存CA/MCAの出力契約を変えず、数値と列の意味が一致することを確認する。

## 検証

- backend `test_120_famd.py`＋`test_121_famd_api.py`: **13 passed**。
- frontend `famd.test.tsx`＋`mca.test.tsx`: **2 passed / 2 files**。いずれも今回実行したテストは軸ラベルhelperの確認であり、画面操作の証拠ではない。
- `tsc --noEmit -p fullstack/frontend/tsconfig.json`: **成功**。過去のビルド報告にあった未使用変数エラーは現在の型検査では再現しない。ビルド成功を意味しない。
- `.temp/review-031-check.py`: 独立した一時データセットでF001/F002をAPI再現。実データは使用していない。
- kernelの標準化、全慣性、重心、寄与・η²、固定射影の実装を設計式と照合した。今回の既存テストで失敗はない。
- 実装コードの修正、ビルド、全体テスト、実ブラウザ操作は実施していない。

FactoMineR oracle比較、Pyodide以外の画面操作と本番経路の確認は報告上未完了。修正後は対象の回帰と、実行・選択連動・保存・stale・KeepAlive・出力等の操作証拠を追加する必要がある。

## 確認したファイルのSHA256

- analysis_frame.py: `AB217A66495107FF2CE55EAD39461999B876BF669923A8246F3D9E46F41D5481`
- analysis_results.py: `4CC7C161076D77D00744C87187C9BB437D6974DAF88FFCD212ADEB68B8D7FD2F`
- famd.py（kernel）: `FC2FC22F16C454CCDFEB18BED40A4F03CF5DAECB5601071692457928302FEC35`
- FamdPage.tsx: `19A5F9689C432CA13D2063BC016AF0311DA6A23BB3121DA4123616CD9BA75CF5`
- FamdFigure.tsx: `74D2C791771D5CC30AD5DC7F9F279F579366D6A6FAFCD57EB96E3E1ACEF5E174`
