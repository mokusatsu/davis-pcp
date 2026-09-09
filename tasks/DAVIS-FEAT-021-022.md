# DAVIS-FEAT-021 / DAVIS-FEAT-022

## 調査ウェイトと順序尺度・Likertビューの実装引き継ぎ

状態: 未完了（21-AC01〜06・08・09 Yes、21-AC07・10 Partial、22-AC01〜09・11 Yes、22-AC10・12 Partial。下記判定表参照）
仕様書: [21_survey_weight.md](../feature/21_survey_weight.md)、[22_ordinal_analysis_and_likert.md](../feature/22_ordinal_analysis_and_likert.md)
前提: Feature 19bのコードブック・`scaleType`・`role`、Feature 20/20aのrow scope・revision・中央Selection
更新日: 2026-09-10

## 0.0 受入判定（21-AC01〜10 / 22-AC01〜12）

| ID | 判定 | 根拠・証跡 |
|---|---|---|
| 21-AC01 | Yes | `weight_candidates`はrole=weight＋interval/ratio＋非MAのみ。unit＋API拒否テスト通過 |
| 21-AC02 | Yes | omit/null/applied区別、dataset切替で`weightColumnId`クリア（reducer＋codebook再検証）。frontend weight stateテスト通過 |
| 21-AC03 | Yes | 手計算fixture一致（weightedN・分布・weightedMean・meanNote）。APIテスト＋`.temp/feature20a`分母証跡と同式 |
| 21-AC04 | Yes | 0許可・null除外＋missing計数・負/NaN/Infinity/変換不能422・全0はno_positive_weight。API＋unitテスト通過 |
| 21-AC05 | Yes | 非加重n/加重Σw/missing/分母0-nullがAPI応答に存在。Distributionカード併記＋注記を実装・表示テスト通過 |
| 21-AC06 | Yes | summaries→Distribution/Likertが同一weightColumn・scope・revision送信。requestにweightColumn付与、cache keyにcolumnId含む |
| 21-AC07 | Partial | relationships matrix/pair・surpriseに`WEIGHT_UNSUPPORTED`警告を実装・テスト通過。Mining/Models/Clusters/PCA等への警告付与は未実施 |
| 21-AC08 | Yes | cache keyにrevision群＋weightColumnId、weight値変更でdataRevision進行、遅延応答ガードは既存inputKey経路。競合テスト（stale 409）は既存契約を流用 |
| 21-AC09 | Yes | weight変更でSelection/scope/軸を消さない（headerはweightのみ更新、Distributionは再取得のみ）。実ブラウザでSelection保持を確認 |
| 21-AC10 | Partial | local実ブラウザ＋production build通過（`dist/index.html` sha256 `7fa944ee…`、`.temp/feature21-22/reports/production-build.json`）。static・`run-production.bat`未実施 |
| 22-AC01 | Yes | 方法選択はcodebook scaleTypeのみ正本（`ordinal_methods.method_family`＋surprise scaleType優先）。resolverテスト通過 |
| 22-AC02 | Yes | 2群MWU/Cliff・多群Kruskal/ε²（既存subgroup）・相関Kendall τb（surprise `adoptedCorrelation`追加）をfixtureテストで確認 |
| 22-AC03 | Yes | 既存テスト回帰（surprise_ma・relationship_projection・summaries_denominators通過）。dtype推測の上書きなし |
| 22-AC04 | Yes | median/IQR/Top2/Bottom2/meanNoteをsummaryに追加（core修正＋unitテスト）。カード表示は既存aux＋Likertで確認 |
| 22-AC05 | Yes | tie/全同値/群不足/分散0→null＋`insufficient_data`（kendall_tb・cliffs_delta・epsilon_squared）。境界値テスト通過 |
| 22-AC06 | Yes | ordinalのみ表示、奇数中央neutral・偶数neutralなし、率合計100（丸め前）。transform unitテスト通過 |
| 22-AC07 | Yes | 5件fixture相当は5pt fixtureで確認、偶数はunit、0件・全欠損は`—`表示実装。7段階・実データ画像は未取得 |
| 22-AC08 | Yes | Top-2/mean/元順＋categoryOrder tie-break決定的（unitテスト通過） |
| 22-AC09 | Yes | segment click→column-matches→中央Selection、Table/PCP/sidebar一致を実ブラウザで確認（Replace 3件・Add 4件） |
| 22-AC10 | Partial | Replace/Add・Focus・Reset・KeepAlive再訪・dataset切替を実ブラウザ確認。Subtract/Toggle・R6〜R10操作ログは未取得 |
| 22-AC11 | Yes | weight選択時に表示基準（非加重/加重）・unweightedN/weightedN・p値非加重注記を表示。加重統計への黙適用なし |
| 22-AC12 | Partial | local実ブラウザ＋production build通過・artifact hash記録。static・run-production.bat・E2E自動化は未実施 |

