# DAVIS-FEAT-020A

## MAスケーラビリティ設計の実装引き継ぎ

状態: 実装中（`DAVIS-FEAT-020` に従属）  
親タスク: [DAVIS-FEAT-020.md](DAVIS-FEAT-020.md)  
設計書: [feature/20a_ma_scalability_design.md](../feature/20a_ma_scalability_design.md)  
共通GUI受入条件: [fullstack/AGENTS.md](../fullstack/AGENTS.md)  
更新日: 2026-09-09

この文書は、20a設計書を実装担当者がそのまま作業へ移せる粒度に分解した引き継ぎ用タスクである。設計書の読み替え、未確認の値の自動補正、MA子列の暗黙展開を行わず、各チェックボックスに検証証跡を紐付けて進める。`DAVIS-FEAT-020` の完了判定は、この文書の必須条件をすべて満たし、実データと実GUIの証跡が揃うまで行わない。

## 1. 完了判定の使い方

各小タスクは次の状態だけを使う。

- `未着手`: 実装または検証を開始していない。
- `実装中`: コード変更中、または限定テストが残っている。
- `ローカル検証済み`: 対象テストと手動操作を通過したが、static/production確認が残っている。
- `実環境検証待ち`: コードと限定テストは通過し、local/static/`run-production.bat` の証跡待ち。
- `完了`: 下記の必須受入条件、性能条件、回帰条件、成果物条件をすべて満たし、証跡ファイルの場所が記録されている。

チェックボックスを付ける条件は「コードが存在する」ではなく、再現手順、入力、期待値、実測値、実行環境を `.temp/feature20a/` 以下に保存したことである。テストが通っていても実データ操作・ページ間連携・static実行が未確認なら完了にしない。

## 2. 引き継ぎ時点の前提

### 2.1 実データと設計上の固定値

- 実データは2,506行、209列。300行サンプルも同じ物理列を持つ。
- コードブックはMA 15グループ、MA 179列、通常列30列、親エンティティ45件。
- 観測コードは主に`0/1/98/99`。`q7s2`には`1`と`99`が同一行に混在する13行がある。
- `q3s1`の暫定期待値は `total=2506, target=1749, valid=1726, missing=23, partial=0, invalid=0, notApplicable=757`。
- `q7s2`の暫定期待値は `2506/1749/1726/10/13/0/757`。混在13行の原票上の意味が確定するまでpartialを変えない。
- `q6s1`の暫定期待値は `2506/2506/2506/0/0/0/0`。全0行66件は、設問定義が変わらない限り有効な回答者として扱う。

### 2.2 既に確認されている実装・検証

- TypeScriptの型チェックは通過済み。
- Clusters MA投影、Mosaic MA投影、関連するバックエンドAPI/unitの限定テストは通過済み。
- Clustersでは、MAのサービスAを明示追加してkmeansを実行し、39/40行、k=3、クラスタ10/19/10、平均シルエット0.639を確認済み。
- MosaicではArea×サービスAを明示し、非選択20行／選択19行を表示して中央Selection、Table、PCPへ同じrowIdを伝播できることを確認済み。
- これはFeature 20/20aの完了証拠ではない。R1〜R10、全登録ページ、local/static、性能、`run-production.bat` は残っている。

### 2.3 引き継ぎ時点で未確定または注意が必要な事項

- `q7s2`の`1+99`混在13行について、99が欠損か設問固有コードかは原票確認まで保留する。推測でselected/unselectedへ移さない。
- 全0の意味、`maxSelections`、回答者分母と延べ回答分母の表示先は、設計書の既定値を使い、原票で覆る場合だけ決定記録を更新する。
- Mosaicの空行scopeは、現行テストが`MOSAIC_EMPTY_DATA`を期待する箇所と、集計APIの「0件結果」を許す設計箇所がある。API契約を一つに決め、テスト・UI・引き継ぎ記録を同時に直す。
- 設計表にClustersのMA子を初回対象外とする記述があるが、現行方針は「明示追加したMA子は利用可能」で固定する。親からの暗黙展開は行わず、既存の明示MA対応を削除しない。
- 作業ツリーにはFeature 19/20を含む既存の未コミット変更が大量にある。リセット、clean、checkout、無関係な削除を行わない。

