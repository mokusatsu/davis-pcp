# MAの設問単位表示・分析・メモリ制御 詳細設計

文書ID: DAVIS-FEAT-020A / 版: 1.1 / 日付: 2026-09-08  
状態: 設計案。実装未着手。  
関連: [Feature 20](20_multiple_answer_support.md)、[Feature 19](19_question_denominators.md)、[Feature 19b](19b_codebook_system_integration.md)、[Feature 15](15_global_variable_observation_selection.md)、[Feature 27](27_pcp_mca_ui.md)。

## 1. 設計方針と範囲

元のMA列と回答者IDを保持し、閲覧・変数選択ではMAを1設問として扱う。選択肢の0/1列を必要とする分析だけが、指定した選択肢を展開する。親設問を数値1列に自動置換しない。

本設計はFeature 20の回答者／延べ回答ベース、グループ定義、PCP連携を具体化する。グループAPI、分母、列取得、ページ初期動作については本書を実装時の基準とする。Feature 20記載の未実装APIに合わせるための互換エンドポイントは追加しない。

初回実装に含めるもの:

- 既存のmultiResponseGroupを利用した親設問表示、MAカード、表の折りたたみ、指定選択肢の分析。
- コードブックのグループ設定、回答状態判定、厳密な分母、中央Selectionへの変換。
- 列・行の限定読込、集計と生値の分離、重複コピーの削減、重い処理の逐次実行。
- ローカル版とPyodideによるブラウザ単体版の両方。

初回実装に含めないもの:

- MCA、新しいクラスタ距離、新しい重み付き推定、複数回答専用の多変量検定。
- MAを文字列集合に書き換えるデータ移行、入力CSVからのMA列削除。
- ヒープ上限を引き上げるだけの対策、集計対象の無告知サンプリング。

これらを必要とするページでは未対応理由を示し、利用可能な選択肢別分析へ誘導する。

## 2. 対象データと現在の増幅箇所

### 2.1 読取確認結果

| データ | 行 | 物理列 |
|---|---:|---:|
| opendata_2025_survey_davis.csv | 2,506 | 209 |
| opendata_2025_survey_davis_sample300.csv | 300 | 209 |
| opendata_2025_survey_davis_sample300_noMA.csv | 300 | 30 |

コードブックではMAが15グループ・179列、その他が30列。親設問としては45項目となる。45項目にはID等も含むため、分析可能な項目数とは区別する。

| グループ | 選択肢数 | role |
|---|---:|---|
| q3s1 / q3s2 / q3s4 | 9 / 11 / 13 | question |
| q6s1 / q6s2 | 19 / 18 | question |
| q7s1 / q7s2 | 16 / 16 | question |
| q11 / q12 | 16 / 8 | question |
| q14s1 / q14s2 | 12 / 13 | question |
| q17 | 6 | question |
| qF5 / qF6 / qF7 | 5 / 8 / 9 | attribute |

MAセルの観測コードは0、1、98、99。q7s2には1と99が混在する13行がある。多くの設問に全0行がある。これらを読込時に一律補正しない。

### 2.2 実装上確認した問題

| 箇所 | 現在の処理 | 対応 |
|---|---|---|
| useDatasetColumns.ts | 列指定なしのArrow取得、通常配列とFloat64Arrayの併存 | 列指定・型別キャッシュ・要求共有 |
| api/datasets.py のview | 全DataFrame読込後にselect | Parquet読込段階で射影 |
| RelationshipsPage.tsx | 列の二重ループ内で全回答者のcircle/titleを生成 | 対象列の明示、集約行列、焦点ペアのみ点描画 |
| KeepAliveOutlet.tsx | 訪問済み画面をdisplay:noneで保持 | 保持方式を継続。ページ離脱を理由に結果・描画データを破棄しない |
| DistributionPage.tsx | 全列要約に加え全列生値も取得 | 表示中の設問集計だけ取得 |
| Mining / Surprise | 画面表示時の自動計算 | 指定対象で実行し、重い処理はキューで逐次実行 |
| コードブック更新 | ラベル変更でも全列キャッシュを再構築 | 生値と意味定義のrevisionを分離 |

全データの数値配列1本は約4 MiB。一方、現在の型推定では207列が数値候補になり、全ペア描画の点候補数は2,506×207×206＝106,860,852。circle以外のReact要素・title・イベントも付く。これはコードと入力から求めた規模であり、OOM時の実測ヒープではない。

## 3. データモデル

### 3.1 正本とID

- 生データの正本は従来のParquetと__rowId__。物理列の追加・削除は行わない。
- 列の所属の正本は既存 `CodebookColumn.multiResponseGroup`。1列は最大1グループに所属する。
- 親設問のIDはdatasetId内で一意なgroupId。表示用entityは `{kind:"ma", groupId}`、通常列は `{kind:"column", columnId}` とする。文字列プレフィックスだけで型を判別しない。
- groupIdの変更は新規グループへの移動として処理する。ラベル変更でIDを変えない。
- グループのメンバー集合を別のvariables配列にも保存しない。所属の二重管理を避ける。

### 3.2 コードブック拡張

ルートに `multiResponseGroups` を追加し、列に `multiResponseOptionLabel` を追加する。既存フィールドは保持する。

