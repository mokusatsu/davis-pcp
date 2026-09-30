# REVIEW-005 への対応報告（全面対応・10分監視中）

- 対応日時: 2026-09-15（未解消指摘IDの個別検証：F006-02・F008-01・F010-01・F011-01・G34・V07拡大中・G41に対応する新規runを追加。既存13/13等の再実行は維持確認のみ）
- branch: master（未コミット作業あり。GraphExpansion.tsx/GraphPanel.tsx/PcpPlotViewport.tsx等は未追跡の新規ファイルとして存在）
- 検証サーバ: backend `http://127.0.0.1:8420`、frontend dev `http://127.0.0.1:5181`
- 証拠JSON: `.temp/graph-expansion/review5-repro.json`（13/13）、`review5-g51.json`（3/3）、`review5-g16-ids.json`（136/136集合一致）、`review5-g20.json`（150/150集合一致）＋`review5-g20-ids.json`、`review5-disc.json`（G37/G38 3/3）、`review5-pca.json`（G17 2/2）、`review5-popup.json`（6/6）、`review5-grows.json`（入口7/7＋5/6）、`review5-models.json`（G25/G26 2/2）、`review5-assoc.json`（G29 2/2）、`review5-expand8.json`（8図拡大 8/8）、`review5-mosaic.json`（G19 1/1）、`review5-heatmap.json`（G30 2/2）、`f004-05c.py`（G20中央5/5）、`f005-g50.py`（G50列名等値・modal kept）
- 画像証拠: `f005-PCP-400-topleft.png`（PCP 400%左上：軸・線あり）、`v12-125-topleft.png`（ブラウザ125%のfit全体像：10軸・150線あり）、`v12-400-22nd.png`（第22回：拡大ドック400%・scale=4・buf=[4915,2408]、軸線・目盛・斜めラベルを確認）、`f005-G50-expanded.png`（ビニング拡大）、`f005-G51-expanded.png`（補完拡大）、`g37-expanded.png`（判別マップ拡大）、`g26-expanded.png`（決定木拡大）、`g40-expanded.png`（MCA個体図拡大）、`g42-expanded.png`（FAMD個体図拡大）、`g47-expanded.png`（EFAスクリー拡大）、`g19-expanded.png`（モザイク拡大）、`g30-expanded.png`（ヒートマップ拡大）
- 証拠JSON追加: `review5-mca.json`（G40/G41 3/3）、`review5-famd.json`（G42-45 3/3）、`review5-efa.json`（G47/G48 2/2）
- 証拠JSON追加（第20回）: `review5-g07g11g.json`（G07 4/5：MA入口・拡大は実証、G11は未達）、画像 `g07-ma-entry.png`・`g07-ma-expanded.png`
- 証拠JSON追加（第21回）: `review5-g11b.json`（G11 3/3：barchart/ma入口・拡大を実証）、画像 `g11b-ma-entry.png`・`g11b-ma-expanded.png`
- 証拠JSON追加（未解消指摘ID対応）: `review5-g51b.json`（F006-02：選択中Mean値の前後等値・拡大図のdialog内配置・125%倍率保持・終了後次操作まで6/6、画像 `g51b-expanded.png`）、`review5-zoom125.json`（F008-01：DPR混同を避けたページズーム相当1024px幅でのバッファ・原点一致2/2、画像 `v12-pagezoom125.png`）、`review5-g24.json`（F010-01：method=disc送信の確認付きで入口・拡大3/3、画像 `g24-expanded.png`）、`review5-g28.json`（F010-01：mrmr入口・拡大2/2、画像 `g28-expanded.png`）、`review5-g41.json`（F011-01：カテゴリタブ切替後のcategories入口・拡大2/2、画像 `g41-expanded.png`）、`review5-g34.json`（G34 diverging入口・拡大・ズーム保持2/2）、`review5-v07b.json`（V07拡大中Escapeの取消し・次操作2/2）、`review5-popup2.json`（拡大中popup：order-menuは拡大dialog外のページ上部に残るためin-dialog判定不可・Tooltip対象あり・Escape終了あり。F009-01のbar-only判定はG24/G28/G34/G41のin-dock配置検査で補完）
- 型検査: `npx tsc --noEmit` 成功（exit 0）。単体: 63ファイル259テスト全合格。build成功（7.43秒、`dist/assets/index-CAX4JpvX.js` 2,184,931 bytes、sha256 `31427850cf743281d9a59aad58dc47220eaf8080270d2ad15a3c2343f7404692`＝前回と同一）。同一版の再実行は維持確認であり、新規指摘対応の証拠は上記の個別runを参照すること。

