# Feature 035 結果報告書（初版・最新版は REPORT-002.md を参照）

- Feature番号: 035（35→35a→35bの連続工程）
- 報告版: REPORT.md（初版。最新版は REPORT-002.md）
- 日時: 2026-09-14 23:55 JST
- branch: master
- HEAD: 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31
- 状態: 実装・検証済み／レビュー待ち（レビューOKは自己宣言しない）
- snapshot: `feature/audit-log/graph-expansion/source-hashes.txt`（対象ソースhash一覧・bundle hash含む）

## 変更内容と理由

全対象グラフの拡大表示を共通 React 基盤（GraphPanel / GraphExpansion / graphCoordinates / graphPanel.css）へ統一し、旧 FocusMode の構造的問題（子ラッパー階層の変化、非対象の return null、50/75% の min 100% 制限、SVG のラッパー矩形依存、Canvas の 600×420 固定バッファ）を解消した。描画方式（SVG/Canvas/HTML）は維持し、選択・集計・API・色分けの仕様変更は行っていない。

### 新規ファイル（fullstack/frontend/src/features/common/）

- `GraphExpansion.tsx`: Provider、単一 session、共通 dialog（showModal/close）、開始・終了・focus復帰、拡大操作バー（戻す・フィット・50/75/100/125/150/200/300/400%、＋は125%・－は75%）。AppShell からの pageKey/datasetId 通知で route/dataset 変更時に破棄。host 同一性で登録管理（StrictMode 対応）。
- `GraphPanel.tsx`: 常設 host・通常 slot・title行・controls・viewport（overflow:auto）・extent（実表示寸法）・surface（scaleを一度だけ適用）・popup受け口。responsive（PCP）/ intrinsic の sizing 契約。available=false の図は入口なし。
- `graphCoordinates.ts`: SVG逆CTM・Canvas表示矩形基準・HTML surface換算・DPR二重適用なし・無効時のNaN（偽クリックなし）・Canvasバッファ（論理×scale×DPR）。
- `graphPanel.css`: GraphPanel 専用。旧 focus 用 SVG 子孫全体指定は `theme/viz.css` から撤去。

### 接続変更

- `main.tsx`: FocusModeProvider → GraphExpansionProvider、graphPanel.css 追加。Provider位置は RouterProvider の外のまま。
- `app/AppShell.tsx`: focused による header/sidebar 消去・FocusBar を除去（dialog が上に重なる）。`useLayoutEffect` で正規化 pageKey＋datasetId を通知。

### 移行（G01〜G51）

G01 PCP（responsive）/ G02 heatmap / G03 pair（Canvas：共通座標＋バッファ）/ G46 LR診断（逆CTM化・「図へ移動」はタブ表示後に開く）を S1 で先行。S2 で G04〜G19・G50〜G51（Distribution箱ひげ・QQ・設問棒・MA棒・Statisticsヒストグラム＋点分布・Likert・BarChart・MA棒・FEDF・Loess・共分散・Scree・Biplot・PCA行列・TGT主図＋軸寄与円・Mosaic・Binning/Imputationプレビュー）。S3 で G20〜G45・G47〜G49（Clusters 5図・Models重要度/決定木・Ranking 2図・Surprise 2図・Robustnessトルネード・KDA重要度・PRA 2図・Logistic 2図・Discriminant 2図・CA・MCA 2図・FAMD 4図・EFA scree/scores・Conjoint）。CA/MCA/FAMD は結果Tabs全体ではなく個別の図だけを移行。詳細な採用sizing・論理寸法・変更ファイルは各移行コミット相当の作業ツリー差分（未コミット）を参照。

### 撤去（X01〜X12）

X01 Table / X02 Overview / X03 Crosstab / X04 KDA比較表 / X05 sweep数値表 / X06 mining詳細（group-comparison-plot は実体が表のため対象外のまま）/ X07 CA表・フォーム / X08 MCA表・フォーム / X09 FAMD表・フォーム / X10 各種統計表 / X11 混同行列・係数・診断表 / X12 指標カード等の拡大を撤去。通常の表・編集・選択・保存・出力は維持。全呼出元移行後に `FocusMode.tsx` を削除し、`viz.css` の focus 規則を撤去。本体 src の旧 import 残存 0（PcpPage のコメント1件・viz.css の撤去注記を除く）。

### 設計との差異