```json
{
  "datasetId": "ds-example",
  "schemaRevision": 2,
  "multiResponseGroups": [
    {
      "groupId": "q3s1",
      "label": "投票した理由（3つまで）",
      "selectedCodes": ["1"],
      "unselectedCodes": ["0"],
      "allUnselectedMeaning": "valid",
      "maxSelections": 3,
      "optionOrder": ["col-a", "col-b"]
    }
  ],
  "columns": [
    {"columnId":"col-a","name":"q3s1c1","label":"投票した理由【候補者】","scaleType":"nominal","role":"question","valueLabels":{"0":"非選択","1":"選択","98":"非該当","99":"無回答"},"categoryOrder":["0","1"],"missingCodes":["98","99"],"missingReasons":{"98":"非該当","99":"無回答"},"multiResponseGroup":"q3s1","multiResponseOptionLabel":"当選させたい候補者がいた"},
    {"columnId":"col-b","name":"q3s1c2","label":"投票した理由【政党】","scaleType":"nominal","role":"question","valueLabels":{"0":"非選択","1":"選択","98":"非該当","99":"無回答"},"categoryOrder":["0","1"],"missingCodes":["98","99"],"missingReasons":{"98":"非該当","99":"無回答"},"multiResponseGroup":"q3s1","multiResponseOptionLabel":"支持する政党があった"}
  ]
}
```

| 属性 | 契約 |
|---|---|
| selectedCodes / unselectedCodes | 正規化コードの重複なし配列。互いに素で、missingCodesとも重ならない。初回は全メンバー共通 |
| allUnselectedMeaning | valid / missing / notApplicable。全メンバーが既知の非選択の場合だけ適用。既存0/1辞書の既定はvalid |
| maxSelections | 正整数またはnull。原票を確認して設定。質問文から自動確定しない。超過行はinvalid |
| optionOrder | 所属列のcolumnId順。空または省略ならコードブック列順。指定時は全所属列を各1回含める |
| multiResponseOptionLabel | 選択肢の短い表示名。省略時は既存label、さらにnameへフォールバック |

roleとscaleTypeは列定義を正本とする。グループ内roleは同一、scaleTypeはnominalを要求する。混在グループは閲覧・修正は可能だが集計・モデル投入を拒否する。role=other/id/weightのグループは分析候補にしない。

メンバーのisReversed=trueはグループ定義エラーとする。選択の意味はselectedCodesで決まり、0/1を反転して置換しない。PCPで上下を逆に見たい場合はページの軸反転だけを使う。selectedCodes/unselectedCodesはそれぞれ1件以上、グループ所属列も1列以上を要求する。

設問名はグループ側、選択肢名は列側に持つ。長い既存labelの「【…】」分解や共通接頭辞抽出は編集候補の提示だけに使用し、自動上書きしない。

### 3.3 既存辞書の適合

1. 明示されたmultiResponseGroupから所属を読み取る。列名プレフィックスだけでは自動確定しない。
2. 親定義がないグループは読取時に暫定定義を生成する。groupIdをラベルとし、選択1／非選択0、全0=valid、上限選択数なし、列順を使用する。
3. メンバーのcategoryOrder、missingCodes、生値を検査する。非欠損コードが0/1以外にある場合は設定が必要と表示し、推測して選択数に数えない。
4. 読取ではファイル保存・schemaRevision増加を行わない。編集保存時に親定義を永続化する。
5. 既存の全列選択セッションは「利用可能な範囲」を復元するが、MA全選択肢をPCPへ自動展開しない。縮退理由と未表示項目数を表示する。

## 4. 回答状態と分母

### 4.1 メンバーセルの状態

既存normalize_codeを使う。数値1.0は"1"、文字列"01"は別値。null/NaN/非有限値はmissing。

| 状態 | 判定 |
|---|---|
| S（選択） | selectedCodesに含む |
| U（非選択） | unselectedCodesに含む |
| N（非該当） | missingCodesに含み、missingReasonsが既存の非該当分類に一致 |
| M（無回答） | その他missingCodes、null、非有限値 |
| X（不正） | 上記に含まれない値 |

既存の欠損理由判定を共通関数へ移し、単一回答とMAで差が出ないようにする。`valueLabels`の文言だけでは状態を変えない。

### 4.2 グループ状態の決定表

上から順に判定し、1行につき必ず1状態を返す。

| 条件 | 状態 |
|---|---|
| Xがある／選択数上限を超える | invalid |
| 全メンバーがN | notApplicable |
| Nとそれ以外の状態が混在 | invalid（適用条件の不整合） |
| 全メンバーがM | missing |
| S/UとMが混在 | partial |
| 全メンバーがU | allUnselectedMeaningに従う |
| 残り、すべてS/UでSが1つ以上 | valid |

部分回答の既知の選択は保持し、MをUに補完しない。例: `[1,99]` はpartial、`[0,99]` もpartial、`[98,99]` はinvalid。グループに列がない場合は設定エラーであり、全行missingとして集計しない。

### 4.3 初期集計規則

初回実装の標準集計は完全回答ベースに固定し、partialとinvalidを有効分母から除外する。部分回答を含める別の推定法は初回には提供しない。除外人数と理由を常時表示する。

実効行集合Rについて:

- total = |R|
- target = total − notApplicable
- valid = target − missing − partial − invalid
- selectedN[j] = valid行のうち選択肢jがSの人数
- totalResponses = Σ selectedN[j]
- pctRespondent[j] = 100 × selectedN[j] / valid
- pctResponse[j] = 100 × selectedN[j] / totalResponses