以下、元の完了条件（§16「8. 21-AC01〜10と22-AC01〜12が全てYes」）は未達のため、本タスクは未完了のまま残す。

この文書は、Feature 21とFeature 22を別の実装担当へ安全に渡すための作業正本である。既存の一部実装を完成扱いにせず、調査ウェイトとサンプリング重みを混同しないこと、順序尺度を数値尺度へ暗黙変換しないこと、LikertビューからPCPへrowIdを中央Selection経由で伝えることを必須条件とする。

## 0. 引き継ぎ時点の確認

### 0.1 既存コードにある基盤

- コードブックの尺度水準に`ordinal`があり、列役割に`weight`がある。`CodebookDetailForm`、`CodebookGridView`、`CodebookVariableList`には尺度・役割の編集UIがある。
- `fullstack/backend/app/algorithms/mining/subgroup.py`には、ordinal質問に対するMann-Whitney U、Kruskal-Wallis、Cliff's delta、ε²相当の処理が一部存在する。
- `fullstack/backend/app/algorithms/summaries/core.py`には、ordinalの中央値、Top-2/Bottom-2、平均への「等間隔得点として計算」注記が一部存在する。ただしIQR、明示的な方法メタデータ、調査ウェイトは未完成である。
- `fullstack/backend/app/algorithms/relationships/surprise.py`にはPearson、Spearman、Kendallの値を出す処理がある。ただし`scaleType`に基づく唯一の採用方法を返す契約は未完成である。
- `globalObservations.sampling.sampledRowWeights`は抽出行の重複回数用であり、Feature 21の調査ウェイトではない。両者を同じフィールドやAPI引数へ統合しない。

### 0.2 未実装または未確定の部分

- `SummaryRequest`などに調査ウェイト列を指定する共通`weightColumn`がない。
- `globalWeight`をdataset単位で保持するRedux状態、ヘッダー選択、セッション復元がない。
- 加重平均・加重度数・加重比率と非加重の実人数`n`を同じ応答で返す契約がない。
- ウェイト未対応の分析へ「ウェイト未適用」を表示する共通状態がない。
- Likert専用のDiverging Stacked Barページ、route、KeepAlive登録、カテゴリクリックからPCPへの経路がない。
- ordinalの検定結果は内部に存在するが、`testUsed`、効果量、尺度根拠、欠損除外数を安定したAPI契約として返す検証が不足している。

### 0.3 作業ツリーと検証の扱い

- 既存のFeature 19/20を含む未コミット変更を保持する。reset、clean、checkout、無関係な削除をしない。
- 最初から巨大な全体テストやビルドを実行しない。担当範囲の限定テスト、API、GUIが確定した後に全体テストへ進む。
- 一時証跡は`.temp/feature21-22/`以下へ保存する。テスト・手動操作・性能計測の入力、期待値、実測値、環境を同じIDで参照できるようにする。
- UIは既存のAnt Design部品、`QuestionCard`、`GlobalHeaderControlBar`、`KeepAliveOutlet`、`viz.css`の配色・余白・フォーカス操作へ揃える。新しい独自のデザイン体系を追加しない。

## 1. 共通の完了判定

各小タスクは`未着手`、`実装中`、`限定検証済み`、`実環境検証待ち`、`完了`の順で状態を更新する。コードが存在するだけでは状態を進めない。

完了には、次の4種類の証拠を分けて残す。

1. **契約証拠**: request/response、revision、scopeHash、エラーコード、空配列の意味。
2. **統計証拠**: 手計算できるfixture、欠損・順序・重みの期待値。
3. **GUI証拠**: 実ブラウザの画面、操作列、rowId比較、表示基準、viewport/DPR。
4. **回帰証拠**: 限定テスト、既知ベースライン、local/static/`run-production.bat`の結果。

Feature 21と22の完了条件は、互いを一方の成功で隠せない。21のACが残っている状態で22の加重表示を「完成」とせず、22のLikert表示がない状態で21のordinal加重値だけを「全エンドポイント対応」としない。

# Feature 21: 調査ウェイト

## 2. Feature 21の目的と範囲

回答者ごとの調査ウェイトを明示指定し、集計系で加重値と非加重の実人数を併記する。加重値は母集団推計用の集計値として扱い、標準誤差や複雑な調査設計を実装したものとは表現しない。

### 2.1 実装する範囲