## 3. 範囲と禁止事項

### 3.1 実装する範囲

- 生のMA物理列、`__rowId__`、元コード、`valueLabels`を保持し、UIではMAを一つの設問として扱う。
- コードブックの`multiResponseGroups`、親カード、Table折りたたみ、指定された選択肢の0/1分析、グループ設定・保存・revision競合を共通契約にする。
- 回答状態（selected/unselected/notApplicable/missing/partial/invalid）、回答者分母、延べ回答分母、`any/all/unselected/status`検索を共通化する。
- グローバルな設問エンティティ、ページ固有の明示選択、中央Selection、scopeHash、dataRevision/schemaRevisionをページ間で共有する。
- 必要列・必要行だけの読込、Arrow/Polarsの射影、共有Promise、シリアライズ、local/static/Pyodideの逐次実行を実装・検証する。
- 設計書のページ行列に従って、各ページでMAの許可、除外、明示展開、派生カウントの扱いを表示・検証する。

### 3.2 実装しない範囲

- 新しいMCA、距離、重み付き推定量、MA固有の多変量検定。
- 物理MA列の削除、破壊的なデータ移行、親列への一括置換。
- ヒープ上限だけを理由にした実行拒否、暗黙のサンプリング、空配列を全列へ戻すフォールバック。
- ページ離脱を理由にしたKeepAlive中の解析結果、描画状態、フォーム、Worker要求の破棄。
- 設計書に列挙されていないMAページ統合を、近い見た目だけを根拠に追加すること。

## 4. 実装タスク分解

### 20A-A データモデル、コードブック、保存

#### 20A-A1 グループ定義と不変条件

対象: `multiResponseGroups`、`multiResponseOptionLabel`、コードブックの型・validator・read adapter。

- [ ] `groupId`は安定IDとし、表示ラベル変更で変化しない。
- [ ] `selectedCodes`と`unselectedCodes`は空でない重複なし集合、相互排他、missingコードとの重複なしにする。
- [ ] `allUnselectedMeaning`は`valid`/`missing`/`notApplicable`のいずれか、`maxSelections`は正数またはnullにする。
- [ ] `optionOrder`はメンバーを過不足なく一度ずつ並べ、同じ物理列を複数グループへ登録できないようにする。
- [ ] メンバーは同一roleかつnominalとし、ID・weight・other列をMAグループへ入れない。
- [ ] 旧辞書に親情報がない場合は読み取り時だけ一時グループを作り、保存・revisionを発生させない。
- [ ] 不正な0/1以外の値は定義エラーとして表示し、コードを推測変換しない。

受入条件: 不正な重複、空配列、順序欠落、親子重複、無効な`allUnselectedMeaning`を含む辞書が保存APIで422になり、既存辞書と元CSVは変更されない。正しい辞書は再読込後も同じgroupId、optionOrder、ラベルを返す。

#### 20A-A2 保存、削除、import/export、revision

- [ ] グループ変更を一トランザクションで保存し、`schemaRevision`を一度だけ進める。
- [ ] staleな`expectedSchemaRevision`は409で拒否し、後勝ち上書きをしない。
- [ ] 一時ファイル書込→置換でコードブックを更新し、途中の部分JSONを公開しない。
- [ ] グループ削除時は`optionOrder`を更新し、空親を削除する。元のMA物理列は残す。
- [ ] JSON import/exportでgroupId、ラベル、順序、意味、制約を保持する。
- [ ] CSV exportの制限（親表示と物理子列の関係）をUIまたは説明へ明示する。

証跡: `.temp/feature20a/acceptance/codebook-save.json` に成功・409・422・削除・import/exportの要求と応答、前後revision、ファイルハッシュを記録する。

### 20A-B 回答状態、分母、MA API

#### 20A-B1 値の正規化とセル状態

- [ ] 数値`1.0`は`"1"`へ正規化するが、文字列`"01"`は別値として保持する。
- [ ] null、NaN、無限値、未定義はmissingとして扱う。
- [ ] selectedCodesはS、unselectedCodesはU、notApplicable指定はN、欠損はM、その他はXとして内部状態を返す。
- [ ] 元値と`valueLabels`は状態計算後も失わない。