分母0の割合はnullで返し、UIでは「—」と理由を示す。計算内部は丸めず、表示で小数1桁に丸める。延べ回答率の表示合計には丸め誤差を許容する。

MAのカードに平均・中央値・Top/Bottom-2を表示しない。選択数を派生変数として明示指定した場合だけ、その変数の統計を表示する。validな全0は選択数0、partial/missing/notApplicable/invalidの派生選択数はnull。

### 4.4 実データの期待値

暫定定義（全0=valid、maxSelections=null）での期待値:

| グループ | total | target | valid | missing | partial | invalid | notApplicable |
|---|---:|---:|---:|---:|---:|---:|---:|
| q3s1 | 2,506 | 1,749 | 1,726 | 23 | 0 | 0 | 757 |
| q7s2 | 2,506 | 1,749 | 1,726 | 10 | 13 | 0 | 757 |
| q6s1 | 2,506 | 2,506 | 2,506 | 0 | 0 | 0 | 0 |

q6s1のvalidには全0の66人を含む。q7s2の13人は入力上1と99が混在しているためpartialとする。原票上の意味が判明するまでは99を0へ変換しない。

## 5. 変数選択・行選択の契約

### 5.1 利用範囲とページ設定

グローバル変数選択は分析に利用可能なentity集合を表す。画面では通常列30＋MA15の45項目を表示する。親MAを選ぶことは全子列を読込・描画・分析する命令ではない。

既存globalVariablesの物理列名ベースの正本を、columnId/groupIdを持つentity集合へ移行する。旧activeVariableIdsを新正本と同時更新する二重管理はしない。旧形式の読込時だけ変換し、各ページの物理列要求は共通resolverが導出する。

ページ設定はdatasetId・routeごとに保持する。設定内容は表示entity、展開した選択肢ID、軸順、集計ベース等であり、生配列・React要素を含まない。

実行対象 = グローバル利用範囲 ∩ ページで明示した対象 ∩ 手法が対応する尺度・役割。対象列数は表示・計測に使い、容量による実行拒否には使わない。グローバル範囲を狭めたら、範囲外のページ指定を削除し理由を表示する。広げてもページ指定を自動追加しない。

初回選択の既定値は通常列をコードブック順に、ID/text/otherと手法非対応尺度を除いて初期表示数までとする。利用者は追加でき、容量による追加拒否は行わない。MAしかない場合は空の対象選択画面を表示し、最初のMA全列を自動選択しない。

### 5.2 空集合とrevision

- rows未指定は現行実効範囲。APIのrowIds省略は全行を意味するため、UIは実効範囲を明示して送る。
- rowIds=[]は0行。columns/entities=[]は0列／0項目。空を全件の別名にしない。
- 現行selectEffectiveRowIdsのselected/sample空時のactiveへのフォールバックは、本変更で明示スコープに従う挙動へ統一する。画面には「選択0件」を表示する。
- rowScopeVersionは実効行集合が変わる場合だけ更新する。hover、色、単なるハイライト変更で全行集計を再実行しない。ただしSelectedスコープで選択集合が変わった場合は再集計する。

### 5.3 MAからの中央Selection

カードの選択肢クリックは、表示人数の計算に使ったvalid行のうち当該選択肢がSのrowId集合を取得する。カードの数値と選択人数を一致させる。

複数選択肢の条件は以下を区別する:

- any: AまたはB。和集合・重複排除。
- all: AかつB。積集合。
- unselected: 指定選択肢が既知のU。missingやnotApplicableを含めない。

この集合をRと交差させてから既存selectionAppliedへ渡し、Replace/Add/Subtract/Toggleを適用する。既存選択のうちR外をどう扱うかは現在の集合演算に従い、Replace以外で勝手に削除しない。

partial/invalid等の人数バッジからは、その状態の行を別操作で選択できる。partialの既知選択を確認する操作は「部分回答を確認」と表示し、通常の率の選択とは区別する。

初回実装では「PCPで表示」はハイライトを反映してPCPへ移動する。選択肢軸の追加は別操作。現在のPCP軸を無断で全MAへ置き換えない。

## 6. ページ別仕様

