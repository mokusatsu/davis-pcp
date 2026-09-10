# DAVIS-FEAT-020 引き継ぎ

更新日: 2026-09-09  
状態: 実装中。Feature 20 / 20a の完了判定はまだ行わない。  
正本: [DAVIS-FEAT-020.md](DAVIS-FEAT-020.md)  
設計基準: [feature/20a_ma_scalability_design.md](../feature/20a_ma_scalability_design.md)、[fullstack/AGENTS.md](../fullstack/AGENTS.md)

20aの実装分解・二値受入条件: [DAVIS-FEAT-020A.md](DAVIS-FEAT-020A.md)

## 1. 目標

MA（複数回答）を元の物理列と回答者IDを保ったまま設問単位で表示し、必要なページだけが明示した選択肢を0/1として利用できるようにする。回答状態・分母・対象行・辞書世代を一貫させ、中央のRedux SelectionをTable、PCP、カード、集計、分析ページの間で共有する。必要列・必要行だけを読み、ページ離脱や遅い応答で結果や描画状態を失わないことが必須条件。

Feature 20が完了したとみなすには、限定テストが通るだけでなく、実データを使ったページ間操作、`fullstack/AGENTS.md` のR1〜R10、local/staticの実行、性能計測、`run-production.bat` 反映まで証拠を残す。

## 2. 作業ツリーの扱い

引き継ぎ時点のGitは次の状態だった。

- branch: `master`
- HEAD: `9e9fed095494f710673f07788b0476594b535870`
- この作業ではコミット、push、配布ビルドをしていない。
- `git status --short` は137件、追跡対象の差分名は79件。バックエンド、フロントエンド、テスト、タスク記録にまたがる既存変更である。

作業ツリーをリセット、clean、checkoutで戻さない。無関係に見える既存変更も所有者不明のため保持する。変更前に対象ファイルの差分を確認し、作業後は `git diff --check` と対象テストを実行する。タスクの完了まではコミットしない。

## 3. 現在確認できていること

### 自動検証

直近の限定検証は次のとおり。全体テストの合格を意味しない。

- `fullstack/frontend`: `node node_modules/typescript/bin/tsc --noEmit` 通過。
- `tests/clustersRequest.test.tsx`: 15件通過。
- `tests/mosaicRequest.test.tsx`: 4件通過。
- `fullstack/backend/tests/api/test_clusters_ma_projection.py` と `test_outliers_ma_projection.py`: 11件通過。
- `fullstack/backend/tests/api/test_mosaic_ma_projection.py` と `tests/unit/test_line_mosaic.py`: 6件通過。
- 既存のMA、Table、Distribution、Relationships、PCA、Logistic、Discriminant、Models、Ranking、Mining、Surprise、保存、Pyodide等にも限定テストを追加済み。詳細な件数と履歴は [DAVIS-FEAT-020.md](DAVIS-FEAT-020.md) の実施記録を参照する。

既知の警告（Ant Design deprecated、Spin tip、router future flag、jsdomの警告）は、上記限定テストの新規失敗とは扱っていない。最新変更後に対象ページのテストを再実行すること。

### 実画面で確認できている経路

- `feature20-mining-review`（40行）で、ClustersにMAのサービスAを明示追加し、kmeans k3を実行。使用39行、対象40行、部分回答1行除外、使用列Score/ScorePlus10/A、クラスタ10/19/10、平均シルエット0.639を確認。
- Clustersのクラスタ選択をTableで照合し、ROW-000002〜ROW-000020の19行が一致。PCPへ移動しても同じ19行と既存のArea/Score/ScorePlus10軸を保持。
- Clustersの通常幅・拡大表示・125%表示で、点クリック、矩形Replace、空領域のReplaceを確認。通常幅ではReplace/Add/Subtract/Toggleを実ポインターで確認済み。
- MosaicでArea×サービスAを指定し、非選択20行／選択19行を表示。選択セルをクリックするとROW-000002〜ROW-000020が中央Selectionへ入り、Table・PCPでも同じ行IDになった。部分回答ROW-000001は含まれない。セル詳細は「選択 × F」と表示される。
- Mining、Surprise、Logistic、Discriminant、Models、Ranking、PCA、Relationships等にも個別の実画面証跡があるが、各ページのR1〜R10全項目を満たす受入証拠ではない。古い記録を完了証拠として再利用せず、下記の残務を実行する。

## 4. 先に固定しておく設計判断

### 4.1 MAの扱い