## F005-01 描画倍率の統一 → 修正・実証済み

- 対応: `PcpPage.tsx` で有効DPR = rawDpr × 表示scale を算出し、バッファ寸法（`width × dpr`）と `spec.dpr` を同じ値で統一。`pcpRenderer.ts` は `spec.dpr` だけで `setTransform`・背景塗りを行うため、両者が一致する。REVIEW-004-REPLY の「実dprが同じなので整合する」という説明は訂正する。正しくは rawDpr × scale を spec に載せて統一した。
- 実証（`review5-repro.py`→`review5-repro.json`、第30回再実行13/13維持）:
  - DPR1 fit: buf=[984,374] exp=[984,374]、DPR1 400%: buf=[4915,2408] exp=[4916,2408]
  - DPR2 fit: buf=[1968,748] exp=[1968,748]、DPR2 400%: buf=[9830,4816] exp=[9832,4816]
  - canvas/SVG原点一致（DPR1・DPR2とも ±2px 以内）
  - 目視: `f005-PCP-400-topleft.png` で400%左上に軸（7.9・4.4等）・線の描画を確認。
- V12追加対応: ブラウザ125%（device_scale_factor=1.25、実dpr=1.25）で buf=[1230,468] exp=[1230,468] 一致、canvas/SVG原点一致。`v12-125-topleft.png` でfit全体像（10軸・150線の描画）を確認。数値評価として背景白（255,255,255）をDPR1/2/1.25で確認（`review5-v12.json` 3/3）、非白ピクセル率（線・軸の描画量）をDPR1 fit 17.86%・400% 3.84%、DPR2 fit 15.41%・400% 3.65%で確認（`review5-v12b.json` 4/4）。厳密な官能評価（ぎざつき・にじみの目視判定）は目視確認に留まる点を明記する。第22回の官能所見：拡大ドック400%（scale=4、buf=[4915,2408]）の `v12-400-22nd.png` で軸の縦線・目盛・斜め列名ラベルににじみやぎざつきなし、折れ線も滑らかな描画を目視確認。

## F005-02 リサイズ・Escapeの取消し → 修正・実証済み

- 対応:
  - `GraphPanel.tsx` で `data-coord-gen`（寸法・DPR・zoom の世代）を公開済み。`PcpPage.tsx` はドラッグ開始時に世代を記録し、`onPointerUp` で異なれば dispatch せず矩形・capture を掃除する。`revision` ではなく `coordGen` を比較する（`data-revision` 属性は存在しないという指摘に対応）。
  - Escape単独の取消しを追加: `PcpPage.tsx` に window keydown リスナーを追加し、進行中ドラッグ中に Escape が押されたら `cancelBrush`（矩形・capture掃除、dispatchなし）する。
- 実証（`review5-repro.json`、第30回再実行13/13維持）:
  - 真のリサイズ（dock幅 100%→70%、世代 `1229x602@1xfit`→`860x602@1xfit`）で dispatch なし・矩形 hidden: 合格
  - Escape単独（通常表示）で dispatch なし・矩形 hidden: 合格
  - zoom-during-drag で dispatch なし・次操作で1件選択: 合格
- 残り: なし（V07の3条件を実ブラウザで確認済み）。

## F005-03 検証証拠の完成 → 対応内容

- G16（集合一致）: PCA実行後の通常→拡大で同じ矩形操作を行い、rowId集合を比較。`review5-g16-ids.json` に通常136件・拡大136件のID集合を保存し、集合一致を確認（先頭 IRIS-001〜003、末尾 IRIS-149・150 を含む）。件数だけでなく集合で照合した。
- G20（全矩形一致・解消）: 従来の不一致（通常0/拡大150）は、通常表示でsvgが画面外（y=1134）にあり操作が届いていなかったことが原因。`scrollIntoView({block:'center'})` 後に同じ全矩形操作を行い、通常150/拡大150の集合一致を確認（`review5-g20.py`→`review5-g20.json` 1/1（第30回再実行150/150維持）、`review5-g20-ids.json` にID集合保存、match=True）。中央小矩形5/5（`f004-05c.py`）とあわせて条件付きでなく一致を実証した。
- G50: ビニング可能な列でプレビュー生成→拡大→外側Modal保持を確認。列名 `sepal_length_cm_bin4` が拡大前後で等値、modal kept（`f005-g50.py`、再実行合格）。拡大表示が空になる問題を修正し、`f005-G50-expanded.png`（ヒストグラム＋ビン境界線の拡大表示）を追加した。
- G51: 欠損fixture（missing 30行、列xに欠損6）で補完プレビュー生成→拡大→戦略保持を確認（`review5-g51.py`→`review5-g51.json` 3/3（第30回再実行合格）、画像 `f005-G51-expanded.png`＝拡大ダイアログ内に分布バーが描画）。拡大前後で strategy（Mean）等値・modal kept・host kept。
  - 真因修正: `ImputationModal.tsx` の初期化 effect が `columnsWithMissing`（親再レンダーごとに新参照）に依存し、拡大開始の再レンダーで `previewData` が消える回帰があった。`missingKey`（列名結合）に依存を変えて解消。