| ページ | 初期動作 | MAを使う場合 | 制限・意味 |
|---|---|---|---|
| Overview | 物理列数と設問数を別表示 | 親→子を折りたたみ | 定義と集計メタデータのみ取得 |
| コードブック | 親設問15＋通常列30 | 親設定、子ラベル編集 | 検出候補はプレビュー後に保存 |
| Table | 親MAを1列、選択項目名を一覧表示 | 指定親だけ0/1列へ展開 | 行ページングと横方向の表示列取得 |
| Distribution | MA親1カード | 選択肢人数、回答者／延べ回答率 | 通常のQuestionCardと排他的に配置 |
| Bar Chart | 指定MAの選択肢別人数 | 属性別の選択率比較 | グループを跨いだ二重計数を避ける |
| Statistics | MA親の分母と選択率 | 指定選択肢の人数 | SAの平均・Top2を流用しない |
| PCP | 通常列を初期10軸、MAは未展開 | 選択肢0/1軸、明示的な選択数軸 | 子の表示ラベルは選択肢名、目盛りは非選択／選択 |
| Relationships | 選択した通常列の集約行列 | 指定MA子の2値関係 | 全列ペアSVGを廃止。焦点ペアだけ点描画 |
| Surprise | 対象指定後に実行 | 指定子の関連。親間全組合せは未提供 | 同一MA内は既定で候補から除外 |
| Mosaic | 通常カテゴリ変数を指定 | 属性×選択肢の選択/非選択 | MA全体を排他的カテゴリにしない |
| Mining | 自動実行せず対象指定 | attributeの子を条件、questionの子を選択率ターゲット | 同じ子を説明と目的の両方にしない |
| Ranking | 目的と候補を指定 | 子0/1特徴、選択肢別順位 | 親単位の重要度は後述の定義を満たす場合だけ |
| Models（木・森林） | 目的と特徴を指定 | 子1列を1個のbinary特徴にする | 0/1の2列one-hotへ増やさない |
| Logistic | binary目的と特徴を指定 | MA子をbinary目的・特徴に利用 | 定数列・完全分離を診断。親MAそのものは目的にしない |
| Discriminant | 通常変数を既定候補 | 明示子を利用可能 | 共線性・サンプル数・展開次元の事前診断 |
| Key Drivers | 通常数値／順序を既定候補 | 明示子を説明変数に利用可能 | 親重要度を子重要度の単純合計で作らない |
| Penalty-Reward | 順序尺度設問を対象 | MA子は対象外 | 選択/非選択を不満/満足と解釈しない |
| Robustness | 元分析の対象・規則を引き継ぐ | 元分析が許可した子のみ | 再標本化で全列へ戻さない。逐次実行 |
| PCA / Touring | interval/ratioと明示ordinalを対象 | MA子は初回実装では対象外 | MCAやグループ重み付き処理はFeature 27で別途定義 |
| Clusters | 通常変数を対象 | MA子は初回実装では対象外 | 多選択肢の設問による距離の偏りを避ける |
| Covariance | 数値／明示ordinalを対象 | MA子は初回対象外 | binary関連はRelationshipsで提供 |
| QQ / LOESS / FEDF / 箱ひげ図 | 対応する数値列のみ | 明示作成した選択数等の派生変数のみ | 親MA・子0/1は通常候補に出さない |
| Export | 生値では原列を全保持 | 表示用の親設問一覧出力を追加 | 読込可能な辞書と表示用データを区別 |

### 6.1 MAカード

```text
投票した理由（3つまで）  MA・9選択肢
全2,506 / 対象1,749 / 有効1,726 / 無回答23 / 部分0 / 不整合0 / 非該当757
[回答者ベース] [延べ回答ベース]    延べ選択数: …
候補者への支持    ━━━━━━━━━   …%（…人） [選択] [軸へ追加]
政党への支持      ━━━━━       …%（…人） [選択] [軸へ追加]
選択中: …人       全0:15人
```

ヘッダーで長い設問名を折り返し、選択肢ラベルは2行まで＋フォーカス/ホバーで全文表示。バー以外にも選択ボタンを置き、キーボード操作と24px以上の操作領域を確保する。選択済み人数と強調は中央Selectionから更新する。

カードは初回12設問単位でページングする。ページ外のカードはマウント・集計しない。カテゴリ全件が多い場合はカード内も20選択肢単位で表示するが、分母は親全メンバーから算出する。「その他」に黙って合算しない。

### 6.2 Table

通常表示ではMAセルに選択名を最大3件＋「ほかn件」、完全な一覧は詳細ポップアップに表示。全0は「選択なし」、missingは「無回答」、notApplicableは「非該当」。partialは既知の選択名と「一部無回答」、invalidは「要確認」を併記する。

既存の値ラベル／生値切替は表示内容を切り替える。生値モードの親セルは `q3s1c1=1, q3s1c2=99` のようにコードと列名を表示し、勝手に展開しない。展開ボタンは別に置く。

行は100件/ページ、最大200件、表示列は最大12 entity相当の窓で取得。MA親セルの構成はバックエンドで行い、折りたたんだ179列をブラウザへ転送しない。選択チェックはrowIdを使用し、ページ外の選択も維持する。

### 6.3 関連と予測の扱い

MA子同士は0/1の2×2表とphi係数、選択率、共選択人数を返す。計算対象の親グループが異なる場合は各親valid行の積集合を用い、pairValidNを表示する。名義コード98/99を数値相関に入れない。binaryと連続値、名義変数との関係は対応する既存手法を明示し、未対応なら停止する。

同一グループ内の共選択は探索用の専用切替で提供し、通常の発見ランキング・Miningの候補から除外する。「3つまで」などの制約で生じる関係を独立した設問間の発見として提示しない。

予測用行列では、使用するMA子の親グループがvalidの行だけを候補にする。同じ親の未使用子も状態判定用には読込むが、モデルの特徴にはしない。通常列・目的変数の欠損処理と合わせた除外人数を返す。

親重要度を提供する場合、検証用データ上で同一MAの使用子をまとめて同じ行置換で並べ替えるグループPermutation Importanceを使う。学習済みモデルを再学習せず評価指標の悪化量を計測する。未対応の手法では「子別のみ」と表示し、単純合計を親重要度と呼ばない。分割・seed・反復数・指標を保存する。

## 7. APIと分析計画

### 7.1 共通計画

バックエンドにMA用の小さなresolverを置く。汎用プラグイン機構や別サービスは導入しない。各APIは同じresolverで次を確定する。

1. datasetId、schemaRevision、dataRevisionの整合。
2. entityの実在、役割、尺度、グループ定義。
3. 特徴/表示列と、欠損判定に必要な補助列の集合。
4. 実効行集合とそのhash。
5. 展開列数・読込範囲と処理の分割単位。
6. 必要データだけを読み込み、重い処理はキュー順に実行する。容量や計算量を理由に開始を拒否しない。

