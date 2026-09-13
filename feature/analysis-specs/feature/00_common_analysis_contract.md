# Feature 029–034 共通機能仕様：分析コンテキスト・結果・連動

版：1.0／2026-09-12／状態：新規実装用の確定設計。対象は今回追加する6分析であり、既存全APIの破壊的改定ではない。

## 1. 目的・非目的

同じデータ、スコープ、コードブック、欠損方針、調査ウェイトで計算したことを、画面・エクスポート・PCP連動・再実行を通じて追跡可能にする。時系列分析、因果推論、母集団代表性の自動保証、探索後の有意性の自動補正は目的としない。

既存の`AnalysisContext`、row identity、Feature 17〜26、KeepAlive、L1/L2選択を維持する。文書中の「必須」は受入条件、「推奨」はUIの初期値を意味する。数式中の単位・標本数・欠損の扱いをUI担当者の裁量にしない。

## 2. 共通入力

### 2.1 データ・版・スコープ

`context.datasetId`、`expectedDataRevision`、`expectedSchemaRevision`を必須にする。`scope=all|active|selected|sampled|explicit`を受け付ける。activeでは`activeRowIds`、selectedでは`selectedRowIds`、sampledでは`sampledRowIds`、explicitでは`rowIds`を必須にする。空配列は全行に置き換えない。allには行ID配列を送らない。指定スコープと関係のない行ID配列は422とする。

active/selected/sampledで未知IDがある場合は既存`resolve_scope`に合わせて現データとの共通部分を使い、`UNKNOWN_SCOPE_ROWS_IGNORED`と件数を返す。explicitでは未知IDを422とする。重複IDは一度だけ処理する。抽出順はデータフレームの保存順に統一し、呼出元のID配列順に結果をzipしない。`sampledRowWeights`を分析ウェイトや複製度数として流用しない。

分析開始時にスコープを固定する。分析図で選択が変わっても再推定しない。再計算は実行ボタンによる明示操作だけで行う。実行後にデータ版・スキーマ版が変わった結果はstaleとし、保存列への反映・新規予測・選択の適用を禁止する。すでに表示している図の閲覧と元のスナップショットのエクスポートは許可し、古い版であることを表示する。

### 2.2 列・カテゴリの識別

APIでは`columnId`を使用する。列名・設問文・翻訳済みラベルをキーにしない。通常の分析変数はrole=question/attributeのみ。ID・重み列・textを数値やカテゴリに自動転用しない。コンジョイントの回答者IDなどの専用マッピングのみrole=idを許す。

カテゴリは`columnId + kind + normalizedCode`で識別する。kindは`value|missing|not_applicable`。実データに`__missing__`という文字列があっても欠損カテゴリと衝突させない。表示順は保存済みcategoryOrder、その後は未登録の観測値を保存順に追加する。`valueLabels`はラベルであり数値ではない。nominal/ordinalをカテゴリとして使うときは、生コードを正規化して使い、ordinalを1,2,3に変換する既存`analysis_series`を呼ばない。

AV02に合わせ、正規化したcategoryOrderからmissingCodesを除いた集合が非空なら、それを閉じた有効領域とする。missingCodesを先に判定し、宣言領域外の値はinvalidとする。valueLabels単独は領域を閉じる宣言ではない。categoryOrderに有効値がなければ観測カテゴリへのフォールバックを許す。判定をdomain/analysis_frame.pyへ共通化し、既存question_summaryの宣言領域テストとの一致を保証する。

### 2.3 欠損・不正値

カテゴリの`missingPolicy`は既存クロス集計と一致させる。

|方針|通常欠損|対象外・非該当|数値変数の欠損|
|---|---|---|---|
|exclude|行除外|行除外|行除外|
|include_missing|欠損1カテゴリ|通常欠損と同じ1カテゴリ|行除外|
|separate_not_applicable|欠損カテゴリ|非該当カテゴリを別に保持|行除外|