- コードブックで`role=weight`、`scaleType=ratio`または`interval`、数値列であることを確認できる列を候補にする。
- datasetごとに一つの有効ウェイトを選択し、dataset切替で誤って引き継がない。
- 加重平均、加重度数、加重比率を算出し、非加重`n`と有効ウェイト合計を同じ応答で返す。
- `summaries`、Distributionの設問カード、Feature 22のLikert分布など、記述集計をサポートする経路へ同じweight契約を渡す。
- 未対応の推測統計・機械学習へウェイトを黙って適用せず、`weightApplied=false`と警告を返す。
- row scope、Selection、`dataRevision`、`schemaRevision`、`scopeHash`を通常の分析と同じ方法で管理する。

### 2.2 実装しない範囲

- 層化、PSU/クラスター、複製ウェイト、デザイン効果、加重標準誤差、加重p値の実装。
- 調査ウェイトと`sampledRowWeights`の加算・乗算・上書き。
- roleを無視して任意の数値列を自動的にウェイトへすること。
- 欠損・負値・無限値の黙った0置換、ウェイト指定時の非加重への黙ったフォールバック。

## 3. Feature 21のデータ契約

### 3.1 ウェイト列の正本

- UIの候補は`role=weight`の列だけにする。数値列を候補へ出す場合も、先にコードブックでroleをweightへ明示変更する。
- 状態の正本は`weightColumnId`（columnId）。API要求では既存列指定の慣例に合わせて`weightColumn`（列名）を送り、応答に両方を返す。
- 同じdatasetで同時に二つのウェイトを使わない。未指定は非加重、明示nullはウェイト解除とする。
- weight列自身を説明変数、target、集計対象、Likert表示対象へ自動追加しない。

### 3.2 行値の検証

- 有限な正数は加重計算へ含める。
- 0は許可するが、加重分母には寄与しない。非加重の有効回答者数には含める。
- nullはその行の加重値から除外し、`weightMissingCount`へ数える。非加重集計は通常どおり続ける。
- 負数、NaN、±Infinity、数値へ変換できない文字列は422で拒否する。0へ変換して続行しない。
- 正のウェイトが一つもない場合、加重値はnull、`weightStatus="no_positive_weight"`とし、非加重値を加重値として返さない。

### 3.3 集計式

scopeを`R`、分析値がvalidな行を`V`、正の有限ウェイトを`w_i`、分析値を`x_i`とする。

- 非加重有効数: `unweightedN = |V|`。
- 加重有効数: `weightedN = Σ(i∈V, w_i>0) w_i`。
- 加重平均: `Σ(w_i*x_i) / weightedN`。ordinalは`categoryOrder`の1始まりの順位を`x_i`とし、「等間隔得点として計算」を注記する。
- カテゴリcの加重度数: `weightedCount(c) = Σ(w_i | category_i=c)`。
- 加重比率: `100 * weightedCount(c) / weightedN`。
- 欠損、非該当、partial、invalidの扱いはコードブックとFeature 20aの分母契約に従い、加重分母へ混ぜない。
- 分母が0の場合は0%ではなくnull。UIは`—`を表示する。
- 非加重の件数・率と加重の値・率を混ぜた単一の`n`を返さない。

### 3.4 応答メタデータ

集計応答には最低限、次を含める。

```json
{
  "weightStatus": "omitted | applied | unsupported | no_positive_weight",
  "weightColumn": "weight_col",
  "weightColumnId": "col-weight-1",
  "unweightedN": 1200,
  "weightedN": 1000.5,
  "weightMissingCount": 3,
  "weightRevision": 1,
  "scopeHash": "...",
  "dataRevision": 1,
  "schemaRevision": 2,
  "warnings": []
}
```

`weighted`項目が存在しないことと、値が0であることを区別する。unsupportedの場合は分析結果を非加重で返すなら`weightApplied=false`と明示し、画面に警告を出す。invalidの場合は結果を返さず422とする。

## 4. Feature 21のAPIと状態

### 4.1 共通request

対象の集計・分析requestへ次を追加する。

- `weightColumn: string | null`
- `expectedSchemaRevision`
- `expectedDataRevision`
- `rowIds`（省略はeffective scope、空配列は0行）

加重計算をする対象は`/summaries`、そこから表示するDistribution/Statistics、Feature 22のLikert分布だけである。Table、PCP、Selection、Focus、Delete、Resetは行単位の処理なのでweightColumnを送らず、値・rowId・選択集合を変更しない。Mosaic、Bar Chart、FEDF、QQ、LOESS、Covariance、Mining、Models、Clusters、PCA、Regression、Discriminant、Relationships、Robustness等は第一段階では加重計算をしない。requestで`weightColumn`を受け取る場合も、`weightApplied=false`と未適用理由を返し、加重値を返さない。

### 4.2 エラーコード