すべての新APIにexpectedSchemaRevision / expectedDataRevisionを受け付け、不一致は409。結果にdatasetId、dataRevision、schemaRevision、scopeHash、usedColumns、excludedCounts、methodを返す。分析結果の配列を受け取る前に、フロントも要求世代を照合する。

### 7.2 追加・変更エンドポイント

| API | 用途・契約 |
|---|---|
| GET /datasets/{id}/codebook | 親定義・optionLabelを含める。読取時に旧辞書の暫定親定義を解決 |
| PUT /datasets/{id}/codebook | 列patchに加えmultiResponseGroupsのupsertを受け付ける。expectedSchemaRevision必須の新UI。変更一括検証後に1回だけrevision増加 |
| DELETE /datasets/{id}/codebook/multi-response-groups/{groupId} | expectedSchemaRevision指定。所属解除と親削除を一括反映。生列は削除しない |
| POST /summaries/multi-response | 指定親の集計。rowIds、groupIds、selectedRowIds、expected revisions。12親単位で分割実行し、親数を理由に拒否しない |
| POST /datasets/{id}/table-view | 指定行ページ・entity窓。親セルと列メタデータを返す。offset/limit、entityIds、rowIds、displayMode |
| POST /datasets/{id}/matches | 指定親・選択肢条件のrowId集合を返す。any/all/unselected/statusと基準となる行集合を指定 |
| POST /datasets/{id}/view | 生列Arrow。columnsとrowIdsの空配列を厳密化。メタデータだけの画面からは呼ばない |
| 既存分析API群 | 上記resolverを経由。既存列名引数をcolumnIdへ解決。MA全子の暗黙展開を禁止 |

`table-view`は通常列も含む単一取得口とし、MAだけ別APIにして同じ行ページを二度取得しない。APIパスはすべて `/api/v1` 配下。

table-viewのentityIdsは第3.1節のオブジェクト配列。展開子は `{kind:"maOption", groupId, columnId}`、派生選択数は `{kind:"maCount", groupId}` として指定する。通常のcatalogに子や派生列を常駐展開せず、親の詳細操作で生成する。応答のrowsは `[{rowId, cells:[...]}]`、cellsは要求entity順。MA親セルにはstatus、selectedCount、選択肢IDと表示名の配列を含める。合計行数とpage offset/limitを別に返し、行順は元データ順を標準とする。

table-viewの検索・並べ替えはサーバー側で実効範囲に適用してからページングする。初回は通常列とmaCountの並べ替えのみ対応し、MA親セルは並べ替え不可と表示する。表示ページ内だけを並べ替えて全体順と誤認させない。

### 7.3 MA集計例

```json
{
  "datasetId": "ds-example",
  "expectedDataRevision": 1,
  "expectedSchemaRevision": 2,
  "rowIds": ["ROW-000001", "ROW-000002"],
  "groupIds": ["q3s1"],
  "selectedRowIds": ["ROW-000001"]
}
```

```json
{
  "datasetId": "ds-example",
  "dataRevision": 1,
  "schemaRevision": 2,
  "scopeHash": "opaque-hash",
  "groups": [{
    "groupId": "q3s1",
    "denominators": {"total":2,"target":2,"valid":2,"missing":0,"partial":0,"invalid":0,"notApplicable":0},
    "allUnselectedN": 0,
    "totalResponses": 3,
    "items": [
      {"columnId":"col-a","label":"候補者への支持","selectedN":2,"selectedInSelection":1,"pctRespondent":100.0,"pctResponse":66.66666666666667},
      {"columnId":"col-b","label":"政党への支持","selectedN":1,"selectedInSelection":0,"pctRespondent":50.0,"pctResponse":33.333333333333336}
    ]
  }]
}
```

応答には各選択肢の全rowIdsを入れない。選択人数は集計で返し、クリック時のみmatchesで集合を取得する。通常のハイライト変更では、同じ基礎集計を再利用して選択数部分だけ算出する。

### 7.4 matchesの契約

要求は `groupId`、`optionColumnIds`、`predicate: any|all|unselected|status`、`status`（status時のみ）、`rowIds`、expected revisionsを持つ。通常条件のpopulationはvalid固定。状態確認のみ指定状態の行を返す。

応答はrowIds、count、scopeHash、revisions。集合は重複なし・データセットの行順。大量IDは転送を分割し、全件受信後に中央Selectionへ一括適用する。途中取消時には既存Selectionを保持する。容量による拒否や部分結果の選択適用は行わない。

### 7.5 エラー

| HTTP/code | 意味 | UI |
|---|---|---|
| 422 MA_DEFINITION_INVALID | コード集合の重複、role混在、所属不整合 | 該当列と修正項目を提示 |
| 422 MA_METHOD_UNSUPPORTED | 親MAまたは子が手法非対応 | 対応する画面・派生変数へ誘導 |
| 409 ANALYSIS_INPUT_STALE | 保存・変換中にrevisionが変化 | 古い結果を表示せず再取得可能にする |
| 422 EMPTY_ANALYSIS_INPUT | 推定に必要な行・列がない | 空状態。集計APIは0件結果を正常返却 |

容量・計算量に基づく新しい事前拒否エラーは追加しない。定義不正や手法非対応の検証は維持する。エラーに生データの回答値を大量添付しない。