#### 20A-B2 グループ状態の優先順位

- [ ] Xが一つでもある、または`maxSelections`を超えた場合はinvalid。
- [ ] 全NはnotApplicable、Nと他状態の混在はinvalid。
- [ ] 全Mはmissing、S/UとMの混在はpartial。
- [ ] 全Uは`allUnselectedMeaning`へ従い、Sを一つ以上含むS/Uのみの行はvalid。
- [ ] partial行の既知Sは保持し、MをUへ補完しない。
- [ ] `[1,99]`と`[0,99]`はpartial、`[98,99]`はinvalidとして固定する。

#### 20A-B3 分母と表示値

- [ ] scope `R`に対して`total=|R|`、`target=total-notApplicable`、`valid=target-missing-partial-invalid`を返す。
- [ ] `selectedN[j]`はvalid行のS件数、`totalResponses=sum(selectedN)`とする。
- [ ] 回答者率は`100*selectedN/valid`、延べ回答率は`100*selectedN/totalResponses`とする。
- [ ] 分母0は0%ではなくnullで、UIは`—`を表示する。
- [ ] 全0のvalid行は選択数0として含めるが、missing/partial/invalid/notApplicableの派生値をvalidとして再利用しない。
- [ ] カード、Table、Distribution、Statisticsが同一scopeHashと同一分母を表示する。

#### 20A-B4 aggregate/matches API

- [ ] API入力に`datasetId`、`expectedDataRevision`、`expectedSchemaRevision`、`rowIds`、`groupIds`、必要時の`selectedRowIds`を含める。
- [ ] aggregate応答にrevision、scopeHash、グループ分母、`allUnselectedN`、`totalResponses`、各optionの`selectedN`、`selectedInSelection`、両率を含める。
- [ ] 基本aggregate応答に全rowIdを含めない。matchesだけがrowId一覧を返す。
- [ ] matchesはgroupId、optionColumnIds、`any/all/unselected/status`、status、rowIds、revisionsを扱い、dedupeと入力順を固定する。
- [ ] 大きなrowId集合は分割しても、中央Selectionへの反映は全チャンク完了後に一度だけ行う。
- [ ] `rowIds`省略は現行effective scope、`rowIds=[]`は0行、`entities=[]`は0項目を意味し、空配列を全件へ戻さない。

#### 20A-B5 エラー契約

- [ ] 定義不正は422 `MA_DEFINITION_INVALID`。
- [ ] ページや方法がMAに対応しない場合は422 `MA_METHOD_UNSUPPORTED`とし、UIでoption-level analysisへの案内を出す。
- [ ] revision不一致は409 `ANALYSIS_INPUT_STALE`。
- [ ] 実行対象0件は422 `EMPTY_ANALYSIS_INPUT`または、集計契約で定めた空結果のどちらかに統一する。Mosaicの判断を先に固定し、全API・テストへ反映する。

### 20A-C エンティティ、行scope、中央Selection

#### 20A-C1 エンティティとページ設定

- [ ] グローバル変数は通常列`{kind:"column", columnId}`またはMA親`{kind:"ma", groupId}`だけを持つ。
- [ ] 旧`activeVariableIds`はadapterでのみ扱い、二重の正本にしない。
- [ ] ページ設定はdataset+route単位でエンティティ、明示展開optionId、軸順、集計基底を保存する。raw arrayやReact elementを保存しない。
- [ ] 実行scopeは「グローバル許可∩ページ明示対象∩scale/role対応」。狭めた場合は除外理由を返し、広げても自動追加しない。
- [ ] MAだけが残る場合は親の空targetを表示し、子を自動選択しない。

#### 20A-C2 row scopeとversion

- [ ] effective row scopeが変わるときだけ`rowScopeVersion`を進める。
- [ ] hoverやハイライトはaggregateを再実行しない。Selected scopeの変更は再実行する。
- [ ] ページ離脱・再訪でKeepAlive中のscope、結果、描画、軸、フォームを保持する。
- [ ] dataset/dataRevision/schemaRevision変更時は古い応答を破棄し、現在の画面へ適用しない。