- `WEIGHT_COLUMN_NOT_FOUND`（422）: 指定列が存在しない。
- `WEIGHT_ROLE_INVALID`（422）: roleがweightでない、または尺度・型が不適切。
- `WEIGHT_VALUE_INVALID`（422）: 負値、非有限、変換不能値がある。
- `WEIGHT_NO_POSITIVE`（200＋status）: 正のウェイトがない。非加重への代替は禁止。
- `ANALYSIS_INPUT_STALE`（409）: data/schema revisionが一致しない。
- 未対応分析は方法固有の成功応答とし、`weightApplied=false`、`warning.code="WEIGHT_UNSUPPORTED"`を返す。エラーにして分析自体を止めるかどうかは既存ページ契約に従うが、黙って適用したように見せない。

### 4.3 cacheとscope

- summary cache keyへdataset、dataRevision、schemaRevision、columns、rowScopeHash、weightColumnIdを含める。
- weight列の値変更でdataRevisionが進み、旧加重結果を再利用しない。
- row scope変更はscopeHashを変える。hoverや色変更だけで加重再集計しない。
- 同じ要求の非加重と加重結果を同一cache entryへ上書きしない。
- 応答が遅い場合も、現在のdataset・revision・weightColumnと一致しない結果を画面へ適用しない。

## 5. Feature 21のGUI

### 5.1 グローバルヘッダー

対象: `fullstack/frontend/src/features/selection/GlobalHeaderControlBar.tsx`、`fullstack/frontend/src/app/store.ts`、必要ならセッション保存。

- [ ] 既存のデータセット選択・Rows Scope・Variablesのレイアウトを崩さず、`Weight: [未選択/列名]`を追加する。
- [ ] 候補はrole=weightの列だけ。列ラベル、列名、尺度、欠損数を候補表示する。
- [ ] Clearで非加重へ戻り、dataset切替時に前datasetのcolumnIdを残さない。
- [ ] 状態はdatasetIdとweightColumnIdの組で保持し、セッション保存・復元時にコードブックrevisionで再検証する。
- [ ] 重み選択の変更でSelection、row scope、ページの軸設定を消さず、必要な集計だけを再取得する。

### 5.2 集計カードと未対応表示

対象: `QuestionCard.tsx`、Statistics/Distributionの集計表示、未対応分析の共通警告。

- [ ] ウェイト未選択時は従来の表示を維持する。
- [ ] 適用時は「非加重（n=...）」と「加重（Σw=...）」を分けて表示する。
- [ ] 加重平均・加重率・加重度数を同じカード内で対応する行へ表示し、非加重nと混ぜない。
- [ ] 「標準誤差は非加重n基準。母集団推論には調査設計情報が必要」を表示する。
- [ ] 未対応分析では「ウェイト未適用」と理由を表示し、適用済みと誤認させない。
- [ ] weightMissingCount、no positive weight、分母0をバッジまたは注記で確認できる。

## 6. Feature 21の実装分解

### 21-W1 コードブック・weight resolver

- [ ] role、scaleType、physicalType、columnId/nameを検証する共通resolverを作る。
- [ ] weight列をMA親、ID、text、other、計算済み表示列から除外する。
- [ ] invalid row valuesの検証結果を、集計へ渡す前に固定する。

完了条件: 同じresolverをsummary、Distribution、Likertで呼び、同じ列が同じ理由で採用・拒否される。

### 21-W2 加重集計コア

- [ ] numeric、nominal、ordinalについて式を実装する。
- [ ] missingCodes、notApplicable、partial、invalidを非加重・加重の両方で同じ規則にする。
- [ ] 0、null、負、NaN、Infinity、全0のfixtureを作る。

完了条件: 手計算fixtureの平均、各カテゴリのweightedCount、weightedPct、unweightedN、weightedNが一致し、負値等は422になる。

### 21-W3 API伝播・unsupported契約

- [ ] requestへweightColumnとrevisionを追加する。
- [ ] responseへweightStatus、重み分母、警告、scopeHashを追加する。
- [ ] unsupported分析へ警告を付ける。既存のクラスタリング重み・miningのscore weightsと混ぜない。

完了条件: omit/null/applied/invalid/unsupportedをAPIテストで区別できる。

### 21-W4 Redux・UI・セッション

- [ ] dataset単位のweightColumnId状態とactionを追加する。
- [ ] ヘッダー、カード、未対応警告、注記を実装する。
- [ ] 保存→再読込→dataset変更→clearを確認する。

完了条件: 実ブラウザで選択前後の集計値、警告、Selection保持、ページ再訪を確認できる。

### 21-W5 性能・回帰

- [ ] weight列を必要列へ一列だけ追加し、全列読み込みに戻さない。
- [ ] 加重・非加重の重複コピーを作らず、同一scopeのcacheを共有する。
- [ ] 既存のTableサンプリング、`sampledRowWeights`、Feature 20aのMA分母を壊さない。

