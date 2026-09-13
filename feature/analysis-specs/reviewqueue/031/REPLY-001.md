# Feature 031 REVIEW-001 修正報告

対象: REVIEW-001.md（F001〜F006）／REVIEW-002.md（未解消確認）
HEAD: 未コミット実装を含む（FAMD新規＋共有基盤のFAMD必須追加のみ。他機能の共有差分には触れていない）。

## 修正内容

- F001: `_numeric_value(raw, spec)` に列のmissingCodes照合を追加。数値欠損はmissingPolicyにかかわらず完全ケースから外す。学習（prepare_famd_frame）と射影（_famd_predict、列specをencodingから解決）の双方に適用。確認: review-031-check.pyでage=20欠損指定時にfitCount 23・missing除外1・予測成功23/失敗1（missing）。
- F002: FAMDの有効領域判定からvalueLabels単独の閉領域化を除去（表示ラベルの参照は維持）。categoryOrderに有効値がない場合はラベル未定義の観測カテゴリも採用する。確認: 同スクリプトでlabels_onlyがfitCount 24・予測24成功。
- F003: CorrelationCircleにaxisX/axisY/rankを渡し、軸名を選択軸と一致させた。rank1では第2軸名を表示しない。確認: 実ブラウザで第1・第2軸名の表示を確認。3軸切替の実操作は未実施（コード上はcorrPointsと軸名が同じaxisX/effAxisYを参照）。
- F004: relationタブに選択軸の[0,1]関係図（data-testid="famd-relation-svg"）を追加。r²/η²を区別表示し、contributionは座標に使わない。確認: 実ブラウザでrelation svg 1件・スクリーンショット取得。
- F005: predictタブ（射影）を追加。対象scope指定・射影実行・行状態・外挿警告・先頭20行表を表示し、固定変換の既存predict APIを使う。確認: 実ブラウザでIris 150行・成功150行の表を確認。
- F006: FAMDのcategories exportをprobability/barycenter列名に変更（side/mass/principal列を廃止）。CA/MCAの出力契約は無変更。確認: 再起動後の新backendでJSON/CSVの列名を確認（categoryId,variableId,code,kind,label,probability,barycenter1...）。

## 回帰

- `test_120_famd.py`＋`test_121_famd_api.py`: 13 passed
- FAMD＋MCA＋CA（100/110/111/120/121）: 37 passed
- stats_tests全体（R参照除外）: 421 passed
- `tests/famd.test.tsx`: 1 passed
- `tsc --noEmit -p fullstack/frontend/tsconfig.json`: FAMDファイルのエラーなし（他者のLinearRegressionPageの既存エラー4件あり、FAMD無関係）

## 実ブラウザ

- 環境: 独自backend :8421＋独自FE :5175。Iris 150行。
- relation svg・相関円軸名・射影タブ（150行成功）を確認。証拠: .temp/famd-fix-relation.png, famd-fix-corr.png, famd-fix-predict.png。
- 既報の実ポインタ矩形35行・保存stale・KeepAliveの結果は維持（今回再操作なし）。

## 未完了・残作業

- 相関円の3軸切替の実操作確認、rank1画面の確認。
- FactoMineR oracle比較、static配布確認。
- カテゴリ点の実ポインタclick選択の改善（前回報告のまま）。