#### 20A-C3 Selection操作

- [ ] MAカードの選択行はvalid populationと一致し、中央Selectionへcanonical rowIdsをdispatchする。
- [ ] `Replace/Add/Subtract/Toggle`は既存selection semanticsを保ち、R外の行をAdd/Subtractで黙って削除しない。
- [ ] any/all/unselected/statusの選択と「部分回答を確認」を別操作として実装する。
- [ ] 「PCPへ表示」は既存軸を全MAで置換せず、ハイライト・移動だけを行う。MA option軸は別操作で追加する。

### 20A-D 読込、コピー、cache、実行寿命

#### 20A-D1 限定読込と射影

- [ ] `DatasetStore`はParquet/Polars scan/readで必要物理列、`__rowId__`、MA依存列だけを読む。
- [ ] responseには要求列だけを返し、MA親を表示するために全物理列をブラウザへ送らない。
- [ ] ブラウザ側Arrowを主経路とし、全列に対する`Array.from`や行オブジェクト化を行わない。
- [ ] MA状態は可能な箇所でUint8等の小さい表現を使い、同一入力の独立コピーを作らない。

#### 20A-D2 cacheと共有Promise

- [ ] raw cache keyはdataset+dataRevision+physical columns+rowScopeHash。
- [ ] codebook/MA cacheはschemaRevision+group、aggregate cacheはrevision+groups/columns+scopeHash+method/params、highlightはselectionHashを含める。
- [ ] 同一要求のin-flight Promiseは共有する。失敗・取消の結果はcacheしない。
- [ ] schema/data/row scopeが変わると該当cacheだけを無効化し、関係ないページの結果を消さない。

#### 20A-D3 ページ寿命、取消、Pyodide

- [ ] ページhideはcancelやevictの理由にしない。明示取消だけが解析を止める。
- [ ] local/staticの重い処理は一度に一つ、待ち行列と明示取消を持つ。
- [ ] Pyodide FSはページ離脱・エラーだけで破棄しない。dataset/revision変更時の明示無効化を実装する。
- [ ] 旧要求のfinallyが現在要求のloading/result/errorを上書きしない。

### 20A-E ページ別MA統合

各行について「初期表示」「明示展開」「除外理由」「Selection連携」「テスト証跡」を個別に残す。親を表示することと子を分析軸にすることを混同しない。

#### 20A-E1 Overview / Codebook / Table

- [ ] Overviewは物理列数と設問数を分け、MA親を1設問として表示する。
- [ ] Codebookは15親、子ラベル、候補プレビュー、保存後のrevisionを表示する。
- [ ] Tableは親を1列として折りたたみ表示し、明示した子だけを列展開する。ページング最大100行、横方向の要求列を最大12件へ制限する。
- [ ] 行選択、Table→Selection→PCP/カードのrowIdが一致する。

#### 20A-E2 Distribution / Bar Chart / Statistics

- [ ] Distributionは親カードとoption別の回答者数・延べ回答数を分ける。通常列カードとの排他的配置を保つ。
- [ ] Bar Chartは指定MA optionのカウントまたは属性別選択率だけを扱い、同一グループの二重カウントをしない。
- [ ] StatisticsはMAの分母・選択率を表示し、SAの平均・中央値・Top2をMAへ流用しない。
- [ ] すべての分母0、partial、invalid、notApplicableを表示し、0とnullを区別する。

#### 20A-E3 PCP / 軸追加

- [ ] PCP初期軸は通常列10件。MA親は未展開で、明示したoptionまたは派生カウントだけを追加できる。
- [ ] option軸は0/1目盛りとラベルを持ち、親を勝手に数値化しない。
- [ ] PCPからの選択、既存軸保持、Table/カードへの反映を実ポインタで確認する。

#### 20A-E4 Relationships / Surprise / Mosaic