invalidは欠損カテゴリに変換しない。欠損処理で残ったカテゴリ以外の数値は有限でなければならない。平均代入、最頻値代入、0補完、pairwise相関を暗黙に行わない。FAとコンジョイントは個別仕様によりexcludeのみ。回帰では目的変数・数値説明変数の欠損は常に行除外で、欠損カテゴリ化はカテゴリ説明変数にのみ適用する。

`imputationPolicy=use_current_values`を本版の唯一の値とする。既存の補完済みセルは現在値として扱い、使用セル数・行数とmaskRevisionを返す。原データを読んだという表示にしない。未実装のexclude_imputed等を受け付けない。

### 2.4 調査ウェイト

`weightMode=dataset`を初期値とし、保存済みweightConfigを解決する。設定がなければ非加重。noneだけが明示的無効化、columnでは`weightColumn`を必須にする。dataset/noneに列やtypeを併記して意味を上書きする入力は拒否する。columnのtype省略は既存宣言から解決し、宣言がなければWEIGHT_TYPE_REQUIRED。

`weightType=survey|frequency`を区別する。重み列はrole=weight、interval/ratio、非MA。null・missingCodesは除外、0はゼロ質量として除外理由を分け、負値・boolean・無限・NaN・非数値は422。frequencyは整数性を絶対許容差1e-9で検証し丸めた非負整数を使う。1行内の複数数値を足して勝手にウェイトを作らない。

|機能|非加重|frequency|survey|推測統計の扱い|
|---|---|---|---|---|
|CA回答者モード|可|可|幾何のみ可|surveyでは通常Pearson p値なし|
|CA分割表モード|セルを度数/質量として指定|重み列の二重適用不可|重み列の二重適用不可|整数度数として明示した場合のみPearson|
|MCA/FAMD|可|可|加重幾何として可|軸の有意性検定は提供しない|
|重回帰|可|複製標本と一致|加重推定＋設計分散|HC3と調査設計分散を区別|
|最尤因子分析|可|複製標本と一致|本版では不可|正規共通因子モデルの参考検定|
|コンジョイント|可|回答者ブロックの複製|回答者重み＋設計分散|回答者内反復・PSUを維持|

unsupportedはエラーとし、画面に適用しないことを告知したうえで、ユーザーがnoneを選び直す。裏で無視して計算しない。surveyウェイトを一律c倍したとき幾何・係数・設計SEが変わらないことを必須テストとする。frequencyはc倍すると情報量・SE等が変わるので同じ不変条件を課さない。

## 3. 結果の共通意味

共通metaにdataset/data/schemaRevision、scope/hash/count、fitCount、除外内訳、weightApplied/type/column、sumWeights、kishEffectiveN、frequencyN、maskRevision、algorithmVersion、numericalRuntime、isExplorative、warningsを持つ。既存互換キー`effectiveN`はfitCountと同じ物理行数とする。コンジョイントでは物理行数に加えrespondentCount/taskCount/observationCountを併記し、標本数を物理プロフィール行数と誤記しない。

`scopeCount=fitCount+excludedCount`を保証する。除外の優先順位はinvalid→missing→missing_weight→zero_weight→structural_task_exclusion。各行を最初に該当した理由で一度だけ数える。複数回答の親判定やタスク単位除外の詳細件数は別の重複可診断値とし、主内訳に足し込まない。コンジョイントで他行の欠損のために巻き添え除外した行はstructural_task_exclusionである。

sumWeightsはfit行の正の重み合計。コンジョイントだけは回答者単位のsumRespondentWeightsも必須。kishEffectiveN=(Σw)²/Σw²はウェイトの偏り指標であり、モデル自由度や調査設計効果を反映した標本数ではない。非加重では物理分析単位数と同じ。frequencyNは複製後の分析単位数でありsurveyではnull。

比率（inertiaRatio、contribution、cos2、R²、importance、probability）は原則0〜1。R²はモデル条件により負値を許す。0〜100のUI表示では必ず×100し、APIが百分率だと推測しない。寄与率の分母は行列の全慣性とし、数値閾値で破棄した慣性も別に報告する。表示2軸内で100%へ再正規化しない。