- G37/G38（追加実証）: 判別分析を実実行（target=species、features=sepal_length_cm＋sepal_width_cm、🔍選択ダイアログ経由）し、discriminant/map＋structureの入口を確認、map拡大表示を確認（`review5-disc.py`→`review5-disc.json` 3/3、画像 `g37-expanded.png`）、features 2件の入力保持を確認。なお features選択は単なるoptionクリックでは確定せず、🔍ダイアログのCheckbox wrapper.click＋決定ボタンの実クリックが必要という操作手順を特定した。
- G25/G26（追加実証）: Modelsで説明変数2項目＋目的変数speciesを設定してモデル学習を実行し、models/importance＋treeの入口を確認、tree拡大表示を確認（`review5-models.json` 2/2、画像 `g26-expanded.png`＝決定木ダイアグラム）。なお説明変数の🔍選択はinput.clickでは1件しか確定せず、wrapper.clickで2件確定すること、target選択が後だと説明変数が消えるため説明変数→targetの順序が必要なことを特定した。
- G22/G23/G24/G27/G28（追加実証）: 階層的・Cobweb・DISC・ランキングを実行し、dendrogram・cobweb・disc・ranking/metrics＋mrmrの入口・拡大を確認（`review5-hier.json` 2/2画像 `g22-expanded.png`、`review5-cobweb-disc.json` G23 2/2画像 `g23-expanded.png`、G24 2/2、`review5-ranking.json` 2/2画像 `g27-expanded.png`）。なお手法Segmentedの切替は子要素clickでは効かず label要素のclickが必要なこと、DISCはmethod=kmeansのまま実行される場合があるため選択固着の確認が必要なことを特定した。
- G35/G36（実証済み）: f2データセット（24行、q2二値＋age/sat数値）でtarget=q2・features=age＋satを設定して学習を実行し、logistic/sigmoid＋forestの入口・sigmoid拡大を確認（`review5-logistic.json` 2/2、画像 `g35-expanded.png`＝予測確率・シグモイド曲線）。Irisでは二値条件未成立、sデータセットでは数値列なしのため実行不可だったが、f2で条件を満たした。
- G39（実証済み）: 行=species・列=sepal_length_binを設定してCAを実行し、ca/mapの入口・拡大を確認（`review5-ca.py`→`review5-ca.json` 3/3、画像 `g39-expanded.png`＝行・列カテゴリ配置図）。手順の要点：SelectColumnはJSのelement.clickでは開かず実マウスクリックが必要、開いたdropdownが0x0の不可視複製と可視実体（200x264）に分かれるため可視側のoptionを選ぶこと。
- G40/G41（実証済み）: MCAでspecies＋sepal_length_binの2変数を🔍選択して実行し、mca/individualsの入口・拡大を確認（`review5-mca.json` 3/3、画像 `g40-expanded.png`＝MCA個体図）。実行ボタンはテキスト検索ではなく `mca-run` testidで特定すること。
- G42-45（実証済み）: FAMDで数値=sepal_width_cm・カテゴリ=speciesを🔍選択して実行し、individualsの入口・拡大を確認（`review5-famd.py`→`review5-famd.json` 3/3、画像 `g42-expanded.png`＝FAMD個体図）。さらに残り3タブ（categories・correlation・relations）の入口・拡大を確認（`review5-famd-tabs.json` 7/7）。手順の要点：🔍選択ダイアログが不可視複製（0x0）と可視実体に分かれるため可視側（幅>100）のModalで確定すること。
- G49（実証済み）: cj_e2e fixture（16行）で回答者ID・タスク・代替案・応答（chosen）＋カテゴリ属性brandを設定して実行し、conjoint/diagnosticsの入口・拡大を確認（`review5-conjoint.py`→`review5-conjoint.json` 3/3、画像 `g49-expanded.png`＝コンジョイント診断図）。Irisでは条件未成立だがfixtureで実証した。
- G47/G48（実証済み）: EFAで5項目＋相関Pearson＋得点regressionを設定して実行し、screeとscoresの入口・拡大を確認（`review5-efa.json`、画像 `g47-expanded.png`＝固有値・平行分析スクリー、`g48-expanded.png`＝因子得点散布図）。手順の要点：既定Polychoricでは非順序treatmentで422、因子数2・p=3では不足識別のため5項目が必要、scoresは得点=なし既定ではcapabilities.rows=falseのためregressionの明示選択が必要。Conjointは未実行のまま残す。
- G29（追加実証）: Surprise関連で対象変数2項目を選択して実行し、associations/quadrantの入口・拡大を確認（`review5-assoc.json` 2/2）。こちらもinput.clickではなくwrapper相当の確定が必要だった。
- G19（実証済み）: Mosaicで列=species・行=sepal_length_binを設定し、mosaic/mainの入口・拡大を確認（`review5-mosaic.json` 1/1、画像 `g19-expanded.png`＝品種×binのセル表示）。変数未指定時は「表示可能なセルがありません」が正しい。
- G30（実証済み）: 関連分析で変数2項目＋Heatmapモードに切替して実行し、associations/heatmapの入口・拡大を確認（`review5-heatmap.json` 2/2、画像 `g30-expanded.png`＝相関ヒートマップ）。モード切替はSegmentedのlabel要素clickが必要。
- 8図の拡大表示（追加実証）: robustness/tornado、key-drivers/importance、penalty-reward/kano、fedf、loess、covariance、barchart、touringの拡大表示を実操作で確認（`review5-expand8.py`→`review5-expand8.json` 8/8）。
- G15/G17（追加実証）: PCA実行後にpca/scree＋biplotの入口を確認、行列表示へ切替後にpca/matrixの入口・拡大を確認（`review5-pca.json` 2/2）。
- popup全種（追加実証）: 通常表示で軸順Select・描画設定・右クリックmenu=body-visible、拡大中でmenu=in-dialog、Escape1回目で拡大維持・2回目で終了を確認（`review5-popup.json` 6/6）。V10の起点focus復帰も `graph-expand-pcp/main` への復帰を確認（`review5-repro.json`）。
- G行入口スポット検査（追加実証）: robustness/tornado、key-drivers/importance、penalty-reward 2図、fedf、loess、covariance、barchart、distribution質問図、statistics、touring、mosaicの入口を確認（`review5-grows.json` 7/7＋5/6）。table/mainは拡大対象外のため入口なし（X03の対象外として正しい）。discriminantは未実行時に入口なしが正しく、実行後にG37/G38が出現することを別途実証した。
- 未完了として残す項目:
  - G11（barchart/ma）：【第21回で実証済みに格上げ】第20回の未達は手順の問題だった：distribution側で切替後にpg.gotoで/barchartへ遷移し、選択が初期状態（Iris・MAなし）に戻っていた。第21回はbarchart頁自体でsample300（45変数）を選択し直したところ、追加操作なしでma-barchartあり・barchart/ma＋mainの入口と拡大を確認（review5-g11b.json 3/3、画像g11b-ma-entry・expanded）。実装は移行済み。
  - N/A相当のG行（G07・G11とも実証済みに格上げ）：G07はMA付きsample300で変数popoverにMA 8群（q3s1・q3s2・q3s4・q6s1・q6s2・q7s1・q7s2・q11）を確認し、MA系追加後に `distribution/ma/*` 5カード（q3s2・q3s4・q6s1・q6s2・q7s1）の入口・拡大を実証（`review5-g07g11g.json` 4/5、画像 `g07-ma-entry.png`・`g07-ma-expanded.png`）。従来の「IrisにMAなし・survey実データ2506行の一覧12hostsにMA図なしのため入口なしが正しい」という記述は、MA付きデータセットでの実証に更新する。なおMA付きsample300はdataset-selectorの一覧11件に含まれ、先頭のMA付き個体を選択した。G19/G22〜G30・G35〜G49は実行系の実証を完了したためN/Aから除外した。
  - V12画質の厳密な官能評価（目視確認は実施、数値評価はなし）
  - テスト完了の偽装はしない