- [ ] Relationshipsは通常列の集約行列を初期表示し、MAは明示したbinary relationとfocus pairだけを追加する。全pair SVGを作らない。
- [ ] Surpriseは明示targetだけを使い、同一親の子同士を既定で組み合わせない。
- [ ] Mosaicは通常カテゴリ×明示MA optionのselected/unselectedを許可し、MAを排他的カテゴリにはしない。
- [ ] Mosaicセル選択が中央Selectionへ入り、Table/PCPのrowIdと一致する。空scopeの契約は20A-B5で固定した結果に従う。

#### 20A-E5 Mining / Ranking / Models

- [ ] Miningは属性子を条件、設問子をselection-rate targetとして明示指定でき、同じ子を条件とtargetへ同時利用しない。
- [ ] Rankingはtargetと候補を明示し、binary optionを使う。親の重要度を単純合計しない。
- [ ] Modelsは1 option=1 binary featureとし、親のone-hot pairを自動生成しない。

#### 20A-E6 Logistic / Discriminant / Key Drivers

- [ ] LogisticはMA子をbinary target/featureにできるが、親自身はtargetにしない。定数・分離を診断表示する。
- [ ] Discriminantは通常列を初期値とし、明示MA子は許可する。共線性、クラス数、サンプル数、次元数を診断する。
- [ ] Key Driversは通常の数値・順序尺度を初期値とし、明示MA子を許可する。親の重要度をnaive sumしない。

#### 20A-E7 Penalty-Reward / Robustness / PCA / Touring / Clusters / Others

- [ ] Penalty-Rewardは順序尺度だけを対象とし、selected/unselectedを満足・不満へ解釈しない。
- [ ] Robustnessは元分析で許可された子だけを再利用し、再標本化時に全列へ拡大しない。重い処理は逐次実行する。
- [ ] PCA/Touringはinterval/ratioと明示ordinalを対象にし、MA子は初期対象外。MCA/グループ重みはFeature 27へ残す。
- [ ] Clustersは現行方針に従い、明示追加したMA子を利用可能にする。ただし親からの暗黙展開はしない。
- [ ] Covarianceはnumericと明示ordinal、QQ/LOESS/FEDF/箱ひげはnumericまたは明示派生カウントだけを対象にする。
- [ ] Outliers、Models等の既存MA対応ページは、同じentity/scope/revision契約へ揃える。

### 20A-F GUI連携とR1〜R10

#### 20A-F1 Selectionと実ポインタ

- [ ] R1: グラフで選んだ行がTable、PCP、sidebarへ同数で反映される。
- [ ] R2: Table checkbox選択が各対象グラフでハイライトされる。
- [ ] R3: 散布図は矩形＋点クリック、集約図はビン・グループを、JS合成でなく実ポインタで選択できる。
- [ ] R4: ページ単位の「選択」メニューがReplace/Add/Subtract/Toggle、解除、Focus、Delete、Resetを提供し、全パネルが同じ集合演算を使う。
- [ ] R5: 点・棒・セル・カードのhoverでrowIdまたは設問/option情報が表示される。

#### 20A-F2 色、ブラシ、dataset切替

- [ ] R6: 有効観測値1〜20種類（numericを含む）のL1 colorByを選択でき、21種類は拒否され、ページ間で同一値が同色になる。
- [ ] R7: Clusters実行後、L2の輝度ステップをON/OFFするとCanvasが即時再描画される。
- [ ] R8: ブラシ中の矩形が`fill rgba(42,120,214,0.15)`、`stroke #2a78d6`、幅1.5、最上位、`pointerEvents:none`で表示される。
- [ ] R9: 列数の大きいCSV、全NaN列を含むCSV、MAを含む別datasetへ切り替えても旧結果・Selection・ラベルが混ざらない。
- [ ] R10: プロット領域のドラッグでテキスト選択が起きず、`getSelection()`が空でcomputed `user-select`が`none`になる。

証跡: `.temp/feature20a/gui/` にページ、viewport/DPR、dataset、操作列、期待rowId、実測rowId、スクリーンショットを保存する。R3は実ポインタの操作ログを必須とする。

### 20A-G local / static / Pyodide / production