## 8. 読込・キャッシュ・メモリ制御

### 8.1 必要データの種類

| 消費者 | 取得するもの |
|---|---|
| 変数選択・エディタ | コードブックと軽量メタデータ |
| MAカード | 表示親の集計。生列なし |
| Table | 表示中行×表示entityの整形値 |
| PCP | 表示列＋色分け列＋行ID。MAの状態マスクはサーバーで作成 |
| 関連行列 | 対象列の集計行列。焦点ペアだけ点データ |
| モデル画面 | 列メタデータと分析結果。特徴行列をブラウザで別生成しない |

### 8.2 読込方式

- DatasetStoreに必要列を指定できる読込を追加。Polarsのscan/selectまたはread_parquet(columns=...)を利用する。PyArrow fallbackもcolumnsを渡す。
- フィルタ用rowIdとMA状態判定の全メンバーは依存列として追加する。ただし応答には要求列だけ返す。
- 分析・集計は親または列ブロック単位で処理する。全MAを毎要求で別DataFrameへコピーしない。
- ブラウザ側はArrow vectorを一次データとして保持し、全列Array.fromを廃止。数値用TypedArrayは必要な列だけ遅延生成する。
- MA内部は0/1/欠損状態をUint8で保持可能。Float64への変換はWASM/モデル投入時の選択列に限定する。文字列コードの意味情報は別途保持する。
- 同一要求は実行中Promiseを共有。中止・失敗は共有キャッシュに保存しない。購読者が残る共有要求を別ページの解除で中止しない。
- Tableの全行row-object生成を廃止。行ID配列は既存中央Selectionのために1セットだけ共有する。

生データの参照を共有し、同じ内容の独立コピーを減らす。容量を理由にページの描画データや解析結果をキャッシュから追い出さない。共有キャッシュ所有のArrayBufferはtransferしない。Workerへ移譲するバッファは要求専有として切り出し、detach済みバッファを再訪ページが参照しない。

CSV取込も原文、全行文字列、全列Pythonオブジェクトを長時間併存させない。列ブロック／バッチ変換を用い、行×列や推定メモリを条件にした新しい取込拒否は追加しない。既存のファイルサイズ・行数・列数制限は本変更の対象外とする。

### 8.3 revisionとキー

dataRevisionを追加し、初期値1、生値・行集合・物理スキーマ変更で増加する。schemaRevisionはコードブック変更で増加する。既存fingerprintは互換のため保持する。コードブック変更で変わる既存fingerprintだけを生配列キャッシュキーに使わない。

| キャッシュ | キー |
|---|---|
| 生列 | datasetId + dataRevision + 物理列集合 + rowScopeHash |
| コードブック解決・MA状態 | 上記 + schemaRevision + groupId |
| 基礎集計 | revisions + groupIds/列集合 + scopeHash + method/params |
| 選択ハイライト集計 | 基礎集計キー + selectionHash |
| モデル結果 | revisions + 特徴/目的 + scopeHash + seed + method/params |

要求列集合は順序非依存のキーに正規化し、表示順は別に扱う。rowScopeHashはsorted unique rowIdsから1回生成して共有する。古いセッションにdataRevisionがなければ、初回メタデータ移行で1を設定する。

### 8.4 初期表示・分割・実行順序

以下は表示と処理の分割単位であり、要求全体の容量上限ではない。初期表示数を超えた項目は追加・ページ移動で利用できる。モデル特徴数、MA候補数、ID数、推定メモリによる新しい実行拒否は設けない。

| 項目 | 動作 |
|---|---|
| PCP | 初期10軸。利用者が追加可能。必要な軸だけ取得 |
| Relationships | 初期6変数。全列ペアのSVG点生成を集約行列と焦点ペア表示へ変更 |
| 焦点散布図 | Canvasを使用。容量を理由とした強制サンプリングは行わない |
| Table | 初期100行、表示窓12 entity。取得と整形をページ単位に分割 |
| MAカード | 12親/ページ、20選択肢/親の表示単位。分母は必要な全メンバーで計算 |
| モデル・Mining | 明示対象を使用。容量の都合で特徴・候補を打ち切らない。手法本来のパラメータは別扱い |
| static分析 | 重い処理を同時1件とし、後続要求はキューで順番に実行 |
| local分析 | 同一データセットの重い処理を同時1件とし、後続要求はキューで順番に実行 |

同時実行の待機は実行順の調整であり、容量見積りによる開始拒否ではない。待機理由と順番を表示し、利用者は明示的に取消できる。メモリ計測は性能改善と検証に使い、実行の可否判定には使わない。

## 9. ページ保持・取消・静的版

KeepAliveOutletによる訪問済みページの保持を継続する。ページ離脱だけではアンマウント、Canvas/geometry参照の解除、キャッシュ退避、解析取消を行わない。解析結果、入力設定、描画状態を保持し、再訪時に離脱を理由とする再解析を行わない。

Codebookの未保存draft、中央Selection、PCP設定も保持する。データセット切替や入力変更による既存の更新は、ページ離脱とは区別する。旧データセットの応答で現在の表示を上書きしない。

要求にはrequestIdと入力世代を付ける。明示的な再実行・入力変更・取消で古い要求を判別する。ページが非表示になっただけでは入力世代を進めず、進行中の解析結果を通常どおり保持する。