- 生のMA子列、`__rowId__`、元コード、`valueLabels`を破壊しない。
- 親を通常の数値1列へ自動変換しない。MA子は、対応ページで明示追加・明示指定された場合だけ0/1化する。
- 同一親の未指定兄弟は、回答状態の判定に必要な依存列として読むだけで、特徴・表示軸・カテゴリには入れない。
- `0/1/98/99` の意味を推測して補正しない。コードブックのselected/unselected/missingを使い、partial/invalid/notApplicableを別状態として残す。
- 分母は回答者ベースと延べ回答ベースを分ける。分母0は0%ではなくnull。全0は設問定義がない限りvalidとして扱う。

### 4.2 Clustersの明示MA

設計表にはClustersのMA子を初回対象外とする記載があるが、現行方針は明示追加したMA子の利用を維持する。Clusters UI/APIのMA拒否を復活させない。共通MA親からの暗黙展開は行わず、明示した子だけを数値0/1または混合型のカテゴリとして分析する。テストとGUI証跡もこの方針に合わせる。

### 4.3 選択とページ保持

- Selectionの正本はRedux `selection`。ページ固有の選択状態を作らない。
- `Replace/Add/Subtract/Toggle`、解除、Focus、Delete、Resetは共通Selectionへdispatchする。
- KeepAlive中のページ離脱だけを理由に結果、フォーム、軸設定、Canvas、Worker要求を破棄しない。
- dataset、row scope、dataRevision、schemaRevision、入力パラメータが変わったときだけ旧結果を無効にする。遅い旧応答が現在の画面・Selection・グループを上書きしてはならない。

## 5. 残務（優先順）

### P0-A: 仕様と共通契約の最終監査

- [ ] `feature/20a_ma_scalability_design.md` の状態表と各API/UIの実装を突き合わせ、候補省略時・明示空配列・MA子指定の意味がページごとに一致していることを確認する。`[]` を全列へ戻すフォールバックを追加しない。
- [ ] ページごとのMA規則を固定する。通常カテゴリ×明示MA子はMosaic、明示子を許すのはLogistic/Discriminant/Models/Mining/Ranking/Key Drivers等、PCA/Touring/Clusters/Covariance/Penalty-Reward/通常のQQ・LOESS・FEDF・箱ひげは仕様どおりMAを除外または派生変数だけに限定する。
- [ ] 既存の全MAコード・状態境界（全0、全欠損、98/99、partial、invalid、notApplicable、同一親の兄弟）を小規模fixtureと実データで再確認する。
- [ ] MAカード、Table、Distribution、Statisticsの人数・率・分母が同じ scopeHash と状態定義を使うことを確認する。any/all/unselected/statusと0件を含める。
- [ ] グループ保存・再読込・JSON import/export・削除・optionOrder・multiResponseOptionLabel・schemaRevision競合を、成功と失敗の両方で確認する。

### P0-B: ページ間Selectionと実GUI

変更した各ページで、同一fixtureを使って次の順序を実行し、行ID・人数・表示状態を記録する。

1. Tableで行を選択する。
2. 対象ページへ移動し、図・カード・セルで選択状態が目視できることを確認する。
3. 対象ページでReplace/Add/Subtract/Toggleを実ポインターで実行する。
4. TableとPCPへ戻り、checked行、sidebar行、既存軸、L1/L2色が一致することを確認する。
5. Focus/Delete/Reset、Selected(0)、dataset切替、ページ再訪、入力変更、失敗再実行を確認する。

残っているページ別の実画面・実ポインター確認は次のとおり。

