# Feature 031 FAMD 実装レビュー 003

判定: **F001〜F006は解消。追加指摘F007と受入確認が残るため要修正。**

- 日付: 2026-09-13
- 対象: `REPLY-001.md`、SHA256 `00FB095DDE7FB01C7F14B546FEAFC4006E1C57309B951F91E40194F44229C86F`
- 対象版: 未コミットFAMD実装。ベースHEAD `9cfcea003b132df3ac4b0876af44aed6b5caae20`。
- Pyodide実ブラウザ操作検証は受入対象外。

## 既存指摘

- **F001 解消**: 学習・射影の双方で数値列specを欠損判定へ渡す。隔離APIでage=20欠損指定時にfitCount=23、missing除外1、予測成功23・missing1を確認。
- **F002 解消**: valueLabels単独で観測カテゴリを制限しない。部分ラベルのfixtureはfit24・予測24成功となり、旧422は再現しない。
- **F003 解消**: 相関円へaxisX/axisY/rankを渡し、座標と軸名が同じ軸状態を参照する。rank1の第2軸名抑止も確認。3軸切替・rank1の実操作は報告上未実施であり、今回はコード経路による確認。
- **F004 解消**: relationStrengthを[0,1]スケールで比較する図を確認。数値r²とカテゴリη²を明示し、寄与列と区別している。
- **F005 解消**: 対象scopeを指定した射影API呼出し、ページ取得、行状態・警告の表示を追加。Iris150行の操作報告も受領。ただし下記F007がある。
- **F006 解消**: FAMD分岐のexportヘッダがprobability/barycenterとなり、CA/MCAのmass/principalヘッダを維持することを確認。

## F007 [P1] 射影結果の所属する分析・軸を保持せず、別の結果として表示する

位置: `fullstack/frontend/src/features/models/FamdPage.tsx:99`のdatasetリセット、146行以降のhandlePredict、202行以降の分析成功処理、768行の射影表見出し。

predictRowsは取得時のwantAxesで射影座標を保存するが、表の見出しは現在のaxisXを使う。第1軸で射影後、個体図のX軸を第3軸へ変更して戻ると、coordinates[0]は第1軸のまま「座標 第3軸」と表示される。軸変更時の再取得・消去・取得軸との照合はない。

また、再分析成功時とdataset切替時のリセットでpredictRows/predictInfo/predictWarnings等を消していない。別datasetで分析した後にも、前datasetのrowId・射影値・成功件数が新しい分析カードの射影タブへ残りうる。runSequenceは進行中応答を抑止するが、保存済み表示を無効化しない。これは旧モデルの座標を現在モデルの結果として誤認させる。

修正条件: 射影表示をdatasetId・resultId・取得axes（必要な版情報を含む）と関連付ける。分析/dataset変更で古い射影状態を消すか明確に別結果として隔離し、軸変更時には再取得または取得軸名を維持する。進行中射影が無効化された場合はloadingも解除する。第1→第3軸の切替、再分析、別dataset分析後の表示、遅延応答の順に確認する。

今回はコード経路で確認した指摘であり、レビューアーによる実ブラウザ再現は未実施。

## 検証と残る受入項目

- `.temp/review-031-check.py`: F001/F002の旧再現ケースが期待どおりになった。
- backend FAMD＋MCA＋CAの5ファイル: **37 passed**。
- frontend famd.test.tsx＋mca.test.tsx: **2 passed**（helperテスト）。
- 型検査: **失敗**。今回の出力はLinearRegressionPage.tsxの9エラーで、FAMDファイルのエラーは出力されていない。別機能の作業中状態として記録し、FAMDの修正対象には加えない。
- ビルド・全体テスト・実装変更は行っていない。

カテゴリ点の実ポインタclickは依然報告上未達。FactoMineR oracle比較、本番配信経路の確認も残る。相関円の3軸/rank1操作は既存コード修正を未解消へ戻す理由とはしないが、画面確認の証拠として追加が必要。Pyodideの操作証拠は不要。

## ソースSHA256

- analysis_frame.py: `0C549D687B9B4471238EE5D245B8CBE4206DE1944B36A1146BF55FE8AB3AE364`
- analysis_results.py: `E6FC47A6058E2F2CCD374322DBE457ABDA199BE6E2B391D6AA26B861511DF01A`
- FamdPage.tsx: `89BEE7E06A87BF2B79AA85A196768FB0F5609E89ACAA26E23A6AE9FE1B21D2C7`
- FamdFigure.tsx: `2C1C1BA2BDCDAF8FC3D0F37A1DA6D66A7EB17590159DE4D43D9121A6566EC4A0`