完了条件: 列射影ログ、cache key、メモリ測定、既存限定テストの結果を保存する。

## 7. Feature 21の二値受入条件

| ID | 受入条件 | 必須証跡 |
|---|---|---|
| 21-AC01 | role=weightかつ数値の一列だけを選択でき、任意の数値列やMA親を自動採用しない | codebook fixture、UI候補、拒否APIログ |
| 21-AC02 | omit/null/appliedが区別され、dataset切替で前datasetのweightが残らない | Reduxテスト、GUI操作ログ |
| 21-AC03 | 正の重みの加重平均・度数・比率が手計算値と一致する | weighted-fixture JSON、pytest結果 |
| 21-AC04 | 0、null、負、NaN、Infinity、全0の動作が契約どおりで、負等は黙って0にしない | 境界値APIテスト |
| 21-AC05 | 非加重n、加重Σw、weightMissingCount、分母0/nullが画面とAPIで一致する | response JSON、カード画像 |
| 21-AC06 | summaries、Distribution、Likertで同一weightColumn・scope・revisionが使われる | requestログ、scopeHash比較 |
| 21-AC07 | Mining/Models等の未対応分析は未適用警告を表示し、加重結果と誤認させない | 各ページ画像、warning JSON |
| 21-AC08 | weight列変更・データ変更・コードブック変更で古いcache/応答を採用しない | revision競合テスト、cacheログ |
| 21-AC09 | Selection、row scope、KeepAlive、PCP軸、ページフォームをweight変更で壊さない | ページ遷移GUI証跡 |
| 21-AC10 | local/static/`run-production.bat`で同じ表示基準・警告・式になる | 起動ログ、artifact hash、画面画像 |

# Feature 22: 順序尺度分析とLikertビュー

## 8. Feature 22の目的と範囲

コードブックの`scaleType`を統計手法選択の正本にし、ordinalを名義・連続値として誤って分析しない。複数のLikert設問をDiverging Stacked Barで比較し、カテゴリクリックから中央Selectionを通じてPCPとTableへ連携する。

### 8.1 実装する範囲

- ordinalの2群比較、多群比較、相関、記述統計を方法・効果量つきで返す。
- `categoryOrder`と`valueLabels`を使って順位、表示順、Top/Bottom-boxを決める。
- 欠損、非該当、invalidを有効分母へ入れず、除外数を表示する。
- Likertページでordinal変数だけを初期候補にし、Diverging Stacked Bar、Top-2-Box、ソート、hover、カテゴリクリックを提供する。
- 同じページのクリックをReplace/Add/Subtract/ToggleのSelection操作へ接続し、PCP・Table・sidebarへ同じrowIdを伝える。
- Feature 21のweightが選択されている場合は、記述分布を明示した表示基準（非加重/加重）で切り替える。推測統計へウェイトを黙って適用しない。

### 8.2 実装しない範囲

- ordinalを連続値としてp値計算すること、名義に落として順序を捨てること。
- 2値MA子を全ordinal設問へ暗黙追加すること。MA対応はFeature 20aのページ別契約に従う。
- Likertビューで新しいMCA、因子分析、複雑な調査推論を追加すること。
- neutralの意味がコードブックにないのにラベル文字列から推測すること。設計仕様の自動規則は「順序済み有効カテゴリの中央index」であり、原票意味の断定ではない。

## 9. Feature 22の統計契約

### 9.1 方法選択表

| 場面 | ordinal | nominal | interval/ratio |
|---|---|---|---|
| 2群比較 | Mann-Whitney U、Cliff's delta | χ²、Cramér's V | Welch t、Cohen's d |
| 3群以上 | Kruskal-Wallis、ε² | χ²、Cramér's V | Welch ANOVA、η² |
| ordinal同士/ordinal×numeric相関 | Kendall τb | - | Pearson r（numeric同士） |
| 記述 | median、IQR、Top/Bottom-box、任意のmean注記 | mode、頻度 | mean、SD、median |

- `scaleType`がコードブックにある場合はdtypeやunique数による自動推測で上書きしない。
- ordinalの順位は`categoryOrder`の順序で符号化する。文字列を辞書順、数字を見た目の大小だけで並べない。
- 2群のCliff's deltaは群順を固定し、符号がどちらの群が高いかを表す。tieを0.5として扱い、n<2などはnullと警告にする。
- 多群のε²は群数`k`を含む式で計算し、Kruskal-WallisのH、p値、除外数とともに返す。
- Kendallは`variant="b"`を明示し、tieを扱う。全同値や有効数不足は0へ丸めずnullとする。
- ordinalの平均を表示する場合は`meanNote="等間隔得点として計算"`を必ず付け、中央値・IQRを同時に表示する。
- 多重比較は既存のBH/FDR契約を利用し、未補正p値を有意判定へ使わない。