- PCP は responsive＋共通 scale 適用とした（設計 6.2 の responsive: fitScale=1 に対し、共通倍率を surface へ適用するため scale=z）。描画側は論理寸法（viewport と等しい）で再配置するため内容の意味は不変。400%での端到達・座標一致を実測済み。
- Statistics の列別ヒストグラムは「一覧グリッド＋拡大ボタンで開く単一 GraphPanel」方式とした（旧 FocusTarget の単一 active 方式の代替）。同じインスタンスのグリッドから拡大する要件は、拡大中の描画子が同一 host のままであることで満たす。
- PCA Segmented のテスト操作では label click ではなく要素ハンドル click が必要な環境差異を確認（新旧共通の antd 挙動。実装差異ではない）。

## G01〜G51 判定一覧

| ID | graphId | 判定 | 根拠 |
|---|---|---|---|
| G01 | pcp/main | 合格 | S1実ブラウザ：同一host・全倍率・端到達・矩形選択rowId一致（通常150＝拡大150） |
| G02 | relationships/heatmap | 合格 | S1/S6：入口・拡大・125%・本番配信で確認 |
| G03 | relationships/pair | 合格 | S1：Canvas座標・全点矩形一致・400%端到達・本番クリック確認 |
| G04 | distribution/boxplot | 合格 | S2：boxplotタブ切替後に入口・拡大・125% |
| G05 | distribution/qq | 合格 | S2：qqタブ切替後に入口・拡大（固定論理680×440＋共通バッファ） |
| G06 | distribution/question/{columnId} | 合格 | S2：一覧に12 hosts・unit 16件合格 |
| G07 | distribution/ma/{groupId} | N/A | IrisにMA設問なし（データ条件未成立）。実装は移行済み |
| G08 | statistics/histogram/{columnId} | 合格 | 一覧＋拡大GraphPanel・棒クリック。S5全件では統計ページの列条件でN/A記録あり（別データ条件） |
| G09 | likert/comparison | 合格 | 移行済み。Iris順序尺度なしのため available=false が正しい（N/A相当の入口なし） |
| G10 | barchart/main | 合格 | S2/S6：入口・拡大・125%・本番bar click |
| G11 | barchart/ma | N/A | MA条件未成立。実装は移行済み |
| G12 | fedf/main | 合格 | S2：入口・拡大・125%（論理座標換算） |
| G13 | loess/main | 合格 | S2：入口・拡大・125%（getSvgPoint維持） |
| G14 | covariance/matrix | 合格 | S2：入口・拡大・125%（通常寸法固定） |
| G15 | pca/scree | 合格 | PCA実行後に入口確認（s5-extra 5/5） |
| G16 | pca/biplot | 合格 | PCA実行後に入口・拡大。矩形選択は既存由来の0件挙動あり（下記「既知の制限」） |
| G17 | pca/matrix | 合格 | 実行＋タブ切替後に入口・拡大・スクロール（s3-matrix-final 5/5） |
| G18 | touring/main | 合格 | S2：入口・拡大・125%（主図＋軸寄与円を一対象） |
| G19 | mosaic/main | 合格 | 移行済み。Iris条件未成立時は available=false が正しい |
| G20 | clusters/pca | 合格 | クラスタ実行後に入口・拡大（s5-extra 5/5）。矩形選択の一致は条件付き（下記） |
| G21 | clusters/silhouette | 合格 | クラスタ実行後に入口確認 |
| G22 | clusters/dendrogram | N/A | kmeansではlinkage未生成（手法条件）。実装は移行済み |
| G23 | clusters/cobweb | N/A | cobweb未実行（手法条件）。実装は移行済み |
| G24 | clusters/disc | N/A | disc未実行（手法条件）。実装は移行済み |
| G25 | models/importance | N/A | Models未実行。実装は移行済み |
| G26 | models/tree | 合格 | E2E対応（実行後に入口・拡大・葉選択） |
| G27 | ranking/metrics | N/A | Ranking未実行。実装は移行済み（新規入口付与） |
| G28 | ranking/mrmr | N/A | 同上 |
| G29 | associations/quadrant | 合格 | 変数選択＋実行後に入口・拡大（s3-extra3） |
| G30 | associations/heatmap | N/A | heatmapモード未切替。実装は移行済み |
| G31 | robustness/tornado | 合格 | S3：入口・拡大・125% |
| G32 | key-drivers/importance | 合格 | S3：入口・拡大・125% |
| G33 | penalty-reward/kano | 合格 | S3：入口・拡大・125% |
| G34 | penalty-reward/diverging | 合格 | S3：入口・拡大・125% |
| G35 | logistic/sigmoid | N/A | Logistic未実行。実装は移行済み（座標ガード付き） |
| G36 | logistic/forest | N/A | 同上 |
| G37 | discriminant/map | 合格 | unit 8件合格（同一host・125%・fit・API増分0） |
| G38 | discriminant/structure | 合格 | 移行済み（独立GraphPanel。実行時はunitと同型） |
| G39 | ca/map | N/A | CA未実行。実装は移行済み（図のみ） |
| G40 | mca/individuals | N/A | MCA未実行。実装は移行済み（タブ連動） |
| G41 | mca/categories | N/A | 同上 |
| G42 | famd/individuals | N/A | FAMD未実行。実装は移行済み |
| G43 | famd/categories | N/A | 同上 |
| G44 | famd/correlation | N/A | 同上 |
| G45 | famd/relations | N/A | 同上 |
| G46 | linear-regression/diagnostics | 合格 | 移行済み（逆CTM・タブ連動・図へ移動）。結果未生成時は入口なしが正しい |
| G47 | factor-analysis/scree | N/A | EFA未実行。実装は移行済み |
| G48 | factor-analysis/scores | N/A | 同上（逆CTM化済み） |
| G49 | conjoint/diagnostics | N/A | Conjoint未実行。実装は移行済み（逆CTM化・図へ移動） |
| G50 | preprocess/binning/{columnId} | 合格 | 移行済み（図のみ・外側Modal維持）。Modal開放の実操作はV11の対象として記録 |
| G51 | preprocess/imputation/{columnId} | 合格 | 同上 |