計算不能値はnullと`unavailableReasons`のJSON Pointer別理由を返す。NaN/Infinity、0埋め、空文字数値を禁止する。距離0点のcos2、残差自由度0のSE、負荷方向の不定性等を明示する。

## 4. 共通画面

分析ナビゲーションに6ページを追加する。CA/MCA/FAMDは「対応分析・混合データ」、重回帰・因子・コンジョイントは「モデル」に分類してよいが、URLは詳細設計で固定する。

```
[分析名] [対象:全体/Active/Selected/標本/明示行] [重み:データ設定]
[設定:列/尺度/欠損/手法固有パラメータ] [実行] [表示結果の列へ保存]
[使用版・対象数・有効数・除外理由・重みの意味] [警告]
[図] [係数/負荷/カテゴリ表] [診断] [計算設定・来歴]
[CSV] [JSON] [図SVG/PNG] （手法が提供する項目だけ表示）
```

設定draftと表示中のsubmittedConfigを分ける。変更後は「設定が変更されています。結果は前回実行分です」と表示する。画面遷移で結果・設定・スクロールを維持し、戻っただけで再取得しない。dataset切替で旧結果を新データへ混ぜない。失敗時も前結果を消さず、その版と失敗表示を分ける。

計算中は現在の段階とスピナーを表示し、根拠のない進捗%を表示しない。「表示を取り消す」は遅延結果の適用を取り消す論理キャンセルであり、実行中のSVD/最適化を直ちに止める保証はしない。静的版の共通workerを強制終了しない。

## 5. PCP・L1/L2・選択

個体点には必ず__rowId__を保持する。図上選択は`selectionApplied({rowIds,operation,label})`だけを経由し、operationは既存のreplace/add/subtract/toggleを使う。選択先は現在のactiveRowIdsとの共通部分となる。図内選択数と実際の適用数が違う場合は両方表示する。表示ページに載っていない点も範囲選択対象とする。

色は既存の`useRowColorResolver`とL1Legendを使用する。色列やL1の変更は図の色だけを変え、推定値を変更しない。カテゴリ点や負荷ベクトルを個人と同一視しない。CA回答者モードのカテゴリ選択は対応する原行集合へ写像し、行カテゴリ集合と列カテゴリ集合を同時選択した場合のAND/ORを明示する。既定は同一側OR・異なる側AND。

## 6. 数値・処理量・安全性

float64を正本とし、サーバーとPyodideは同じPythonコードを通す。数値パッケージ名が同じでも版やBLASが違うためビット完全一致は要求しない。符号・因子置換・縮退固有空間を考慮した検証を行う。

必要列だけ取得し、大きなrow結果をページ分割する。分析対象の勝手な間引き、ページ先頭だけによる推定、ページ離脱時の自動破棄、単純な件数閾値による実行拒否は行わない。実際の割当失敗等はANALYSIS_RESOURCE_EXHAUSTEDとして返す。ユーザーがスコープを小さくして再実行できる案内を表示するが、裏で縮小しない。

CSV/JSONは現在の解析結果と設定・版を含める。Excel式注入対策として文字列セルの先頭=,+,-,@,タブ,CRに引用符を前置し、数値セルは数値のまま出力する。回帰式等のユーザー入力をevalしない。数式ではなく構造化したterm配列からモデル行列を構築する。

## 7. 全機能共通の受入条件

C01 同じcontextと設定で再現可能な結果になる。C02 staleの書込みを拒否する。C03 行順・列順を変えてもIDによる対応が保たれる。C04 欠損/NA/invalidを区別する。C05 重み未対応を黙って無視しない。C06 metaの物理行数と複製/加重の量が混ざらない。C07 表示2軸の寄与率を再正規化しない。C08 非有限値をJSONへ出さない。C09 選択連動で再推定ループを起こさない。C10 local/static同一fixtureで意味が一致する。C11 KeepAlive復帰で結果を失わない。C12 有効な解析行をページサイズや描画上限で減らさない。

## 一次資料との対応

[S-WLS](../references/PRIMARY_SOURCES.md#s-wls)、[S-SURVEY](../references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。
