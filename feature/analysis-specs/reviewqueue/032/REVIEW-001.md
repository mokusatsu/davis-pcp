# Feature 032 重回帰 実装レビュー 001

判定: **要修正。7指摘あり。現在の作業ツリーではAPI試験も失敗する。**

- 日付: 2026-09-13
- 対象: `REPORT.md`、SHA256 `A47DFD5327CD4AD16CB4EE6A045B38BA079E0F71B79D8602EE6E558B85CCDC18`
- HEAD: `9cfcea003b132df3ac4b0876af44aed6b5caae20`。ステージ済み・未ステージ・未追跡を含む現在の実装を確認。
- 照合: Feature 032詳細設計と共通契約。Pyodide実ブラウザ操作検証は対象外。

## L001 [P1] APIと画面の共有登録が欠落している

位置: `fullstack/backend/app/main.py:93`付近、`fullstack/frontend/src/main.tsx`、`src/app/KeepAliveOutlet.tsx`、`src/app/AppShell.tsx`。

現在のmain.pyはlinear_regression routerをimport/includeしていない。POST /api/v1/models/linear-regressionが405となり、test_131の3件すべてが失敗する。フロントのルート・KeepAlive・ナビゲーションにもlinear-regression登録が見当たらない。同じ共有ファイル群からFAMDの登録も欠落している。実装報告の登録済み・全試験合格とは現在の状態が異なる。変更者や消失理由は特定していない。

修正条件: MCA等の既存登録を保ち、LR/FAMDのAPI・ルート・KeepAlive・ナビゲーションを統合する。現在の作業ツリーでAPI試験とルート表示を確認する。

## L002 [P1] 目的変数・数値説明変数のmissingCodesを無視する

位置: `fullstack/backend/app/domain/analysis_frame.py:1431,1461`、`fullstack/backend/app/api/linear_regression.py:1195`付近。

学習は `_numeric_value(raw)` にspecを渡さず、通常数値の予測もfloat変換だけを行う。10行fixtureでx=0またはy=2.2を欠損コードとして保存しても、fitCount=10・missing除外0となることを隔離データで再現した。本来は9行で学習しなければならず、欠損コードが係数・残差・分散へ入る。ordinalの欠損照合だけでは通常数値を保護できない。

修正条件: targetと通常numeric predictorの学習・予測・評価で列の欠損定義を統一して適用する。target欠損行も説明変数が有効なら予測自体は可能とし、評価だけから外す。欠損行を除いた直接計算との係数一致を確認する。

## L003 [P1] dataset指定の予測評価を無加重で計算する

位置: `fullstack/backend/app/api/linear_regression.py:1490`〜1524。

評価のwmapを作るのはweightMode=columnの場合だけで、通常UIが送るdatasetでは空となり、全行の評価重みを1へ置き換える。学習済み予測値が正しくても、datasetに宣言されたsurvey/frequency評価RMSE・MAE・R²が誤る。column経路もfloat変換だけでmissingCodesやfrequencyの整数性等の共通規約を適用していない。

修正条件: 予測contextの重みを共通resolver・検証経路で解決する。dataset/columnの同一重みで評価が一致すること、noneでは無加重になること、欠損・0・不正重みの扱いを確認する。新しい評価重みで係数を更新しない。

## L004 [P2] 交互作用の第2変数を設定できない

位置: `fullstack/frontend/src/features/models/LinearRegressionPage.tsx:376`。

「変数2」のonChangeも配列の第1要素を書き換え、第2要素はnullのまま維持する。追加条件がinterDraft[1]を要求するため、通常操作で交互作用を1件も追加できない。

修正条件: 第2要素へ選択値を保存する。異なる2変数を選び、追加されたペアとAPI payloadの一致を確認する。

## L005 [P1] 古い診断行を新しい分析に重ねて選択できる

位置: `LinearRegressionPage.tsx:155`〜202、218〜240、314。

再分析成功時に新resultを設定する一方、旧rowsは新しい取得完了まで残り、取得失敗時も消えない。rowsのresultId照合がなくloading/errorの状態値も表示に利用していないため、旧点の座標を見て新resultへ矩形選択を送る。さらに点clickはAPIを通さず直接selectionAppliedをdispatchし、scope/staleの判定を迂回する。staleも保存済みmeta.resultStateのみで、現在のdataRevision/schemaRevisionとの比較がない。

修正条件: 行取得の所属resultId・状態を表示と選択に反映する。未取得/取得失敗/版不一致では選択を抑止する。点選択も現在contextと版を検証した原行解決経路を使用する。再分析直後・取得失敗・データ編集後の選択を確認する。

## L006 [P1] 予測結果と保存元IDが別分析・別datasetへ残る

位置: `LinearRegressionPage.tsx:107`〜123、handleRun成功処理、handlePredict、保存元Select。

dataset切替と再分析でpredictRows/predictInfo/matSource等をリセットせず、予測の所属resultIdを表示時に照合しない。別分析後にも旧予測・旧rowIdが現在のカードへ残り、保存元も旧predictionIdのままになる。また保存元候補が現在のmatSourceから作られるため、予測後にfitへ切り替えると予測IDの選択肢を失う。

修正条件: predictionIdを選択中保存元とは別に保持し、dataset/resultに紐付ける。別分析時は旧予測と保存元状態を無効化し、現在のfitとpredictionを往復選択できるようにする。遅延応答が新しい表示へ混入しないことを確認する。

## L007 [P2] 列名入力が配列になりmaterialize要求を壊す

位置: `LinearRegressionPage.tsx:541`。

matNameは文字列stateだが、Selectのmode=tagsはonChangeで配列を返す。利用者が列名を入力・確定するとmatNameへ配列が入り、source列のnameとして配列を送るため保存契約に合わない。初期値のまま保存する確認では検出できない。

修正条件: 単一文字列の入力部品または明示的な文字列変換を使い、変更した列名で保存成功を確認する。

## 検証と範囲

- backend test_130＋test_131: **8 passed / 3 failed**。API3件は405。報告の11件合格は現在のツリーでは再現しない。
- frontend linear-regression.test.tsx: **2 passed**。画面操作全体の検証ではない。
- `.temp/review-032-check.py`: API登録欠落とは分けて、隔離データを作りrun_linear_regression関数を直接呼び、L002を再現。HTTP成功の証拠としては扱わない。
- 数値kernelとsurvey/model_covarianceの設計、FPC/PSU保持・共分散経路を静的確認した。今回の8単体テストは合格したが、survey E2Eの完了は示さない。
- 実装修正・ビルド・全体テスト・実ブラウザ操作は行っていない。全体回帰やCOM完了の報告だけで今回の具体的不一致を解消扱いにしない。

API登録修正後の関連試験、予測の未知カテゴリ/欠損等、survey E2E、画面操作、本番経路の受入証拠が必要。

## 確認したソースSHA256

- backend/app/main.py: `A2C4F69B12B91A975C049E23B2362FEFE25CE678E855F398681F752EAF0E888D`
- frontend/src/main.tsx: `E2F9834E015C9E516E14790167378617622611DE506BD7099D38C3D46F68A1B9`
- LinearRegressionPage.tsx: `D115B302800AEA3382D01ECCAD7EAD195D160F1E9E5DEE5A3E516DACE303FB19`
- analysis_frame.py: `0C549D687B9B4471238EE5D245B8CBE4206DE1944B36A1146BF55FE8AB3AE364`
- api/linear_regression.py: `CC812C5391BA0BBA147E0CD2240E2A62B8A3485CF7E8EAC3C07CA197A5C6C603`