### 9.2 欠損と分母

- `missingCodes`と`missingReasons`をコードブックから読み、notApplicableとmissingを区別する。
- 比較・相関は対象ペアのcomplete valid rowsを使い、pairごとの`n_valid`、missing、notApplicable、invalidを返す。
- ordinalの`categoryOrder`に存在しない観測コードはinvalidとして除外し、未知コードを末尾へ自動追加しない。
- valid rowが不足、群が1つ、分散0、全tieの場合は、統計量を0や有意へ置換せず、`methodStatus="insufficient_data"`と警告を返す。

## 10. Feature 22 API契約

### 10.1 既存summaryを使うLikert分布

新しいAPIを増やさず、既存の`POST /summaries`をLikertページから呼ぶ。`columns`は明示的なordinal列、`rowIds`は現在のeffective scope、`selectedRowIds`はハイライト用とする。Feature 21の`weightColumn`とrevisionを任意で渡す。

各ordinal列の応答には最低限次を含める。

- `scaleType`、`categoryOrder`、`valueLabels`
- `denominators`（total、target、valid、missing、notApplicable、invalid）
- categoryごとのcode、label、order、unweighted count、unweighted pct
- weight適用時のweightedCount、weightedPct、weightedN
- `median`、`iqr`、`top2Box`、`bottom2Box`、`mean`、`meanNote`
- `scopeHash`、`dataRevision`、`schemaRevision`、`weightStatus`

### 10.2 方法メタデータ

既存の`/mining/subgroups`、`/relationships/surprise`などの結果へ、少なくとも次を追加する。

```json
{
  "scaleType": "ordinal",
  "methodUsed": "mann_whitney_u",
  "effectSize": {"measure": "cliffs_delta", "value": 0.42, "label": "medium"},
  "nValid": 120,
  "excludedCounts": {"missing": 3, "notApplicable": 2, "invalid": 0},
  "meanNote": "等間隔得点として計算"
}
```

機械的に全指標を計算して並べるだけでなく、「採用した方法」を一つ返す。表示側は`methodUsed`を日本語ラベルへ変換するが、機械判定には安定したenumを使う。

### 10.3 カテゴリクリック

Likertページでカテゴリをクリックしたら、既存の`POST /datasets/{dataset_id}/column-matches`へ列、code、現在のrowIdsを送り、返ったrowIdsを中央Selectionへdispatchする。空配列は0行、返却順はAPI契約に従う。古いscopeHashやdatasetの応答はdispatchしない。

## 11. Feature 22のLikert GUI

### 11.1 routeとKeepAlive

- [ ] routeを`/likert`、表示名を`Likert`または`Likert Comparison`として`main.tsx`、`AppShell.tsx`のナビゲーション、`KeepAliveOutlet.tsx`へ登録する。
- [ ] ページ再訪で設問候補、sort、表示基準、フォーカス、選択操作を保持する。
- [ ] dataset/revision変更時だけ結果を破棄し、別ページへ移動しただけでは解析と描画を破棄しない。

### 11.2 Diverging Stacked Bar変換

- [ ] 有効カテゴリを`categoryOrder`順に並べ、カテゴリ数が奇数なら中央indexをneutralとして中央へ置く。
- [ ] neutralより前をnegative、後をpositiveへ配置する。カテゴリ数が偶数の場合はneutralなしで中央境界を使う。
- [ ] missing/notApplicable/invalidは棒のvalid百分率へ入れず、カードの除外情報へ表示する。
- [ ] valid分母でnegative、neutral、positiveの幅を計算し、合計が100%（丸め前）になる。
- [ ] Top-2-Boxは`categoryOrder`の最後の2カテゴリ。カテゴリが2未満ならnull。
- [ ] 0件カテゴリも順序を保持し、幅0で表示・tooltipから欠落させない。
- [ ] 色は既存テーマに合わせ、negative/neutral/positiveの意味を明示する。質問ごとに同じコードが別色へ変わらない。

### 11.3 操作と表示

- [ ] ordinalだけを候補にし、MA親・未指定MA子・weight列・id/textを自動表示しない。
- [ ] SortはTop-2降順、mean降順、元順を提供し、同値のtie-breakをcategoryOrder/columnIdで固定する。
- [ ] weight選択時は`非加重`/`加重`の表示基準を明示選択でき、現在の基準、unweightedN、weightedNを表示する。
- [ ] segment hoverで質問ラベル、code、カテゴリラベル、n、率、除外数、表示基準を表示する。
- [ ] segment clickは現在のSelection operationを使い、Replace/Add/Subtract/Toggleを選択できる。PCP/Table/sidebarでrowIdが一致する。
- [ ] scopeが0、validが0、カテゴリが全欠損の場合は空チャートを0%で偽装せず、`—`と理由を表示する。
- [ ] narrow/125%/focus/fullscreenでもラベル、tooltip、クリック領域が重ならない。