| ページ | 現状 | 必須の残確認 |
|---|---|---|
| Mosaic | API、候補、MAラベル、1セル選択は確認済み | 実矩形、全集合演算、セル境界/空セル、Focus/Delete/Reset、目的変数ラベル、空scope、dataset切替、拡大表示、R1〜R10 |
| Clusters | MA/通常、PCA点・矩形、Table/PCP連携を確認済み | 2図のhover、単一軸、全画面の全演算、L1/L2同時表示、結果入力変更・失敗保持、R5〜R10、Outliers画面連携 |
| PCA / Touring | APIとPCA一部操作を確認済み。Touringは`features/tgt/TgtPage.tsx` | 親画面の候補・空scope・結果保持、Biplot/Matrixの実ポインター、拡大/fit/図外終点/cancel、Tgt対象規則・行ID連携、L1/L2 |
| Covariance | resolver/射影/APIの限定検証済み | MA除外、通常ordinal/numeric候補、空scope/世代、行列の選択・focus・拡大・Table連携 |
| Models | 決定木/RF APIとMA限定テスト、葉のキーボード実装済み | SVG葉の実クリック/Enter/Space、回帰予測表示、RF代表木のMAE表示、Focus/Delete/Reset、再保存・復元、入力変更、拡大表示 |
| Logistic | MA目的/特徴、係数原点修正、点選択・色を確認済み | 切片切替、L2、誤分類赤輪と選択輪郭、矩形全演算、Focus/Delete/Reset、拡大、dataset切替、静的版 |
| Discriminant | MA LDA/QDA/stepwise API、診断、通常GUI選択を確認済み | 点/矩形全演算、診断の実GUI、拡大、目的/特徴変更、旧応答、L1/L2、Table/PCP往復 |
| Ranking | APIと手動実行の限定検証済み。古いGUIの自動実行は撤去済み | explicit MA UI、候補初期化、上位Kの親entity順、冗長性行列の数値、結果保持、空scope、実GUIとTable/PCP往復 |
| Mining / Surprise | APIと専用40行の一部実GUI（AX/DOM）を確認済み | Canvas/図の視覚、実ポインター、集合演算、空scope・対象未指定、候補のattribute/question分離、再訪・PCP/Table往復 |
| Relationships | 射影/API、Canvas限定テスト、Iris集約と焦点変更を確認済み | 実Canvasポインター、MA状態説明、hover、集合演算、焦点ペア・拡大、逐次処理、結果保持、R1〜R10 |
| Table / Distribution / Statistics / Overview / PCP | MA表示・順序・一部連携を確認済み | 12項目窓/ページング、検索/並べ替え、ページ外選択、部分回答確認、dataset切替、コードブック再読込、全集合演算、L1/L2、旧応答 |
| Bar Chart / QQ / LOESS / FEDF / Box | 一部API/UI変更または既存実装 | ページ別MA許可規則、必要列だけの読込、ビン/点/セル選択、L1/L2、hover、対象範囲とTable連携。実装箇所を特定して受入表に追加 |

### P0-C: Mosaicの直近変更を仕上げる

- [x] `fullstack/backend/app/api/summaries.py` のline_mosaic APIを最新コードで実データ確認した（`.temp/feature20-browser-workspace` のfeature20-mining-review、Area×Aでscope40/使用39/除外1）。実ブラウザ再起動による画面操作は未実施。
- [x] 空のrow scopeの契約を0件正常へ統一した（20a 7.5準拠）。`MOSAIC_EMPTY_DATA` の空範囲テストを廃止し、API・算法・UI・テストを同時更新した。決定日2026-09-09。
- [x] `scopeCount`/`usedRows`/`excludedRowCount` を画面の操作バーへ表示した（`mosaic-scope-summary`）。`excludedCounts`/`usedColumns`/revisionsの受入証拠はAPI応答に残す。表示レイアウトの実画面確認は残務。
- [x] `LineMosaicCanvas.tsx` をPointer Events・Pointer Capture・cancel/結果変更破棄・重複排除・R8様式・セル到達可能性へ変更し、共通「選択」メニューをページへ追加した。限定テストで確認済み。実ポインター・図外終点・空セル・拡大表示の実画面確認は残務。
- [x] 入力変更中の旧 `mosaicData` を操作可能な状態で残さない対応をした（結果キー不一致時のCanvas非表示・セル詳細Focus/Delete無効化・結果キーによるCanvas再生成）。dataset/scope/revision変更後の実画面確認は残務。

### P0-D: Storage・revision・並行実行

- [ ] `DatasetStore` の本体・辞書・meta同時保存をプロセス強制終了のケースまで確認する。現在は書込失敗時の復元と並行読取待機を確認済みだが、プロセス中断後の複数ファイル原子性は未保証。
- [ ] dataRevision/schemaRevisionを全変換、補完、計算列、列削除、import/export、表示API、分析APIで同じスナップショットとして扱う。変換後の辞書・meta・Parquetのrevision不一致を再現テストする。
- [ ] 全APIが同じdataset lock/snapshotを使うか監査する。遅い旧要求、dataset切替、辞書だけの変更、生データ変更が混ざらないことを確認する。
- [ ] 生列Arrowキャッシュ、MA状態キャッシュ、基礎集計キャッシュ、選択ハイライトキャッシュのキー・共有・失敗時の無保存を確認する。ページ非表示を理由に結果を追い出さない。
- [ ] local分析とstatic分析の重い処理を同時1件にし、明示取消だけをキューから除去する。待機、失敗、後続、共有購読者、WorkerエラーのGUI表示を確認する。

### P0-E: Pyodide / static / 配布

- [ ] `fullstack/frontend/src/engine/pyodideClient.ts` と `serialQueue.ts` の実Pyodide経路で、初期化失敗、STATUS/error、保留要求、明示取消、後続要求、IDBFS同期失敗を確認する。Workerをページ離脱で再起動・破棄しない。
- [ ] `fullstack/scripts/build_static.py` が追加されたbackend/appとMA関連モジュールを梱包することを確認する。
- [ ] `run-production.bat` → `run-production.ps1` の実行で、既存distの扱い、local/staticの起動、データ読込、MA集計、ページ再訪、選択連携を確認する。現在は配布ビルド未実施。
- [ ] 本番ビルド・ZIP・ハッシュ・実ブラウザの証跡をタスク記録へ追加する。ビルドはユーザーが指示した段階で実行し、外部ダウンロードが必要ならその実行結果を記録する。