- HTTP: 利用者の取消や入力差替え時にAbortSignalを使う。転送中断がサーバーCPU処理の即時停止を意味するとはみなさない。
- Graph Worker: 明示取消した専有処理は停止可能。pendingを終了させ、共有中のSelection処理や他ページの結果を巻き込まない。ページ離脱ではterminateしない。
- Pyodide: 仮想FSを持つWorkerはページ離脱でterminateしない。明示取消した未着手要求だけをキューから削除する。実行中は協調的なチェックポイントで取消を確認する。
- 中断できない同期処理は逐次実行する。明示取消された結果だけ反映せず、完了を待って後続を開始する。非表示になっただけの処理結果は破棄しない。

Worker再起動が必要なエラーでは、保存済みデータの復元可否を確認した専用回復操作を提示する。未保存の仮想FSを自動破棄しない。

staticではPython側とJS側が同じブラウザのメモリを使う。必要列だけの取得、二重コピー削減、処理の分割・逐次化で使用量を減らす。本設計には非表示画面の描画データ解放と容量による事前拒否を含めないため、任意の大きさのデータについてOOM回避を保証するものではない。

## 10. 保存・移行・出力

- 新規親定義、所属変更、親削除は1トランザクションで検証し、schemaRevisionを1回増加する。旧revisionへの書込みは409。
- コードブック全体を単一JSONとして組み立て、dataset単位の排他下でrevision再確認→一時ファイル→atomic replaceを行う。失敗時は旧JSONを維持する。codebookのschemaRevisionを正本にし、meta内の複製値は参照時に照合・再生成する。コードブック更新とmeta更新の二つの保存成功を前提に、半端なrevisionを返さない。
- JSON import/exportでmultiResponseGroupsとmultiResponseOptionLabelを保持する。移植用JSONのoptionOrderは列名参照を受け付ける別フィールド `optionOrderNames` を用意し、保存時にcolumnIdへ解決する。両方指定は422。
- CSV辞書は列単位のmultiResponseGroup・optionLabelを扱う。親設定を完全に保持した交換はJSONを正規形式とする。CSVエクスポート時に親設定が含まれないことを明示する。
- 既存のJSON importの未検証属性更新を置き換え、全列・親定義を検証してから保存する。部分成功でrevisionだけ増える挙動にしない。
- templateの仕様書とJSON Schemaは実装と同時に更新する。本設計だけでは現行Schemaを変更しない。
- 生値CSV/Parquet/Arrowは原列を保持。閲覧用の親列CSVは「MAをまとめた表示用」と明示し、通常データとしての完全な再読込は保証しない。
- 補完・変換でMAの0/1を平均補完しない。MAメンバーは既定で数値補完候補から除外。生値変更後はMA状態を再検証する。
- 子列削除時は親定義の順序も更新し、残り0列なら親を削除。実際の列削除は別の明示的な操作を要する。
- ロールバックでは旧実装が読める元CSVとコードブックを保持する。新UI設定を旧実装が理解できない場合は設定だけ初期化し、生列を失わない。

## 11. 実装対象と順序

### 11.1 主な変更箇所