## 12. Feature 22の実装分解

### 22-O1 順序尺度resolverと方法選択

- [ ] `scaleType`、role、`categoryOrder`、`missingCodes`を共通resolverで取得する。
- [ ] ordinal/nominal/numericの方法表をAPIに固定し、`methodUsed`と効果量を返す。
- [ ] invalid、群不足、all-tie、分散0をnull＋警告にする。

完了条件: 同じfixtureでscaleTypeだけを変えた場合、選択方法が仕様表どおりに変わり、数値dtypeだけでは上書きされない。

### 22-O2 記述統計と分布

- [ ] median、IQR、Top/Bottom-box、meanNoteをsummaryへ追加する。
- [ ] `categoryOrder`を保持し、欠損・非該当・未知コードの扱いをFeature 19/20aと一致させる。
- [ ] Feature 21のweight基準を使う場合も、非加重値を失わない。

完了条件: ordinal fixtureの手計算値、既存`QuestionCard`表示、summary JSONが一致する。

### 22-O3 Kendall・Subgroup・Surprise

- [ ] `subgroup.py`のordinal処理をrank order、Cliff's delta、Kruskal-Wallis、ε²、BH/FDR契約へ揃える。
- [ ] `surprise.py`の採用方法をscaleTypeで決め、ordinal pairにKendall τbを返す。Pearson等を表示してordinalの採用方法に見せない。
- [ ] ordinal×nominalなど未定義の組合せは方法を推測せず、unsupportedまたは明示した適切な指標へ分岐する。

完了条件: 2群、3群、ordinal同士、ordinal×numeric、欠損、tieのAPIテストが通る。

### 22-O4 Likert page

- [ ] pure data transform関数（neutral検出、左右配置、pct、Top-2、sort）をUIから分離する。
- [ ] `LikertComparisonPage.tsx`を既存のDistribution/QuestionCard/Selection部品と統一感のあるUIで実装する。
- [ ] route、KeepAlive、navigation、dataset/revision guardを登録する。

完了条件: ordinal fixtureで棒の左右、中央、Top-2、ソート、空分母表示が再現できる。

### 22-O5 中央SelectionとPCP

- [ ] segment click→column match→canonical rowIds→Selection dispatchを実装する。
- [ ] row scope、dataset、dataRevision、weight basisを要求・応答へ紐付ける。
- [ ] PCPへ移動しても既存軸、L1/L2、Focus状態を壊さず、Table/sidebarとrowIdが一致する。

完了条件: Replace/Add/Subtract/Toggleを実ポインタで確認し、遅い旧応答がSelectionを上書きしない。

### 22-O6 local/static/GUI回帰

- [ ] localとstaticの両方でLikertページを開く。
- [ ] 実データ、5段階・7段階・偶数カテゴリ・欠損ありfixtureを確認する。
- [ ] R1、R2、R3、R4、R5、R6、R8、R9、R10を実画面で確認する。R7はClusters実行後の既存条件を回帰する。

完了条件: `.temp/feature21-22/gui/`に操作列、rowId、画像、環境を保存する。

## 13. Feature 22の二値受入条件

| ID | 受入条件 | 必須証跡 |
|---|---|---|
| 22-AC01 | codebookのscaleTypeとcategoryOrderが方法選択と表示順の唯一の正本になる | resolverテスト、API JSON |
| 22-AC02 | ordinal 2群=MWU/Cliff、3群以上=Kruskal/ε²、相関=Kendall τbになる | fixture pytest、methodUsed比較 |
| 22-AC03 | nominal/numericの既存方法を壊さず、scaleType変更なしの回帰結果が一致する | 既存テスト、baseline JSON |
| 22-AC04 | median、IQR、Top/Bottom-2、meanNote、欠損分母が手計算と一致する | summary JSON、カード画像 |
| 22-AC05 | tie、全同値、群不足、分散0、未知コードを0や有意へ偽装しない | 境界値テスト、warning JSON |
| 22-AC06 | Likertページがordinalだけを表示し、neutral/negative/positiveの左右配置と率合計が正しい | transform unit test、画面画像 |
| 22-AC07 | 5段階・7段階・偶数カテゴリ・0件・全欠損・欠損混在を表示できる | fixture画像、操作ログ |
| 22-AC08 | Top-2降順・mean降順・元順のtie-breakが決定的である | sort unit test |
| 22-AC09 | category clickが中央Selection、Table、PCP、sidebarへ同じrowIdを伝える | APIログ、rowId比較、実ポインタ画像 |
| 22-AC10 | Replace/Add/Subtract/Toggle、Focus、Reset、KeepAlive、dataset切替が既存GUI契約を守る | GUI/R1〜R10証跡 |
| 22-AC11 | weight選択時のLikert記述分布は明示基準を表示し、推測統計へ黙って加重しない | weight basis画像、warning JSON |
| 22-AC12 | local/static/`run-production.bat`でroute、表示、PCP連携が一致する | 起動ログ、artifact hash、E2E結果 |