- [ ] local開発サーバーで、実データを読み込み、Codebook→Table→PCP→Distribution/Mosaic→分析ページを通して明示MAの選択とSelection伝播を確認する。
- [ ] static配布物で同じ操作を確認する。重い要求は同時に一つだけ実行し、待ち行列、取消、エラー復帰を確認する。
- [ ] Pyodide経路で同じrevision・scopeHash契約を確認し、FSをページhideで破棄しないことを確認する。
- [ ] `run-production.bat` で変更が表示される状態を確認し、起動ログ、URL、ビルド生成物のハッシュを記録する。
- [ ] buildは実装範囲と限定テストが確定した後に行う。開始時点で巨大な全体テストや配布ビルドを実行しない。

### 20A-H 性能、メモリ、負荷

#### 20A-H1 ベンチマーク入力

- [ ] 実データ3種（MAを含む通常ケース、欠損・全NaN列を含むケース、別dataset）を用意する。
- [ ] 50,000行×209列の一時fixtureを生成し、生成元・ハッシュを記録する。
- [ ] 各ページと、PCP→Distribution→Table→Relationships→Mining→Modelsの10サイクルを、local/staticのcold/warmで各3回測定する。
- [ ] OS、CPU、RAM、ブラウザ、viewport、DPR、dataset、revision、scope、実行時刻を記録する。

#### 20A-H2 合格条件

- [ ] OOM、クラッシュ、Worker errorがない。大入力でメモリ不足になった場合は拒否して合格にせず、分割・逐次化を見直す。
- [ ] MAカードは最大12親、option表示は最大20件。初期Arrow読込は全列にならない。
- [ ] Tableは最大100行・最大12エンティティで、全行オブジェクトを生成しない。
- [ ] Relationships等はpairごとの大量DOM円を生成しない。
- [ ] 同一要求のcache共有と、hiddenページでのcache evictionなしをログで示す。
- [ ] staticの重い処理は同時に1件。light operationは100ms以下、warm時のカード/Table要求は2秒以下を目標とする。
- [ ] GC後の10サイクル目ヒープが2サイクル目に対して`max(32MiB, 10%)`を超えて増加しない。JSとWorkerを分けて記録する。
- [ ] 3回の中央値と最大値を保存し、最速1回だけを合格根拠にしない。

### 20A-I 回帰、成果物、最終監査

- [ ] 変更箇所のunit/Vitest/pytestを先に実行し、失敗原因を実装由来・既存ベースライン・環境に分ける。
- [ ] integration/APIを実行し、revision競合、空配列、scopeHash、Selection伝播、cancel後の結果保持を確認する。
- [ ] 対象範囲の限定テストが全て通った後に全体テストを実行する。Feature 19から継承した既知失敗2件はベースラインとして別記する。
- [ ] production build、local、static、実ブラウザ操作の順で確認する。
- [ ] `git diff --check`を実行し、対象ファイルの差分、テスト結果、スクリーンショット、性能ログを証跡ディレクトリへ保存する。
- [ ] task-list、親タスク、設計タスク、引き継ぎ文書の状態とリンクを一致させる。

## 5. 必須受入条件（二値判定）

以下は全て`Yes`でなければ20aを完了にしない。