### P1: 性能・メモリ受入

- [ ] 実データ3種と一時領域の50,000行×209列合成データで測定する。原データへ追記しない。
- [ ] 各画面単独、PCP→Distribution→Table→Relationships→Mining→Modelsの10周巡回を測定し、cold/warm、OS、CPU、RAM、ブラウザ、viewport/DPRを記録する。
- [ ] カード初期12親、Table初期100行/最大12 entity、全列Arrow要求0回、全行object生成なし、ペア図の大量DOMなし、重分析同時1件を確認する。
- [ ] GC後live heapの2周目と10周目の差が `max(32 MiB, 2周目の10%)` 以内であることを測る。結果を削除して条件を満たすことは禁止。
- [ ] 2,506行のwarmカード/Table初期応答2秒以内、軽量操作100ms以内を測定する。超過は内訳とともに記録する。容量推定だけで実行を拒否しない。

### P1: R1〜R10の証跡化

変更した各グラフで、次の表を埋める。AX/DOMだけでなくR3は実ポインターを使う。

| ID | 合格証拠 |
|---|---|
| R1 | グラフで選択→Table/PCP/sidebarの同数・同rowId |
| R2 | Tableで選択→グラフ自身の塗り/枠/不透明度が変化 |
| R3 | 実ポインターの点/矩形/セル/ビン選択でsidebarが変化 |
| R4 | 選択メニューの演算・解除・Focus/Delete/Resetと各パネルへの適用 |
| R5 | hoverでrowIdと主要値が見える |
| R6 | 1〜20水準のL1候補と同値色、21水準除外、欠損表示 |
| R7 | Clusters/Models/Outliers後のL2輝度切替、L1×L2合成 |
| R8 | ドラッグ中のrgba青矩形が最上位に表示され、pointerEvents none |
| R9 | Iris、MA fixture、大列/全NaN fixtureのdataset切替 |
| R10 | プロットドラッグで文字選択されず、computed `user-select:none` |

### P2: Feature 21以降

Feature 20/20aの完了判定後に、`feature/21`〜`feature/27`を順番に着手する。Feature 28は既存実装を連携回帰へ含める。20の未達を21以降の実装で覆い隠さない。

Feature 21/22の実装分解・受入条件は[こちら](DAVIS-FEAT-021-022.md)。調査ウェイトとサンプリング重み、ordinalの一部基盤とLikertビューを混同せず、同文書のAC表を別々に満たす。

## 6. 既知の注意点・未決定点

- q7s2の1/99混在、全0の意味、maxSelectionsは原票根拠がないため推測で変更しない。partialとして表示し、除外人数を明示する。
- Mosaicの空scope応答（0件正常か、MOSAIC_EMPTY_DATAか）は上記のとおり未統一。決定をタスク記録へ残す。
- ClustersのMA子は現行方針で明示追加を維持する。設計表の初回対象外という文言だけを根拠に拒否へ戻さない。
- `run-production.bat` はPowerShellラッパーであり、既存 `dist` がある場合の再構築条件を確認してから実行する。古いZIPを新しい実行結果の証拠にしない。
- 既存のFeature 19/19Bテスト失敗2件は変更前基準と新規退行を分けて報告する。
- 実画面用の`.temp/feature20-mining-review` fixtureは追加列・辞書を含む。セットアップスクリプトを無確認で再実行して上書きしない。

## 7. 引き継ぎ後の最初の作業

1. この文書、[DAVIS-FEAT-020.md](DAVIS-FEAT-020.md)、[20a設計](../feature/20a_ma_scalability_design.md)、[fullstack/AGENTS.md](../fullstack/AGENTS.md)を読む。
2. `git status --short`、`git diff --check`、TypeScript型検査、直近のMosaic/Clusters限定テストを再実行する。
3. Mosaicの空scope契約を決定し、API・画面・テストを同期する。
4. P0-Bのページ間回帰を実データで進め、R1〜R10表をページ別に埋める。
5. Storage/revisionとPyodide/staticの未確認を片付ける。
6. その後に性能計測、全体テスト、ユーザー指示を受けた配布ビルドを行い、完了条件ごとに `達成 / 未達 / 未確認` を更新する。

完了条件が一つでも未確認なら、タスク状態は「実装中」または「実環境検証待ち」のままにする。