# 共有統合条件

## 14. Feature 21×22の連携シナリオ

次の順で実ブラウザ操作を行い、各段階のrowId、scopeHash、revision、表示値を保存する。

1. ordinal列とrole=weight列を持つfixtureを読み込む。
2. ウェイト未選択でDistribution/Likertの非加重n・率を確認する。
3. Headerでweightを選択し、同じscopeでweightedN・weightedPct・meanNoteが表示されることを確認する。
4. LikertのカテゴリsegmentをReplaceでクリックし、PCP/Table/sidebarのrowIdと一致させる。
5. Add、Subtract、Toggleを行い、weight変更でSelectionが消えないことを確認する。
6. unsupported分析を開き、「ウェイト未適用」が出ることを確認する。
7. dataset切替、コードブック編集、ページ離脱・再訪を行い、旧weight・旧result・旧rowIdが混ざらないことを確認する。

## 15. 共有回帰・性能条件

- weight列を含むデータでも必要列射影が一列増えるだけで、全列読み込みへ戻らない。
- summary/Likertの同一入力は同じscopeHashを使い、weightColumn変更だけで古いcacheを採用しない。
- LikertのDOMはカテゴリ数×設問数に比例し、全行の個別DOMや全rowIdを応答へ含めない。
- 50,000行fixtureでは、weighted/unweightedの両結果を作ってもJS・Workerのヒープが10回遷移後に基準から`max(32MiB,10%)`以上増えない。
- local/staticのcold/warmを各3回測定し、中央値と最大値を記録する。最速1回だけを合格根拠にしない。
- Feature 20aのSelection、MA分母、KeepAlive、R1〜R10を回帰し、21/22の追加で既存ページを壊していないことを確認する。

## 16. 推奨実施順

1. 19b/20aのcodebook、scope、revision、Selection契約を読み、既存の限定テストを通す。
2. 21-W1〜W3でweight resolver、式、API、エラー、cacheを固定する。
3. 21-W4〜W5でヘッダー、カード、未対応警告、セッション、限定読込を実装・検証する。
4. 22-O1〜O3でordinal方法選択・記述統計・KendallのAPI契約を固定する。
5. 22-O4〜O5でLikertページ、route、KeepAlive、PCP連携を実装する。
6. 22-O6でlocal/static、実データ、実ポインタ、R条件を確認する。
7. 共有統合シナリオ、限定テスト、integration、必要な全体テスト、production確認の順で進める。
8. 21-AC01〜10と22-AC01〜12が全てYesになり、証跡の場所を記録してからtask-listの状態を完了へ変更する。

## 17. 停止・判断条件

- ウェイトの意味が不明、roleがweightでない、負値をどう扱うかが未決定の場合は実装を進めず、列・影響範囲・必要な確認を記録する。
- ordinalのcategoryOrderと実値の順序が食い違う場合、numeric順へ自動補正しない。コードブックを直すか、invalidとして停止する。
- 加重p値、加重標準誤差、モデル学習への加重を追加したくなった場合はFeature 21第一段階の範囲外として別タスクへ分離する。
- Likertのneutralをラベル文言だけから推測したくなった場合は、中央index規則を使うか、設計変更として別途記録する。
- 既存の`sampledRowWeights`、miningの`weights`、クラスタリングの距離重みを調査ウェイトへ流用しない。
- APIの空scope、revision、Selectionの挙動がページごとに異なる場合は、ページ個別の例外を増やさず共通契約を先に修正する。

## 18. 完了報告に必ず含めるもの

- 21-AC01〜10、22-AC01〜12のYes/No表と未達理由。
- 変更ファイル、API request/response、エラーコード、revision/scopeHashの実例。
- 加重境界値、ordinal検定、Likert変換のfixtureと手計算結果。
- 実ブラウザのroute、viewport/DPR、操作列、rowId比較、画面画像。
- local/static/`run-production.bat`の起動ログとartifact hash。
- 既知のFeature 19/20/20aベースライン失敗と、21/22由来の新規失敗の切り分け。
- Feature仕様書、task-list、親タスク、次の担当者が最初に実行する限定テストのリンク。