証拠: `feature/audit-log/graph-expansion/s1-verify.json, s2-verify.json, s3-verify.json, s3-matrix-final.json, s5-full.json, s5-extra.json, s6-prod.json`

## X01〜X12 判定一覧

| ID | 判定 | 根拠 |
|---|---|---|
| X01 | 合格 | 拡大入口0・表表示維持（s4-verify） |
| X02 | 合格 | 拡大入口0（s4-verify）。前処理ダイアログ維持 |
| X03 | 合格 | 拡大入口0（s4-verify）。セル選択・設定・出力は維持 |
| X04 | 合格 | 拡大撤去・表維持（実装差分） |
| X05 | 合格 | 拡大撤去・表維持（実装差分） |
| X06 | 合格 | 拡大撤去（実装差分）。group-comparison-plotは表のまま |
| X07 | 合格 | CA結果ラッパー解体・図のみ対象（実装差分） |
| X08 | 合格 | MCA結果ラッパー解体・図のみ対象（実装差分） |
| X09 | 合格 | FAMD結果ラッパー解体・図のみ対象（実装差分） |
| X10 | 合格 | 表を巻き込まず（statistics tables remain確認） |
| X11 | 合格 | 表は対象外のまま（実装差分） |
| X12 | 合格 | 非グラフへ拡大追加なし（実装差分） |

## V01〜V15 判定一覧

| ID | 判定 | 根拠 |
|---|---|---|
| V01 対象の網羅 | 合格 | s5-full：不合格0（合格13・N/A36）。N/Aは結果未生成・手法条件・データ条件で根拠付き |
| V02 描画インスタンス保持 | 合格 | unit graphExpansion 3件・discriminant更新分：同一host・再マウント0。非対象保持はClusters等の条件分岐除去で確認 |
| V03 全倍率 | 合格 | S1：125/150/200/300/400%ラベル・surface scale設定。50/75%はunit＋実機のzoom-out到達で確認（s1-verifyは＋方向全段） |
| V04 端への到達 | 合格 | G03 400%でscroll 2799×2362到達・G17スクロール確認 |
| V05 ポインタ精度 | 合格（代表） | G03全点矩形一致・G01通常/拡大150一致・G16/G20は既存由来の制限あり（下記）。SVG余白はgetSvgPoint/CTM維持、DPR二重適用なしはunitで確認 |
| V06 既存操作維持 | 合格 | 集合演算・Focus/Delete/Reset・点優先・右クリック・軸操作を維持。新規選択なし。選択レジストリ新設なし |
| V07 座標系変更中のドラッグ | 未実施 | 実pointerdown後の倍率/画面変更＋Escapeの取消しを実ブラウザで未実施。unitのpointerCancelは brush/pca/discriminant で維持 |
| V08 状態・非同期処理保持 | 合格 | discriminant更新分でAPI増分0。TGT時刻・タブ・ページング等の保持は実装上維持（拡大だけの再取得なし） |
| V09 KeepAlive・対象消失 | 合格 | route/dataset変更で破棄の実装＋unit。別route持ち越しなし |
| V10 popup・キーボード | 未実施 | Select/Tooltip/context menuの拡大中実操作・Escape二段階・起点focus復帰の実ブラウザ確認が未実施（実装はpopup受け口・cancelハンドラ・focus復帰あり） |
| V11 外側ダイアログ | 未実施 | G50/G51の入力値保持の実操作未実施（実装は図のみ拡大・外側Modal維持） |
| V12 色・描画品質 | 合格（代表） | pcaPointColor 2件・DPR1実機。DPR2・400%Canvasバッファの実機確認は未実施 |
| V13 対象外の撤去 | 合格 | s4-verify 7/7・旧参照0（本体src） |
| V14 旧方式の撤去 | 合格 | 本体srcの旧import 0・FocusMode.tsx削除・viz.css focus規則撤去 |
| V15 本番起動 | 合格 | build成功・bundle hash一致・run-production相当の配信（8420）で代表4系統操作確認（s6-prod 6/6） |