| 対象 | 変更 |
|---|---|
| backend/app/domain/codebook.py | 親定義、optionLabel、revision検証 |
| backend/app/domain/codebook_adapter.py | グループ解決、正規化、依存列計画 |
| backend/app/algorithms/summaries/multi_response.py（新規） | 状態分類・分母・選択率・matchesの共通ロジック |
| backend/app/storage/dataset_store.py | 射影読込、dataRevision、整合保存 |
| backend/app/api/datasets.py / summaries.py / exports.py | コードブック、table-view、matches、MA集計、出力 |
| backend/app/api/mining.py / models.py / orderings.py等 | resolver、対象明示、逐次実行、空集合、MA尺度判定 |
| frontend/src/features/dataset/codebookSlice.ts / useCodebookColumn.ts | 親定義・entity catalog、旧辞書適合 |
| frontend/src/features/selection/VariableSelectionModal.tsx / app/store.ts | 親選択、ページ対象、実効行集合の厳密化 |
| frontend/src/features/pcp/useDatasetColumns.ts / api/client.ts | 射影・共有要求・コピー削減・AbortSignal |
| frontend/src/app/KeepAliveOutlet.tsx | 既存KeepAliveの継続、設定・結果・描画状態の保持 |
| frontend/src/features/distribution/MultiResponseCard.tsx（新規） | MA表示・中央選択・部分回答確認 |
| frontend/src/features/dataset/MultiResponseGroupDialog.tsx（新規） | 定義編集・検証・プレビュー |
| frontend/src/features/table/TablePage.tsx | 親セル・行/列ページング・生値切替 |
| frontend/src/features/relationships/* | 全ペアDOM廃止・集約・焦点表示 |
| frontend/src/engine/graphClient.ts / pyodideClient.ts / workers | キュー・明示取消・世代判定 |
| 全登録分析ページ | 第6節の候補規則と対象明示 |
| template/* / tests / tasks | 契約説明・検証・証拠 |

### 11.2 段階ごとの完了条件

| 段階 | 内容 | 次へ進む条件 |
|---|---|---|
| A | 全ペアDOM廃止、共有取得、重い処理の逐次化 | 画面遷移で解析結果・描画状態を保持し、同一要求を重複実行しない |
| B | グループモデル・状態分類・revision・API | 決定表と実データ期待値が通る |
| C | 射影読込・集計取得・Table・要求共有 | cards/tableが全列Arrowを要求しない。空集合が0件 |
| D | 親変数選択・MAカード・PCP・全ページ候補規則 | 全ページでMA親の暗黙全展開がなく、Selection連携が一致 |
| E | Mining/予測のMA子対応・親重要度・出力 | 指定子のみ使用、欠損・同一親漏洩・importance定義を検証 |
| F | 性能・回帰・local/static配布確認 | 第12節の受入条件と残課題を記録 |

初回リリースはA～Fを一括した機能として扱う。途中段階を完了機能と表示しない。各段階は小さな変更単位に分け、対象テストが通ってから全体テストへ進む。

## 12. 検証と受入条件

### 12.1 正しさ

1. 決定表の各分岐と全0の3設定をテストする。常にtotal=valid+missing+partial+invalid+notApplicable。
2. 回答者率合計>100%を許容し、延べ回答率は丸め前合計100%。分母0はnull。
3. q3s1/q7s2/q6s1の第4.4節の値に一致する。
4. `[1,99]`をvalidまたは非選択に変換しない。partialの既知選択をTableから確認できる。
5. any/all/unselected、Add/Replace/Subtract/Toggle、0件、行範囲変更、並べ替えで集合が一致する。
6. カードの人数とクリック選択人数、他ページのハイライト人数が一致する。
7. rawとlabel、98/99、観測0件選択肢、先頭ゼロを保持する。
8. 保存・補完・変換・別datasetへのJSON取込後に親定義と列IDの整合が保たれる。
9. Miningでattribute/question分離と同一親除外、モデルで使用子と状態判定用子の分離を確認する。
10. 同一親のPermutation Importanceでは全使用子に同じ置換を使い、検証データだけで評価する。

### 12.2 API・寿命

1. 同じ列集合の同時要求が1回だけ実行される。
2. label変更時に生値Arrowを再取得せず、意味依存の集計・描画は更新される。
3. dataRevision変更時には生列も再取得する。
4. 遅い旧要求の後着で別dataset/別scope/別revisionの表示を上書きしない。
5. []が全件に展開されない。旧API省略要求も共通resolverを通る。
6. 容量・列数・点数・候補数の見積りを理由に、新しい実行拒否を行わない。
7. ページ離脱でアンマウント・描画用データ破棄・解析取消を行わない。結果・フォーム・軸設定は再訪時にも保持される。
8. Pyodide取消・エラーで保存前のコードブックdraftやFSを自動消去しない。

### 12.3 性能計測

測定環境はOS、CPU、RAM、ブラウザ版、viewport/DPR、local/static、cold/warmを記録する。性能値は設計時には未測定。

対象は実データ3種類、追加の50,000行×209列の合成データ。合成データは一時領域に作成し、本来の調査データへ追記しない。

各画面を単独に測定した後、PCP→Distribution→Table→Relationships→Mining→Modelsの巡回を10回行う。各測定3回の中央値と最大値を保存する。

| 指標 | 合格条件 |
|---|---|
| 実データの全画面初期表示 | OOM、タブクラッシュ、Worker異常終了なし。未対応画面は空状態で正常表示 |
| カード初期要求 | 最大12親、全列Arrow要求0回 |
| Table初期要求 | 100行、最大12 entity。全行オブジェクト生成なし |
| ペア図DOM | 行×列²個のcircle/titleを生成しない。グラフ点はCanvasまたは集約 |
| 生列/結果キャッシュ | 同一生列の共有とコピー数を確認。非表示を理由とした結果・描画データの退避なし |
| 同時実行 | static重分析1件以下。巡回で過去ページの計算が増加しない |
| 巡回後メモリ | 結果・描画を保持した同一条件の2周目と10周目を比較し、GC後JS live heap差がmax(32 MiB, 2周目の10%)以内。これを満たすために結果を削除しない |
| Worker/WASM | JSヒープと別計測。確保済み容量だけで漏洩判定せず、live参照・キャッシュ・反復時増分を確認 |
| 時間の初期目標 | 2,506行でwarmのカード/Table初期応答2秒以内、軽量操作100ms以内。超過時は内訳を示しリリース判断前に調整 |
| 大規模入力 | 分割・逐次処理の実測を記録する。OOMや実行失敗は未達として記録し、容量による事前拒否で合格扱いにしない |

GC後のlive heapは検証用Chromiumの計測機能を用いる。製品UIがperformance.memory等の非標準APIを利用できることを前提にしない。Python/Rust/WASM側のバッファと要求数も記録し、単にGCで見えなくなったことを完了証拠にしない。

機能単位pytest/Vitest→統合テスト→全体テスト→本番ビルド→配布したlocal/staticの実ブラウザ操作の順で検証する。既存の行ID関連テスト失敗2件は変更前基準と比較し、新規退行と分けて報告する。

## 13. 設計上の制限と確認事項

- q7s2の1/99混在が原票上どの意味かは未確定。初回はpartialとして保持・除外人数を示す。
- 全0の意味は設問ごとに設定可能とし、既定valid。原票が「無回答」と定義している場合だけ変更する。
- maxSelectionsは原票確認後に設定する。既存ラベル内の数字を自動抽出して回答を無効化しない。
- 分割単位・応答時間目標は性能検証で調整する。調整理由と実測をタスク記録に残す。
- 本書はMAの解析方法をすべて増やす設計ではない。非対応手法を明確にし、必要列・正しい尺度で実行することを初回の完成条件とする。