| ID | 受入条件 | 必須証跡 |
|---|---|---|
| AC-01 | 0/1/98/99/null、不正、全0、partial、invalid、notApplicableの状態と優先順位がfixtureと実データで一致する | 状態表、fixture出力、q3s1/q7s2/q6s1再集計 |
| AC-02 | 回答者分母と延べ回答分母、分母0のnull表示、option別件数が全対象ページで一致する | aggregate JSON、画面画像、scopeHash |
| AC-03 | codebook保存・再読込・import/export・削除・stale 409が原子性とrevision契約を満たす | APIログ、前後辞書、revision/hashes |
| AC-04 | `rowIds=[]`、`entities=[]`、省略行の意味が全APIで一致し、空を全件へフォールバックしない | APIテストとリクエストログ |
| AC-05 | 明示MA子だけが分析に入り、未指定兄弟・親の暗黙展開・物理列削除がない | ページ別設定、射影列ログ、画面画像 |
| AC-06 | 中央SelectionのReplace/Add/Subtract/Toggle、Focus、Reset、Table/PCP/カード/グラフのR1〜R5が実ポインタで通る | GUI操作ログ、rowId比較、スクリーンショット |
| AC-07 | L1/L2、ブラシ矩形、dataset切替、user-selectのR6〜R10が通る | GUI操作ログ、computed style、画像 |
| AC-08 | KeepAlive、遅い旧応答、cancel、dataset/revision変更で結果・描画・Selectionが壊れない | race/cancelテスト、再訪画面、ログ |
| AC-09 | localとstaticで実データを使い、Pyodideと`run-production.bat`の動作を確認する | URL、起動ログ、artifact hash、画面証跡 |
| AC-10 | 3実データ＋50k×209 fixture、10サイクル、cold/warm 3回測定がメモリ・時間条件を満たす | 性能CSV/JSON、環境情報、中央値・最大値 |
| AC-11 | 対象限定テスト、integration、全体テスト、production buildの結果と既知ベースラインを区別して記録する | test report、build log、失敗分類 |
| AC-12 | task-list、親タスク、20aタスク、設計書の状態・リンク・残務が一致する | 最終差分とリンク検査 |

## 6. 推奨実施順

1. `20A-A1`〜`20A-B5`を先に固定し、状態・分母・空配列・revisionの契約テストを通す。
2. `20A-C1`〜`20A-D3`を実装し、Selection、rowScope、射影、cache、KeepAliveの共通経路を揃える。
3. `20A-E1`〜`20A-E7`をページごとに実装・検証する。ページをまたいだ選択を各ページ完了条件に含める。
4. `20A-F1`〜`20A-F2`を実ポインタで一巡し、GUI証跡を揃える。
5. `20A-G`でlocal/static/Pyodide/productionを確認する。
6. `20A-H`の性能計測を行い、計測結果に応じて射影・分割・共有Promiseだけを調整する。拒否ゲートを追加しない。
7. `20A-I`で限定テスト、全体テスト、build、成果物、リンクを最終監査し、AC-01〜AC-12を全てYesにする。

## 7. 引き継ぎ開始手順

作業開始時は、既存の変更を確認してから対象コードを読む。作業ツリーを戻す操作はしない。

```powershell
Set-Location C:\dev\davis-pcp
git status --short
git diff --check
rg -n "multiResponse|ma_projection|rowScope|scopeHash|schemaRevision|dataRevision" fullstack/backend fullstack/frontend
```

最初に実行するテストは変更範囲の限定テストだけにする。TypeScript、対象API、対象ページのテストが通った後で、必要なintegration、全体テスト、production buildへ進む。証跡は`.temp/feature20a/`に保存し、既存の`.temp`以外へ一時ファイルを作らない。

## 8. 停止・判断ゲート

- 原票確認が必要な値（`q7s2`混在、全0、`maxSelections`）に遭遇したら、推測でコードや辞書を修正せず、未確定値・影響ページ・必要な確認内容を記録する。
- APIの空scope、partialの扱い、invalidの扱いがページ間で食い違ったら、実装を追加せず契約を一つに決めてからテストとUIを同時に更新する。
- schemaRevision/dataRevisionの競合を回避するために、後勝ち上書き、古い応答の採用、暗黙再読込を追加しない。
- 性能不足の対策は射影、共有、分割、逐次実行、表示上限で行い、容量見積りによる実行拒否や無言サンプリングを追加しない。
- ユーザー確認が必要な外部ダウンロード、環境変更、破壊的操作が発生した場合は、その操作を止め、対象・理由・代替案を記録する。

## 9. 完了報告に含める内容

- AC-01〜AC-12のYes/No一覧と、Noの残理由。
- 実行したテストコマンド、件数、失敗の分類、既知ベースライン。
- 実データ・fixture・local/static/productionの操作証跡のパス。
- 性能測定の環境、中央値、最大値、ヒープ増加、Worker/JS別の値。
- 未確定の原票事項、仕様判断、次タスクへ残す除外範囲。
- `DAVIS-FEAT-020.md`、`DAVIS-FEAT-020-DESIGN.md`、`tasks/task-list.md`との状態・リンク整合。