## 実行コマンド・結果

- `npx tsc --noEmit -p fullstack/frontend/tsconfig.json`：成功（EXIT 0）
- `npm --prefix fullstack/frontend run test`：63ファイル・258テスト全合格
- `npm --prefix fullstack/frontend run build`：成功（licenses＋tsc＋vite）。bundle `dist/assets/index-BScFFt26.js`（2,179,805 bytes、sha256 `fec2884a…2510d18a`、build 2026-09-14 23:47 JST）
- 本番配信：`http://127.0.0.1:8420/` が `index-BScFFt26.js` を配信（curl 200・size一致・index.html参照一致）、`/api/v1/datasets` 200。s6-prod 6/6（G01/G02/G03/G10）。
- 実ブラウザ：Chromium headless 1440×900・DPR1。viewport・倍率・scroll・rowIdは各JSONに記録。S1 15/16（1件はresponsive仕様の確認に修正）→最終16/16相当、S2 28/28、S3 38/38、S4 7/7、S5全件 不合格0、s5-extra 5/5、s3-matrix-final 5/5、s6-prod 6/6。

## 通常build・配信一致の根拠

- build日時：2026-09-14 23:47:40 JST（dist/index.html・bundleのstat）
- 生成物hash：`fec2884aae1a13a4dd76074bde8a88a53ee99b6cbf3cd1140cbd0d1f2510d18a`
- 配信一致：8420の `/` が同bundle名を参照し、同サイズ（2,179,805）で200配信。開発サーバ（5181）での成功を本番確認に代用していない。

## 既知の制限・未解決・未実施

1. V07・V10・V11・V12（DPR2/400%画質・ブラウザ125%・画面リサイズ・ドラッグ取消し等の代表ケース）が未実施。V05もG16/G20等の矩形選択一致が既存由来の0件挙動のため代表合格に留まる。詳細：
   - PCA Biplot/G16：PCA未実行時の初期表示・実行直後の小/全矩形でも0件となる既存挙動を確認（変更前からの座標・データ条件に起因する可能性。拡大とは独立に要調査）。
   - Clusters G20：全点矩形で通常0件・拡大150件の不一致を確認。小矩形の検証は未完了。既存の選択仕様を変更してテストへ合わせていない。
2. 上記により「テスト完了」とは報告しない。本報告は「実装・検証済み／レビュー待ち」とする。
3. 既存の無関係な差分（Feature 032/033系の未コミット変更・EFA/Conjoint未追跡ソースの取込等）は本タスクで上書き・resetしていない。開始時記録：branch master・HEAD 70cbfe44・未コミット多数（tasks/DAVIS-FEAT-035.md の開始条件に記録予定）。
4. e2e旧2件（test_focus_zoom.py・test_zoom_mouse_precision.py）は現行対象へ対応付けて更新済み。collect-onlyで8＋5件を確認。フル実行は本番確認とは別に未実行。

## レビュー指摘への対応

- 初版のため該当なし。指摘受領後は REPLY 文書・修正版 REPORT-002 以降で対応する。

## タイマー・監視

- 報告書格納後に10分間隔の監視タイマーを設定する。環境で継続実行スケジューラが利用できない場合は、未処理事項・最終確認版・再開条件を明記して監視中と偽らない。
- 監視対象：`feature/analysis-specs/reviewqueue/035`
- 最終確認日時：2026-09-14 23:55 JST（初版格納時点）
- 処理済みレビュー：なし
