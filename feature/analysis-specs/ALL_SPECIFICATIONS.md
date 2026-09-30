# DAVIS-PCP追加分析仕様・実装設計：一括閲覧版

更新日：2026-09-13。正本は各分割ファイル。探索的因子分析（EFA）・033c CFAを含む。

---

<a id="doc-1"></a>

出典ファイル：[README.md](README.md)

# DAVIS-PCP 追加分析機能：機能仕様・実装詳細化設計 v1.0

作成日：2026-09-12／対象：アンケートを中心とした、非時系列の探索的データ分析。

本書群は設計成果物であり、DAVIS-PCPへの実装パッチではない。添付の`feature.zip`と`package(1).zip`を設計基準とし、実際のコード上の接続箇所を確認した。確認した版と根拠は[ソース照合記録](references/source_audit.md)に記載する。

一括閲覧：[HTML読書版](index.html)／[Markdown連結版](ALL_SPECIFICATIONS.md)。旧029〜034の検証結果：参照数式・入力契約42ケース成功。033 EFA・033c CFAの追加設計は2026-09-13版で、実績は[拡張検証報告](validation/FACTOR_EXTENSIONS_VALIDATION.md)を参照する。新規API本体・画面・静的版への組込み試験は未実施。

文書の配置先は `feature/analysis-specs/`。本書群内の相対リンクは各文書からの相対パスであり、本文中の `fullstack/` はリポジトリルート基準の実装パスを表す。[既存機能仕様](../README.md)／[開発タスク一覧](../../tasks/task-list.md)／[本体README](../../fullstack/README.md)。

## 1. 読む順序と文書の優先順位

最初に[共通機能仕様](feature/00_common_analysis_contract.md)、次に[共通実装設計](tasks/DAVIS-FEAT-029-034-COMMON-DESIGN.md)、担当機能の仕様・実装設計、最後に[受入・実装順序](tasks/ACCEPTANCE_AND_HANDOFF.md)を読む。APIの構文は[実行可能な型契約](contracts/analysis_requests.py)とそこから生成したJSON Schema、数式・意味・処理順序は実装設計を正本とする。型契約だけではデータ依存検証を代替しない。

|新規ID|機能仕様書|実装詳細化設計書|今回の確定範囲|
|---|---|---|---|
|029|[通常のコレスポンデンス分析](feature/29_correspondence_analysis.md)|[CA実装設計](tasks/DAVIS-FEAT-029-DESIGN.md)|回答者データの二元表／既存分割表、χ²距離による配置|
|030|[多重対応分析](feature/30_multiple_correspondence_analysis.md)|[MCA実装設計](tasks/DAVIS-FEAT-030-DESIGN.md)|完全指示行列MCA、明示選択したMA子項目の二値変数化|
|031|[混合データ因子分析](feature/31_famd.md)|[FAMD実装設計](tasks/DAVIS-FEAT-031-DESIGN.md)|カテゴリ＋数値のFAMD、個体・変数・カテゴリの別表示|
|032|[重回帰分析](feature/32_multiple_linear_regression.md)|[重回帰実装設計](tasks/DAVIS-FEAT-032-DESIGN.md)|OLS、カテゴリ説明変数、交互作用、HC3、調査設計分散|
|033|[探索的因子分析（EFA）](feature/33_exploratory_factor_analysis.md)|[EFA実装設計](tasks/DAVIS-FEAT-033-DESIGN.md)|非加重・完全ケース、Pearson ML／MINRES、Polychoric MINRES、平行分析、斜交回転、Pearson／Polychoric感度比較|
|033c|[確認的因子分析（CFA）](feature/33c_confirmatory_factor_analysis.md)|[CFA詳細設計](tasks/DAVIS-FEAT-033C-DESIGN.md)|独立した測定モデル、WLSMV/MLRと追加ULSMV・ML、推論・適合度・独立性|
|034|[コンジョイント分析](feature/34_conjoint_analysis.md)|[コンジョイント実装設計](tasks/DAVIS-FEAT-034-DESIGN.md)|評点型・選択型・完全順位型、効用・重要度・選好シミュレーション|

### 既存仕様との関係

033 EFA・033c CFAは[拡張契約](contracts/FACTOR_EXTENSIONS_CONTRACT.md)と[専用受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)を併読する。現行033はEFAの唯一の正本であり、旧033と033bは移動案内である。初期版の両機能は非加重・完全ケースのみ。CFAはローカルlavaanを検証対象とし、静的CFA実行は別段階。旧42件の参照試験は、新しい順序EFA/CFAの数値受入済みを意味しない。

追加成果物：[入力Python契約](contracts/factor_extension_requests.py)、[EFA Schema](contracts/schemas/efa.schema.json)、[CFA Schema](contracts/schemas/cfa.schema.json)、[fixture仕様](fixtures/FACTOR_EXTENSIONS_FIXTURES.md)、[一次資料](references/FACTOR_EXTENSIONS_SOURCES.md)、[接続確認](references/FACTOR_EXTENSIONS_SOURCE_AUDIT.md)。033 EFA/033cの構文正本はこの追加Python契約、意味・計算の正本は各詳細設計とする。既存のFactorAnalysisRequestとfactor_analysis.schema.jsonは旧連続ML資料の参照検証資産であり、現行入力契約ではない。

033 EFA/033cの個別仕様は版1.1。主要用途を5件法中心・N=1000〜2000程度とし、良好分布でのPearson＋ML/MINRESを主要経路に含める。033の順序尺度感度分析は、共通条件・因子の順序/符号整合の下で相関・負荷量・共通性・因子相関・因子数候補の差を表示する。CFAはEFA比較の一致を独立検証や推論の同等性として扱わない。

新規IDは添付のFeature 28までに続けて29〜34を採番した設計上の提案番号であり、既存リポジトリの採番を変更済みという意味ではない。Feature 30はFeature 27のMCA分析部分を置き換える。Feature 27/28のPCP、スクロール、ヒットテスト、ポップアップ、L1等の仕様は置き換えない。`/models/mca`はこの新契約で一本化し、同名の別エンドポイントを増やさない。

既存MCA詳細設計にある`P=Z/(N×Q)`のQを「指示行列の列数」とする記述を廃止する。新仕様では設問数をm、カテゴリ総数をKとし、非加重では`P=Z/(n m)`である。欠損方針、調査ウェイト、`selectedRowIds`、探索ラベル、比率単位も共通契約に統一する。

## 2. 設計上の判断

「多重応答分析」はMCA（多重対応分析）として定義した。ただし複数回答設問（MA）との混同を避けるため、MAは別の入力モードとして明示的に扱う。FAMDはカテゴリと数値を同時に扱う次元縮約であり、Feature 33の共通因子モデルとは別手法である。

コンジョイントは「評点を回帰する方式」だけに限定せず、選択型の条件付きロジット、完全順位型の逐次選択モデルも対象にした。階層ベイズ、混合ロジット、個人別効用の自動推定、実験計画の自動生成、適応型質問票は本版に含めない。代わりに対象内の識別可能性、回答単位、ウェイト、標準誤差、シミュレーションの意味を確定している。

推定値と標準誤差のウェイト対応は別に定義した。特にsurveyウェイトを精度重みや複製度数として処理しない。Feature 033 EFAは初期版で解決済みdatasetウェイトを受け付けず、FA_WEIGHT_UNSUPPORTEDを返す。ユーザーがnoneを明示した場合は別の非加重試行として保存する。

## 3. 付属成果物

- `contracts/`：Pydantic v2入力契約、JSON Schema、入力例、結果契約・データ辞書。
- `fixtures/`：CA/MCA/FAMD/回帰/因子/コンジョイントの小規模合成データと、数式検証から作成した期待値。
- `validation/`：独立した参照計算・自動検証、実行記録。アプリの実装用統計ライブラリではない。
- `references/`：原典の最小引用、採用理由、ソース確認箇所・ハッシュ。
- `ALL_SPECIFICATIONS.md`：文書を一括で読める連結版。編集・実装時の正本は分割ファイル。

本体ソース、既存のユーザーデータ、node_modules、Python実行環境は再配布ZIPに含めない。検証状況と未実施事項は[検証報告](validation/VALIDATION_REPORT.md)を参照する。


---

<a id="doc-2"></a>

出典ファイル：[feature/00_common_analysis_contract.md](feature/00_common_analysis_contract.md)

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
|探索的因子分析（EFA）|可|本版では不可|本版では不可|Pearson＋MLのみ参考検定。順序MINRESは推論なし|
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

[S-WLS](references/PRIMARY_SOURCES.md#s-wls)、[S-SURVEY](references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-3"></a>

出典ファイル：[tasks/DAVIS-FEAT-029-034-COMMON-DESIGN.md](tasks/DAVIS-FEAT-029-034-COMMON-DESIGN.md)

# DAVIS-FEAT-029–034 共通実装詳細化設計

版1.0／2026-09-12／関連：[共通機能仕様](feature/00_common_analysis_contract.md)。以下の`fullstack/`はリポジトリルート以下を指す。新規と明記したファイルは提案する実装先であり、既存ファイルではない。

## 1. 既存接続点と実装単位

|区分|確認した既存パス|使い方・注意|
|---|---|---|
|API登録|backend/app/main.py|全て/api/v1配下へrouter登録|
|基本context|backend/app/domain/context.py|collect_revisions/check_revisions/resolve_scope/scope_hashを再利用|
|列選択・MA|backend/app/domain/analysis_columns.py|dependencies解決、MA親全項目でのvalid判定|
|コードブック|backend/app/domain/codebook_adapter.py|normalize_code、missing/reverse。カテゴリにanalysis_seriesを流用しない|
|重み|backend/app/domain/weight_mode.py、survey_weight.py|既存宣言・列role・typeの検証を再利用|
|調査設計|backend/app/algorithms/survey/design.py、covariance.py|公式と境界条件を監査した新ラッパーから使用|
|原データ保存|backend/app/storage/dataset_store.py|lock/get_dataframe/get_meta/load_codebook/commit_data_change|
|来歴|backend/app/domain/provenance.py|operation=calculateによる派生列保存|
|API呼出|frontend/src/api/client.ts|localとstaticの共通入口|
|静的実行|frontend/src/engine/pyodide.worker.ts|同じFastAPIをASGI呼出。別のJS計算法を作らない|
|選択・色|frontend/src/app/store.ts、features/common配下|selectionApplied、hovered、既存L1/色resolver|
|ページ登録|frontend/src/main.tsx、app/KeepAliveOutlet.tsx、app/AppShell.tsx|routes、ROUTE_COMPONENTS、ANALYSIS_NAV_ITEMSの3箇所を変更|

新規共通モジュールは`backend/app/domain/analysis_contracts.py`、`domain/analysis_frame.py`、`domain/analysis_encoding.py`、`algorithms/analysis_numerics.py`、`algorithms/survey/model_covariance.py`、`services/analysis_service.py`、`storage/analysis_result_store.py`、`api/analysis_results.py`とする。`api/models.py`の私有辞書`_results`や`api/multi_response.py`の私有revision helperへの新たな依存は作らない。古い機能の全面移行は別作業とする。

FE共通は`features/analysis/useAnalysisRun.ts`、`AnalysisContextBar.tsx`、`AnalysisResultMeta.tsx`、`FactorMap.tsx`、`AnalysisExport.tsx`、`api/analysis.ts`を新規作成する。数値座標・点の選択と描画を分ける。SVG/Canvasは既存Reactから実装し、現在入っていないD3/Recharts等を導入必須にしない。

## 2. 入力型と境界検証

付属`contracts/analysis_requests.py`はPydantic v2の参照契約である。新規APIのみextra=forbid、型の厳密検証、JSON有限値を採用する。新規`AnalysisContextV2`は既存`AnalysisContext`の項目を維持しweightMode/typeを追加する。既存全APIにstrictをかけて破壊しない。

リクエスト構文の検証はPydantic、版とスコープはdomain/context、コードブックや欠損・重みの意味はanalysis_frame、計算法固有の識別可能性は個別kernelへ分ける。Pydantic ValidationErrorは既存形式のerrorへ整形し`ANALYSIS_REQUEST_INVALID`、HTTP422で返す。独自APIからHTMLや例外tracebackを返さない。

すべての列IDはコードブックで一意に解決し、同じ名前の別列へフォールバックしない。変数指定の順序はモデルの列順でありcache keyに含める。行IDは選択集合と保存順であり、モデル行列のインデックス位置ではない。

## 3. 共有前処理の確定手順

1. dataset lock内でmeta/codebook/maskRevisionを取得し、期待data/schema版を検証する。
2. `resolve_scope`を呼ぶ前にV2のスコープ必須配列を検証する。重複除去後の集合hashを得る。明示行のrequest順ではなくフレーム保存順に並べる。
3. 列計画を作り、モデル変数、__rowId__、全MA親dependencies、目的変数、重み、調査設計、コンジョイントIDをまとめて必要列集合にする。survey分散ではスコープ外の設計行も必要なため、設計用の全行ID/層/PSU/FPCは別に読む。
4. `get_dataframe(datasetId,columns=...)`から必要な不変スナップショットをコピーし、raw/datafingerprintと版を記録してlockを解放する。計算全体でデータ更新lockを握り続けない。
5. カテゴリはnormalize_code→missingCode→有効領域→表示ラベル/順序の順に処理する。有効領域Dはnormalized categoryOrder−missingCodes、Dが非空ならD外をinvalidとする。Dが空なら観測カテゴリを許す。`valueLabels`だけで閉領域を作らない。ordinalのカテゴリ解析は生コード同一性を維持する。
6. 数値は領域・欠損・有限性を判定後にreverseを適用する。reverseで固定尺度範囲がなければ既存CODEBOOK_REVERSE_RANGE_MISSINGを返す。データのscope内min/maxで逆転範囲を変えない。ordinal数値扱いは明示したordered_rankを使う。
7. MA子は親全体を`prepare_classifier`相当で検証しvalid行だけ0/1へ写像する。`AnalysisColumns.prepare`は要求names以外を落とすため、重み・ID・目的変数まで同じ戻りframeに残ると仮定しない。rowIdをキーとしたaligned補助配列を保持する。
8. weightMode解決→重み値の検証→個別手法のタスク/回答者整合性を実施する。weightMode=columnにtypeがなければ保存宣言から解決する。survey/frequencyを自動推測しない。
9. 各行のfirstExclusionReasonを一つ確定し、共通validMaskを全数値・カテゴリ・重み配列へ一度だけ適用する。合計件数の不変条件をassertする。CA表やコンジョイントのタスクルールは個別設計の例外を適用する。
10. 学習用変換、カテゴリ順、基準水準、正規化前の重み、除外理由、原rowId配列をPreparedAnalysisFrameに保存する。

`PreparedAnalysisFrame`はrowIds:list[str]、numeric:float64[n,p]、categorical:int32[n,m]、categoryCatalog、weights:float64[n]、aux、exclusions、snapshot、surveyFrameを持つ。無関係列の値を結果storeへ丸ごと保存しない。

## 4. 学習・結果ID・寿命

`POST /api/v1/models/{method}`は同期レスポンスとする。サーバーでは通常のFastAPI実行、staticでは既存serialQueueを使う。既存jobs/managerの中断状態をこのAPIの中断保証として使わない。

resultIdはUUID、modelFingerprintはSHA256で別に生成する。fingerprintの正規化JSONにはdatasetId/dataRevision/schemaRevision/imputationMaskRevision、元データfingerprint、scopeHash、fitRowIdsの保存順hash、型を保持したeffectiveConfig、カテゴリcatalog、resolvedWeight/type/design、seed、algorithmVersionを入れる。文字列と数値カテゴリをnormalize_codeした後の同一性は既存規則に従う。NaNを正規化してhashへ入れない。JSONはUTF-8、sort_keys=True、ensure_ascii=False、separators=(',',':')、allow_nan=False。float値の再現性が問題になる内部配列はdtype/shape/バイト列hashを記録する。

同一fingerprintの明示再実行はキャッシュを利用できる。UIの色、表示軸、ラベル位置、スクロールはfit fingerprintに入れない。変更の取り消しで既存resultIdを再表示してよい。`algorithmVersion`を変えた場合はcache互換なし。source/runtime版は検証・再現性情報であり、異なるruntimeの結果を同一bit列だと保証しない。

### 4.1 保存形式

`workspace/analysis-results/{resultId}/`にmanifest.json、model.npz、rows.parquet、exclusions.parquet、snapshot_columns.parquetを原子的に保存する。model.npzは数値配列だけ、object配列/pickleは禁止。文字列はJSON/Parquet。manifestはowner datasetId、method、config、meta、capabilities、schemaVersion、各ファイルhashを含む。

全軸の個体座標またはそれを正確に再構築できる変換済み行＋loadingsを保存する。片方を`rowStorage=coordinates|transform_input`で明示する。本版実装はcoordinatesを正本とし、FAMD/MCAの全非零軸を行ごとにParquetへ保存する。FAはq因子、回帰/コンジョイントは診断列を保存する。

ページ離脱で削除しない。明示的な結果削除、dataset削除、利用者のワークスペース初期化でのみ削除する。自動LRU/件数上限でKeepAlive結果を消さない。ローカルメモリにはmanifestだけ保持し、数値は必要時にディスクから読む。staticのIDBFS利用可否はruntimeCapabilitiesに返す。永続化不可なら「このタブ内のみ」と表示し、ブラウザ再読込後の保持を保証しない。IDBFS有効時は保存後syncfsを行い、失敗を警告する。

### 4.2 publishと版競合

計算後、dataset lockを再取得してdata/schema/mask版を確認する。変更されていれば計算結果を新規有効結果として公開せず409 ANALYSIS_INPUT_STALEとする。一時ディレクトリを削除する。変更がなければmanifestを最後にatomic renameして完成扱いにする。半端なmodelだけをGETで見せない。

stale判定は毎回の結果操作で現版と比較する。staleでも閲覧GET/rows/exportは許しmeta.resultState=staleを返す。select/predict/materializeは409。datasetが削除された場合は結果も削除して404。予測先は本版では同じdatasetの現在版に限り、別datasetへの汎用モデル移植は未対応。

## 5. 共通結果API

結果形は`{status:'success', resultId, method, meta, config, capabilities, summary, details, unavailableReasons}`。methodはca/mca/famd/linear_regression/factor_analysis/conjoint。詳細フィールドは`contracts/RESULT_CONTRACT.md`を正本とする。

|メソッド・URL|入力/出力と条件|
|---|---|
|GET /analysis-results/{id}|manifest由来の結果。rowデータは含めない。stale閲覧可|
|GET /analysis-results/{id}/rows?offset=0&limit=5000&axes=1,2|保存順の個体結果。limit 1..10000。rows,total,nextOffset,axes,meta。空末尾はrows=[]、nextOffset=null|
|POST /analysis-results/{id}/select|contextとselector。全保存点からrowIds,matchedCount,fitMatchedCount,contextIntersectionCount,selectionLabel。選択自体はFE storeで行う|
|POST /analysis-results/{id}/predict|contextとoptions。結果はpredictionIdとsummaryを返し、行結果はprediction用GETで取得|
|GET /analysis-results/{id}/predictions/{predictionId}/rows|offset/limit。同じページ仕様、観測yなしでも予測可|
|POST /analysis-results/{id}/materialize|context、source=fitまたはpredictionId、columnsマッピング、idempotencyKey。原子的に派生列保存|
|POST /analysis-results/{id}/export|format=json/csv、table、offset/limit。UTF-8文字列payloadとmime/fileName/nextOffsetを返し、FEがBlob化|
|DELETE /analysis-results/{id}|明示的削除。dataset本体を変更しない。既にない場合も204|

rowsのaxesは1始まりの重複なし昇順でなくても入力順を維持。省略時はmin(2,rank)、FAはmin(2,q)。回帰/CJではaxesを拒否する。最初から全rowsをPOST本文に載せない。GETのpage範囲を推定サンプルの範囲にしない。

### 5.1 select契約

selectorはrectangle、categories、row_ids、respondentsの判別union。rectangle={kind,axes:[a,b]または[a],bounds:[[lo,hi],...]}, boundsは閉区間・有限・lo<=hi。categories={kind,categoryIds,betweenVariables:'and'|'or'}で同一変数内はOR。row_idsは原__rowId__だけ。respondentsはCJ専用。scopeと結果の有効行の共通部分を計算し、FEはさらに現在activeとの交差を行う。

CA表モードではcategoriesの行カテゴリだけを受け付け、返すIDは集計表の行レコード。CA回答者モードは両側のカテゴリ組合せに対応する。回帰のrectangleはaxes指定ではなく`xField/yField`を使う別selector=diagnostic_rectangleとし、許可fieldはfitted/residual/leverage。任意JSON Pathの評価は禁止。

### 5.2 predict契約

共通contextは対象行。fit側のスコープ/欠損数とは別metaを返す。結果ごとのcapabilitiesで禁止機能はANALYSIS_OPERATION_UNSUPPORTED。CAはpredict不可。MCA/FAMD/FAはprojection。回帰はpoint/mean_ci/individual_piの区別、評価yが存在すれば追加指標。CJは学習行形式の予測のみ本APIで扱い、任意プロフィールシミュレーションは`POST /models/conjoint/{id}/simulate`とする。

予測は学習時に保存したcodebook変換を使用する。現スキーマの変更で解釈がずれる場合はstaleとなるため実行不可。行単位の不明値はpredictionStatus=unknown_category/missing/invalid/ok、value=nullで返す。全行失敗でも予測処理自体はsuccessとし、successfulPredictions=0と理由を返す。

### 5.3 materialize契約

columnsは`[{sourceField:'coordinate:1', name:'MCA1', label:'MCA第1軸'}]`等。field allowlistは手法ごとに固定する。新規列のみとし、既存列名/columnIdへの上書きは409 COLUMN_ALREADY_EXISTS。名前は既存の列作成バリデータに従い、空/予約語/制御文字を拒否する。columnIdはサーバー生成。scaleType=interval、role=other、derived originを設定する。

lock内でresult所有dataset一致→idempotencyKeyとpayload照合（既成功なら保存済み応答を返す）→未処理要求だけ版確認→全データへrowId左結合→対象外null→codebookに列追加→schemaRevision+1→operation=calculateのProvenanceStep作成→commit_data_change。dataRevision更新はstoreに任せる。補完maskは再作成しない。paramsにresultId/fingerprint/sourceField/fitScope/hash/configを保存する。

idempotencyはdatasetId+keyを一意に保存し、同じkey/同じpayload再送は以前の結果を返す。異なるpayloadなら409 IDEMPOTENCY_CONFLICT。コミット直後の通信失敗でも二重列作成しない。成功済み同一要求の再送は、元結果が保存によってstaleになっていても以前の成功応答を返す。新しいkeyによる書込みは通常通りstaleを拒否する。idempotency記録を同じコミットの来歴paramsに含め、独立ファイルへの後書きだけに依存しない。保存成功後の元モデルはdataRevisionが変わるためstaleになる。FEは新列と版を再取得し、旧モデルを勝手に新しい版へ付け替えない。

### 5.4 export・描画

現client.downloadBlobはstatic未対応のためそのまま流用しない。JSON/CSVのページを文字列としてapi.postで受け、FEでBlobを作る。CSVは各ページで同じヘッダ契約を使い、結合時は2ページ目以降のヘッダを除く。`table=manifest|eigenvalues|categories|variables|coefficients|diagnostics|rows|utilities`の手法別allowlistを使用。行出力は全件分ページを読む。データセット版が変わっても保存された同一snapshot結果を最後まで出す。

図はFE SVGをシリアライズし、PNGは既存Canvas変換を使う。書出しの倍率指定は描画解像度だけを変える。分析座標をpxから逆算して保存しない。テキストはエスケープし、HTMLラベルをそのまま埋め込まない。

## 6. 数値共通部

`thin_svd(A)`はscipy.linalg.svd(A,full_matrices=False,lapack_driver='gesdd',check_finite=True)。LAPACK収束失敗時のみ同じ行列でgesvdを一度試し、driverとfallback警告を記録する。乱数近似SVDへ変えない。rankTol=max(1e-12,eps*max(A.shape)*s0)、σ>rankTolを有効軸とする。全慣性は||A||F²。eigenvaluesはσ>rankTolの全有効軸のσ²を降順で保持し、長さはrankと一致する（表示軸だけへの切詰めではない）。閾値未満の慣性はdiscardedNumericalInertiaとして示す。各inertiaRatioの分母は切詰め前の全慣性であり、Σeigenvalues+discardedNumericalInertia≈totalInertiaとする。

軸の符号は右特異ベクトルまたは定義された負荷ベクトルの最大絶対成分を正にし、同率は保存列順で選ぶ。許容差1e-10で同一と見なされる固有値群はdegenerateBlocksとして返す。縮退群の軸ごとの位置の完全一致は要求せず、projector/再構成行列/距離で比較する。ユーザーのラベル移動や因子名は符号や縮退軸の識別を自動的に越えて移植しない。

除算はdenominator<=0またはrankTol相当のゼロならnullとする。小さい負固有値を全てabsにすることは禁止。理論上0の範囲に対する丸めのみ、絶対1e-12以内なら0へclipしてnumericalClipsに記録する。寄与・cos2・η²が1を1e-10以上超える場合は実装不整合としてANALYSIS_NUMERICAL_INVARIANT_FAILED。

回帰の最小二乗はlstsq(gelsd)またはQR/SVDで解く。推定のために逆行列(X'WX)^-1を直接生成しない。分散や予測に必要なbreadはSVDの特異値逆数から構成し、rank検証後だけ使用する。

## 7. surveyモデル分散の共通部

今回サポートするのは一段の層化PSU設計によるTaylor線形化。surveyDesignにreplicateWeightColumnIdsがある場合はANALYSIS_SURVEY_REPLICATE_UNSUPPORTEDで拒否し、通常重みだけで十分だと黙認しない。層/PSU/FPC列はcodebookから取得し、FPCは層内母PSU数M_hとして扱う（割合でない）。M_hは層内一定、有限、M_h>=m_h。複数段の指定は本版契約にない。

完全なデータセットの正重み分析単位から設計frameを作る。選択scope外・目的変数等で不使用の単位はscore=0として残す。重みや設計ID自体が欠損した行は完全設計を構成できないためinferenceStatus=unavailableを返し、点推定は利用可能行で継続できる。黙ってPSU数を減らして精密なSEを出さない。

単位iの加重scoreをu_iとし、PSU計T_hg=Σ_i∈hg u_i、層内平均Tbar_hを取る。meat=Σ_h (1−m_h/M_h) m_h/(m_h−1) Σ_g(T_hg−Tbar_h)(...)'。FPCなしは係数1。breadをBとしてV=B meat B'。PSUは(stratum,psu)の組で一意化する。PSUなしなら各回答者/各行をPSUとみなし、層があれば維持する。`designAssumption=independent_units`の注意を返す。

m_h=1でM_h=1と明示された確実抽出層は分散寄与0。他のsingleton層はinferenceStatus=unavailable、SINGLETON_PSU_WITHOUT_CERTAINTY。削除・平均補正を自動選択しない。設計df=D=Σ_h(m_h−1)。回帰はν=D−(p−intercept)、CJはν=Dを採用する。CJのD使用は漸近scoreモデルに対する設計t参照の製品規約で、回帰の残差自由度と混在させない。ν<=0はSEを計算できてもt/p/CIはnull。

既存covariance helperはsingletonを0寄与にする経路、strata/noPSU/FPCの特殊経路があるため、この境界契約の検査なしで呼ばない。新model_covarianceには上式を独立実装し、既存helperの利用は同じfixtureで一致する部分だけに限定する。既存クロス集計などへの変更は回帰テストを付けた別パッチとする。

## 8. FE状態・同時操作・表示

`useAnalysisRun`はdatasetId、datasetEpoch、runSequence、draftConfig、submittedConfig、resultId、status、errorを持つ。実行前にrunSequence++。レスポンスのepoch/sequenceが現在値と一致しなければ破棄する。data/schema変更はstale、dataset変更はreset。失敗した新実行で以前の結果を新設定として表示しない。

status=idle/dirty/running/success/stale/failed/cancelled。dirtyは結果があれば旧結果を保持、running中の設定編集はdraftのみ更新、実行に使用した値を変更しない。二重実行ボタンを無効化する。論理cancel時はsequenceを進めて結果採用だけを停止し、static queueが実際に空いた後に次の要求を流す。worker終了でキャンセルを実現しない。

FactorMapはaxisID/coordinateを受け、表示スケールとhit-testスケールを同じ変換から生成する。DPRは描画密度だけ。rank1は1軸の範囲選択。FocusMode、ブラウザzoom、KeepAlive非表示→再表示、resize、scrollに対応する。選択矩形はデータ座標でAPIへ送り、DOMpxを統計kernelへ渡さない。

## 9. 配布とテストゲート

実装はNumPy/SciPyと既存のPolars/Pydanticで行い、statsmodels、FactoMineR、prince、factor_analyzerをproduction依存に追加しない。これらのうちR/Statsmodelsはoracle用の別環境で使用する。添付requirementsとPyodide同梱版は同じとは限らないためruntime情報を必ず保存する。

静的ビルドではbackend_app.zipに新規api/domain/services/algorithmsを含め、キャッシュversionを更新する。添付`fullstack/scripts/build_static.py`のROOTからのパス連結は配布レイアウトで二重fullstackになり得るため、release作業で実在パスをassertする。変更後にlocal API、frontend型検査、static実機の3段階で確認する。

本体受入テストはbackend/tests/stats_tests配下へ追加、FEは既存frontend/testsに追加する。ネットワーク不要の数値fixtureを常設し、外部oracle値は生成元版・コマンド・データhashを保存する。本配布のvalidationはその準備であり、未実装APIに対して成功したと報告しない。

## 10. 共通操作contextの補足

select/materializeのcontextは対象集合と版検証に使用し、学習済み重み・欠損・変換を再解決しない。effectiveConfigを変更した扱いにしない。materializeはcontextで指定した現在集合とsourceに保存した行集合の共通部分にだけ値を保存する。scope=allならsourceの全行を対象とし、残りはnull。predictは学習時のmissing/encodingを固定し、contextのweight設定はevaluate=true時の評価集計にのみ使用する。射影座標や回帰係数を変えない。MCA/FAMD/FAはoptions.interval=noneのみ、CJもnoneのみとし、未対応区間指定を黙って無視しない。CAは予測そのものが未対応。

## 一次資料との対応

[S-SVD](references/PRIMARY_SOURCES.md#s-svd)、[S-LSTSQ](references/PRIMARY_SOURCES.md#s-lstsq)、[S-SURVEY](references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-4"></a>

出典ファイル：[feature/29_correspondence_analysis.md](feature/29_correspondence_analysis.md)

# Feature 029：通常のコレスポンデンス分析（CA）機能仕様書

版1.0／2026-09-12／依存：Feature 17〜21、25〜26、今回の共通分析契約。実装詳細：[DAVIS-FEAT-029-DESIGN](tasks/DAVIS-FEAT-029-DESIGN.md)。

## 1. 目的

二つのカテゴリ変数の関連を、分割表の独立モデルからの偏りに基づく低次元の配置として表示する。各カテゴリの位置、質量、軸への寄与、表示品質を同時に確認できるようにする。単なる棒グラフの配置、ユークリッド距離のPCA、個人同士の距離の分析とは区別する。

## 2. 入力モード

### 2.1 回答者データからの二元表

通常のnominal/ordinalを2列選ぶ。各行は一人の回答者として同じ二元表に1回だけ寄与する。MA親・子・countは本モードに受け付けない。MAの複数選択を人数として重複投入した表を通常の独立標本のCAと表示しない。数値をカテゴリにしたい場合は既存の明示的な再コード機能を先に使用する。

ウェイト・欠損カテゴリ方針は共通契約に従う。片方の変数だけ有効な行を周辺度数だけへ加えない。行/列カテゴリの全体表、対応する非加重人数表、加重質量表を結果に含める。

### 2.2 既存の分割表

既存データセット内の行ラベル列1列と、2列以上の数値セル列をマッピングする。行ラベルは名義・順序・id・textを許すが、非欠損かつ一意であること。各セルは0以上の有限数値とし、欠損セルを0にしない。同名行を自動で合算しない。

`cellSemantics=frequency`は全セルが整数度数、`mass`は一般の非負質量。割合表・加重表を使う場合はmassとする。frequencyの選択は「セルが独立した観測の度数である」という利用者の明示宣言も必要。合計行・合計列はユーザーが入力列/行の指定から外す。見出しがTotal/合計というだけで削除しない。適用されたdatasetウェイトが存在すればCA_DOUBLE_WEIGHT_FORBIDDENを返し、noneへ変更を促す。

構造的ゼロを制約とするCAは本版では対象外。標本上の0セルは許す。構造的ゼロがあることを利用者が指定した場合は拒否し、擬似度数を足す等の代替をしない。

## 3. 出力・操作

固有値、全慣性、各軸の慣性比、累積慣性比、特異値、数値ランクを表示する。行カテゴリと列カテゴリに、質量・座標・contribution・cos2・除外理由を表示する。質量0カテゴリは分析から外し、結果のomittedCategoriesに残す。

配置は3種類に限定する。symmetric=両側主座標、row_principal=行主座標/列標準座標、column_principal=行標準座標/列主座標。初期値はsymmetric。切替時は再推定せず座標の表示変換だけを行う。

同じ側の全次元距離がχ²距離に対応する。2次元図はその近似である。異なる側の点同士の近さを距離として解釈しない旨を図内のヘルプに常設する。対称図で「この属性の人はこの回答に最も近い」と自動文章化しない。

ランク1なら1次元ストリップを表示し、縦方向のラベル退避は表示用ジッターとして区別する。ランク0、正の質量をもつ行または列が1つ以下なら計算不能とする。初期表示軸はrank>=2なら1・2、rank=1なら1だけ。ユーザーのaxis指定が存在しなければ最適な初期値を選び、指定済みの存在しない軸は拒否する。

## 4. 推測統計

独立度数と宣言された非加重/frequency二元表に限り、χ²=総度数×全慣性、df=(I-1)(J-1)のPearson統計量を「独立性の参考検定」として併記する。Yates補正はしない。期待度数<1のセル、<5のセル比率を返し、近似の適否を利用者に示す。surveyウェイト・mass入力には通常Pearson p値を付けない。必要なら既存の調査設計対応クロス集計へ誘導するが、CAの軸が有意であるとは表示しない。

## 5. PCP・保存・エクスポート

回答者モードでは行カテゴリと列カテゴリの選択を元の有効回答者ID集合に戻す。行側の複数カテゴリはOR、列側の複数カテゴリもOR、両側はANDが初期値。ユーザーがORへ変えるとラベルに残す。カテゴリ座標をそのまま各回答者の個体座標として列保存しない。

分割表モードの選択は「表の行レコード」を選択する操作としてのみ提供し、列カテゴリは列の強調表示だけとする。回答者数や回答者へのPCP連動を捏造しない。CAでは派生個体座標のmaterializeは未対応として422。カテゴリ座標CSV、分割表CSV、固有値CSV、全設定JSON、図を出力できる。

## 6. 画面構成

設定：入力モード、行/列変数またはセル列、欠損方針、重み、配置方式。結果：配置図、寄与率、行カテゴリ表、列カテゴリ表、元の二元表、診断。行/列ラベルの色と形状を分け、カテゴリ点に回答者のL1色を無理に割り当てない。クリック時はラベル・度数・質量・座標・表示品質を提示する。

## 7. 受入条件

CA01 `[[30,10],[10,30]]`で固有値0.25、全慣性0.25、主座標は符号を除き±0.5、χ²=20。CA02 同じ表を回答者展開した場合と一致する。CA03 表全体の定数倍で座標が不変。CA04 質量0行/列の追加で既存座標が不変。CA05 2軸表示を全慣性で割る。CA06 不正セル/欠損セル/二重ウェイトを拒否。CA07 選択のAND/ORで原行IDが正しく戻る。CA08 surveyではp値なし。CA09 ランク1で偽の第2軸を表示しない。CA10 独立表は有効な配置として返さずCA_ZERO_INERTIA。

## 一次資料との対応

[S-CA](references/PRIMARY_SOURCES.md#s-ca)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-5"></a>

出典ファイル：[tasks/DAVIS-FEAT-029-DESIGN.md](tasks/DAVIS-FEAT-029-DESIGN.md)

# DAVIS-FEAT-029：通常CA 実装詳細化設計書

版1.0／対応仕様：[Feature 029](feature/29_correspondence_analysis.md)／前提：[共通実装設計](tasks/DAVIS-FEAT-029-034-COMMON-DESIGN.md)。

## 1. 実装対象と既存再利用

新規`backend/app/algorithms/models/correspondence.py`に純粋数値kernel、`api/correspondence.py`にrouteを作る。`algorithms/summaries/crosstab.py`の度数計算・欠損意味と一致させるが、旧APIレスポンスの丸めた割合や上限付きrowIdsから行列を逆算しない。共通のカテゴリエンコーダで回答者配列を一度生成し、そこからcount tableとrow-set indexを構築する。

FEは`features/models/CorrespondenceAnalysisPage.tsx`、routeは`/models/ca`。main.tsx、KeepAliveOutlet、AppShellへの登録を同じPRに含める。

## 2. API入力

`POST /api/v1/models/ca`。

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"none","missingPolicy":"exclude"},"input":{"kind":"respondents","rowVariable":"q_brand","columnVariable":"q_need"},"mapScaling":"symmetric"}
```

input unionのもう一方は`{kind:'contingency',rowLabelColumn:string,valueColumns:string[],cellSemantics:'frequency'|'mass',independentCountsAcknowledged:boolean,structuralZerosDeclared:boolean}`。frequencyのackはtrue必須、massではfalse。構造的ゼロtrueは422。両モードとも同じ列の二重指定を拒否。nComponentsは入力に置かず、全スペクトルを計算し表示axisは結果側の操作とする。

respondentsの場合、nominal/ordinal2列、同一列不可、両列とも非MA。contingencyの場合、ラベルは非欠損一意、セル列はinterval/ratioで2つ以上、選択scope内に2つ以上の表行。tableではmissingPolicy=excludeのみとし、欠損セル/欠損行ラベルは行除外ではなく表不正として422。入力の意味が崩れるため、列ごとに違う有効表をつくらない。

## 3. 行列構築

respondentsでは共通前処理後の各原行iに行カテゴリr_i、列カテゴリc_iを整数付番する。非加重ならw_i=1。`T=coo_matrix((w,(r,c)),shape=(I,J)).toarray()`またはnp.add.atによる同値実装を使う。非加重実人数の`Tphysical`も別に加算する。カテゴリー順は共通catalog。tableではscope内のセル値そのものをTにする。表の行レコード数はrespondentCountではない。

周辺質量が0の行/列は数値計算から除き、その順序とoriginalIndexをomittedCategoriesへ保存する。セル全体の総和が0ならCA_EMPTY_TABLE。除いた後のI/Jが2未満ならCA_DIMENSION_TOO_SMALL。全表を比率にする前にfloat64のfiniteを再検証し、sum overflowもCA_NONFINITE_TOTAL。

## 4. CAの数式

T∈R^(I×J)、t=Σ_ab T_ab>0、P=T/t、r=P1、c=P'1。全r,c>0を確認する。

```
S = diag(r)^(-1/2) (P - r c') diag(c)^(-1/2)
S = U diag(s) V'
lambda_l = s_l^2
F = diag(r)^(-1/2) U diag(s)          # 行主座標
G = diag(c)^(-1/2) V diag(s)          # 列主座標
Phi = diag(r)^(-1/2) U               # 行標準座標
Gamma = diag(c)^(-1/2) V             # 列標準座標
```

共通thin_svdとrankTolを使う。理論最大ランクmin(I−1,J−1)を超える数値軸は許さず、超過が丸め誤差の範囲外なら内部不変条件エラー。全慣性=sum(S*S)。rank=0ならCA_ZERO_INERTIA、summaryに表の診断をerror.detailsとして添える。成功の空scatterを返さない。

axis lの寄与はrowContrib_a,l=r_a F_a,l²/lambda_l、columnContrib_b,l=c_b G_b,l²/lambda_l。全軸距離はrowDistance²_a=Σ_b(P_ab/r_a−c_b)²/c_b、columnDistance²_b=Σ_a(P_ab/c_b−r_a)²/r_a。cos2は主座標²をこの距離で割る。距離0ならnull。標準座標表示へ切り替えても寄与とcos2は主座標による定義を変えない。

inertiaRatio=lambda/totalInertia。display2DInertiaRatio=lambda_axis1/total+lambda_axis2/total。分母に表示軸の合計を使わない。軸符号は列主座標の最大絶対成分を正、同率は列catalog順。UとV、F/G/Phi/Gammaをまとめて反転する。

## 5. 統計量と注意

独立frequency度数の場合だけexpected_ab=t r_a c_b、pearson=sum((T−expected)²/expected)、df=(I−1)(J−1)、p=scipy.stats.chi2.sf(pearson,df)。identityとしてpearson≈t totalInertiaをrtol1e-10で検査する。Yatesなし。smallExpectedCellsLt1、smallExpectedCellsLt5、fractionExpectedLt5を返し、推測統計の注記を付ける。

survey/massでは`pearson={statistic:null,df:null,pValue:null,status:'not_applicable',reason:'NON_INDEPENDENT_FREQUENCY_INPUT'}`。Tとtとinertiaは返すが`t*inertia`を検定として強調しない。CAの参考Pearsonは軸の検定や残差セルの多重比較ではない。

## 6. 結果型

summaryは`rank,totalInertia,eigenvalues:number[],inertiaRatio:number[],cumulativeInertiaRatio:number[],discardedNumericalInertia,tableTotal,activeRowCategoryCount,activeColumnCategoryCount,pearson`。

detailsは`rowCategories,columnCategories,omittedCategories,table,physicalTable,mapScaling`。各categoryは`categoryId,side,variableId,code,kind,label,mass,physicalCount,principalCoordinates,standardCoordinates,contributions,cos2,distanceSquared`。tableモードのphysicalCountはnullで、表セル度数を実際の回答者レコード件数と呼ばない。physicalTableもnull。

rowStorageはCA専用category-index。capabilitiesはrows=false,projection=false,materialize=false,selectionKinds=[categories]とexportTablesの一覧。category row-set indexはfull original __rowId__を保存し、上限付きの代表行リストで選択を代用しない。

## 7. UI実装手順

1. input.kindごとにフォームを分け、dataset weight適用表示を共通バーに置く。tableモード切替だけでweightModeをnoneへ裏変更しない。利用者が明示切替する。
2. コンポーネントの図にはprincipal/standardのどちらを渡すかをmapScalingで決定し、軸名に変換方式を書く。
3. 表示rank1のとき第2軸selectを無効化して1Dへ切替。有効カテゴリ0質量情報は折りたたみ表へ表示。
4. category clickを直接selectionAppliedへ流さず、CA用select APIで元行集合に解決し、existing operationを適用する。
5. tableモードの列カテゴリclickは選択ではなくセル列強調。rowカテゴリclickだけ原表行レコードへの選択ボタンを表示する。
6. 点のカテゴリラベル、質量、cos2をhoverで表示し、軸ラベルにraw inertia比を常時表示。

## 8. エラーと回復

|code|条件|画面対応|
|---|---|---|
|CA_CATEGORY_REQUIRED|非カテゴリ/同一列/MA|列選択を強調|
|CA_TABLE_INVALID|欠損・負数・重複行ラベル・非整数frequency|セル位置/行ID/列IDを最大20件、全件数も返す|
|CA_DOUBLE_WEIGHT_FORBIDDEN|table入力＋解決済み重み|明示的noneへの操作|
|CA_STRUCTURAL_ZERO_UNSUPPORTED|構造的ゼロ宣言|対象外の説明。擬似度数は加えない|
|CA_EMPTY_TABLE|全質量0|入力表を確認|
|CA_DIMENSION_TOO_SMALL|正質量行/列不足|行/列選択を確認|
|CA_ZERO_INERTIA|独立表で数値ランク0|関連を配置できない説明|

すべてHTTP422。数値不変条件違反は500 ANALYSIS_NUMERICAL_INVARIANT_FAILEDとしてtraceIdを残し、ユーザーデータ全体をログに流さない。

## 9. 実装・受入順序

kernel→表モード→回答者mode/weight→category選択→FE→export→staticの順。テスト新規`backend/tests/stats_tests/test_100_ca.py`、API`test_160_new_analysis_api.py`、FE`frontend/tests/correspondence.test.tsx`。

正解fixture、独立表、零周辺、表倍率、行列転置（FとGの交換）、カテゴリ置換、rank1、少数期待度数、missing3方針、weight none/frequency/survey、部分スコープ、stale選択を全てテストする。R caまたはFactoMineR CAと比較する際はscaling・重み・質量0処理を合わせ、符号と縮退を調整する。

## 10. 分割表モードの件数契約

表として妥当な入力ではmeta.scopeCount=fitCount=effectiveN=選択された表レコード数、excludedCount=0とする。幾何で除く零周辺行は入力不正でも回答者除外でもないため、omittedCategoriesとactiveRowCategoryCountだけに反映する。meta.analysisUnit=table_record、sumWeights=null、kishEffectiveN=null、frequencyN=null。summary.tableTotalはセル総量であり、独立frequencyモードの推論に使う度数総数もこの値である。cellSemantics=frequencyであってもfrequencyNを表行の複製数と誤認させない。weightApplied=false。回答者モードの通常metaと同一視しない。

## 一次資料との対応

[S-CA](references/PRIMARY_SOURCES.md#s-ca)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-6"></a>

出典ファイル：[feature/30_multiple_correspondence_analysis.md](feature/30_multiple_correspondence_analysis.md)

# Feature 030：多重対応分析（MCA）機能仕様書

版1.0／2026-09-12／Feature 27のMCA分析部分を改訂する。PCP/UI部分は維持。実装詳細：[DAVIS-FEAT-030-DESIGN](tasks/DAVIS-FEAT-030-DESIGN.md)。

## 1. 用語と目的

MCAはMultiple Correspondence Analysis、多重対応分析である。本依頼の「多重応答分析」はこの機能として受け止めるが、複数回答設問（MA、Multiple Answer）とは同義にしない。複数のカテゴリ設問の回答パターンを個体・カテゴリの両面から探索し、PCPの選択に接続する。

## 2. 対象・入力

通常のnominal/ordinalを2変数以上選択する。順序尺度も順序間隔を仮定しないカテゴリとして扱い、数値の大きさで距離をつくらない。変数は明示選択のみ。空配列や変数1つを「全変数」の指定と解釈しない。

`maMode=ordinary_only`を初期値とする。MA親・MA count・仮想未解決列は常に拒否する。`maMode=explicit_binary_options`では明示選択したMA子項目のみを許す。親の全子列でvalid/missing/partial/notApplicable/invalidを判定してから、valid行の選択項目を0/1の二値カテゴリへ変換する。親に不正がある行の選択済み子だけを救済しない。

MA子項目では「非選択」もカテゴリであり、選択された選択肢だけを1個の長いカテゴリリストにする方式ではない。10項目のMA親を10変数として入れると、通常1設問より強く分析へ関与し得る。`MA_OPTION_BLOCK_WEIGHTING`警告に親ごとの採用子数を示す。本版では親ブロックごとの重み補正、選択肢数補正、MFAと称する別手法を行わない。親内全子列の取得は判定のためであって、自動採用ではない。

## 3. 計算法の指定

完全指示行列のCA（indicator MCA）に統一し、Burt表を使った別実装と混在させない。m=分析変数数、K=実際に正の質量をもつカテゴリ総数を使用する。非加重の正規化はnmであってnKではない。

各変数の有効カテゴリが1つだけならその変数を黙って落とさずMCA_CONSTANT_VARIABLEで拒否し、該当変数を設定画面で表示する。未観測のコードブックカテゴリは表示用メタに残すが行列には入れない。すべての行が同じ回答パターン等でランク0ならMCA_ZERO_INERTIA。

ウェイトは非加重・frequency・surveyに対応し、後二者の幾何には正の重みを総和1に正規化して使う。surveyの設定があることと、母集団全体を代表する軸であることは同義ではない。推測統計や有意軸を出力しない。

## 4. 出力・解釈

個体主座標、カテゴリ主座標/標準座標、質量、contribution、cos2、固有値、rawInertiaRatioを返す。基本表示は個体主座標の散布図とカテゴリ主座標図を別タブにする。重ね合わせは明示切替とし、異なる種類の点の間のユークリッド距離を解釈しない注意を残す。

raw比率を正本にし、`inertiaAdjustment=benzecri`を選択した場合は修正固有値と修正比率も別系列で示す。raw座標を修正固有値で再スケーリングしない。修正後固有値が全て0なら修正比率をnullにし、「1/mを超える固有値がない」を表示する。raw比率を修正比率と同じ見出しで差し替えない。

少数カテゴリは非加重人数<5または加重割合<1%で警告する。この閾値は解釈上の注意を表示する製品仕様であり、統計的有意性の基準ではない。カテゴリを自動でOthersに統合しない。高寄与カテゴリを因果要因や優良顧客と自動命名しない。

## 5. PCP連動・列保存

個体の範囲選択は全有効個体に対して実施する。カテゴリークリックは「そのカテゴリーを持つ有効回答者を選択」する操作として区別し、変数内OR・変数間ANDを初期値にする。個体座標をMCA1、MCA2等の派生数値列として保存できる。除外行はnull、元のセルは変更しない。座標の計算法と版・スコープを来歴に記録する。

新規行への射影では学習済みカテゴリ確率・順序・変換を固定する。未知カテゴリ、学習時に質量0であったカテゴリ、不完全な行は個別のpredictionStatusで未計算とし、再学習や0ベクトル置換を行わない。

## 6. UI・互換性

メニュー名は「多重対応分析（MCA）」とする。「MAを含める」を詳細設定に置き、オンにしたとき上記のブロック警告を説明する。既存F27の`variables`名称は新契約の`variables`で維持するが値はcolumnIdに統一する。旧仕様の`includeRowCoordinates,rowOffset,rowLimit`は結果APIに置換し、本版に併用しない。未実装だったAPIへの新設計なので、実装済みの利用者がいる環境では移行アダプタで旧キーを明示警告つき変換するか、422でバージョン不整合を通知する。暗黙に無視する移行は禁止。

## 7. 受入条件

MCA01 行和m、総和nm。MCA02 全慣性=(K-m)/m。MCA03 mとKが異なるfixtureで旧nKバグを検出。MCA04 直接indicator CAと一致。MCA05 重み倍率不変。MCA06 missing/NAの3方針が集計と一致。MCA07 MA親全体の不正判定を維持。MCA08 ordinary_onlyでMA子を拒否。MCA09 Benzécri閾値とゼロ分母を処理。MCA10 個体座標保存がrowId一致。MCA11 カテゴリの改名だけで幾何が不変。MCA12 同一固有値では符号だけでなく部分空間として同値を検証。

## 一次資料との対応

[S-MCA](references/PRIMARY_SOURCES.md#s-mca)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-7"></a>

出典ファイル：[tasks/DAVIS-FEAT-030-DESIGN.md](tasks/DAVIS-FEAT-030-DESIGN.md)

# DAVIS-FEAT-030：MCA 実装詳細化設計書

版1.0／対応仕様：[Feature 030](feature/30_multiple_correspondence_analysis.md)。既存tasks/DAVIS-FEAT-027-028.mdの§2.5〜2.7を置き換える。

## 1. ソース構成・優先事項

新規`backend/app/algorithms/models/mca.py`、`api/mca.py`、`frontend/src/features/models/MultipleCorrespondencePage.tsx`。route `/models/mca`、API `/api/v1/models/mca`。このソースsnapshotではMCAの実装routeは確認できなかったため、新設として設計する。別ブランチに既存MCAがあっても旧nK正規化を温存しない。

共通numerics/encodingとCAの一般計算を再利用するが、MCA固有のm・K・補正慣性・MA親判定を独立にテストする。Burt法への分岐は作らない。

## 2. 入力契約

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"selected","selectedRowIds":["r1","r2","r3"],"weightMode":"dataset","missingPolicy":"exclude"},"variables":["q1","q2","q3"],"maMode":"ordinary_only","inertiaAdjustment":"raw"}
```

variablesはcolumnIdの重複なし配列、長さ>=2。input列にbinaryという存在しないscale enumを要求しない。通常2水準のnominalが二値変数である。maMode explicit_binary_optionsでMA子を含める場合はgroupId→全member dependenciesを解決し、採用columnsはvariablesに明示した子のみ。親全体の判定がvalid以外ならその親に由来する採用子全てを欠損/不正状態にする。MAのpartialは通常のmissingとして扱うがinvalidはinvalidのまま、notApplicableはその理由を保つ。共通missingPolicyがそれをカテゴリ化できる。

逆転ordinalはカテゴリの同一性を変えない。表示順の逆転をコードブック規約通り行ってよいが数値距離は同じ。使用変数ごとの観測正質量カテゴリ数K_j>=2を要求する。

## 3. 正規化の正本

nは正の重みをもつ有効物理行数、mは変数数、K=ΣK_j、Zはn×K完全指示行列。各行の和mをassertする。w_i>0、a_i=w_i/Σw、p_k=Σ_i a_i Z_ik、c_k=p_k/m。

```
P_ik = a_i Z_ik / m
r_i = a_i
S_ik = sqrt(a_i) (Z_ik - p_k) / sqrt(m p_k)
S = U diag(s) V'
lambda = s^2
F_il = U_il s_l / sqrt(a_i)
G_kl = V_kl s_l / sqrt(c_k)
Gamma_kl = V_kl / sqrt(c_k)
```

非加重ではP=Z/(nm)である。旧仕様のQ=KによるZ/(nK)を禁止する。ΣP=1、Σr=Σc=1、Σ_k p_k=m、変数jのΣ_{k∈j}p_k=1を検査する。

行列はscipy sparse CSRで構築してよいが、中心化後のSは一般にdenseになる。密行列のexact SVDを正本とし、疎行列近似に黙って変えない。行列サイズを理由に先頭行だけを計算しない。np.bincountでカテゴリmassを求め、重みを二重に掛けない。

全慣性=||S||²_F=(K−m)/m。これは全変数が完全指示で各使用カテゴリのp>0である場合の値で、未観測カテゴリをKへ数えない。数値rank<=min(n−1,K−m)。行数だけでなく回答パターンによるrank低下を許す。

## 4. 寄与・cos2・軸補正

個体寄与=a_i F_il²/lambda_l、カテゴリ寄与=c_k G_kl²/lambda_l。個体全次元距離²=Σ_k (Z_ik/m−c_k)²/c_k。カテゴリ距離²=(1−p_k)/p_k。cos2はF²/G²を各距離²で割る。全軸について個体平均0、カテゴリ主座標の質量加重平均0、axisごとの寄与和1を検査する。

rawRatio=lambda/totalInertia。Benzécriを選択すると、全固有値について`adjustedLambda_l=(m/(m−1))² max(lambda_l−1/m,0)²`、`adjustedRatio=adjustedLambda/Σ_all adjustedLambda`。閾値と同じ固有値は0。分母0は比率配列の各値をnull、reason=NO_EIGENVALUE_ABOVE_BENZECRI_THRESHOLD。raw座標、raw寄与、raw cos2は一切変えない。

カテゴリ点による符号規則はGの最大絶対成分正。縮退ブロックは共通規約通り。カテゴリー座標のscatterを「個人間距離」と説明しない。カテゴリpが小さければ距離が大きくなりやすいことを警告するが、自動でカットしない。

## 5. 結果・永続化

summary={nVariables:m,nCategories:K,rank,totalInertia,eigenvalues,rawInertiaRatio,rawCumulativeInertiaRatio,inertiaAdjustment,adjustedEigenvalues,adjustedInertiaRatio,degenerateBlocks}。raw時のadjusted配列はnull。details.categoriesはcategoryId/variableId/code/kind/label/physicalCount/categoryProbability:p/categoryMass:c/principalCoordinates/standardCoordinates/contributions/cos2。未観測の宣言カテゴリはomittedCategoriesに理由zero_massとして残す。

row結果はrowId、coordinates、contributions、cos2、mass:a。rowStorage全軸、model.npzにp,c,V,sとfit encodingを保存する。選択・射影・保存のcapabilitiesをtrueとする。新規rowへは次式で主座標を計算する。

`F_new = (z_new/m − c)' diag(c)^(-1/2) V`（row-vector表記では`(z/m-c) @ (V/sqrt(c)[:,None])`）。ここで新規rowの重みで点の座標を動かさない。学習済みmとカテゴリ順を固定する。学習rowで射影と保存Fがrtol1e-9で一致することを検査する。

## 6. MA境界の具体例

親QMAにA,B,Cの3子があり、採用はA,BだけでもCを読みvalid判定に使用する。行(1,0,9)が親宣言のselected={1},unselected={0}ならinvalid。A=1,B=0だけを使って成功させない。行(0,0,0)の意味はallUnselectedMeaningに従う。validならA非選択/B非選択の2カテゴリとして使う。missingならmissingPolicyで両変数の欠損カテゴリへ写像し、その実行はm=採用変数数に含む。すべてmissingの変数が1水準しか持たなければconstantとして拒否する。

選択された子数を親ごとにmaDiagnosticsへ返す。MAを一つの通常カテゴリ変数にするため選択組合せを連結するモード、選択数に応じて各rowを複製するモードは本版に存在しない。

## 7. FE実装

個体図とカテゴリ図を分け、個体図はL1色、カテゴリ図は変数ごとの色。1変数のカテゴリを点shapeではなく変数凡例で区別する。カテゴリ表をクリックして選択する場合は変数間AND/ORを設定し、その条件をselection labelにする。表と図のaxis IDは1始まりで統一する。

Benzécri表示はスクリープロットにraw/adjustedの2系列を明示、軸ラベルはデフォルトraw。切替は結果JSONの別系列を読むだけで実行ボタンを押さない。n<30、稀少カテゴリ、MAブロック重みの注意を別コードで表示する。

座標materializeでsourceField=coordinate:lを選び、name既定MCA1等。rankを超えたfieldを拒否する。カテゴリ負荷や座標を個体列へ自動転記しない。

## 8. エラー・テスト・完了条件

MCA_CATEGORY_REQUIRED、MCA_TOO_FEW_VARIABLES、MCA_CONSTANT_VARIABLE、MCA_MA_UNSUPPORTED、MCA_ZERO_INERTIA、MCA_INVALID_INDICATOR。通常入力不備422、indicator row sum不変条件の破れは500として実装バグを検出。

`test_110_mca.py`に少なくとも、3変数・2/3/4カテゴリ(m≠K)、同一変数複製、カテゴリー改名、row permutation、frequency整数複製、survey×100、zero weight、MA親invalid、missing3種、Benzécri全0、projection、重複固有値を置く。

FactoMineR MCAのmethod=Indicatorとのoracle比較では欠損処理、row.w、カテゴリ順、raw固有値を合わせる。Burtの固有値はindicatorと同じではないためoracleに混ぜない。Feature27旧試験のnK・selected rowIds・isExplorative=false・MA無視の期待値は本仕様に更新し、PCP関連試験は削除しない。

## 一次資料との対応

[S-MCA](references/PRIMARY_SOURCES.md#s-mca)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-8"></a>

出典ファイル：[feature/31_famd.md](feature/31_famd.md)

# Feature 031：混合データ因子分析（FAMD）機能仕様書

版1.0／2026-09-12／実装詳細：[DAVIS-FEAT-031-DESIGN](tasks/DAVIS-FEAT-031-DESIGN.md)。

## 1. 目的・位置づけ

カテゴリ変数と連続数値変数を、尺度に応じて重み付けした同じ個体空間で分析する。カテゴリを整数ラベルへ置換して通常PCAをする誤りを防ぎ、数値だけのPCAとカテゴリだけのMCAの間を扱う。FAMDという名称にfactorが含まれても、潜在共通因子と独自因子の正規モデルを推定するFeature 33とは別機能である。

## 2. 入力

`numericVariables`を1列以上、`categoricalVariables`を1列以上必須とする。numericはinterval/ratio、categoricalはnominal/ordinal。両配列の重複を禁止する。ordinalはカテゴリ側を初期値とする。等間隔得点として扱う場合は既存変換機能で明示的に数値派生列を作成し、それを指定する。FAMD内で順序を黙って1,2,3に変換しない。

MA親・子・countは本版では拒否する。MCAの明示MAモードを自動で流用しない。利用者がMA子を通常の独立した名義派生列として作成した場合は通常列として扱うが、来歴で元のMAを追跡できる。多数の派生列による寄与の増加を自動的に補正する機能はない。

数値だけならPCAへ、カテゴリだけならMCAへ案内し、FAMDとして成功を返さない。数値変数のゼロ分散、カテゴリ変数の有効1水準は拒否し、利用者に除去対象を示す。

## 3. 標準化・欠損・ウェイト

数値変数は正の重みを総和1にした平均と分散（ddof=0）で標準化する。カテゴリの各指示列は中心化して√カテゴリ比率で割る。二値変数の一般的な標準偏差√p(1-p)で割る方式ではない。またカテゴリ数の平方根で追加正規化する独自方式ではない。これをFAMDの数値契約として固定する。

数値欠損は全指定変数に対する完全ケース除外。カテゴリの欠損は共通missingPolicyによる。FAMDが自動補完まで実施したような表示にしない。非加重/frequency/surveyを同じ加重幾何で扱い、ウェイトの全体倍率に依存しない。

## 4. 結果

個体座標、全固有値、全慣性、各軸比率を表示する。数値変数は軸との相関、カテゴリ変数は相関比η²、すべての変数は軸への寄与を示す。数値相関²とカテゴリ相関比を並べた「変数と軸の関係」図を提供するが、因果的な重要度とは呼ばない。

カテゴリ座標は「そのカテゴリを持つ個体の座標の加重重心」として定義する。指示列のPCA負荷量をカテゴリ点と称して直接表示しない。カテゴリcontributionは指示列の右特異ベクトル成分の二乗に基づき、重心座標を通常CAの寄与式へ代入しない。

個体・カテゴリの平面と、数値変数の相関円は別表示とする。相関円は[-1,1]の同一縮尺、個体図はデータ範囲であり、同じ距離尺度として重ねない。η²図は各軸[0,1]とする。座標は画面のpxではなく分析座標で保存する。

## 5. 補助操作

個体座標の選択、L1による色分け、座標列への保存、新規行の射影に対応する。新規行は学習時の平均・標準偏差・カテゴリ確率・列順を固定して変換する。欠損/未知カテゴリ行は未計算理由を返す。サプリメンタリー変数、欠損補完モデル、クラスタの自動生成は本版対象外。

## 6. 表示上の注意

変数ごとの総慣性は数値1、カテゴリKj-1であり、全慣性は数値列数+Σ(Kj-1)。これはカテゴリ変数の全カテゴリ数を無条件に同じ総量へそろえる方式ではない。カテゴリの水準数が多いことによる解釈上の注意を表示する。「すべての元変数が必ず同じ総寄与」と説明しない。

寄与・相関比・cos2は異なる量として独立した列名を使う。カテゴリの遠さだけで重要度が高いと判断させず、質量と寄与を併記する。集計の分母は表示中2軸ではなく全非零軸に固定する。

## 7. 受入条件

FAMD01 全慣性=pnumeric+Σ(Kj-1)。FAMD02 数値列の正の単位変換と平行移動に対して個体間距離が不変。FAMD03 カテゴリ改名で不変。FAMD04 ダミーを√pで割るfixtureと一致し√p(1-p)とは一致しない。FAMD05 カテゴリ座標が個体重心に一致。FAMD06 変数寄与の軸内合計1。FAMD07 カテゴリη²と数値相関²が0〜1。FAMD08 予測で学習標準化を固定。FAMD09 survey倍率不変。FAMD10 数値のみ/カテゴリのみ/MA/定数を明示エラー。

## 一次資料との対応

[S-FAMD](references/PRIMARY_SOURCES.md#s-famd)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-9"></a>

出典ファイル：[tasks/DAVIS-FEAT-031-DESIGN.md](tasks/DAVIS-FEAT-031-DESIGN.md)

# DAVIS-FEAT-031：FAMD 実装詳細化設計書

版1.0／対応仕様：[Feature 031](feature/31_famd.md)／原典：FactoMineR FAMD実装を規約の比較先とする。ソースの逐語移植ではなく、以下の数式を独立実装する。

## 1. ファイル・API

新規`backend/app/algorithms/models/famd.py`、`api/famd.py`、`frontend/src/features/models/FamdPage.tsx`。route `/models/famd`、POST `/api/v1/models/famd`。

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"dataset","missingPolicy":"exclude"},"numericVariables":["age","satisfaction"],"categoricalVariables":["region","brand"]}
```

各配列長>=1、相互重複なし。MA列とordinal数値扱いは拒否し、前段の明示派生列化を案内する。全列の有効行を同一maskで確定後に標準化する。変数ごとに別nや別平均を使わない。

## 2. 行列構築

有効row数n、正規化重みa、数値列数p、カテゴリ変数数m、各水準数K_j>=2、K=ΣK_jとする。

数値変数x_jについてμ_j=Σa_i x_ij、σ²_j=Σa_i(x_ij−μ_j)²、Z_ij=(x_ij−μ_j)/σ_j。σ²<=0はFAMD_CONSTANT_VARIABLE。平均の大きさに依存した不安定な`E[x²]−E[x]²`ではなく中心化した二段階の分散を使う。

カテゴリ指示行列Gについてp_k=Σa_i G_ik、B_ik=(G_ik−p_k)/sqrt(p_k)。各変数のカテゴリ確率和は1。質量0の宣言カテゴリは行列から外しカタログだけ保持する。二値指示列の標準偏差sqrt(p_k(1−p_k))で割らない。MCAのsqrt(m)をここへ持ち込まない。

```
X = [ Z | B ]              # n×(p+K)
A = diag(sqrt(a)) X
A = U diag(s) V'
lambda = s^2
F = X V = diag(a)^(-1/2) U diag(s)
```

全慣性=Σ_j Σ_i a_i Z_ij²+Σ_kΣ_i a_i B_ik²=p+Σ_j(K_j−1)。rank<=min(n−1,p+K−m)。MCA全慣性(K−m)/mとは異なる。exact薄型SVD、共通rankTol、縮退取り扱いを使用する。

## 3. 個体・数値変数・カテゴリの意味

### 3.1 個体

coordinates=F、distanceSquared_i=||X_i||²、contribution_i,l=a_i F_il²/lambda_l、cos2_i,l=F_il²/distanceSquared_i。Σa_iF_il=0、Σa_iF_il²=lambda_l。

### 3.2 数値変数

numericCoordinate_j,l=cor_w(x_j,F_l)=V_j,l sqrt(lambda_l)。表示名correlations。contribution_j,l=V_j,l²。cos2はcorrelation²（標準化変数の長さ1）。元スケールの回帰係数や独立した因子負荷と混同しない。

### 3.3 カテゴリ

表示座標は個体の重心である。

```
barycenter_k,l = sum_i a_i G_ik F_il / p_k
               = lambda_l V_(p+k),l / sqrt(p_k)
categoryContribution_k,l = V_(p+k),l^2
```

`p*barycenter²/lambda`を寄与とするのは誤り。今回のFAMD規約では`p*barycenter²/lambda²=V²`が対応する。CAの式をそのまま流用しない。

カテゴリcos2は`barycenter_k,l² / ||b_k||²`、`b_k=Σ_i a_i G_ik X_i/p_k`を全標準化特徴空間で計算した重心。分母を表示2軸だけの重心距離にしない。分母0ならnull。

### 3.4 元変数単位

数値変数のrelationStrength=correlation²。カテゴリ変数jのrelationStrength=η²_j,l=Σ_{k∈j}p_k barycenter_k,l²/lambda_l。変数のcontributionは数値V²、カテゴリはΣ_{k∈j}V_(p+k),l²。axisごとに全元変数contributionの和=1。relationStrengthの変数間和は1になる必要がなく、寄与率として出力しない。

## 4. 結果契約

summary={rank,totalInertia,eigenvalues,inertiaRatio,cumulativeInertiaRatio,nNumericVariables,nCategoricalVariables,nCategories,degenerateBlocks}。

details.numericVariables=[{variableId,label,mean,scale,correlations,contributions,cos2}]。

details.categoricalVariables=[{variableId,label,categoryIds,relationStrength,contributions}]。

details.categories=[{categoryId,variableId,code,kind,label,probability,physicalCount,barycenterCoordinates,contributions,cos2,distanceSquared}]。coordinateConvention='weighted_individual_barycenter'を全体に記載。details.omittedCategoriesも保持する。

row結果はrowId,coordinates,contributions,cos2,mass。model.npzにμ,σ,p,V、encoded列順を保存する。categoricalVariablesのprobabilityは変数ごとに合計1であり、MCAのcategoryMass=p/mとは違う。名前をmassに省略して混同させない。

## 5. 学習済み射影

新規x_new,g_newに対しz_new=(x_new−μ_fit)/σ_fit、b_new=(g_new−p_fit)/sqrt(p_fit)、f_new=[z_new,b_new]V_fit。予測対象の平均やカテゴリ比率を計算し直さない。新規行重みは座標を変えない。学習時未観測カテゴリ/unknownは変換不能。欠損方針で追加したmissingカテゴリが学習時に存在しなければ、予測時の欠損は未知カテゴリと同じ未計算になる。

数値の外挿は学習min/maxに対して警告を返すが、有限値なら射影可能。fit行を再射影した座標の一致をテストする。予測行のcontributionは学習軸の慣性を説明する量ではないため返さずnullとする。cos2は同じX空間の距離で表示可能。

## 6. FE詳細

3つの図を同じFactorMapの異なるvariantで実装する。individualsはF、categoriesは重心、numeric_correlationsは相関円。個体とカテゴリを重ねる場合はどちらもF座標系なので重心関係を説明できるが、数値相関円を同じスケールに重ねない。

`variable_relation`タブはrelationStrengthで軸別に[0,1]に配置し、数値はr²、カテゴリはη²とtooltipに明記。contributionランキングは別タブ/別列。カテゴリを選択したら当該カテゴリを持つfit行のIDを解決する。図の色を変数色/L1色で切り替えても学習をやり直さない。

保存列はcoordinate:1等の個体座標だけ。correlationやカテゴリ重心を全回答者へ貼り付けない。min(2,rank)初期軸とrank1 fallbackを共通実装から使用する。

## 7. エラー・受入

FAMD_MIXED_INPUT_REQUIRED、FAMD_SCALE_INVALID、FAMD_MA_UNSUPPORTED、FAMD_CONSTANT_VARIABLE、FAMD_ZERO_INERTIA、FAMD_UNKNOWN_CATEGORY。データ依存422、未知カテゴリ予測だけrow statusとする。

`test_120_famd.py`に、カテゴリ比率不均等の3水準＋数値2列を使う正規化fixture、数値の+1000/×100、カテゴリの水準順逆転、数値符号反転、重み×100、frequency展開、共通mask、予測再現、η²恒等式、寄与合計、重心の直接平均比較を実装する。

FactoMineR FAMDとのoracle比較はrow.w、scale=加重ddof0、カテゴリmissingなし、同じ行/列順で行う。R側の既定欠損補完と本版listwiseは違うため、欠損ありデータを前処理の違いを無視して比較しない。慣性比とカテゴリ重心は同じ規約を確認してから照合する。

## 一次資料との対応

[S-FAMD](references/PRIMARY_SOURCES.md#s-famd)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-10"></a>

出典ファイル：[feature/32_multiple_linear_regression.md](feature/32_multiple_linear_regression.md)

# Feature 032：重回帰分析機能仕様書

版1.0／2026-09-12／実装詳細：[DAVIS-FEAT-032-DESIGN](tasks/DAVIS-FEAT-032-DESIGN.md)。

## 1. 目的・範囲

連続目的変数を複数の数値・カテゴリ説明変数で説明する線形モデルを追加する。既存のLOESS、ロジスティック回帰、KDAとは別機能とする。OLSを基本とし、frequencyウェイトによる複製同値推定とsurveyウェイトによる加重推定・設計分散に対応する。逆分散を入力する精度WLS、時系列誤差、混合効果、GLM、ステップワイズ、正則化は本版に含めない。

## 2. 入力・モデル設定

目的変数はinterval/ratioの1列。説明変数は数値/カテゴリの構造化リストで選ぶ。ordinalはカテゴリ扱いを初期値とし、数値扱いには`ordinalAsNumericAcknowledged=true`と`score=ordered_rank`を明示する。数値として扱ったordinalはカテゴリ順に1〜K、逆転項目ならK+1-rankとする。等間隔を仮定したことをモデル式に表示する。

カテゴリはtreatment coding、基準水準を指定できる。省略時は有効な学習カテゴリのコードブック順の先頭を基準とし、結果に必ず書き戻す。説明変数同士の2項交互作用は明示指定したものだけ生成し、構成する主効果を必須とする。カテゴリ×カテゴリでは非基準ダミーの直積、数値×カテゴリでは数値と非基準ダミーの積。3項以上は拒否する。

切片を初期値trueとし、falseも明示的に対応する。切片なしの場合はモデル式・結果表・R²の見出しを「非中心化」とし、通常R²や平均中心の調整済R²を使わない。入力重複、目的変数の説明変数への混入、ランク欠損を自動で削除して続行しない。

## 3. 推定・標準誤差

非加重/frequencyでは`covariance=hc3`を初期値とし、`classical`も選べる。surveyでは`taylor`に固定する。covarianceの不適切な組合せを受け付けて無視しない。HC3は異分散に頑健であって、クラスター依存や選択バイアスへの万能な補正ではない。

surveyで層・PSUがある場合は設計に基づく分散を使う。ない場合は「回答者を独立な抽出単位とした近似」として返す。singleton PSUや自由度不足で分散が推定不能でも係数を表示できるが、SE/CI/p値をnullとし、0や通常OLS SEへ置換しない。複製ウェイト法、多段抽出の全段、校正ウェイトの推定誤差は本版対象外で、該当設定は未対応として明示する。

## 4. 結果

係数、標準誤差、t統計量、参照自由度、両側p値、95%CIを返す。連続主効果のみ標準化係数も補助表示する。ダミーや交互作用の標準化係数を「変数重要度」と一括比較しない。

適合度には使用物理行数、frequencyN、R²、残差RMSE、残差自由度、モデル行列ランク、条件数を含める。非加重/frequencyのclassicalでは通常F検定・AIC/BICを追加できるが、必須結果の定義は実装設計に固定する。HC3/Taylorの同時検定はrobust Wald Fとして通常Fと区別する。surveyの調整済R²・通常AIC/BICは本版ではnull。

予測値/残差の図、残差QQ、レバレッジ、Cook距離、設計列単位のVIFを提供する。カテゴリ変数の複数ダミーを単一の通常VIFにまとめない。VIFは切片を含む補助回帰に基づく設計列単位の診断と表示し、surveyでは加重共線性の診断であって調査設計補正値ではない。

## 5. 予測と保存

学習と同じモデル行列変換を新規行へ適用する。未知カテゴリは予測不能として行単位で返す。学習データに目的変数が欠損して除外された行でも、説明変数が揃っていれば新規予測として計算可能。学習残差保存と新規予測保存を区別する。

平均応答のCIは採用した係数共分散で計算する。個別の観測値の予測区間は非加重/frequencyかつclassicalだけに提供し、HC3/surveyでは一般の誤差分散が定まらないため未提供とする。学習範囲外の数値には外挿警告を返すが、有限でモデル行列を作れる場合は点予測を許す。

予測値、学習残差、レバレッジの保存はrowIdで結合する。学習外の残差やレバレッジを0としない。検定結果を因果効果、予測精度を未検証の汎化精度とは呼ばない。

## 6. 検証用ホールドアウト

本版の推定APIは学習のみとし、内部の自動train/test分割は導入しない。別スコープで学習済み結果へ予測し、観測yがある行に対してRMSE/MAE/R²を計算する評価操作を提供する。評価対象と学習対象に重複があれば件数を明示し、「未学習データでの評価」と表示しない。カテゴリ水準・平均・係数は評価データから再推定しない。探索後の評価セット使い回しについては参考値であることを常設する。

## 7. 受入条件

LR01 既知の小データでstatsmodels OLSと係数・古典SEが一致。LR02 HC3が一致。LR03 frequencyを物理展開したHC3と一致。LR04 survey重み倍率で係数・SE不変。LR05 選択スコープのsurvey分散で全設計PSUを保持。LR06 ランク欠損を拒否。LR07 未知カテゴリは予測null。LR08 切片なしR²の意味が明示。LR09 個別PIをHC3/surveyに捏造しない。LR10 既存LOESS・ロジスティック回帰のAPIを壊さない。

## 一次資料との対応

[S-HC3](references/PRIMARY_SOURCES.md#s-hc3)、[S-SURVEY](references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-11"></a>

出典ファイル：[tasks/DAVIS-FEAT-032-DESIGN.md](tasks/DAVIS-FEAT-032-DESIGN.md)

# DAVIS-FEAT-032：重回帰 実装詳細化設計書

版1.0／対応仕様：[Feature 032](feature/32_multiple_linear_regression.md)。共通設計の重み・スコープ・版・推測統計契約を適用する。

## 1. 接続先・入力

新規`backend/app/algorithms/models/linear_regression.py`、`api/linear_regression.py`、`frontend/src/features/models/LinearRegressionPage.tsx`。route `/models/linear-regression`、POST `/api/v1/models/linear-regression`。既存`api/regression.py`のLOESSを置き換えない。

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"none","missingPolicy":"exclude"},"target":"overall","predictors":[{"columnId":"quality","kind":"numeric"},{"columnId":"brand","kind":"categorical","referenceCategory":"A"}],"interactions":[],"intercept":true,"covariance":"auto","confidenceLevel":0.95}
```

covariance=autoは非加重/frequencyでhc3、surveyでtaylorに解決し、effectiveConfigへ解決後を保存する。明示したhc3/classical/taylorがweightTypeと不整合ならLR_COVARIANCE_WEIGHT_CONFLICT。purpose=精度WLSの入力フィールドは存在しない。

predictor.numericはinterval/ratio、またはordinalで`ordinalAsNumericAcknowledged=true,score='ordered_rank'`。categoricalはnominal/ordinal、referenceCategoryはnormalize_code済みの実値カテゴリのcodeを指定する。欠損カテゴリを基準にしたい場合のUIは本版では未提供とし、referenceCategoryに内部missing sentinelを渡させない。基準省略時は有効な通常value水準の先頭、通常valueがない場合はLR_NO_REFERENCE_CATEGORY。

説明変数/target重複・predictor重複・interaction重複・自己交互作用・3項以上・未採用主効果との交互作用を拒否する。式文字列をevalしない。

## 2. モデル行列

学習validMaskを先に確定し、カテゴリcatalogと基準水準を学習行だけから作る。通常のvalue水準に加えmissingPolicyで採用したmissing水準もk−1符号化する。各カテゴリ変数は有効水準>=2。宣言カテゴリが未観測なら列を生成せずomittedLevelsへ返す。指定基準が未観測ならLR_REFERENCE_UNOBSERVED。評価/予測行から水準を追加しない。

列順は切片（有の場合）、predictorsの指定順、各変数内のcatalog順（基準除外）、interactionsの指定順で展開する。interaction内は第一変数の列を外側、第二変数の列を内側とする。数値は元尺度または宣言ordinal得点のまま。自動中心化/標準化はせず、条件数が大きければ警告する。

X∈R^(n×p)、pは切片とダミーと交互作用を含む列数。すべて有限。`Xw=sqrt(w)[:,None]*X`、`yw=sqrt(w)*y`。`scipy.linalg.lstsq(Xw,yw,cond=eps*max(Xw.shape),lapack_driver='gelsd')`でβを得る。rank<pならLR_RANK_DEFICIENTを422。rankTolと依存候補列（SVDのnull方向から最大係数の列名）をdetailsに返す。黙ってダミーを削除しない。

bread B=(X'WX)^−1はrank確認済みのXwのSVDからV diag(1/s²)V'で構成する。正規方程式を直接逆行列化して係数推定しない。n physical<pなら必ず識別不能だが、frequencyN>pだけで通過させない。

## 3. 残差・標本数・適合

fitted=Xβ、e=y−fitted、SSE=Σw e²。非加重w=1、frequency w=fは整数度数。nStat=nまたはΣf。surveyではnStat=null。sumWeightsは倍率依存するがmean/R²は比なので不変。

切片ありはTSS=Σw(y−ybar_w)²、なしはTSS=Σw y²。R²=1−SSE/TSS、rSquaredType=centered|uncentered。TSS=0ならnull。RMSE=sqrt(SSE/Σw)とresidualStdError=sqrt(SSE/(nStat−p))を別々に表示する。後者は非加重/frequencyだけ。

非加重/frequencyの残差dfν=nStat−p、ν>0を要求する。surveyのt/CI参照dfは共通設計のD−(p−intercept)。adjustedR²=1−(1−R²)(nStat−intercept)/(nStat−p)、切片なしは見出しもadjusted uncenteredにする。surveyではadjustedR²=null。

完全当てはまりSSE<=eps*max(1,TSS)はLR_NEAR_PERFECT_FIT警告。SSE=0のとき通常Gaussian log likelihoodとAIC/BICは未定義としてnull。係数が計算できることと誤差分散が安定して推定できることを分ける。

classicalかつ非加重/frequencyでSSE>0なら`logLik=−nStat/2*(log(2π)+1+log(SSE/nStat))`、`kAic=p+1`（誤差分散も1パラメータ）、AIC=−2logLik+2kAic、BIC=−2logLik+kAic log nStat。statsmodels OLSの表示AIC/BICは誤差分散を数えない規約なので、oracle比較時はAICへ2、BICへlog(nStat)を加えて比較する。HC3/Taylorでは本版のAIC/BIC表示はnullとする。

## 4. 分散の正本

### 4.1 classical

非加重/frequencyのみ。σhat²=SSE/(nStat−p)、V=σhat²B。係数SE=sqrt(diagV)。95%等CIはt_(ν,1−α/2)。frequency重みを平均1に正規化してからSSE/dfを計算しない。原度数で複製と同値にする。

### 4.2 HC3：非加重

h_i=x_i'Bx_i、meat=Σ x_i x_i' e_i²/(1−h_i)²、V=B meat B。h>=1−1e-12の行があればHC3は数値的に未定義のためSE/CI/pをnullとし、HC3_LEVERAGE_ONEを返す。分母へ適当なepsilonを足して大きなSEを作らない。

### 4.3 HC3：frequency

f_i回同じ独立観測を複製したものとして扱う。B=(X' diag(f)X)^−1。一つの複製観測のleverageは`h0_i=x_i' B x_i`。したがって

`meat=Σ_i f_i x_i x_i' e_i²/(1−h0_i)²`。

f_i²を使う式、h0の代わりにf_i h0を分母へ入れる式はいずれも禁止。これは調査ウェイトのsandwichと別物である。参照dfν=Σf−pを使うt近似であり、有限標本の厳密なHC3分布を保証しない。

### 4.4 survey Taylor

βは同じ重み付き最小二乗。単位score u_i=w_i x_i e_i、scope外/分析変数欠損行のscore=0。共通model_covarianceで層/PSUのmeatを求めV=B meat B'。survey重みを任意にc倍したらBは1/c、meatはc²となりVが不変であることをテストする。PSUなしは独立行の近似とラベル付けする。

設計情報不足/不正/単一PSU層でVを得られない場合は係数だけ成功、inferenceStatus=unavailable。negative/FPC範囲外等の明らかな設計入力不正は422、それ以外のsingleton/df不足は推測不能として返す。この区別をUIの警告とエラーで分ける。

## 5. 検定・標準化係数

係数t=β_j/SE_j、p=2*t.sf(abs(t),ν)。SE=0なら非有限tを送らずnull、ZERO_STANDARD_ERROR。p値0は浮動小数のunderflowとして起こり得るため0を許すが「p=0で絶対」と表示せず表示下限で`p<1e-300`等にする。

全傾きの同時検定はRβを取りq=rankR、`F=(Rβ)'(RVR')^−1(Rβ)/q`、df=(q,ν)のrobust Wald。RVR'がfull rankでなければnull。classicalでは通常Fも計算し一致を検査する。切片だけのモデルはpredictors>=1規約により本版入力対象外だが、交絡で傾きrankが0の場合は推定不可。

標準化係数は連続/ordinal数値の主効果に限りβ_j*sd_w(x_j)/sd_w(y)、両sdはddof0の同じ重み比で計算する。交互作用・ダミーにはnull、reason=NOT_COMPARABLE_STANDARDIZED_EFFECT。共線性や交互作用がある状況で大きさだけを重要度の順位にしない。

## 6. 診断

non-survey：leveragePerReplica=h0、leverageTotal=f*h0（noneはf=1）。行表でこの2つを分ける。studentizedInternal=e/(σhat sqrt(1−h0))、CookPerReplica=e²*h0/(p*σhat²*(1−h0)²)。frequencyでは「一つの複製観測」を削除する診断であって元の圧縮行ブロック全削除の影響ではない。ブロック削除診断は本版未提供。

survey：leverageTotal=w*x'Bxを幾何的診断として出す。通常のCook距離とstudentized residualはnullであり設計補正済みと偽装しない。fitted/residualは通常通り出す。

VIFは各非切片設計列x_jを他の設計列＋補助切片へ重み付き回帰し、centered補助R²から1/(1−R²)。補助回帰に重複切片を追加しない。1−R²<=1e-12ならnull理由PERFECT_COLLINEARITY、定数列ならnull。結果は元変数ではなくdesignColumnIdに紐付ける。GVIFや自動変数除去は実装しない。

QQは有効なeを標準化して並べ、非加重の表示位置(i−0.5)/nに対する標準正規quantileを使う。frequencyでは頻度重みのmid-CDF位置(累積前f+f/2)/Σfを使用する。surveyは加重CDFを使っても正規性検定とは呼ばず参考図である。

## 7. 予測・評価・保存

保存モデルにdesignColumns、category/reference、ordinal/reverse、学習数値min/max、β、V、σ²、νを保持。row予測ではtargetの欠損を理由に予測を除外しない。平均CIはβ推定共分散Vから`yhat±tcrit sqrt(x'Vx)`。individualPIはclassicalのみ`yhat±tcrit sqrt(x'Vx+σ²)`。入力の新しいweight値で予測値や誤差分散を変えない。

予測評価のyがある行だけRMSE/MAE/R²を計算し、評価数、fitRowOverlap、fitRespondentOverlap（通常rowIdのみならnull）を返す。評価の重みは予測contextの宣言を使うが、係数を更新しない。評価指標のスコープと学習スコープを別metaにする。

保存可能fieldはfitted/residual/leverage_total/leverage_per_replica、およびpredictionのpredicted/mean_ci_lower/mean_ci_upper/individual_pi_lower/individual_pi_upper。inference未対応fieldを全null列として保存することは拒否する。fit外行へresidualを埋めない。

## 8. 結果フィールド・FE

summary={targetLabel,nDesignColumns,rank,conditionNumber,rSquared,rSquaredType,adjustedRSquared,rmse,residualStdError,residualDf,referenceDf,logLikelihood,aic,bic,kAic,inferenceStatus,covarianceMethod,jointTest}。details={designColumns,coefficients,categoryReferences,vif,omittedLevels,designDiagnostics}。coefはdesignColumnId/termId/label/estimate/standardError/statistic/pValue/ciLower/ciUpper/standardizedEstimate。

係数表の見出しにcovarianceMethodとreferenceDfを表示する。設定フォームのカテゴリ基準選択は表示ラベルを検索できるがAPI valueはcode。UI上で選択したvariable一覧と展開後design columnsの両方を確認可能にする。個体図はx=fitted,y=residualを初期値とし、selectionは全保存rowへ適用する。

## 9. 実装テストと完了条件

`test_130_linear_regression.py`、API共通試験、FE linear-regression.test.tsxを追加。検証順はOLS点推定→classic→HC3→frequency展開→カテゴリ/交互作用→survey→予測→FE/保存。準備したfixtureで、factor列/row順変更と符号ではなく係数codingを一致させて比較する。

surveyは少なくとも2層×各3PSU、PSU内複数行の手計算fixture、scopeが1PSUを除くdomain解析、certainty singleton、非certainty singleton、FPCあり/なし、PSU番号が層間重複するcaseを置く。現行のsurvey helperが違う値を出した場合はその値へ新期待値を合わせず数式と原典から原因を確認する。

## 一次資料との対応

[S-HC3](references/PRIMARY_SOURCES.md#s-hc3)、[S-WLS](references/PRIMARY_SOURCES.md#s-wls)、[S-LSTSQ](references/PRIMARY_SOURCES.md#s-lstsq)、[S-SURVEY](references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-12"></a>

出典ファイル：[feature/34_conjoint_analysis.md](feature/34_conjoint_analysis.md)

# Feature 034：コンジョイント分析機能仕様書

版1.0／2026-09-12／実装詳細：[DAVIS-FEAT-034-DESIGN](tasks/DAVIS-FEAT-034-DESIGN.md)。

## 1. 目的と分析種別

属性と水準を組み合わせたプロフィールへの選好データから効用を推定し、属性重要度と仮想選択集合の選好を比較する。以下を別モデルとして実装する。

|種別|観測値|モデル|標準出力|
|---|---|---|---|
|ratings|プロフィールごとの数値評点|pooled OLSまたは回答者固定効果OLS|部分効用、評点予測|
|choice|各選択タスクで1つだけ選んだ代替案|条件付きロジット|部分効用、選択確率|
|ranking|各タスクの全代替案の重複なし完全順位|逐次選択ロジット（Plackett–Luce型）|部分効用、第1位選択確率|

部分順位、同順位、best-worst、適応型、階層ベイズ、ランダム係数、個人別効用推定、実験計画自動生成は本版対象外。評点を指数変換しただけの値をCBC推定確率と表示しない。

## 2. 入力形式

縦持ちデータを正本とする。必須マッピングはrespondentId、taskId、alternativeId、属性列、response列。1行は1回答者×1タスク×1代替案。`__rowId__`はアプリの行ID、respondentIdは回答者IDであり別物である。ワイド形式は既存変換または明示的な外部変換で縦持ちにしてから投入する。同梱CSVテンプレートを提供する。

ratingsのresponseは有限評点。choiceは0/1で各タスクに1だけ一つ。rankingは1が最良で、各タスクに1..Jの完全な順位が一度ずつ存在する。各タスクでalternativeIdは一意。choice/rankingでは利用可能な代替案が2つ以上必要。availability列を任意指定でき、false行は選択肢集合外として扱うが、選択された行や順位付き行が利用不可なら不正。

属性はcategoricalまたはlinear。categoricalはeffect codingを使い水準効用の和を0にする。linearは実数値を固定した学習中心で中心化する。価格をlinearとして指定すれば同一単位の効用傾きを推定できる。カテゴリ価格から連続的な支払意思額を勝手に算出しない。

## 3. データ整合性と分析単位

PCP選択等でタスクの一部代替案だけが選ばれた場合、choice/rankingはCONJOINT_PARTIAL_TASKで拒否する。勝手に選択集合を変えたり、選択範囲外の行を無断で追加しない。UIには「選択に含まれるタスク全体を対象にして再実行」の明示操作を設ける。その操作は新しいcontextとして記録する。

欠損方針はexcludeのみ。choice/rankingで利用可能な1行に欠損があればタスク全体を除外し、理由を返す。回答不正（複数選択、順位重複等）は除外して通すのではなく422。ratingsは行単位除外。人数、タスク数、代替案行数、逐次順位ステージ数を分けて表示する。

回答者ウェイト・層・PSU・FPCは同じrespondentId内で一致することを要求する。frequencyは回答者の回答ブロックを複製する度数であって、各選択肢の頻度ではない。surveyは回答者の代表性調整であり、タスクや選択肢の出現回数を標本数にしない。

## 4. モデル設定・識別

ratingsでは`ratingEffects=pooled|respondent_fixed`を選択し、初期値pooledとする。回答者固定効果は十分な回答者内変動があるときだけ利用する。回答者ごとの評点水準の違いを除く方法であって、個人別属性効用を推定する方法ではない。

choice/rankingは選択集合内で定数になる共通切片を入れない。opt-outを含む場合だけoptOutIndicator列による共通ASCを任意で追加する。通常代替案の位置番号ごとのASCを自動で追加しない。位置や提示順を効用と取り違えない。

本版は主効果のみとし、属性間交互作用は提供しない。属性が完全に交絡する、タスク内で変動しない、常に特定水準が選ばれる等の場合は識別可能性・有限最尤解を検証する。失敗時に自動でridgeやベイズ事前分布を付けない。

## 5. 結果・推測統計

カテゴリ水準効用、線形属性係数、推定SE/CI、属性内レンジ、相対重要度、学習適合指標、回答単位診断、収束情報を表示する。水準数が異なる属性間の重要度は、今回提示した水準範囲に依存する指標と説明する。レンジがすべて0なら重要度nullであり、均等配分しない。

推測統計は回答者単位のscoreを集約したクラスター共分散を初期値とし、surveyでは設定に応じた層・PSU分散を使う。順位を逐次choiceへ変換した各段階を独立回答者として扱わない。自由度不足や分離に伴う推測不能を、標準誤差0や非常に高い確信として表示しない。

線形価格が負の傾きで十分識別された場合のみ、他属性の効用差を価格係数で割ったモデル上のWTPをオプション出力する。価格係数が0/正、CIが0をまたぐ場合は不安定として未提供。これは実購買行動から推定した因果的価格弾力性ではない。

## 6. 選好シミュレーション

学習範囲内の新しいプロフィール集合をユーザーが入力する。choice/rankingでは同じlogitモデルで集合内確率を計算する。「市場シェア」ではなく「指定集合におけるモデル選択確率」と表記する。外部認知率、供給制約、競合の追加、売上予測は含まない。

ratingsでは予測評点を返し、first-choice配分を補助表示する。最高効用の同点は等分する。評点の尺度から温度パラメータを勝手に定めてsoftmaxを出さない。回答者固定効果の新規回答者は回答者平均切片を使った参考予測と明示する。

既存データで予測・評価する際はタスクの完全性を維持し、学習に含まれる回答者との重複数を表示する。未学習タスクでも同じ回答者なら「回答者外検証」と呼ばない。

## 7. PCP・保存

プロフィール点の残差や選択確率から元の__rowId__へ連動する。回答者単位で選択する操作は全タスク行を対象として別ボタンにし、行選択と区別する。学習行の予測評点/選択確率/残差を派生列に保存できる。水準効用を回答者固有の効用として列保存しない。モデルJSON、効用CSV、タスク診断CSV、プロフィール予測CSVを出力する。

## 8. 受入条件

CJ01 effect codingで水準効用和0。CJ02 2択・同一属性差・3対1選択の係数がln(3)/2。CJ03 タスク内全効用への定数加算で確率不変。CJ04 部分選択集合を拒否。CJ05 回答者反復のscoreを集約。CJ06 frequencyの回答者ブロック展開と一致。CJ07 survey倍率で推定値/SE不変。CJ08 順位の尤度が段階確率の積と一致。CJ09 ratingsに根拠のないlogit確率を出さない。CJ10 分離/識別不能/欠損タスク/opt-outを検証。CJ11 重要度分母0とWTP不安定をnullにする。

## 一次資料との対応

[S-CLOGIT](references/PRIMARY_SOURCES.md#s-clogit)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。


---

<a id="doc-13"></a>

出典ファイル：[tasks/DAVIS-FEAT-034-DESIGN.md](tasks/DAVIS-FEAT-034-DESIGN.md)

# DAVIS-FEAT-034：コンジョイント 実装詳細化設計書

版1.0／対応仕様：[Feature 034](feature/34_conjoint_analysis.md)。統計単位は回答者、選択集合は回答者×タスク、物理行はプロフィールという3階層を保持する。

## 1. 実装分割・接続

新規`backend/app/domain/conjoint_data.py`、`algorithms/models/conjoint_encoding.py`、`conjoint_ratings.py`、`conjoint_choice.py`、`conjoint_simulation.py`、`api/conjoint.py`を作る。ratingsの数値最小二乗はFeature32の純粋coreを再利用し、HTTP APIを内部呼出ししない。choiceとrankingは同じstage尤度kernelを使う。

FEは`features/models/ConjointPage.tsx`、`ConjointMapping.tsx`、`ConjointSimulator.tsx`。route `/models/conjoint`、POST `/api/v1/models/conjoint`。

## 2. 入力型と段階検証

```json
{"context":{"datasetId":"conjoint-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"none","missingPolicy":"exclude"},"mode":"choice","columns":{"respondentId":"respondent_id","taskId":"task_id","alternativeId":"alternative_id","response":"chosen"},"attributes":[{"columnId":"brand","kind":"categorical"},{"columnId":"price","kind":"linear","utilityRange":[100,300]}],"ratingEffects":"pooled","confidenceLevel":0.95,"maxIterations":1000}
```

mode=ratings|choice|ranking。columnsの任意項目はavailability、optOutIndicator。ratingEffectsはratingsでのみ有効、他modeでは既定pooled以外を拒否。属性>=1、同じ列の属性重複不可。mappingのID/response列と属性列を重複使用しない。すべてのIDは非欠損、キーはtupleとして扱い、文字区切り結合による衝突を起こさない。

属性categoricalはnominal/ordinal、linearはinterval/ratio。categoricalのreferenceLevel省略はcatalogの最後の通常value水準。linearのutilityRange省略はfit内の最小/最大、明示時はfinite lower<upperで訓練範囲外でも指定範囲であることを警告して許可。価格属性は`priceAttribute`でlinear属性1列を任意指定する。指定しなければWTPは出さない。

### 2.1 完全性と欠損の処理順

1. 全datasetのID列からtask indexを作る。scopeがchoice/rankingのタスクの一部rowだけを含む場合、欠損除外やavailability判定より先にCONJOINT_PARTIAL_TASKを返す。未選択タスクは対象外、選択されたタスクは元の全raw rowが必要。全datasetの他タスクのresponse/属性を読む必要はない。
2. mapping IDの欠損、タスク内alternative重複、回答者に矛盾するweight/designは422。これらを単なる欠損に変えない。
3. availability省略は全true。指定時はboolean、数値0/1、正規化後の文字列"0"/"1"だけを認め、false/0→利用不可、true/1→利用可能と固定する。それ以外の二値コード（例1/2、はい/いいえ）をcategoryOrderから推測せず、事前の明示的派生列化を求め422。optOutIndicatorも同じ変換規約を使い、欠損をfalseにしない。falseは分析不使用。choiceでresponse=1のfalse行、rankingで順位があるfalse行は矛盾として422。
4. responseの非欠損値に対してchoiceは0/1、rankingは正整数、ratingsはfinite numericを検証する。choiceで1が複数、rankingで順位重複は即422。response欠損があるタスクは全体除外であり、残存0件のchoiceを「選ばれなかった」と解釈しない。
5. choice/rankingの有効候補に属性またはresponse欠損が一つでもあればタスク全体を除外する。非欠損の不正response/不正属性コードは422。ratingsは属性/response欠損行を除外し、不正値も共通invalid件数へ分類して除外する。
6. 残ったchoiceタスクの選択数=1、rankingの順位集合=1..J、J>=2を検証する。scopeで回答者の一部タスクだけを使うことは許すが、task単位選択であることをmetaへ記録する。
7. 回答者weightがmissingならその回答者のscope内rowをすべてmissing_weight除外、zeroならzero_weight除外。負/非有限/frequency非整数は422。スコープ外を含む同回答者のweight値が一致しない場合はCONJOINT_RESPONDENT_WEIGHT_CONFLICT。

false availability行はfitCountに含めず、structural_task_exclusion理由をavailability_excludedとして補助内訳に記録する。除外件数は物理行単位で共通の和を満たす。得点欠損の巻き添え行もstructural_task_exclusionにする。

### 2.2 opt-out

choice/rankingのみ。各taskに最大1行、optOutIndicator=1で識別する。opt-out行の全属性design値を0、ASC値を1に固定し、通常行のASCは0。opt-out行の属性セルは欠損を許し値を無視するが、無視した属性が非欠損なら警告する。ratingsではopt-out設定を拒否。opt-outの選択頻度が0/100%等で有限最尤解がない場合は分離検査で止める。opt-outの有無がタスク間で違うことは許す。

## 3. effect codingと学習用辞書

属性jがK水準ならK−1列。非基準水準kは自身の列1・他列0、基準水準は全列−1。通常プロフィールの属性効用はβ_jk、基準効用は−Σ_{k<K}β_jk。K=2ならcode±1なので係数は二水準効用差の半分である。水準効用の和=0が必須。

linear属性はx−μ_train。μ_trainはfit通常プロフィール行の正重み平均（同回答者の各プロフィール行に同じwを使う）。この中心は係数の単位を変えず、opt-out ASCの基準を明示するため保存する。utilityRangeは重要度算出用で、学習値のclip範囲ではない。

辞書は属性順→水準順で固定。未観測水準を0係数として追加せずomittedLevelsへ返す。codebookで有効だが学習時未観測の水準も予測時は未知扱い。属性全体に1水準しかない場合CONJOINT_CONSTANT_ATTRIBUTE。

## 4. 評点型モデル

### 4.1 pooled

通常プロフィールのdesign Xに切片を加え、Σ_i w_i Σ_t (y_it−α−x_it'β)²を最小化する。X'WXのrankを検証し、OLS用gelsdで解く。回答者ごとのタスク数でwを割らない。観測の多い回答者が情報を多く提供する構造を保持し、SEでは反復を考慮する。

### 4.2 respondent_fixed

回答者iの有効評点行の平均xbar_i/ybar_iを取り、x~_it=x_it−xbar_i、y~_it=y_it−ybar_i。回答者内のwが一定なのでこの平均は行の単純平均と同じ。切片なしでΣw_i(y~−x~β)²を最小化する。α_i=ybar_i−xbar_i'β、fitted_it=α_i+x_it'β。

within行列のrankが属性係数数p未満ならCONJOINT_WITHIN_RANK_DEFICIENT。回答者1行のケースはwithin情報を提供しないが、他回答者でrankが満たされるなら保持し、当該回答者のαのみ再現する。全員1行なら識別不能。

meanIntercept=Σ_i w_i α_i/Σ_i w_iを新規回答者の参考切片とする。回答行数で加重しない。α_iやmeanInterceptの推測CIは本版未提供。固定効果があることを個人別βがあることと混同させない。

## 5. 選択型・順位型の尤度

choiceのstageはtaskそのもの。rankingは最高順位から順に選ばれた代替案を取り除き、残存集合サイズ>=2までJ−1stageへ展開する。ステージは元taskとrespondentを保持する。

stage sの集合C_s、選ばれたc_s、効用v_sj=x_sj'β、`logP_sj=v_sj−logsumexp(v_s)`。

```
logL = sum_s w_respondent(s) * logP_s,c_s
score_s = x_s,c_s - sum_j P_sj x_sj
H_s = X_s' [diag(P_s) - P_s P_s'] X_s
```

各回答者score U_i=Σ_s∈i score_s、H=Σ_i w_iΣ_sH_s。学習中の確率にnp.exp(v)を直接使わずlogsumexpでoverflowを防ぐ。最後の1選択肢stageは尤度0なので保存しなくてよいが、元行はfit行として残る。

### 5.1 識別可能性・有限解

タスク内でX列を平均中心化した行列のrankがp必要。共通切片はrankを失うので禁止する。さらにchosen対otherの差行列D_sj=x_s,c−x_s,jを構築して完全/準完全分離を検査する。列を非ゼロRMSでスケールしたDで、`maximize sum(Dv)` subject to `Dv>=0, -1<=v_j<=1`をscipy.optimize.linprog(method='highs')で解く。正の最大値>1e-8なら改善方向があるのでCONJOINT_SEPARATIONを返す。設計matrix rank欠損は先に止め、null方向を分離と混同しない。

LP solverが失敗/利用不可ならCONJOINT_SEPARATION_CHECK_FAILEDで止める。PyodideでHiGHSが利用できることをstatic releaseの明示スモークテストにする。分離検査を削除してβの任意上限だけで判定しない。

### 5.2 最適化

内部conditioning用にタスク内変動のRMS scale_jを計算し、scaledX=X/scale_j。初期βscaled=0、scipy.optimize.minimize(method='L-BFGS-B',jac=analytic,ftol=1e-12,gtol=1e-7,maxiter=input,maxls=50)。境界なし、正則化なし。conv条件solver.successかつscoreInfNorm/Σwstage<=1e-6、Hの正定値・full rank、logL finiteを要求する。

最終βoriginal=βscaled/scale。Voriginal=diag(1/scale)Vscaled diag(1/scale)。最適化のための内部scaleを効用単位に残さない。有限解でも情報行列が数値的に特異ならCONJOINT_INFORMATION_SINGULARとし、過度に小さいSEを表示しない。

## 6. 標準誤差・ウェイト

### 6.1 非加重・frequency

主結果は回答者クラスター共分散。ratingsではU_i=Σ_t x_it e_it（固定効果ならwithin x）、H=X'WX。choice/rankingは上式のscore/H。frequency f_iは回答者ブロックをf_i回複製するのでG*=Σ_i f_i、meat=Σ_i f_i U_i U_i'。非加重f=1、G*=回答者数。

`V_CR1 = (G*/(G*−1)) H^−1 meat H^−1`、t参照df=G*−1。ここで採用するCR1はクラスター数補正G/(G−1)のみであり、観測行数による追加因子(N−1)/(N−p)は掛けない。共分散名は`respondent_cluster_CR1_G`とし、statsmodelsの既定cluster補正と無条件に一致すると主張しない。oracleではCR0へG/(G−1)だけを掛けて比較する。

frequencyをw_i=f_iとして`Σ f_i² U_iU_i'`を使うと回答者複製と一致しないため禁止。元の同回答者の全タスクを複製した各コピーに別の仮想回答者IDを付けたoracleで検査する。G*<=1なら点推定のみ、SE/CI/pはnull。

### 6.2 survey

回答者score U_iにw_iを掛け、回答者が属する層/PSUへ集約して共通Taylor meatを用いる。層/PSU/FPCは回答者内で一定。surveyDesignがなければ回答者をPSU、1層とし、回答者独立の近似と表示する。scopeに含まれない回答者も全設計にはscore0で残す。

SE=sqrt(diagV)、t/p/CI参照dfはD=Σ(m_h−1)。有限母集団の単位は回答者またはPSUであり、choiceの行数をM_hにしない。倍率cの不変性をテストする。PSU/層不整合やreplicate weights指定は共通エラー。singleton/df不足は推測不能として係数のみ。

### 6.3 効用表への共分散伝播

カテゴリ水準効用u=Lβで、非基準は単位ベクトル、基準は当該属性係数の−1和。V_u=L V L'。省略水準のSEを0にしない。linear slope/opt-out ASCは対応するβ。重要度・レンジのCIは本版未提供（max/minを含む非線形量への簡易SEを捏造しない）。

## 7. 適合指標・予測評価

ratingsはRMSE/MAE、pooledの中心化R²、固定効果ではwithinR²=1−withinSSE/withinTSSとoverallR²を別に表示する。固定効果の学習R²を未知回答者への予測性能とは呼ばない。

choice/rankingはlogLikelihood、stageCount、taskCount、meanNegativeLogLikelihood=−logL/Σ_s w_s。equal-choice nullはlogL0=−Σ_s w_s log |C_s|、McFaddenR²=1−logL/logL0。これは通常OLS R²ではない。surveyのlogL総量は重み倍率依存なので平均NLLを主指標にする。尤度比χ²/AIC/BICは反復/設計を無視しやすいため本版では提供しない。

choiceのhitRateは最大確率代替案を1位とした予測の正解率。同点は正解がtie集合に含まれる場合1/tie数を加点。rankingの第1位hitRateは最初のstageのみ、全順位loglossは全stageと明記する。予測時の異なるtaskは学習からパラメータを更新しない。

## 8. 任意プロフィールのシミュレーション

`POST /api/v1/models/conjoint/{resultId}/simulate`、body={context,profiles:[{alternativeId,values:{columnId:code_or_number},optOut:false}],includeWtp:false}。contextは同datasetの版確認に使用し、scope=all・weightMode=noneのみ許す（profile集合はdataset行でない）。profilesのIDは一意、通常行は全属性キーのみ、optOutはvalues={}。choice/rankingは2つ以上、ratingsは1つ以上。未知/未観測水準、非有限数値は422。optOutは学習モデルがASCを持つ場合だけ許す。

linearのfit範囲外はextrapolation警告。utility=xβ（ratingsは別に平均切片も含むpredictedRating）。choice/ranking probability=exp(v−logsumexp(v))、合計1。ratingsはprobability=null、firstChoiceShare=最大utilityに同点等分、他0。このモデルは共通βなので回答者ごとの嗜好異質性を創作して分布を作らない。

重要度はカテゴリrange=max(u)−min(u)、linear range=abs(β)*(upper−lower)。importance=range/Σrange。opt-out ASCは属性重要度の分母から除く。すべてrange=0ならnull。選択肢プロフィール集合を変えても、同じ学習utilityRangeに対する属性重要度は自動で変えない。

WTPはpriceAttributeのβ_price<0かつ推測可能CIが0を含まない場合だけ。非価格属性の水準差dに対しΔU=d'β、WTP=−ΔU/β_price。delta勾配g=−d/β_price+ΔU e_price/β_price²、var=g'Vg、t CIを参考値として表示する。比率の厳密CIではないこと、指定価格単位であることを明記する。価格係数不安定はWTP_UNSTABLEでnull、絶対値を取って救済しない。

## 9. 結果・保存

summary={mode,ratingEffects,respondentCount,taskCount,fitProfileCount,stageCount,sumRespondentWeights,frequencyRespondentN,referenceDf,inferenceStatus,covarianceMethod,converged,fitMetrics}。

details={attributes,designColumns,coefficients,levelUtilities,attributeImportance,omittedLevels,respondentIntercepts,taskDiagnostics,optimizer,encoding}。respondentInterceptsはratings fixedのみ、他はnull。respondentIntercepts/taskDiagnosticsは結果データ辞書のページ付き索引とし、全行配列をPOSTへ載せない。coefficientsのJSONキーはestimate/standardError/statistic/pValue/ciLower/ciUpper、levelUtilitiesはattributeId/levelCode/label/utility/standardError/ciLower/ciUpper/referenceLevel。

row結果はrowId/respondentId/taskId/alternativeId/observed/predictedRating/probability/residual/predictionStatus。choiceのresidual=y−P。rankingではprobabilityは第1位確率だけとし、stageごとの確率はtaskDiagnosticsに保存する。rankingのresidualはnull。ratingsのprobabilityはnull。

materialize fieldはpredicted_rating/probability/residual。methodで未提供fieldを拒否する。ranking確率列名の既定はCJ_FirstChoiceProbabilityとし、全順位の確率と混同しない。task全体尤度を各プロフィール行の応答確率として保存しない。

## 10. UI・エラー・テスト順序

mapping wizard→完全性検証→属性・水準一覧→model設定→結果の4段階にする。返されたエラーでは該当respondent/task/row/columnを最大20件提示し、全件数は別表示。値の一覧が切れていても処理対象を20件に減らさない。

主エラー：CONJOINT_PARTIAL_TASK、DUPLICATE_ALTERNATIVE、INVALID_RESPONSE、RESPONDENT_WEIGHT_CONFLICT、CONSTANT_ATTRIBUTE、RANK_DEFICIENT、WITHIN_RANK_DEFICIENT、SEPARATION、NONCONVERGENCE、INFORMATION_SINGULAR、UNKNOWN_LEVEL。すべて422、内部不変条件違反だけ500。

`test_150_conjoint.py`でratings加法fixture→effect utility和0→choice2択解析解→rank stage尤度→クラスターSE→frequency回答者複製→survey倍率→LP分離→opt-out→予測/重要度/WTPを検証する。FEではpartial-task拒否と明示task拡張、新規回答者の固定効果予測ラベル、probabilityとfirstChoiceShareの違いをE2Eで確認する。

モデルが有限解を持たないデータを、テスト成功のために正則化して通すことは受入違反。階層ベイズや潜在クラスは将来追加時に別method/algorithmVersionとし、本版logitの別名で導入しない。

## 一次資料との対応

[S-CLOGIT](references/PRIMARY_SOURCES.md#s-clogit)、[S-SURVEY](references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。

## 11. タスク全体への明示的スコープ拡張

`POST /api/v1/models/conjoint/expand-scope`、入力は`{context,columns}`でConjointExpandScopeRequestを用いる。contextの版を検証し、columnsのIDマッピングから全datasetのtask indexを読む。選択された各rowが属する(respondentId,taskId)の全raw row（availability=falseも含む）を保存順・重複なしで返す。responseや属性の欠損をこの段階で除外しない。

応答は`{status:'success',datasetId,dataRevision,schemaRevision,originalRowCount,expandedRowCount,addedRowCount,expandedRowIds,scopeHash}`。空scopeは全て0/[]。データを変更せず、PCPの選択も勝手に更新しない。UIは追加件数を示し、ユーザーの明示ボタンでscope=explicit,rowIds=expandedRowIdsの新contextを作る。他scope用配列は除去する。推定の重み・欠損設定は元draftを保持し、実行時に改めて版を検証する。APIが返した配列をそのまま自動再実行することは禁止。


---

<a id="doc-14"></a>

出典ファイル：[feature/33_exploratory_factor_analysis.md](feature/33_exploratory_factor_analysis.md)

# Feature 033：探索的因子分析（EFA）機能仕様書

版1.1／2026-09-13／状態：設計確定、数値エンジン・本体実装の受入は未完了。
実装詳細：[DAVIS-FEAT-033-DESIGN](tasks/DAVIS-FEAT-033-DESIGN.md)。関連：[入力・結果契約](contracts/FACTOR_EXTENSIONS_CONTRACT.md)、[受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)。

## 1. 目的・範囲

アンケート項目の共通因子構造を探索する。主要利用条件は同一国内の一般的なアンケート、N=1000〜2000程度、5件法中心とする。順序尺度のモデル化にはポリコリック相関と最小残差法（MINRES／ULS系）を提供し、明示した連続近似のPearson＋ML／MINRESも提供する。因子数の候補、回転、欠損・相関・解の診断、再現可能な設定、Pearson／Polychoric感度分析を含める。

5件法でカテゴリ分布が概ね対称、床・天井への極端な集中がなく、各カテゴリが十分観測される場合、連続近似を合理的な実務選択肢として提示する。N=1000を統計的境界にはしない。ベル型ヒストグラムは単一項目の連続正規性や多変量正規性の証明ではなく、手法間の一致も潜在モデルの正しさの証明ではない。

現行のEFAは非加重・完全ケースのみである。PCA、PAF、混合相関・ポリシリアル、順序プロビット因子、確認的因子分析、構造方程式、pairwise、FIML、内部補完は対象外とする。CFAは独立した[Feature 033c](feature/33c_confirmatory_factor_analysis.md)で扱う。旧Feature 033の連続ML資料とFeature 033bは移動案内であり、本書より優先しない。

## 2. 入力・測定水準・前処理

POST /api/v1/models/factor-analysis は [EFARequest](contracts/factor_extension_requests.py) を受け、結果 method は efa、schemaVersion は factor_extensions.1 とする。生成Schemaは[efa.schema.json](contracts/schemas/efa.schema.json)、入力例は[efa.request.json](contracts/examples/efa.request.json)である。旧[FactorAnalysisRequest](contracts/analysis_requests.py)と[factor_analysis.schema.json](contracts/schemas/factor_analysis.schema.json)は旧連続ML資料の参照検証資産であり、現行API入力ではない。旧入力を自動変換せず、旧形式は明示的に拒否する。

3項目以上を選ぶ。測定水準はコードブックまたは根拠付きの分析時指定から解決し、カテゴリ数・標本数・分布形状で自動変更しない。

|入力状態|既定候補|制御|
|---|---|---|
|全項目が連続|Pearson＋ML|多変量正規性の前提を表示。MINRESも選択可能|
|順序尺度を順序モデルとして扱う|Polychoric＋MINRES／ULS系|潜在応答と閾値を仮定する旨を表示|
|順序尺度の連続近似|Pearson＋MLまたはMINRES|項目ごとの明示同意と等間隔順位得点が必要|
|順序と連続のモデル化が混在|実行不可|混合相関・ポリシリアル経路は初期版未対応|
|名義・ID・文字列・MA親・水準不明|実行不可|対象列または測定水準の確認が必要|

順序項目は許容コード、カテゴリ順序、逆転指定を分析情報として保存する。カテゴリ順序を数値コードやラベルの辞書順から生成しない。逆転は確認済み順序の反転として一度だけ適用し、元の順序と最終順序を保存する。連続近似では最終位置を1..Kの等間隔得点にする。コードブック変換済み列への二重逆転を防ぐ。

全対象項目の完全ケースを固定する。無回答・非該当・不正値を区別し、除外理由と項目別件数を返す。既存補完値の利用は共通契約の use_current_values に従い、補完件数と来歴を明記する。datasetの解決済みウェイトが存在する場合は FA_WEIGHT_UNSUPPORTED で拒否し、設定を none へ変更して続行しない。

未観測の許容カテゴリ、定数、項目ごとの実観測カテゴリ不足、n<=p、q>=p、df<0、非正定値または数値的特異な相関行列は停止条件である。カテゴリの削除・統合、nearPD、ridge、cor.smooth、因子数の自動削減は行わない。

## 3. 相関・抽出・因子数

Pearson相関は同じfit集合から ddof=1 の標本共分散と標本標準偏差で求める。Polychoricは全項目で共通の完全ケース集合を使う二段階推定であり、項目閾値を項目対で共有する。2値項目は同じ推定系のtetrachoric特殊形とする。0.5加算、カテゴリ統合、負確率のclip、相関行列補正は行わない。相関未収束、境界推定、非正定値は抽出へ進めず、対別診断と試行を保存する。

抽出法は Pearson 経路のMLと、Pearson／Polychoric双方の単一MINRES／ULS系である。MLをPolychoricへ適用せず、未収束時に別の抽出法へ切り替えない。MLの完全目的関数、勾配、複数start、Varimax／Promax、連続得点、参考推論は[実装詳細](tasks/DAVIS-FEAT-033-DESIGN.md)に定義する。MINRES／ULS系は目的関数識別子 uls_profile_full_v1 を保存し、非対角MINRESのSSEと混同しない。

因子数は利用者が最終指定する。全相関行列のスクリープロット、項目別独立置換による平行分析、明示した compareFactors の比較を提供する。平行分析は候補を示すだけで nFactors を変更しない。観測・比較側とも対角1の全相関行列の降順固有値を使い、項目分布を厳密に維持する。反復失敗を再抽選・除外せず、失敗時の分位値と候補はnullとする。主qの失敗を別qの成功で置換しない。

回転はPromaxを既定とし、Varimax、無回転を提供する。1因子では適用回転をnoneとし、要求との差と理由を保存する。回転失敗を無回転で置き換えない。Promaxではpattern、structure、因子間相関Phiを別表とし、pattern二乗和を加算可能な因子寄与率として表示しない。

## 4. 結果・診断・推論

pattern、structure、Phi、共通性、独自性、観測相関、再現相関、対角を含む残差、非対角RMSR、最適化履歴、分布・相関診断を返す。computationStatus、solutionStatus、inferenceStatusを分離する。未収束、回転特異、独自性境界、負の独自性、共通性範囲外、特異Phiを明示する。pattern係数の絶対値だけで斜交解を不適と判定しない。

MINRES／ULS系は負荷量・残差を中心に返し、chi-square、CFI、TLI、RMSEA、係数SEを返さない。Pearson＋MLだけが適用条件付きで通常の参考chi-square、df、p値、RMSEA、KMO、Bartlett球面性を返せる。境界・不適解・定義不能な推論値は理由付きnullとし、0を代用しない。MLの通常近似をscaledまたはrobustと表示しない。

表示用の負荷量強調閾値は初期値 abs(0.4) とするが、係数の切捨て、因子選択、解の適否には使わない。因子名は自動断定せず、利用者が表示名を設定できる。

## 5. 得点・保存・PCP

scoreMethodの既定はnoneである。Pearson経路で適切な解かつ明示したregressionまたはbartlettだけ、学習時の標本平均・標本標準偏差・標本相関・得点係数を固定して得点、射影、PCP行選択、派生列保存を有効にする。連続近似を含む場合は continuous_approximation と来歴へ残す。Polychoric経路、得点none、不適解では得点に基づくrows、projection、materialize、PCP操作を無効にする。

回答者得点は全fit行を原rowIdで結合し、対象外・欠損予測行はnullにする。項目・因子のクリックを回答者行選択として扱わない。得点が有効な結果だけ中央selection、既存L1/L2、実ポインタ選択、相互ハイライト、export、保存を利用できる。dataset、列、コードブック、maskの版変更で結果をstaleにし、KeepAliveで設定・結果・スクロールを保持する。

結果・失敗試行・比較は共通の所有dataset、revision、scope、有限JSON、原子的保存、idempotency、stale、削除、ページ出力の規約に従う。EFAの設定、変換、相関、閾値、start、平行分析反復、比較条件、エンジン版とhashを保存する。

## 6. Pearson／Polychoric感度分析

感度分析は全項目の元measurementがordinalの場合に提供する。API既定はoffであり、enabled=true、独立したapproximationAcknowledged=true、parallelAnalysis.enabled=trueを同時に要求する。主結果を変更せず、Pearson-MINRESとPolychoric-MINRESを同じfit行、項目、順序、逆転、欠損、q、回転、制約、start、seed、置換indexで比較する。主MLを比較用MINRESへ置換しない。

両側の因子は絶対congruence最大の一対一割当と符号付き置換で整合し、Phiとstructureにも同じ変換を適用する。元の行列を上書きしない。次善割当との差、低congruence、ゼロノルム、rank不足から曖昧性を判定する。Procrustesは補助の空間診断だけであり、pattern差や割当変更を消すために使わない。

相関・負荷量・共通性・Phiの差、確定因子割当の変更、平行分析候補の差を返す。異なるqの不足列を0で埋めて差を計算しない。片側失敗、平行分析不能、不適解、曖昧整合は「差なし」にしない。比較artifactは主resultIdとは独立し、comparisonIdで進捗、取得、export、cancelを提供する。感度比較の一致を同等性検定、正規性の証明、CFAの独立検証と表示しない。

## 7. 受入

受入IDはEFA-B01〜EFA-B22である。尺度・順序・逆転・欠損・ウェイト拒否、Pearson／Polychoric、ML／ULS系、回転・不適解、平行分析・候補比較、得点、保存、PCP、KeepAlive、感度分析、local/Pyodide、性能を検証する。数値oracle、許容差、実装順序、未実施事項は[受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)と[検証報告](validation/FACTOR_EXTENSIONS_VALIDATION.md)を参照する。

## 一次資料との対応

[S-FA](references/PRIMARY_SOURCES.md#s-fa)、[S-FA-SRC](references/PRIMARY_SOURCES.md#s-fa-src)、[S-ROT](references/PRIMARY_SOURCES.md#s-rot)、[拡張一次資料](references/FACTOR_EXTENSIONS_SOURCES.md)を参照する。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典が唯一の実装方法を要求するという意味ではない。


---

<a id="doc-15"></a>

出典ファイル：[tasks/DAVIS-FEAT-033-DESIGN.md](tasks/DAVIS-FEAT-033-DESIGN.md)

# DAVIS-FEAT-033：探索的因子分析（EFA）実装詳細化設計書

版1.1／2026-09-13／対応：[Feature 033](feature/33_exploratory_factor_analysis.md)。本書のAPIとファイルは実装予定であり、既存実装済みという意味ではない。

現行の入力正本は[EFARequest](contracts/factor_extension_requests.py)、生成Schemaは[efa.schema.json](contracts/schemas/efa.schema.json)、結果・能力・診断の正本は[拡張契約](contracts/FACTOR_EXTENSIONS_CONTRACT.md)である。旧FactorAnalysisRequest、factor_analysis.schema.json、旧033／033b文書は参照検証資産または移動案内であり、現行APIの互換入力ではない。

初期版は全経路で非加重・完全ケースである。旧033のfrequency対応、ML専用、平行分析なし、順序相関対象外の規約を引き継がない。EFA-B01〜EFA-B22が本設計の受入IDである。CFAは[033c](tasks/DAVIS-FEAT-033C-DESIGN.md)の独立機能で、本書の完了条件ではない。

## 1. 接続・責務・実装境界

画面は route /models/factor-analysis、POSTは /api/v1/models/factor-analysis、結果methodは efa、schemaVersionは factor_extensions.1 とする。

|予定ファイル（fullstack/基準）|責務|
|---|---|
|backend/app/api/factor_analysis.py|構文検証・サービス呼出し|
|backend/app/services/factor_analysis_service.py|scope snapshot、尺度解決、ウェイト拒否、段階実行、保存|
|backend/app/algorithms/models/ordinal_correlations.py|閾値・ポリコリック・項目対診断|
|backend/app/algorithms/models/factor_analysis_minres.py|単一ULS系目的関数と最適化|
|backend/app/algorithms/models/factor_analysis_ml.py|Pearson ML目的関数、得点、参考診断|
|backend/app/algorithms/models/factor_rotations.py|Varimax／Promax規約|
|backend/app/algorithms/models/factor_parallel.py|項目別置換、同一相関推定、固有値比較|
|backend/app/algorithms/models/factor_sensitivity.py|Pearson／Polychoricの同条件比較、因子整合、差分診断|
|frontend/src/features/models/FactorAnalysisPage.tsx|設定、診断、結果、得点連動|

既存のcontext、codebook_adapter、analysis_columns、analysis-results、provenance、storeを接続先とし、main.tsx、KeepAliveOutlet.tsx、AppShell.tsxへ登録する。共通基盤が未完成の箇所を完成済みと仮定しない。

NumPy/SciPyでlocal／Pyodide共通kernelを作り、Rのpsych・polycor・factanalを独立oracleとする。factor_analyzer、psych、polycor、factanalをproduction依存へ追加しない。仕様だけで数値一致を達成済みと表示せず、oracle不一致は目的関数・制約・回転規約を確認して設計差分として記録する。

## 2. 入力・前処理・識別可能性

1. 所有dataset、data/schema/mask revision、明示scopeを確定し、必要項目だけをsnapshot取得する。空selectedをallへ変更しない。
2. 既存resolverでweightを解決し、有効なdatasetウェイトがあれば FA_WEIGHT_UNSUPPORTED を返す。weightModeをnoneへ黙って変更しない。
3. measurementはコードブックまたは根拠付き分析時指定で解決する。未知・名義・ID・MA親・countは拒否し、分析時指定でコードブックを変更しない。
4. 順序項目は既存normalize_codeで許容コードを照合する。categoryOrderは許容順序カテゴリの完全な重複なし配列で、欠損・非該当用コードを含めない。表示ラベル、辞書順、数値間隔から順序を作らない。
5. 逆転は raw code → 確認済みカテゴリ位置 → 最終順序の順で一度だけ適用する。連続近似は最終位置1..Kを等間隔得点にする。連続変数の逆転は前処理済み派生列として扱い、ここでreverse=trueを受け付けない。
6. 全対象項目に有効値を持つ完全ケースをfit集合とする。主除外理由は invalid、次にmissing（無回答・非該当を含む）とし、詳細診断では両者を別件数にする。scopeCount=fitCount+excludedCountを維持する。既存補完値の使用は共通契約のuse_current_valuesに従い、補完来歴を保存する。
7. 連続列は標本標準偏差が正、順序列は実観測カテゴリが2以上で全許容カテゴリが観測済み、n>p、1<=q<p、df=((p-q)^2-p-q)/2>=0を要求する。n>pは数値入力条件であり一般的な必要標本数の結論ではない。df=0は記述解を許すが通常の適合度推論をnullにする。

全ordinal treatmentなら polychoric/minres/scoreMethod=none、ordinal treatmentを含まない場合はpearsonとする。continuousと明示したcontinuous_approximationの混在は許可する。ordinal→continuous_approximationには項目ごとのapproximationAcknowledged=trueが必須である。真の順序treatmentと連続treatmentの混在は FA_MIXED_MEASUREMENT_UNSUPPORTED とする。pairwise、FIML、correction、重み付き推定は受け付けない。

未観測カテゴリ、定数、n不足、df負、危険な数値、非正定値は自動的に修正・削除・統合しない。失敗試行は診断として保存し、有効resultId、rows、projection、materializeには公開しない。

## 3. 相関・閾値・行列検証

### 3.1 Pearson

同じfit集合から、nをfit行数として標本平均、ddof=1の標本共分散 S、標本標準偏差 D、相関 R=D^-1 S D^-1 を求める。大きな非対称性を転置平均で隠さず、丸め範囲の対称化だけを数値処理として記録する。変数別・対別の有効数はすべてnである。

### 3.2 Polychoric

二段階推定を固定する。項目jのカテゴリ累積比率 F_jk から有限内部閾値 tau_jk=Phi^-1(F_jk) を求め、端点は -infinity、+infinity とする。全項目で同じ完全ケース集合を使うため、項目閾値は全項目対で共有する。未観測カテゴリは無限内部閾値を生むため停止する。

項目対のセル度数 n_kl と潜在標準二変量正規の矩形確率 p_kl(rho) に対し、負の対数尤度 -sum(n_kl log p_kl) を rho in [-0.9999,0.9999] で最小化する。0件セルは和に寄与しない。度数への0.5加算、カテゴリ統合、負確率のclipは行わない。2×2も同じ式でtetrachoricとして記録する。

行区間[a,b]、列区間[c,d]の矩形確率は次の条件付き一次元積分を用いる。

P = integral_a^b phi(z) { Phi((d-rho z)/sqrt(1-rho^2)) - Phi((c-rho z)/sqrt(1-rho^2)) } dz

積分は絶対・相対許容誤差1e-10を要求し、極端な尾部は生存関数またはlog差分で桁落ちを抑える。積分誤差超過、負確率、非有限確率はclipなどで救済せず相関推定失敗とする。bounded scalar solverはxatol=1e-8、maxiter=1000とし、粗いrho格子で目的関数形状を確認して最良区間を含む探索を行う。有限目的値、有限確率、停止成功を要求し、端点から1e-5以内は境界推定として抽出を停止する。pair recordにはn、度数表、閾値参照、rho、最適化回数、積分誤差、境界フラグ、0セル数、少数セル数を保存する。

相関係数だけのSEをCFAの漸近共分散として渡さない。この相関モジュールはCFAの標本統計量・Gamma生成器の代用品ではない。

### 3.3 行列検証

Rは対角1、有限、対称、範囲内を要求する。最小固有値が 1e-10×最大固有値以下なら数値的非正定値または特異として停止し、Choleskyも要求する。元行列と診断を失敗記録に保存し、nearPD、ridge、cor.smoothを自動適用しない。matrixCorrectionは applied=false、method=null とする。

## 4. 抽出エンジン

### 4.1 単一のMINRES／ULS系

UI名は「最小残差法（MINRES／ULS系）」、API extractionは minres、実方式は uls_profile_full_v1 とする。代表的な非対角診断値 F_off=sum_{i<j}(R_ij-[L L']_ij)^2 も返すが、最適化目的値と同名にしない。

対角パラメータ u in [uniquenessLower,1] に対し A(u)=R-diag(u) とする。上位q固有値・固有ベクトルから L(u)=E_q diag(sqrt(max(d_1..d_q,0))) を作り、F_profile(u)=||A(u)-L(u)L(u)'||_F^2 を最小化する。対角残差を含む。目的値の2倍・半分を黙って混同しない。

これは対角の扱い・境界制約を明示したULS系の一方式であり、全実装のMINRESと完全同一とは主張しない。factor_analyzerの公開ULS profile実装と、R psychのMINRESによる再現相関を別の比較対象にする。名称だけで同値と判定しない。

optimizerはL-BFGS-B、ftol=1e-12、gtol=1e-7、maxls=50、maxiterは入力値とする。微分可能な領域の勾配は -2 diag(A-L L') とし、有限差分で検証する。初期uは clip(1/diag(solve(R,I)),lower,1)、追加startはseed固定PCG64のUniform(max(lower,.05),.95)とする。成功候補は有限、solver成功、projectedGradientInfNorm<=1e-5を満たすものとし、目的値最小、差が1e-10以下ならstart番号順で採用する。

最終共通性 h^2=diag(L L')、報告独自性 psi=1-h^2 とする。最適化変数uをpsiと同一とせず、両方と差を返す。u境界、psi<=lower+1e-6、psi<-1e-8、h^2>1+1e-8を個別診断する。負のpsiを0へ修正しない。不適解は記述診断だけを残し、得点・推論・派生列保存を無効にする。

### 4.2 Pearson ML

MLはPearson経路だけで用いる。相関変数モデルは R approximately Sigma=L L'+Psi、Psi=diag(psi)、psi_j in [lower,1] とする。固定psiでは C=diag(psi)^(-1/2) R diag(psi)^(-1/2)=E diag(d) E' を固有値降順で分解し、L(psi)=diag(sqrt(psi)) E_q diag(sqrt(max(d_l-1,0))) for l=1..q とする。

目的関数は完全式 F(psi)=logdet(Sigma)+trace(R Sigma^-1)-logdet(R)-p を常に使う。d_q<=1でも上位qだけの簡略式へ置き換えない。SigmaのCholeskyでlogdetとsolveを計算し、Fは理論上非負、-1e-10程度の丸めだけ0へclipする。大きな負値は内部エラーとする。SigmaやRの明示逆行列は作らずsolveを使う。

可微分領域のprofile勾配は diag(Sigma^-1-Sigma^-1 R Sigma^-1) である。計算では A=solve(Sigma,I)、gradient=diag(A-A R A) とし、重複固有値またはd=1境界で不安定なstartは失敗候補として記録して有限差分で検証する。微分試験を自動差分だけへ委ねない。

最適化は scipy.optimize.minimize(method=L-BFGS-B,jac=gradient,bounds) とする。ftol=1e-12、gtol=1e-7、maxiterは入力、maxls=50。初期psi_0=clip((1-0.5q/p)/diag(R^-1),lower,1) とし、残りstartはseed固定PCG64のUniform(max(lower,0.05),0.95)をp成分独立で生成する。seed、各startの初期psi、終了status、F、iterations、projectedGradientNormを保存する。

成功候補はsolver成功、有限、projectedGradientInfNorm<=1e-5を満たすものとする。境界成分のprojected gradientは下限でgradient>0、上限でgradient<0なら0とする。F最小を採用し、差が1e-10以下ならstart indexが小さいものを採用する。全start失敗は FA_NONCONVERGENCE で422とし、部分負荷量を正常結果として返さない。ゼロ因子列はeffectiveFactorRank<q警告とし、因子数を勝手に減らさない。

## 5. 因子数、平行分析、候補比較

観測・比較側とも「対角1の全相関行列の降順固有値」を使い、eigenvalueDefinition=full_correlation を画面・manifestに保存する。PCAを因子抽出として実行する意味ではない。

帰無データはfit行列の項目別独立置換とし、各項目のカテゴリ度数または連続値分布を厳密に維持し、項目間関連だけを壊す。既定は500反復、許容範囲100..10000、比較分位点.95、seed42、PRNG=PCG64である。列処理順はcolumnIdで固定し、返却は要求項目順にする。推定startとは別ストリームを使い、各反復で観測と同じ相関推定・行列診断を通す。

失敗反復は再抽選・除外しない。1件でも相関推定失敗または非正定値があれば、予定反復すべての診断を保存し、referenceQuantilesとsuggestedFactorsはnull、reasonCode=PA_REPLICATE_FAILEDとする。EFA本体が成功していれば主結果は保持する。

分位値は各固有値順位の線形補間分位点とする。観測値が比較値を厳密に超える先頭からの連続順位数を候補kとし、0を1へ切り上げない。後順位の超過も表示する。kがモデルとして許されるqの範囲外でも黙って切り詰めず、利用者がnFactorsを確定する。

compareFactorsは追加候補の明示整数配列であり、主nFactorsを含む候補集合を同じfit行、R、回転規約で実行する。各qの目的値、RMSR、共通性、診断、試行参照を成功・失敗とも残す。主q失敗なら全実行を失敗記録とし、別qの成功を主結果へ置換しない。比較用モデルの得点は主qを明示して別実行するまで保存しない。

## 6. 回転、得点、推論

### 6.1 回転

1因子では要求回転にかかわらず適用noneとし、理由をmeta.methodSwitchReasonへ保存する。

無回転ではLの各列を最大絶対負荷が正となる符号に正準化し、負荷二乗和の降順（同率は元列順）で並べる。Phi=Iとし、同じ符号付き置換を得点へ適用する。

VarimaxはKaiser正規化を固定する。h_j=sqrt(sum_l L_jl^2)、ゼロ行は0行のまま残し、B_j=L_j/h_jとする。T=Iから最大500回反復し、Lambda=B T、C=B'[Lambda^3-Lambda diag(colSums(Lambda^2))/p]、C=U D V'、T_new=U V'とする。目的値sum(diag(D))の相対改善が1e-8未満で収束する。正規化を戻して L_v=(B T) h とし、L_v L_v'+Psi が元のSigmaとrtol=1e-9で一致することを検証する。未収束は FA_ROTATION_NONCONVERGENCE としnoneへfallbackしない。収束後は二乗負荷和の降順（同率は元列順）で因子を並べ、各列の最大絶対負荷が正となるよう符号を正準化する。

PromaxはVarimax完了後に target=sign(L_v) abs(L_v)^4 を作る。B=least_squares(L_v,target) はrank qを要求し、Phi_0=(B'B)^-1、D=diag(sqrt(diag(Phi_0)))、T_p=B D、L_p=L_v T_p、Phi=D^-1 Phi_0 D^-1 とする。pattern=L_p、structure=L_p Phi、diag(Phi)=1、L_p Phi L_p'+Psiが元のSigmaと一致することを確認する。符号付き置換Hでは pattern_new=L_p H、Phi_new=H' Phi H、structure_new=structure H、score_new=score H とする。Promax後もpattern二乗和の降順（同率は元列順）と符号正準化を表示規約として適用する。これは加算可能な分散寄与の根拠ではない。因子相関が極端に±1に近くrankを失う場合は FA_ROTATION_SINGULAR とする。

### 6.2 得点

scoreMethodの既定はnoneである。Pearson・適切な解・明示した得点法だけがrows/projection/materializeを有効にする。標準化は z=(x-mean)/sd で、meanとsdは学習fit集合のddof=1標本値を固定する。連続近似ではscoreInterpretation=continuous_approximationを結果と派生列来歴に残す。順序経路は得点を拒否し、EBMなどを代替しない。

patternをL、Phi、Psiとする。regression得点係数は B_reg=solve(R,L) Phi、score=Z B_reg とする。Rは標本相関であり、Sigmahatへ置換しない。Bartlett得点係数は B_bart=Psi^-1 L (L' Psi^-1 L)^-1、score=Z B_bart とする。逆行列はCholesky/solveで構成し、rank不足を一般化逆行列で救済しない。斜交でもBartlettはpattern Lを使い、さらにPhiを掛けない。得点分散を1に再標準化しない。fit行をpredictへ通した値と保存得点の一致を検証し、元項目に欠損のある予測行はnullにする。

### 6.3 参考推論と診断

共通性 h^2=diag(L Phi L')、uniqueness=psi、reproducedCorrelation=L Phi L'+diag(psi)、residualCorrelation=R-reproducedCorrelationとする。対角残差を返し、0へ強制しない。非対角RMSRは sqrt(sum_{j<k}(R_jk-Sigmahat_jk)^2/[p(p-1)/2]) とする。全共通分散比は sum(h^2)/p とする。

Pearson＋MLでは F を使い、c=n-1-(2p+5)/6-2q/3、T=cF、df=((p-q)^2-p-q)/2 とする。c>0かつdf>0なら pValue=chi2.sf(T,df)、RMSEA=sqrt(max((T-df)/(df(n-1)),0))とする。c<=0またはdf<=0は対応する推論値をnullにする。psi<=lower+1e-6は BOUNDARY_UNIQUENESS 警告とし、chi-square近似の保証がないことを明示する。

KMOは可逆Rから partialCorrelation_jk=-invR_jk/sqrt(invR_jj invR_kk)、KMO=sum r^2/(sum r^2+sum partial^2) とする。分母0はnullとする。Bartlett球面性の参考検定はPearson＋MLだけで、係数 n-1-(2p+5)/6 が正のとき T_b=-(n-1-(2p+5)/6)logdetR、df_b=p(p-1)/2、chi-square p値を返す。MINRES、係数非正、非正定値その他の適用不能時はstatisticとp値をnullにし理由を返す。KMO/Bartlettを実行可否の自動ゲートに使わない。

MINRES／ULS系のchi-square、CFI、TLI、RMSEA、係数SEはnot_implementedとし、MLの通常近似をscaledまたはrobustと呼ばない。不適解・境界解では公開推論値をnullにし、内部計算値は診断artifactへ分離する。

## 7. Pearson／Polychoric感度分析

### 7.1 対象と共通条件

対象は全項目の元measurementがordinalの場合である。sensitivityAnalysis.enabled=trueには独立したapproximationAcknowledged=trueとparallelAnalysis.enabled=trueを要求する。主treatmentは全ordinalまたは全continuous_approximationであり、混在は拒否する。

比較はPearson-MINRESとPolychoric-MINRESで揃える。主がMLなら主MLを保持し、必要に応じて主ML＋比較用Pearson-MINRES＋Polychoric-MINRESの3モデルを保存する。比較子は項目ID、fit行、n、逆転、許容値、欠損、q、回転、ULS目的、制約、最適化start、seedを共通化し、scoreMethod=noneとする。Pearson側は最終カテゴリ順位1..Kを使い、元コードの数値間隔を使わない。

主結果は比較完了を待たずに公開する。比較子結果を主結果としてmaterializeせず、主結果の設定・fingerprint・PCP選択を比較の完了・失敗・中断で変更しない。

### 7.2 分布プロファイルと平行分析

fit集合に対し、各項目のcategoryCounts、categoryProportions、minCategoryCount、maxCategoryProportion、floorProportion、ceilingProportionを返す。scope除外前の有効回答分布は別集計・別Nとして保存し、fit集合と混同しない。floor/ceilingは確認済み順序の両端であり、逆転適用前後の対応を保存する。順位位置rの歪度は m_k=n^-1 sum(r-mean)^k、g1=m3/m2^(3/2)、G1=sqrt(n(n-1))/(n-2) g1（n>2、m2>0）とし、未定義はnullとする。異なるKは u=(r-1)/(K-1) で揃え、対ごとの経験CDF最大差をdistributionDistanceとして返す。count<5、floor/ceiling>=.5、abs(G1)>1は表示目安であり、実行経路を強制しない。

同じfit行列の項目別置換indexをPearson側・Polychoric側へ共通供給する。両側の観測・帰無に同じ相関推定を使い、同じseedでも別の置換標本を使う実装は禁止する。片側のPA失敗は候補nullであって0ではない。候補数が違う場合も共通指定qの感度差は計算できるが、異qの係数差はnull、reasonCode=FACTOR_COUNTS_DIFFERとする。

### 7.3 因子整合と評価

同じq・回転のpattern P（Pearson）とO（Polychoric）に対し、c_ab=(P_a' O_b)/(||P_a|| ||O_b||)とする。sum abs(c_ab)を最大化する一対一割当をlinear_sum_assignmentで解き、c_ab>=0となる符号付き置換Hを保存する。整合後は O_a=O H、Phi_oa=H' Phi_o H、structureも同じHで変換する。元行列を上書きしない。

ゼロノルム因子、rank不足、最適割当と次善割当の目的差<=1e-6、congruence<.85はalignmentStatus=ambiguousとする。次善割当は採用辺を一つずつ禁止した最良割当を使い、q=1では次善割当なしと記録する。Procrustesは O'P=U D V'、Q=U V'、||OQ-P||_F/||P||_F による補助空間診断だけであり、pattern差・割当変更を置き換えない。

返却する差分は i<j の相関の最大・中央値絶対差、整合済み負荷量の最大・中央値絶対差、共通性差、Phi非対角差、確定因子割当変更数、比較可能数、曖昧数、PA候補差である。q=1のPhi非対角差は0、比較対数は0とする。因子割当は最大絶対負荷>=assignmentThreshold（既定.4）かつ第2位との差>=assignmentMargin（既定.1）で確定する。q=1は第2位条件を持たない。確定しない項目はunassignedとambiguousを区別する。負荷量差・共通性差・Phi差の閾値は各0.10、範囲(0,1]として要求値とともに保存する。

assessmentの優先順は、片側失敗・PA不能・境界・不適解・整合不能ならindeterminate、次に候補差・いずれかの最大差の閾値超過・確定割当変更ならmethod_sensitive、曖昧項目があればindeterminate、すべて揃い候補一致・差が目安以下・確定割当変更0ならsmall_observed_differenceとする。これは同等性検定、正規性証明、CFAの独立検証ではない。

比較はcomparisonIdで queued/running/completed/partial/failed/cancelled、進捗、比較子resultIdまたはattemptId、行・項目hash、置換ストリーム、H、Q、差分、閾値、判定を保存する。GET /api/v1/analysis-comparisons/{comparisonId}、同URLのexport、POST同URLのcancelを提供する。完成artifactは不変とし、stale時は新規比較を公開しない。

## 8. 結果、保存、UI、実装ゲート

保存するEFA結果は拡張契約に従い、fit/excluded行ID、変換辞書、R、閾値、対別診断、raw loadings、最終行列、start履歴、PA設定・全反復固有値、候補比較、engine manifestを含む。model.npzにpickleを含めない。canonical fingerprintは行集合と内容hash、測定水準、元／適用order、逆転、欠損、要求／適用方法、全数値設定、実装版を含み、UI表示閾値は含めない。

422の代表コードは FA_CATEGORY_ORDER_REQUIRED、FA_UNOBSERVED_CATEGORY、FA_CONSTANT_COLUMN、FA_CORRELATION_NONCONVERGENCE、FA_CORRELATION_BOUNDARY、FA_NON_POSITIVE_DEFINITE、FA_UNDERIDENTIFIED、FA_NONCONVERGENCE、FA_ROTATION_NONCONVERGENCE、FA_WEIGHT_UNSUPPORTED とする。失敗試行は GET /api/v1/analysis-attempts/{attemptId} と diagnosticsページで参照可能にし、有効モデル操作に使わない。

得点可能な適切な解だけ中央selection、既存L1/L2、rectangle／row_ids、相互ハイライト、fit得点の派生列保存を提供する。対象外・未計算行はnullにする。項目・因子選択で回答者選択を変更しない。設定・結果・スクロールはKeepAliveで保持し、dataset切替、古い応答、logical cancelを扱う。

UIは「対象と尺度」「因子数」「抽出・回転」「診断」「負荷量・残差」「平行分析・感度比較」の順で読めるようにする。入力エラーは項目直下と上部一覧に表示し、失敗時は一覧へフォーカスする。診断は色だけに依存せず、項目名・状態・理由を表示する。重い相関・PAはキューで直列化・区分実行し、無断のサンプリング、反復削減、画面ページだけの推定、容量見積だけによる任意拒否を行わない。実メモリ不足は503として扱う。

検証は相関oracle→ULS系oracle＋ML→PA→回転と不適解→感度比較→契約/API/保存→FE/PCP→localとPyodideの順に行う。各段階のfixture、oracle、許容差、実装順序、性能計測は[受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)を正本とする。R oracleの入力hash、出力、sessionInfo、版・設定を保存し、製品kernelをoracle期待値の生成に使わない。

## 一次資料との対応

[S-FA](references/PRIMARY_SOURCES.md#s-fa)、[S-FA-SRC](references/PRIMARY_SOURCES.md#s-fa-src)、[S-ROT](references/PRIMARY_SOURCES.md#s-rot)、[拡張一次資料](references/FACTOR_EXTENSIONS_SOURCES.md)を参照する。閾値、API、能力境界、警告方針は製品設計であり、原典が唯一の実装方法を要求するという意味ではない。


---

<a id="doc-16"></a>

出典ファイル：[feature/33c_confirmatory_factor_analysis.md](feature/33c_confirmatory_factor_analysis.md)

# Feature 033c：確認的因子分析（CFA）機能仕様書

版1.1／2026-09-13／状態：設計確定、本体実装・統計的受入は未完了。
詳細：[033c詳細設計](tasks/DAVIS-FEAT-033C-DESIGN.md)。関連：[契約](contracts/FACTOR_EXTENSIONS_CONTRACT.md)、[受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)。

## 1. 目的・EFAとの関係

事前に指定した項目と因子の対応関係を、因子モデルとして推定・診断する独立機能とする。EFAの回転をCFAと呼ばない。CFAの完成を033 EFAの公開条件にはしない。推定法と分析目的は別の分類であり、WLSMV等が原理的にCFA専用であるとは説明しない。

初期版は単一群、一次因子、単純構造、連続または全順序項目、因子間相関を自由／直交から選ぶ範囲とする。各因子に3項目以上、各項目は1因子に所属させる。交差負荷、誤差共分散、等値・非線形制約、多群・測定不変性、高次・bifactor・構造回帰・ESEMは追加段階であり、入力UIで利用可能にしない。

## 2. 測定モデルの指定

項目一覧から各因子に指標を割り当て、因子名と尺度基準となるマーカー項目を指定する。マーカー負荷量を+1に固定する。未指定交差負荷は0、項目誤差共分散は0。因子相関は既定自由、直交を明示選択したとき0に固定する。固定・自由パラメータの表を実行前に確認できる。

カテゴリの順序・許容値・逆転・連続近似、欠損分類は[033 EFA](feature/33_exploratory_factor_analysis.md#2-入力測定水準前処理)と同じ。順序項目の閾値と残差尺度の制約を明示し、連続モデルの切片と混同しない。カテゴリ数やNによる自動切替は行わない。

## 3. 推定法と対象

|方法|初期の位置づけ|前提・制限|
|---|---|---|
|WLSMV|順序CFAの基本候補|DWLS点推定とロバストSE・平均分散補正検定を組み合わせる|
|MLR|連続または明示した連続近似の基本候補|ロバストSEと補正検定。外れ値除去や順序性の解消ではない|
|ULSMV|有力な追加候補|独立した数値照合に合格後に利用可能。小標本での収束を保証しない|
|通常ML|連続モデルの基本方式の確認・比較|多変量正規性と通常推論の前提を表示|

ULSMVの提供は追加ゲートとし、WLSMVとMLRを第一の受入対象とする。WLSMVをN≥500や1000専用としない。推定法の加重と回答者の調査ウェイトを区別する。初期版はfrequency／surveyとも未対応。欠損は完全ケース方式のみとし、順序経路に連続FIMLを流用しない。

主要な5件法・N=1000〜2000程度の利用でも、良好な周辺分布を持つ項目の明示的な連続近似＋MLRを主要候補として提示する。ヒストグラムがベル型であることだけで通常MLの前提成立とはしない。033 EFAの[Pearson／Polychoric感度分析](feature/33_exploratory_factor_analysis.md#6-pearsonpolychoric感度分析)は、測定上の扱いを検討する参考情報として参照できるが、その一致だけでCFAの推定法を決定したり、CFAのSE・適合度が同等と判断したりしない。EFA比較結果を同じデータで再利用した事実も来歴に残す。

## 4. 推定・識別・状態

自由度だけで識別済みと判断せず、モデル構造、パラメータと標本統計量の対応、局所識別性、情報行列を検査する。標本数に対する固定倍率を実行の可否にしない。推定器の実際の収束・情報不足を診断する。

負の分散、極端な因子相関、特異な潜在共分散、閾値の不順序、SE計算不能、負荷量の境界、非正定値、未収束を表示する。計算完了と適切な解を別状態とし、別推定法での自動再試行をしない。

## 5. 結果・適合度

非標準化推定値、標準誤差、信頼区間、標準化負荷量、因子共分散・相関、残差分散、切片または閾値、再現共分散／潜在応答相関、残差を返す。固定パラメータにはSE・検定値を付けず、fixedを表示する。

χ²・df・p・CFI・TLI・RMSEA（CIを含む）・SRMRを、推定器と定義が対応するものだけ返す。通常版・scaled版・robust版を別欄にし、元エンジンの名称と補正法を保存する。適用不能は理由付きnull。MINRES負荷量からML適合度を計算する等の代用を禁止する。

CFI等の固定カットオフによる「合格」「妥当性確認済み」を表示しない。df=0、基準モデル推定失敗、補正係数未定義、順序相関の非正定値、非収束、不適解の場合は対応指標と推論の利用可否を分ける。異なる定義の値を同名に詰め直さない。

## 6. 確認の独立性

`validationIntent`は利用者の意図であり証明ではない。EFAからのモデル作成は割当の草案だけを渡し、CFA実行前に確定させる。同一データ・重複行での再推定は「同じデータによる追試」と表示する。

探索元の結果、データの系譜、回答者ID集合、分割方法、モデル確定時点を保存する。同一データセットでは行ID交差を検証し、別データセットで回答者同一性を確認できなければ「独立性未確認」とする。非重複だけで研究上の独立な確認が成立したとは断定しない。学習後にモデルを変更した検証データは、その変更後のモデルの独立確認には数えない。

## 7. UI・PCP・実行環境

EFAと別ページで、対象項目→因子への割当→尺度設定→推定法と前提→結果と診断の順に構成する。モデル表はキーボードで操作でき、図を使う場合も表から同じ情報を読めるようにする。ドラッグ操作だけを必須にしない。

初期版のCFAは因子得点・PCP得点保存・個体予測を提供しない。設定・結果はKeepAliveで保持し、PCPの行選択を勝手に変更しない。結果の表とmanifestの出力を提供する。

初期の検証対象はローカル実行のlavaanエンジン。静的版は結果閲覧に必要な契約を共有するが、CFA実行は未対応能力として明示する。静的環境でのCFA実行には同じ推定・推論を実現するエンジンの別受入が必要。ブラウザから外部へ回答データを送信して代用しない。

## 8. 受入

受入IDはCFA-C01〜C14。測定モデル、固定／自由、識別、WLSMV・MLR・追加ULSMV・MLの数値照合、閾値・SE・各適合度定義、欠損、疎カテゴリ、不適解、同一データ判定、結果保存、環境能力を検証する。詳細は[受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)を正本とする。


---

<a id="doc-17"></a>

出典ファイル：[tasks/DAVIS-FEAT-033C-DESIGN.md](tasks/DAVIS-FEAT-033C-DESIGN.md)

# DAVIS-FEAT-033c：CFA 実装詳細化設計書

版1.1／2026-09-13／対応：[033c機能仕様](feature/33c_confirmatory_factor_analysis.md)。設計上の予定API・ファイルであり、既存機能の実装を示さない。

## 1. 接続と実行エンジン

route `/models/cfa`、POST `/api/v1/models/cfa`、結果method=`cfa`、schemaVersion=`factor_extensions.1`。入力は[CFARequest](contracts/factor_extension_requests.py)。既存のEFA APIと分離する。予定ファイルはfullstack/backend/app/api/cfa.py、services/cfa_service.py、algorithms/models/cfa_engine.py、algorithms/models/cfa_runner.R、frontend/src/features/models/ConfirmatoryFactorAnalysisPage.tsx。

初期ローカルエンジンはR lavaanを採用し、推定・SE・検定・適合度を同じfitから取り出す。WLSMV/MLRを必須、MLを通常版の照合対象、ULSMVを独立した追加受入対象とする。実装時にR/lavaan/BLAS版とソースhashを固定し、全オプションを解決したengine manifestを作成する。最新版への無条件追従はしない。

033cに限り、共通設計の「NumPy/SciPyのみでlocal/static同時実行」から独立したローカルエンジン境界を定義する。静的PyodideではCFA実行を`CFA_ENGINE_UNAVAILABLE`とし、環境能力と理由を表示する。EFAの静的対応をCFA完了待ちにしない。静的CFAは後続エンジンの同等性検証で別ゲートとする。

Rscriptは設定済み絶対パスから引数配列で起動し、ユーザーの文字列をR式やshellへ補間しない。固定runnerが制限したJSON測定モデルを内部記号v1..vp/f1..fqに変換する。表示ラベルやcolumnIdを構文識別子として流用しない。raw R script、任意式、任意パスをAPI入力で受け付けない。依存不足時の自動インストールや外部計算サービスへの送信は行わない。

## 2. 測定モデルとパラメータ表

連続：`x=ν+Λη+ε`、Eη=0、Varη=Φ、Varε=Θ、Σ=ΛΦΛ′+Θ。Θは対角、非指定負荷量は0。各因子のmarker負荷量を+1、他の所属負荷量を自由、因子分散を自由にする。因子共分散はfreeなら全対自由、orthogonalなら全対0。

順序：同じ線形モデルを潜在応答x*に置き、`Yj=k ⇔ τj,k−1<x*j≤τjk`。probit、theta parameterizationを固定する。単一群で項目の潜在応答切片0、残差分散1、潜在因子平均0とし、内部閾値Kj−1を自由、marker負荷量+1・因子分散自由。項目の潜在応答総分散を1と決め打ちせず、標準化時にΣの対角から求める。

1項目が複数因子に所属、未所属、markerが非所属、因子ID重複、項目数3未満、未知項目を拒否する。これは初期UIの単純構造範囲であり、3項目あれば必ず識別されるという主張ではない。

自由パラメータは安定ID、lhs/op/rhs、fixedValue、freeIndex、label、sourceColumnId/sourceFactorId、scaleを持つ。標本統計量との対応順を保存する。markerの符号を後処理で変更して固定+1と矛盾させない。符号反転は別モデルの設定変更として扱う。

## 3. 前処理・識別性

scope・版・欠損・重み・categoryOrder・逆転は[033 EFA設計第2節](tasks/DAVIS-FEAT-033-DESIGN.md#2-入力前処理識別可能性)の前処理を再利用し、完全ケースのみとする。同節のEFA専用n>p・q・自由度条件はCFAへ引き継がず、以下のCFAモデルで検査する。raw相関のユーザー持込モードは初期版なし。連続項目は元の分析単位の値を渡し、EFAのddof1相関への標準化を勝手に適用しない。連続近似は確認済み等間隔順位値を渡す。

識別は事前構造検証、自由度、推定後Jacobianの列rank、情報行列のrankと条件数で判定。連続の標本統計量数はp+p(p+1)/2、順序はΣ(Kj−1)+p(p−1)/2。自由度は当該統計量数と制約を適用した独立自由パラメータ数から求め、エンジン値と照合する。冗長制約やデータ依存特異をdf≥0だけで許可しない。

df<0は停止。df=0は点推定を条件付きで許し、モデル適合の検定・RMSEA/CFI/TLIをnullとする。十分なNの固定境界は設けず、定数・未観測カテゴリ・計算不能・実測rank不足など具体的原因で停止する。

## 4. 四つの計算層

|層|入力→出力|禁止事項|
|---|---|---|
|標本統計量|raw fit行→共分散／閾値・相関・Γ|EFAのpair別SEをΓと呼ばない|
|パラメータ推定|統計量・モデル・推定重み→θhat|単なるULS負荷量をULSMVと名付けない|
|推論|θhat・Jacobian・情報行列・Γ→SE・検定・補正量|通常SEでロバストSEを代用しない|
|適合度|target/h1/baselineの対応する統計量→指標|通常・scaled・robustを混合しない|

順序の標本統計量sは閾値＋相関の一意成分、Γはsqrt(n)(s−σ)の漸近共分散として、順序・次元・Nによるscale規約を必ず記録する。点推定はWLSMVで対角重み、ULSMVで単位重みを使うが、推論は完全な漸近共分散情報を要する。lavaan内部の標本統計量・WLS.V・NACOV・parameterTable・test設定を取り出し、正規化や並びをadapterで検証する。

連続ML/MLRはlavaanのnormal likelihood、meanstructure=true、missing=listwiseを固定し、内部のN分母共分散・尤度規約を保存する。033 EFAのN−1/Bartlett補正式をCFAへ流用しない。MLRのSE/testはエンジンが解決した方式を返す。ロバスト性は標準誤差と検定の補正の意味に限定する。

runnerはestimator、ordered項目、parameterization、meanstructure、std.lv=false、missing、likelihood、SE/test、optim.method、最大反復・許容誤差を解決済み設定として返す。初期adapterはNLMINB、最大反復20000とし、収束許容値は選定したエンジン版の値を固定manifestに記録してgolden生成前に凍結する。これは公開UIの任意エンジンオプションではない。エンジンが指定した推定器を別方式へ変えた場合は、WLSMV内部のDWLSのように定義に含まれるもの以外をエラーとする。

## 5. 結果抽出と標準化

非標準化推定値は元のパラメータ表順。std.lv（因子標準化）とstd.all（因子・観測または潜在応答の標準化）を別フィールドにする。`stdAllLoading_jf = Λjf sqrt(Φff)/sqrt(Σjj)`。`Dφ=diag(diagΦ)`として`factorCorrelation=Dφ^(-1/2) Φ Dφ^(-1/2)`。SE・CIの標準化版はエンジンがその定義で返すものだけ採用し、点推定を割った倍率で通常SEを代用しない。

順序閾値は有限内部閾値を推定尺度付きで返す。外端の±∞はJSON数値として返さず、境界種別文字列で表す。固定残差分散1と標準化残差分散Θjj/Σjjを混同しない。順序の再現相関は`Dσ=diag(diagΣ)`として`Dσ^(-1/2) Σ Dσ^(-1/2)`で、観測回答コードの相関ではない。共通性はstd.all尺度のdiag(ΛΦΛ′)/diagΣとして返す。

負のΘ/Φ対角、Φ非正定値、|因子相関|≥1、未順序閾値、特異Jacobian、境界・非収束を診断。不適解に対するSE/CI/検定は公開推論欄をnullとし、エンジンの生値は診断用に分離する。SEのみ不能で点推定が許容される場合は`solutionStatus=admissible`、`inferenceStatus=unavailable`を許す。

## 6. 検定統計量・適合度の契約

返却は[拡張結果契約](contracts/FACTOR_EXTENSIONS_CONTRACT.md)の`fitMeasures[]`。metric、variant、engineKey、value、補正法、N/df、availabilityとreasonCodeを一組とする。

|表示指標|通常版エンジンキー|scaled版|robust版|
|---|---|---|---|
|χ²/df/p|chisq / df / pvalue|chisq.scaled / df.scaled / pvalue.scaled|独立した値を捏造しない。scaled検定と補正名を使用|
|CFI/TLI|cfi / tli|cfi.scaled / tli.scaled|cfi.robust / tli.robust|
|RMSEA/CI|rmsea / rmsea.ci.lower / rmsea.ci.upper|各キーのscaled系列|各キーのrobust系列|
|SRMR|srmr|提供なしはnull|提供なしはnull|

実エンジンのキーとCIキーの位置は採用版で存在検査し、登録した対応表を固定する。CI水準は入力confidenceLevelをfitMeasuresのRMSEA CI設定へ明示伝達する。指標の標準キー名を生成規則だけで推測しない。availabilityはavailable/not_applicable/not_implemented/failed。未提供キーはnullと理由を返す。

target model、baseline model、h1の推定器、統計量種別、補正係数、shift、df、元エンジンtestオブジェクト参照を保存する。相関行列PD検査を無効化してrobust指標を強制しない。baseline不適合・未収束ならCFI/TLIの関連variantをnull、RMSEA等は個別条件で判断する。通常のカットオフによる自動合否なし。

AIC/BICはML/MLRの比較可能な同一データ・同一観測変数・同一尤度規約のみ。初期UIはモデル比較機能を持たず、WLSMV/ULSMVで尤度を捏造しない。修正指標と自動モデル探索は初期版対象外。将来のscaled差の検定は専用検定を用い、補正χ²同士の単純な差で代用しない。

## 7. EFAからの草案と独立性

`sourceEfaResultId`は同一所有者の保存結果を解決し、元のdata lineage、fit行ID集合、設定hash、モデル作成時点を記録する。標準は利用者による手動割当。草案機能を設ける場合も負荷量閾値で自動確定せず、全項目の単純構造割当を確認してCFAモデルとして保存する。

同一dataset lineageなら行ID交差のcountを算出し、重複>0ならsame_data。非重複で事前に固定されたsplitとmodel hashが確認できる場合はholdout_recorded。別datasetで同一回答者の判別情報がなければunknown。externalの選択だけでconfirmedとしない。meta.isExplorative=trueを維持し、analysisPurpose=confirmatory_model、validationEvidenceで確認の意味を分離する。

探索元EFAに感度比較が付随する場合は親resultIdからcomparisonId・両比較子結果・探索使用行の和集合を解決する。主結果だけを探索使用データと見なし、比較で使った行を未使用holdoutと誤認しない。同じscopeに固定した初期仕様では集合は同じになることを検証する。比較のsmall_observed_differenceをCFAモデルの独立検証済みフラグへ変換しない。

5件法・N=1000〜2000の良好分布に対する明示連続近似はMLRの主要利用例とし、元measurementがordinalでもtreatmentで推定器を選ぶ。CFA自身のWLSMV対MLR自動感度比較は初期版には追加しない。将来実施する場合は同じ指標・同じ制約でも観測得点と潜在応答の推定対象・尺度が違うことを整合させ、EFAの行列差比較をそのまま流用しない。

## 8. API・保存・画面・運用

共通の409 stale、422 input/estimation、503 resourceと原子的result publishを使う。計算時の失敗はattemptIdに診断を保存し、正常モデルとして公開しない。対応エンジンが未導入なら503 `CFA_ENGINE_UNAVAILABLE`、ULSMVが未検証なら422 `CFA_ESTIMATOR_NOT_VALIDATED`。Rの警告を捕捉し、SE失敗と非収束を同一分類にまとめない。

manifest、parameter table、sample statistics、Γ/WLS.V参照、test/fit measures、モデル制約、engine版・hash、fit/excluded行ID、sourceEfaResultIdと独立性根拠を保存する。raw RオブジェクトをPython pickleへ変換しない。必要な数値・文字列をJSON/NPZ/Parquetへ明示変換し、raw engine logは内部診断としてパスを公開しない。

rows/projection/materialize/simulation=false、selectionKinds=[]。CFA図上の因子・項目クリックでReduxの回答者選択を変更しない。設定モデルと結果モデルhashを表示し、変更後に旧結果を新モデルの結果として見せない。KeepAlive・dataset切替・logical cancel・版照合・exportは既存規約を使用する。

入力エラーは対応項目の直下と上部のエラー一覧に併記する。実行失敗時は一覧見出しへフォーカスを移し、一覧から各入力へ移動できるようにする。推定診断の警告は色だけで区別せず、状態名・対象項目・修正可能な設定をテキストで示す。進捗は読み上げ対応、非表示KeepAliveページからの重複通知を抑制する。

本番実装時はrun-production.batによるローカル画面確認を受入に含める。ビルド・配布検証は実施指示がある段階で行い、設計資料作成やkernel試験と区別する。

## 9. 未実装ゲート

R同梱方式・ライセンス・依存固定・runner起動の製品検証、単純構造のoracle、SE/適合度variant、失敗診断、API/保存/FE、追加ULSMVを順に完了させる。これらは実装前の未検証事項であり、WLSMV/MLRの名前だけを選択肢へ追加して完了としない。[受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)を参照。


---

<a id="doc-18"></a>

出典ファイル：[contracts/RESULT_CONTRACT.md](contracts/RESULT_CONTRACT.md)

# 結果契約・データ辞書 v1.0

033 EFA／033c CFAでは[拡張入力・結果契約](contracts/FACTOR_EXTENSIONS_CONTRACT.md)がmethod、状態、適合度variant、capabilities、export表を追加する。本書の旧ML因子分析項目や「CA以外rows=true」は拡張機能へ自動適用しない。

本書はFeature 029〜034のJSON出力名・単位・配列形状の正本。数式は各実装設計、入力型は`analysis_requests.py`。未提供値はnullと理由を返す。以下の型表記はTypeScript相当で、`Float`は有限JSON number、`Count`は0以上の整数、`Nullable<T>`はTまたはnullである。公開APIのcamelCaseとmaterialize用の固定sourceField識別子を混同しない。

## 1. 共通エンベロープ

```ts
type Method = 'ca'|'mca'|'famd'|'linear_regression'|'factor_analysis'|'conjoint';
type Reason = {code:string; message:string; relatedFields:string[]};
type Warning = {code:string; message:string; count:number|null; columnIds:string[]};
type AnalysisResult = {
  status:'success'; resultId:string; method:Method;
  meta:AnalysisMeta; config:object; capabilities:Capabilities;
  summary:object; details:object;
  unavailableReasons:Record<string,Reason>;
};
```

resultIdはUUID、meta.modelFingerprintは`sha256:`付きhash。configはdefault補完済み入力とresolvedEncoding/resolvedWeightを含むeffectiveConfigを返す。リクエスト値を変更した設定は表示中configに混ぜない。meta.warningsのcodeでUI分岐しmessageの日本語部分で判定しない。構文誤りのerrorも共通API例外ハンドラからJSONへ変換する。

```json
{"status":"error","error":{"code":"ANALYSIS_INPUT_STALE","message":"入力の版が変更されています。再実行してください。","details":{"expectedDataRevision":1,"currentDataRevision":2}},"traceId":"server-generated-id"}
```

HTTPは入力・推定不能422、競合409、未存在404、内部不変条件500、実際のメモリ/保存資源枯渇503。中断表示はFE状態であってHTTP成功ではない。公開エラーにPythonスタック、原データ全体、ファイルシステム絶対パスを含めない。

## 2. AnalysisMeta

|フィールド|型・単位|規約|
|---|---|---|
|datasetId|str|所有データセット|
|dataRevision/schemaRevision|正整数|学習snapshotの版。GET時に現在版で上書きしない|
|maskRevision|整数またはnull|既存mask_revisionの戻り値を型を保って記録|
|currentDataRevision/currentSchemaRevision|正整数|GET時の現版|
|resultState|`current` / `stale`|旧結果の閲覧を区別|
|scope|入力scope enum|学習時scope|
|scopeHash|str|既存scope_hashの規約|
|scopeCount/fitCount/effectiveN/excludedCount|Count|物理行、effectiveN=fitCount|
|exclusionCounts|下記オブジェクト|first reasonによる排他計数|
|analysisUnit|`respondent_row` / `table_record` / `profile_row`|行の意味|
|weightApplied|bool|解決後の有効な重み使用有無|
|weightType|`survey` / `frequency` / null|未適用時null|
|weightColumn|strまたはnull|解決後columnId|
|sumWeights|Floatまたはnull|有効物理行の重み合計。CA表はnull|
|kishEffectiveN|Floatまたはnull|通常は有効物理行wのKish。CJは後述回答者単位。CA表null|
|frequencyN|Floatまたはnull|frequencyのみ複製数。CJは回答者数。CA表null|
|imputedCellCount/imputedRowCount|Count|実際に使用したモデル入力の補完済みセル・原行。親MA判定用だけの補助セルは別診断|
|modelFingerprint|str|学習内容hash|
|algorithmVersion|str|本版は各`davis.<method>.1.0.0`|
|numericalRuntime|object|python/numpy/scipy/polars/pydantic、platform、engine=`local`/`pyodide`、BLAS識別（取得不能null）|
|isExplorative|true|全6機能でtrue。データ探索で確認的検証済みとはしない|
|warnings|Warning[]|なしは[]|
|runtimeCapabilities|object|resultPersistence=`workspace`/`idbfs`/`tab_only`、logicalCancel=true、hardCancel=false|

exclusionCountsの固定キーはinvalid,missing,missing_weight,zero_weight,structural_task_exclusion。0件も0を返す。合計=excludedCount、scopeCount=fitCount+excludedCount。meta.exclusionDiagnosticsに詳細の非排他件数を追加できるが主内訳へ足さない。

CJはmeta.kishEffectiveNを有効回答者重みで一度ずつ計算し、meta.frequencyN=summary.frequencyRespondentN。summary.sumRespondentWeightsを必須併記する。meta.sumWeightsはプロフィール行合計であり、モデル自由度・回答者数に使わない。非加重CJのkishEffectiveNはrespondentCount。観測数が異なる回答者がいる試験でこの差を検証する。

整数がJavaScript安全整数を超えるfrequency総量は推測処理を422 `FREQUENCY_TOTAL_UNSAFE`で止める。これはページ件数による制限ではなく、現API型の整数同一性を守る制限である。物理行数・revisionも安全整数であることを保証する。

## 3. 配列・ID・軸

全スペクトルを返すCA/MCA/FAMDではrank=r、summary.eigenvalues長r。数値閾値未満を除いた全有効軸であり、表示2軸への切詰めではない。慣性比の分母は全行列慣性。summary.discardedNumericalInertiaも3機能で必須。軸IDは1..r、配列indexはaxisId−1。因子分析では軸でなく因子ID1..q。縮退ブロックは`[{axisIds:[1,2],relativeGapTolerance:1e-10}]`、縮退なしは[]。

categoryIdは`cat:`+SHA256(canonical JSON `[columnId,kind,normalizedCode]`)。CA表の行カテゴリはcolumnId=rowLabelColumnとkind=value、列カテゴリはcolumnId=対応valueColumnとnormalizedCode=同columnIdとする。省略カテゴリにも安定IDを付ける。kind=missing/not_applicable時code=null、kind=value時codeは既存normalize_codeに従う文字列。ラベル欠落時はcodeを表示、missing/NAは明示日本語ラベル。

designColumnIdは`design:`+SHA256(canonical JSON `[termId,codingColumnDescriptors]`)。termIdは切片`intercept`、主効果は`main:<columnId>`、交互作用は元predictors順で並べた2列のcanonical JSONにhashを付ける。IDに表示ラベルを含めない。designColumnDescriptorsにdummy水準・基準水準・coding方式を保存し、式文字列から復元しない。

## 4. CapabilitiesとsourceField

```ts
type Capabilities = {
 rows:boolean; projection:boolean; materialize:boolean;
 selectionKinds:('rectangle'|'categories'|'row_ids'|'respondents'|'diagnostic_rectangle')[];
 exportTables:string[]; materializeFitFields:string[]; materializePredictionFields:string[];
 predictionIntervals:('none'|'mean_ci'|'individual_pi')[];
 simulation:boolean;
};
```

|手法|selectionKinds|保存field|projection|
|---|---|---|---|
|CA|categories|なし|false|
|MCA/FAMD|rectangle,categories,row_ids|fit/predictionともcoordinate:1..r|true|
|ML因子|rectangle,row_ids|fit/predictionともscore:1..q|true|
|重回帰|diagnostic_rectangle,row_ids|fit:fitted,residual,leverage_total,leverage_per_replica。prediction:predicted,mean_ci_lower,mean_ci_upper,individual_pi_lower,individual_pi_upper|true|
|CJ|row_ids,respondents|predicted_rating / probability / residualのうちmodeで定義されたもの|true|

capabilities.materializeFitFields等は、その結果で本当に保存可能なfieldだけを列挙する。CI不可ならそのfieldを入れない。surveyの通常leverage診断は個別仕様に従う。rectangleをCAカテゴリ座標に適用する別意味のAPIは設けない。CAのrows=false、他はtrue。simulationはCJのみtrue。

exportTablesはCA:`manifest,eigenvalues,categories`、MCA:`manifest,eigenvalues,categories,rows`、FAMD:`manifest,eigenvalues,categories,variables,rows`、回帰:`manifest,coefficients,diagnostics,rows`、FA:`manifest,variables,rows`、CJ:`manifest,coefficients,diagnostics,rows,utilities`。表の主要全項目はmanifest JSONから取得できる。追加export table enumは本版に勝手に追加しない。

## 5. 手法別summary/details

個別設計の列挙フィールドは必須。該当しない場合nullとする。以下は配列の形と省略記述を確定する補則。

### 5.1 CA

summary.pearson={statistic:Float|null,df:Count|null,pValue:Float|null,status:`available`|`not_applicable`,reason:str|null,smallExpectedCellsLt1:Count|null,smallExpectedCellsLt5:Count|null,fractionExpectedLt5:Float|null}。pValueは確率0..1。

details.tableは正質量カテゴリだけの二次元配列I×J、details.tableRowCategoryIds/ tableColumnCategoryIdsで順序固定。physicalTableは同形、表入力時null。削除前の0質量カテゴリはomittedCategoriesに置き、入力全体をmanifestへ二重保存しない。

rowCategories/columnCategoriesの各coordinates/contributions/cos2長r。physicalCountは有効非加重原行数（surveyでも同じ物理数）、table入力時null。variableIdは元列ID、side=`row`/`column`。omittedCategoriesは`{categoryId,variableId,code,kind,label,side,reason:'zero_mass'}`。

### 5.2 MCA

details.categories各項目長r、details.variables=`[{variableId,label,categoryIds,isMaOption,maParentId}]`、details.maDiagnostics=`[{parentId,selectedChildIds,dependencyChildIds,statusCounts}]`。ordinary-onlyでMAなしは[]。summary.inertiaAdjustment=rawではadjustedEigenvalues/adjustedInertiaRatio=null。benzecriの場合は長r配列で、分母0ならadjustedInertiaRatio=[null,...]。adjustedEigenvaluesはこのとき0。

### 5.3 FAMD

numericVariablesはp件、categoricalVariablesはm件、categoriesはK件。numericVariables.scaleは母分母ddof0の標準偏差、sampleScaleという名前にしない。summary.coordinateConvention=`weighted_individual_barycenter`。カテゴリcos2のdistanceSquaredは全変換特徴空間での重心距離。個体とのユークリッド座標は共有できるが相関円とは共有しない。

### 5.4 重回帰

coefficients配列はdesignColumns順、両者length=p。全係数のフィールドは`designColumnId,termId,label,estimate,standardError,statistic,pValue,ciLower,ciUpper,standardizedEstimate`。`statistic`は採用referenceDfによるt。推測不能時SE/t/p/CIをnullとし係数は残す。標準化係数の計算法・未定義条件は個別設計通り。

summary.jointTest=`{kind:'classical_f'|'robust_wald_f'|null,statistic:Float|null,dfNumerator:Count|null,dfDenominator:Float|null,pValue:Float|null}`。切片を除いた全係数を検定。切片だけモデルは入力で成立しない。基準水準はcategoryReferencesに`{columnId,referenceCategoryId,observedCategoryIds,coding:'treatment'}`。

vif=`[{designColumnId,value:Float|null,status:'available'|'constant'|'perfect_collinearity'}]`。大きさ∞はJSON数値にせずnull。summary.rSquaredType=`centered`/`uncentered`、rmseは重み和分母、residualStdErrorは残差自由度分母で区別する。

### 5.5 旧最尤因子分析資料

この節は旧FactorAnalysisRequestに対応する参照検証資産であり、現行Feature 033 EFAの結果正本ではない。現行のEFA結果、得点能力、平行分析、感度比較は[拡張入力・結果契約](contracts/FACTOR_EXTENSIONS_CONTRACT.md)を参照する。

pattern/structureはp×q、factorCorrelation/rotationTransformはq×q。sample/reproduced/residualCorrelationはp×p、uniqueness/communalityはp、ssLoadings/varianceRatiosはqまたはPromax時null。variables順とfactorLabels順が共通。

summary.bartlett=`{statistic:Float|null,df:Count,pValue:Float|null}`。kmoは0..1またはnull。optimizerStarts=`[{index,initialUniqueness,converged,iterations,fitFunction,projectedGradientInfNorm,messageCode}]`。最終採用startはsummary.selectedStartIndex。乱数seedを記録し、最適化message文字列に依存した成功判定を禁止。

### 5.6 コンジョイント

coefficientsは重回帰と同じ明示長名称standardError/statistic/ciLower/ciUpperを使う。実装設計中のSE/t/CIは説明上の略記であってJSONキーでない。levelUtilities=`[{attributeId,categoryId,levelCode,label,utility,standardError,ciLower,ciUpper,referenceLevel}]`。

attributeImportance=`[{attributeId,label,kind,range,importance,rangeLower,rangeUpper}]`。カテゴリrangeLower/Upperは最小/最大効用、linearは指定属性値範囲（この違いをkindで明示）。推定レンジ量のCIは返さない。omittedLevelsに未観測水準を保持。

fitMetricsはratings:`{rmse,mae,overallRSquared,withinRSquared}`、choice/ranking:`{logLikelihood,nullLogLikelihood,meanNegativeLogLikelihood,mcfaddenRSquared,hitRate,hitRateDefinition}`。ratings pooledのwithinRSquared=null。未採用modeの指標を0で混在させない。

大量のrespondentIntercepts/taskDiagnosticsはPOST/GETのdetails配列に無制限に載せない。detailsでは`{available:true,total,exportTable:'diagnostics',subtables:[...]}`という索引とする。diagnostics出力はkind=`respondent_intercept`/`task`/`stage`のlong format。row結果と同じページングで取得し、ページ順はkind順→回答者保存順→タスク保存順→stage番号。model.npz/Parquetからの読み出しが正本。これは「全件を分析する」と「全件を一度にHTTP返送する」を分ける契約である。

## 6. rows/予測API

```ts
type RowPage = {
 status:'success'; resultId:string; predictionId?:string;
 offset:number; limit:number; total:number; nextOffset:number|null;
 axes:number[]|null; rows:object[]; meta:{dataRevision:number;schemaRevision:number;resultState:'current'|'stale'};
};
```

fit rowsは有効fit行のみ、prediction rowsは指定scopeの全行を保持しstatus別にnullを返す。offset>=totalは空配列、limit超過は422。axesの重複/範囲外/回帰・CJでの指定は422。FAのaxesも因子IDを意味し、配列scoresを要求した順序に並べる。

|手法|fit rowの必須フィールド|
|---|---|
|MCA/FAMD|rowId,coordinates,contributions,cos2,mass,distanceSquared|
|FA|rowId,scores|
|重回帰|rowId,observed,fitted,residual,leverageTotal,leveragePerReplica,studentizedResidual,cooksDistance|
|CJ|rowId,respondentId,taskId,alternativeId,observed,predictedRating,probability,residual,predictionStatus|

MCA/FAMDの射影rowは上記にpredictionStatus追加、contributions=null、mass=null。cos2は学習空間の全距離から計算し、MCAも新行カテゴリプロファイルのχ²距離を分母とする。FAの予測rowはscoresとpredictionStatus。回帰予測rowはpredicted,observed,residual,meanCiLower,meanCiUpper,individualPiLower,individualPiUpper,predictionStatus。未依頼区間の上下限はnull。

predict応答=`{status,resultId,predictionId,summary,meta,unavailableReasons}`。summaryにはrequestedCount,successfulPredictions,failedPredictions,statusCounts,evaluationを必須。statusCountsのkeyはok,unknown_category,missing,invalid,unavailable。evaluationにはfitOverlapCount,nonFitEvaluationCountと別々のmetricsを返し、学習行を含む集計をholdout精度と呼ばない。evaluate=falseならevaluation=null。MCA/FAMD/FAは評価yを持たないためevaluation=null。

CJ予測は原task構造を保つ。未知属性/属性欠損があるchoice/ranking taskは全候補を未計算にする。responseは予測だけなら欠損可、evaluate時に整った回答を持つタスクのみ評価する。ランキングの予測確率は第1位のみ。availability=falseはunavailable。ratings fixedで未知回答者はmeanInterceptを用い、predictionAssumption=`population_mean_intercept`、既知なら`fitted_respondent_intercept`を追加する。

## 7. select/materialize/export

select応答rowIdsは結果保存順、重複なし。matchedCountはselectorに一致した保存結果の行数、fitMatchedCountはそのうち学習fit行（現版では同数）、contextIntersectionCountは要求scopeとの交差数。返却rowIdsは交差後のみ。FEはさらに現在activeに交差し、実適用件数を表示する。row_ids/respondentsで未知IDは無視するがignoredIdsCountを返す。categoriesでunknown categoryIdは入力誤り422（別結果の辞書混入を検出）。

materialize成功=`{status:'success',resultId,source,operationId,datasetId,dataRevision,schemaRevision,createdColumns:[{columnId,name,label,sourceField}],writtenRowCount,idempotentReplay:false}`。同一key/payload再送では同じ内容でidempotentReplay=true。writtenRowCountは少なくとも一つの非null保存値を持つ行数。sourceFieldごとにnonNullCountもcreatedColumnsへ含める。

export=`{status:'success',mime,fileName,encoding:'utf-8',payload,offset,total,nextOffset,hasHeader,snapshot:{datasetId,dataRevision,schemaRevision,resultId}}`。csv hasHeader=trueで各ページ同ヘッダ。manifest JSONはnextOffset=null。各テーブルJSONは`{columns,rows}`。配列列をCSV化するときはaxisIdでlong formatに展開し、曖昧なカンマ連結文字列にしない。ヘッダ順はschemaの固定field順、locale依存並べ替え禁止。HTML/SVGやExcel数式を文字列のまま実行させない。

## 8. simulate/WTP

simulate応答=`{status:'success',resultId,profiles:[{alternativeId,utility,predictedRating,probability,firstChoiceShare}],attributeImportance,wtp,warnings}`。各alternativeは入力順。ratingsではprobability=null、choice/rankingではpredictedRating/firstChoiceShare=null。効用に同じ定数を加えてもlogit確率不変であることを試験する。

includeWtp=falseならwtp=null。trueでは非価格カテゴリの各非基準水準対基準水準、および非価格linear属性のrangeLower→rangeUpperの比較を固定で出す。`[{attributeId,fromLevel,toLevel,deltaUtility,value,standardError,ciLower,ciUpper,priceUnit,status,reason}]`。価格は自分自身との比較を作らず、opt-outも含めない。価格の単位は保存codebook label/unitから表示し、単位未登録なら`per recorded price unit`。価格係数が負でCIが0を含まない条件を満たさないと値/SE/CI=null、status=unavailable、reason=WTP_UNSTABLE。

## 9. 未確定値・失敗例

距離0のcos2は`/details/categories/0/cos2/0`等にZERO_DISTANCE。推測不可SEはINFERENCE_UNAVAILABLE、survey非適用AICはUNSUPPORTED_FOR_SURVEY。nullが多数の行ページではunavailableReasonsを行ごとに重複文字列展開せず、pageのreasonCatalogとrow.reasonCodes（field→code）に正規化してよい。その場合reasonCatalogを必須とし、理由の省略とはしない。

本書の必須追加field（例CA tableカテゴリ順、FA selectedStartIndex）は個別設計の列挙に補完する。受入時は本書と入力Python契約からFE型・response serializerを作り、フィールド名のその場の略記を禁止する。

## 10. CJスコープ拡張API

`POST /models/conjoint/expand-scope`は学習前の補助API。入力はConjointExpandScopeRequest、出力は実装設計§11の固定field。expandedRowCount=originalRowCount+addedRowCount、expandedRowIds長=expandedRowCountを検証する。ID欠損/重複代替案などを見つけた場合はCONJOINT_INVALID_ID/CONJOINT_DUPLICATE_ALTERNATIVEで422。実行しないことを選んでも現在の設定・選択・結果は変更されない。


---

<a id="doc-19"></a>

出典ファイル：[contracts/FACTOR_EXTENSIONS_CONTRACT.md](contracts/FACTOR_EXTENSIONS_CONTRACT.md)

# Feature 033 EFA・033c CFA：入力・結果契約

版1.1／2026-09-13。対象は現行Feature 033 EFAと033c CFAのみ。[共通結果契約](contracts/RESULT_CONTRACT.md)の行ID・保存・stale・有限JSON・CSV安全性を継承し、本書でmethodとcapabilities、診断を追加定義する。旧FactorAnalysisRequestの自動互換変換は行わない。

## 1. 正本・入力

実行可能な構文正本は[factor_extension_requests.py](contracts/factor_extension_requests.py)、生成Schemaは[efa.schema.json](contracts/schemas/efa.schema.json)と[cfa.schema.json](contracts/schemas/cfa.schema.json)。入力例は[efa.request.json](contracts/examples/efa.request.json)、[cfa.request.json](contracts/examples/cfa.request.json)。既存analysis_requests.pyのAnalysisContextV2とStrictModelを再利用する。データ依存検証・エンジン能力はSchema外でサービスが検査する。

|入力|033 EFA|033c CFA|
|---|---|---|
|context|既存V2、missingPolicy=exclude|同左|
|weightMode|none/dataset。dataset解決後にweightなしのみ|同左|
|variables|columnId、measurement、treatment、categoryOrder、reverse、approximationAcknowledged|同左|
|尺度|measurement=ordinal/continuous。treatment=ordinal/continuous/continuous_approximation|同左|
|相関・方法|correlation=pearson/polychoric、extraction=minres/ml|estimator=wlsmv/mlr/ulsmv/ml|
|因子指定|nFactors、compareFactors|factors内factorId/indicatorIds/markerColumnId|
|回転・因子相関|rotation=promax/varimax/none|factorCovariance=free/orthogonal|
|得点|scoreMethod=none/regression/bartlett、ordinal経路はnoneのみ|初期版なし|
|補助|parallelAnalysis、sensitivityAnalysis、seed、nStarts、maxIterations、uniquenessLower|confidenceLevel、sourceEfaResultId、validationIntent|

measurementの根拠はサービスでコードブック・分析時指定を照合し、結果に保存する。categoryOrderの値は正規化済みコード文字列で、表示ラベルではない。ordinalでは2個以上の一意コードが必須、連続変数ではnull。ordinal→continuous_approximationにはack=true、それ以外はfalse。連続変数のreverseはfalse。真の順序treatmentと連続treatmentの混在は拒否する。ordinalのカテゴリ数に上限・自動連続化規則を設けない。

EFA qは1以上p未満、df≥0、比較候補も同条件。CFAは全項目がちょうど一因子に所属、因子ごとに3項目以上、markerは所属項目、因子IDは一意。未知キー・不適切な尺度／推定器の組合せは拒否する。

生成JSON Schemaはフィールド型・enum・基本範囲を表し、Pydanticのmodel_validatorによる複数項目間の制約を自動では表現しない。JSON Schemaだけの合格を実行許可とせず、Python契約でtreatmentと推定器・因子割当・欠損・ウェイト設定等を再検証し、その後サービスがデータ依存条件を検証する。

sensitivityAnalysisはenabled=false、approximationAcknowledged=falseがAPI既定。両者を同時にtrueにした場合だけ比較を実行する。全項目の元measurement=ordinal、parallelAnalysis.enabled=trueが必須。主treatmentは全ordinalまたは全continuous_approximationであり、その二つのtreatmentは混在させない。continuousとcontinuous_approximationだけの混在は主EFAで許可されるが、感度比較の対象ではない。alignment=signed_permutation、comparisonExtraction=minresを固定し、主のML指定は保持する。差分目安3種は(0,1]、割当閾値とmarginは[0,1]で、全て有限値。定義と既定値は[033 EFA設計の第7節](tasks/DAVIS-FEAT-033-DESIGN.md#7-pearsonpolychoric感度分析)を正本とする。CFARequestではこの比較指定を受け付けない。

## 2. 共通エンベロープ拡張

共通の`{status,resultId,method,meta,config,capabilities,summary,details,unavailableReasons}`を使用し、methodへefa/cfaを追加する。schemaVersion=`factor_extensions.1`。status=successは保存された計算結果の応答を意味し、統計的な妥当性の宣言ではない。

|フィールド|型・意味|
|---|---|
|summary.computationStatus|completed。failed/cancelledは失敗試行の診断で使用し、成功結果にしない|
|summary.solutionStatus|admissible / boundary / inadmissible|
|summary.inferenceStatus|available / partial / unavailable / not_implemented|
|meta.analysisPurpose|efa=exploratory、cfa=confirmatory_model|
|meta.isExplorative|両方true。CFAの分析目的と独立検証済みを分離|
|meta.requestedMethod|要求correlation/extraction/rotationまたはestimator|
|meta.appliedMethod|実相関・実抽出・回転、objectiveId、engineEstimator、SE/test定義|
|meta.routingReasons|code、columnIds、根拠の配列。UIの既定候補提示の理由|
|meta.methodSwitchReason|変更なしnull。1因子回転不要等の実適用差のみ。別推定器への自動切替不可|
|meta.matrixCorrection|applied=false、method=null、originalMatrixHash、effectiveMatrixHash|
|meta.attemptId / previousAttemptId|当該試行／明示再実行元。過去失敗を削除しない|
|meta.fitRowsRef / excludedRowsRef|保存行集合参照とcount/hash。HTTPへ全IDを二重埋込みしない|
|meta.measurementResolution|各列のsource、original/effective measurement、order、reverse、approximation|
|meta.engineManifest|algorithmVersion、sourceHash、runtime、libraryVersions、resolvedOptions、validationSuiteId|

既存のdataset/revision/scope/count/imputation/warnings/fingerprintは保持する。全経路非加重のためweightApplied=false、weightType/weightColumn/sumWeights/frequencyN=null。effectiveN=fitCount。未対応ウェイト入力の結果をこの形で成功返却してはならない。

診断レコードは`{code,severity,stage,columnIds,pairIds,factorIds,count,value,threshold,reason}`。severity=info/warning/error、配列なしは[]、数値未提供はnull。文字列messageではなくcodeでUI分岐する。stageはinput/correlation/extraction/rotation/parallel/scoring/identification/inference/fit/persistence。

422失敗は共通errorに`attemptId,stage,diagnosticsRef`を追加できる。失敗記録は独立した診断保存でありresultIdを使った有効モデル操作の対象ではない。元回答・内部パス・スタックを公開errorへ含めない。

失敗を再試行後も参照できるよう、実装予定APIはGET `/api/v1/analysis-attempts/{attemptId}`（要求・解決済み設定・段階・状態・診断要約）とGET `/api/v1/analysis-attempts/{attemptId}/diagnostics?offset=0&limit=500`（上限10000、total/nextOffset）を追加する。所有datasetの照合と明示削除・dataset削除への追従を共通結果storeと揃える。失敗attemptにrows/predict/materialize APIは設けない。成功結果の大量診断は共通exportのdiagnostics表で取得する。

## 3. EFA結果

p=項目数、q=主因子数、Kj=項目jのカテゴリ数。配列順はdetails.variablesとfactorIdsで明示する。

|項目|型・形状|
|---|---|
|summary.nVariables/nFactors/modelDf|整数|
|summary.objective|{id,value,offDiagonalSse,optimizerDiagonalParametersRef}。MLでは最後の参照null|
|summary.rmsr/totalCommunalityRatio|有限値またはnull。RMSRは非対角p(p−1)/2分母|
|summary.selectedStartIndex/effectiveFactorRank|整数|
|summary.scoreMethod/scoreInterpretation|none/regression/bartlett、latent_estimate/continuous_approximation/null|
|details.variables|p件、columnId、label、order、変換、mean/sampleScale（順序モデルはnull）|
|details.factorIds/factorLabels|q件|
|details.pattern/structure|p×q|
|details.factorCorrelation/rotationTransform|q×q|
|details.communality/uniqueness|p件|
|details.sampleCorrelation/reproducedCorrelation/residualCorrelation|p×p、対角残差も保持|
|details.thresholds|順序のみp件の{columnId,cuts[Kj−1],scale:standard_normal}、他null|
|details.correlationDiagnostics|対別診断へのページ参照、総対数p(p−1)/2|
|details.optimizerStarts|startごと初期u/ψ、status、iterations、objective、projectedGradientNorm|
|details.ssLoadings/varianceRatios|q件またはPromax時null|
|details.parallelAnalysis|下記|
|details.factorComparisons|q候補ごとのstatus、objective、RMSR、診断・行列参照。失敗も保持|
|details.distributionProfiles|項目別N、categoryCounts/Proportions、minCategoryCount、maxCategoryProportion、rankSkewness、floor/ceilingProportion、reasonCodes|
|details.sensitivityAnalysis|enabled、comparisonIdまたはnull、現在の実行状態。主結果を変更するものではない|

parallelAnalysisは`{enabled,status,iterationsRequested,iterationsSucceeded,iterationsFailed,seed,rng,nullGenerator,quantile,quantileMethod,eigenvalueDefinition,observedEigenvalues,referenceQuantiles,suggestedFactors,exceedanceRanks,replicatesRef,reasonCode}`。nullGenerator=independent_column_permutation、eigenvalueDefinition=full_correlation、quantileMethod=linear。未実行はstatus=not_requested、統計量null。失敗反復があればreferenceQuantiles/suggestedFactors=null。観測固有値p件はスクリープロット用として残す。

MLの参考適合度・KMO/BartlettはfitMeasuresとunavailableReasonsで033規約に対応させる。ULS系にML検定を返さない。算出されたが不適解のため利用できない値は、公開推論valueをnullとし、内部診断値と区別する。

### 3.1 感度比較の独立結果

GET `/api/v1/analysis-comparisons/{comparisonId}`は次を返す。主resultIdの計算値やfingerprintは比較完了で書き換えない。進捗・比較索引はGET時に解決し、完成した比較データは不変とする。

|フィールド|型・内容|
|---|---|
|comparisonId/primaryResultId|保存された比較／主結果のID|
|status/stage/progress|queued/running/completed/partial/failed/cancelled、段階名、完了反復数と予定数|
|meta|dataset/revisions/rowHash/itemHash/fitCount、同意、engine版、比較版、置換ストリーム参照、stale状態|
|methods|pearson/polychoricそれぞれのresultIdまたはattemptId、抽出・q・回転・得点none、solutionStatus|
|alignment|method、status、permutation、signs、congruences、assignmentGap、H、procrustesResidual/Q（未計算null）|
|metrics|相関・負荷量・共通性・Φの最大/中央値差、割当変更・比較可能・曖昧数、PA候補数と差|
|itemDifferences|columnId、共通性差、整合済み負荷量差、各側確定/曖昧割当、変更の有無|
|factorCountComparison|pearsonSuggestedFactors、polychoricSuggestedFactors、difference、各PA参照、reasonCode|
|assessment|small_observed_difference / method_sensitive / indeterminate / null（未完了）|
|thresholds/assessmentVersion|要求された比較目安、固定整合目安、判定ロジック版|
|unavailableReasons/diagnostics|各差分のnull理由、片側失敗や低整合を含む|

`completed`は比較処理完了を示し、assessment=indeterminateもあり得る。副解析失敗のpartial/failedを「差なし」に変換しない。両側の行hash・項目hash等が一致しなければ`COMPARISON_CONTEXT_MISMATCH`で指標を計算しない。適用qが異なる場合に係数差を0補完しない。

比較には回答者得点・PCP選択・materialize能力を付けない。GET同URLの`/export?table=manifest|items|metrics|diagnostics&offset=0&limit=500`で同じ所有確認と上限10000のページ出力を行う。POST同URLの`/cancel`は比較だけを中断し、主結果の閲覧を保持する。削除は明示操作またはdataset削除に追従し、関連IDの参照切れは削除済みと示して別結果に付け替えない。

## 4. CFA結果

|項目|型・形状|
|---|---|
|summary.nVariables/nFactors/nFreeParameters/modelDf|整数、自由度はエンジンと独立数え上げを照合|
|summary.estimator/parameterization/scaleIdentification|wlsmv/mlr/ulsmv/ml、thetaまたはcontinuous、marker|
|details.model|確認済み割当・制約・marker・modelHash|
|details.parameters|下記Parameter配列|
|details.factorCovariance/factorCorrelation|q×q|
|details.loadings/stdLvLoadings/stdAllLoadings|p×q、非所属は固定0|
|details.residualVariances/stdAllResidualVariances|p件、単位を明示|
|details.intercepts|連続p件、順序null|
|details.thresholds|順序p件の有限内部閾値と尺度、連続null|
|details.observedMoments/reproducedMoments/residualMoments|共分散／潜在応答相関をkindで区別する参照|
|details.sampleStatistics|ordered statisticIds、nStatistics、GammaShape、GammaScale、GammaRef、WlsWeightRef|
|details.identification|parameterCount、jacobianRank、informationRank、conditionNumbers、reasonCodes|
|details.fitMeasures|下記FitMeasure配列|
|details.testStatistics|target/baseline/h1、通常・補正検定、係数・shift・エンジン参照|
|meta.validationEvidence|下記|

Parameterは`{parameterId,lhs,op,rhs,freeIndex,fixed,fixedValue,estimate,standardError,statistic,pValue,ciLower,ciUpper,confidenceLevel,stdLvEstimate,stdAllEstimate,scale,reasonCode}`。固定値はestimateにも含め、SE/statistic/p/CIはnull、reasonCode=FIXED_PARAMETER。推定値・SE等は有限数またはnull。統計量はSEに対応するz等の定義をtestStatisticsに保存する。

FitMeasureは`{metric,variant,engineKey,value,ciLower,ciUpper,confidenceLevel,statisticDefinition,correctionMethod,df,n,availability,reasonCode}`。variant=standard/scaled/robust/descriptive。SRMR/RMSRはdescriptive、参考χ²等は適切なvariant。未定義の統計量を空配列で隠さず、初期UI対象指標についてnullのレコードと理由を返す。χ²のrobust別値は捏造せず、補正χ²をscaledで記録する。

validationEvidenceは`{intent,sourceEfaResultId,sourceModelHash,sourceDatasetLineage,currentDatasetLineage,overlapCount,splitDefinitionRef,modelFrozenAt,evidenceStatus,reasonCode}`。intent=exploratory/same_data/holdout/external/unknown、evidenceStatus=same_data/holdout_recorded/unknown。別データの行IDが偶然一致・不一致であることだけを回答者の同一性判定に使わない。

## 5. 能力・結果操作

|能力|EFA得点なし／不適解|EFA得点あり・適切な解|CFA初期版|
|---|---|---|---|
|rows/projection/materialize|false|true|false|
|selectionKinds|[]|rectangle,row_ids|[]|
|materializeFitFields/PredictionFields|[]|score:1..q|[]|
|simulation|false|false|false|

境界解は得点・保存を無効にする。EFA得点rowは共通のrowId/scores、学習外欠損はnullのpredictionStatus。scoresを計算していない行の代わりに負荷量をPCPに載せない。

拡張専用exportTablesはEFA=`manifest,variables,diagnostics,parallel_analysis,factor_comparisons`と得点がある場合のrows、CFA=`manifest,parameters,fit_measures,diagnostics`。共通の既存enumには実装時に明示追加し、他手法の同名表の意味を変えない。diagnostics・反復・比較はkindごとのlong table、offset/limitを使い全件を出力できる。

result storeは共通の原子的保存と版照合を使用する。schemaVersionとmethodに応じて追加serializerを選ぶ。現在の共通Python/Schemaはこれらの結果・export拡張をまだ実装していないため、本書を実装契約の追加要件とする。request Schema成功を結果API実装済みの根拠にしない。


---

<a id="doc-20"></a>

出典ファイル：[tasks/ACCEPTANCE_AND_HANDOFF.md](tasks/ACCEPTANCE_AND_HANDOFF.md)

# 実装順序・受入条件・引き継ぎ

版1.0。これは実装タスクの完了条件であり、この成果物作成時の試験実績ではない。実績はvalidation/VALIDATION_REPORT.mdを参照。

033 EFA／033c CFAは[拡張受入計画](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)を適用する。現行033のEFA受入条件を適用し、旧ML専用資料の受入条件は使わない。CFAはEFA完成後の独立段階で、ローカルlavaanと静的実行未対応の能力境界を個別に検証する。

## 1. PR/タスク分割

|順序|変更単位|先行条件|完了条件|
|---|---|---|---|
|A|V2入力契約・共有前処理・数値共通部・結果store|基準版差分確認|既存API非破壊、scope/invalid/weight/行ID一致|
|B|CA kernel→表→回答者API→画面|A|解析解、カテゴリ選択、零質量、local/static一致|
|C|MCAとFAMDを別kernel/画面で実装|A,BのSVD/カテゴリ基盤|m/K正規化、FAMD標準化、寄与・cos2・射影|
|D|回帰core＋Taylor model_covariance|A|OLS/HC3/frequency複製、設計PSU、識別不能|
|E|EFA（Pearson ML／MINRES、Polychoric MINRES）→平行分析→回転→得点・感度比較|A|EFA-B01〜B22、ML目的関数、相関・回転不変性、得点能力規約|
|F|CJデータ検証→ratings→choice→ranking→simulate|A,D|タスク完全性、回答者SE、分離、効用・WTP|
|G|共通保存/export/PCP/E2E/配布統合|B〜F|原子的保存・idempotency・stale・KeepAlive・静的版|

UIを先に架空レスポンスへ固定して、後から数式や実装の都合でfield名・比率単位を変えない。初期にはfixtureから同じ契約のmockを生成し、API完成時にserializer契約テストを差し替える。

## 2. 既存仕様の更新リスト

Feature27のMCA部分はFeature30へ置換リンクを付ける。旧nK正規化、selected scopeにrowIds、isExplorative=false、weight未対応の無警告実行を新しい期待値に更新する。Feature27/28のPCP・ヒットテスト・スクロール等の試験は維持。

Feature17〜26のrole/scale/categoryOrder/MA/weight/provenance契約は原則維持。新APIのstrict化を既存全routeへ強制しない。既存Api AnalysisContext型にoptional拡張を無制限に重ねず、新V2を明示定義する。

statsmodels/prince/factor_analyzer/FactoMineRをproduction依存へ追加しない。NumPy/SciPy計算をlocalとPyodideで共通化する。SciPyの公開最新版への追従をこの機能追加に便乗させない。添付依存とブラウザruntimeの組合せを別々に記録する。

## 3. 受入マトリクス

|ID|確認|必須fixture/操作と判定|本体の追加先|
|---|---|---|---|
|COM-01|版競合|計算中にdata/schema変更→409、半結果未公開|test_160_new_analysis_api.py|
|COM-02|scope|空selectedは空、active配列省略422、明示未知ID422|同上|
|COM-03|分類|missing/NA/invalid、閉領域外9、literal欠損文字列衝突なし|test_170_new_analysis_context.py|
|COM-04|MA|選ばなかった子のinvalidでも親判定に反映|同上|
|COM-05|重み|negative/NaN/bool拒否、frequency整数、survey倍率不変|同上|
|COM-06|補完来歴|使用セル数・maskRevision・current values表示一致|同上|
|COM-07|保存|rowId join、非対象null、既存列上書き拒否、版+1|test_180_analysis_result_store.py|
|COM-08|再送|成功後通信失敗→同key再送はstaleでも同成功、二重列なし|同上|
|COM-09|store|半保存不可、明示delete、データ削除、再起動後GET|同上|
|COM-10|ページ|2ページ目以降を含めた選択/export、全fit数不変|同上/FE|
|COM-11|状態|KeepAlive復帰、dataset変更、古いrunSequence破棄|frontend/tests/analysisRun.test.tsx|
|COM-12|安全|有限JSON、CSV式注入、ID照合、path traversal拒否|API/FE|
|CA-01|解析解|[[30,10],[10,30]]、λ=.25、主座標±.5、χ²=20|test_100_ca.py|
|CA-02|不変性|表倍率、転置、カテゴリ順、零周辺除外|同上|
|CA-03|境界|全0/独立表/一水準、rank1、survey p=null|同上|
|MCA-01|正規化|m=3、K≠m、ΣP=1、trace=(K−m)/m|test_110_mca.py|
|MCA-02|軸|Benzécri全0時null、縮退空間、全軸寄与和|同上|
|MCA-03|射影|fit再射影・未知水準・重み倍率・MAモード|同上|
|FAMD-01|正規化|不均等カテゴリ、ddof0、trace=p+Σ(Kj−1)|test_120_famd.py|
|FAMD-02|寄与|カテゴリ重心の直接平均、λとλ²の区別|同上|
|FAMD-03|表示|相関円と個体空間分離、r²/η²と寄与率分離|同上/FE|
|LR-01|外部正解|Statsmodels OLS classical/HC3と係数・共分散一致|test_130_linear_regression.py|
|LR-02|frequency|行を整数複製した非加重HC3と一致|同上|
|LR-03|設計|層/PSU/FPC、scope外PSU0、singleton推測不能|同上|
|LR-04|モデル行列|カテゴリ基準、交互作用、切片なし、rank欠損|同上|
|LR-05|診断予測|R²種別、SE/PI、VIF、leverage複製単位|同上|
|FA-01|ML|固定相関、勾配有限差分、複数start、境界・失敗|test_140_factor_analysis.py|
|FA-02|回転|LΦL'不変、pattern/structure、得点変換|同上|
|FA-03|得点|R使用regression/Bartlett、frequency複製、未知行|同上|
|FA-04|推測|df<0/0、sampleR非正定値、survey明示拒否|同上|
|CJ-01|入力|long format、部分task拒否、ID重複、availability|test_150_conjoint.py|
|CJ-02|評点|effect code効用和0、pooled/within識別|同上|
|CJ-03|選択|3対1の解析解β=log(3)/2、P=.75|同上|
|CJ-04|順位|J−1stage、積の尤度、ties/partial未対応|同上|
|CJ-05|SE|回答者反復、frequencyブロック複製、survey倍率|同上|
|CJ-06|分離|完全/準完全分離LP、非収束・情報行列特異|同上|
|CJ-07|simulate|確率和1、ratings第一選好、range固定、WTP符号|同上/FE|
|REL-01|静的|同fixture API一致、HiGHS稼動、SVG/CSV出力|実ブラウザE2E|
|REL-02|回帰防止|既存全backend/FE統計テストが成功|既存全suite|

## 4. 数値一致基準

小規模解析解はatol1e-12、通常のSVD係数/固有値はrtol1e-9,atol1e-10を基本とする。勾配有限差分はstepと相対誤差を記録。MLの独自性・目的値は収束の違いを考慮しrtol1e-5程度から原因を検証し、失敗を通すため無条件に許容差を拡大しない。

軸符号とカテゴリ/列順をそろえる。同一固有値群は座標成分ごとの一致ではなくprojector・Gram行列・再構成で検査する。FAの異なる回転解は再現相関と因子空間から照合する。CIのt参照自由度、HC3定義、CR1補正因子、Rの欠損/row.w、AIC分散パラメータ数を一致させてから比較する。

## 5. 実装者が実行するコマンド

作業treeの依存環境を整え、新規試験を追加した後に実行する。新規API未実装の現時点でこれらが成功したとはしていない。

```bash
# リポジトリルートから
cd fullstack/backend
python -m pytest -q tests/stats_tests
python -m pytest -q tests
cd ../frontend
npm test
npm run build
npm run build:static
```

実ブラウザではlocalとstaticへ同じfixtureを投入し、各分析実行→全ページ取得→PCP選択→列保存→stale確認→再実行→export→KeepAlive復帰を行う。静的配布scriptはfullstackの二重連結を先に実在パスassertし、backend_app.zip中に新モジュールが存在することをZIP一覧で検査する。HiGHSの最小LPが静的worker内で成功しない場合、choice/ranking機能を正常としてリリースしない。

外部oracleのR環境は別途準備し、FactoMineR CA/MCA/FAMD、stats::factanal、surveyを同じ有効データで実行する。Rの既定補完を有効にした値とlistwise除外の値を直接比べない。oracle値更新は生成スクリプト・R/package版・入力hashをセットでレビューする。

## 6. 完了報告の必須内容

変更パス、採用algorithmVersion、各受入IDの結果、コマンドと実行環境、未実施試験、意図した非対応機能、旧仕様を置換した箇所、runtime差分を記載する。「テスト成功」だけでnumerical/contract/API/FE/static/R oracleのどれかを省略しない。

動作の救済として、無警告の無重み化、欠損0埋め、変数自動削除、勝手な標本縮小、分離時だけ正則化、特異値のabs化、推測不能のp=1埋めを導入した場合は本仕様未達とする。対象外機能は画面とAPIの双方で明示する。


---

<a id="doc-21"></a>

出典ファイル：[tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)

# Feature 033 EFA・033c CFA：実装順序・受入条件

版1.1／2026-09-13。以下は実装の受入計画であり、実行済み実績ではない。[検証実績](validation/FACTOR_EXTENSIONS_VALIDATION.md)と区別する。現行033はEFA-B01〜EFA-B22を適用し、旧033のFA01「ML以外を指定できない」等は現行EFAの受入条件として流用しない。

## 1. 段階と終了条件

|段階|対象|終了条件|
|---|---|---|
|B0|尺度・カテゴリ・欠損・契約|コード順序、逆転、重み、scope、strict入力の意味検証|
|B1|ポリコリック＋単一ULS系＋既存ML|独立oracle、目的値、境界・未収束、失敗経路の照合|
|B2|PA・回転・候補比較・得点・感度比較|再現相関不変性、共通置換、因子整合・差分、順序得点を提供しない|
|B3|EFA API/保存/画面|行IDと版、KeepAlive、PCP、run-production.batで確認|
|B4|EFA静的実行|同一kernelのPyodide数値と状態・保存検証。ビルド実行は別指示に従う|
|C0|CFA runner・依存固定|local R/lavaan、配布可能性、任意式排除、能力応答|
|C1|CFA WLSMV/MLR/ML|測定モデル、識別、点推定・SE・適合度の独立golden照合|
|C2|CFA API/保存/画面|独立性の根拠、失敗診断、KeepAlive、local操作確認|
|C3|追加ULSMV|専用oracle・失敗条件。合格前はUI能力false|

C0以降をB段階の必須条件にしない。CFA静的計算は別機能ゲートで、C2完了が静的CFAを意味しない。設計文書の作成時には本体実装・ビルド・全体試験を実施しない。実装時も対象単位の検証を先に行い、問題を解消してから全体回帰を行う。

## 2. oracleと数値基準

oracleのR script、入力hash、出力、sessionInfo、ライブラリversion/source hash、オプション・乱数規約を保存する。期待値は製品kernelから生成しない。golden更新は製品失敗を解消するために自動承認しない。

|対象|一次比較|受入許容差（初期基準）|
|---|---|---|
|polychoric|polycor::polychor ML=FALSE、同一閾値・maxcor・補正なし|ρ/閾値atol1e-5、整ったfixture|
|ULS profile|factor_analyzer公開profile規約と独立した数式oracle|目的値atol1e-7、再現相関/共通性atol1e-5|
|MINRES系の外部照合|psych::fa(fm=minres)、同じR・q・回転条件|Σhat/h² atol1e-4を初期目標。目的関数・制約差は別記し、一致未達を成功扱いしない|
|ML|R stats::factanal、同じR/下限/初期値/回転|目的値1e-7、Σhat/h²1e-5|
|回転|同規約のoracle、raw/rotated再構成|同じ解のΛΦΛ′の差atol1e-8|
|CFA|別作成した固定R lavaan script（adapterを使わない）|点推定・閾値atol1e-5、SE1e-5、χ²1e-4、CFI/TLI/RMSEA/SRMR1e-5|
|不変性|同じモデルのコード・行・項目変換|deterministic統計量atol1e-8、反復推定atol1e-5|

比較は原則rtol=1e-5も併用し、ゼロ近傍は絶対誤差で判定する。悪条件fixtureを通常精度の成功例と同じ閾値で強制通過させず、失敗・警告の正しさを判定する。因子順・符号を揃え、回転規約が異なる場合はpatternの直接比較ではなく再現相関・共通性・目的値を比較する。SE比較はパラメータ表の尺度・自由/固定を合わせる。

## 3. EFA受入マトリクス

|ID|検証内容|fixture・判定|
|---|---|---|
|EFA-B01|尺度routing|2/5/6/7カテゴリはordinalのまま。未知水準・混在・名義拒否。明示近似のみpearson|
|EFA-B02|カテゴリ順序|1..5→10,20,40,80,160の順序保存再符号化でρ不変。ラベル辞書順に依存しない|
|EFA-B03|逆転・列順|一項目逆転で対応行列符号変換、二重反転なし。項目順をIDで揃えて同値|
|EFA-B04|欠損・不正|missing/NA/invalid/補完を含む。listwise集合・件数・行hash一致、pairwise拒否|
|EFA-B05|入力限界|定数、未観測カテゴリ、カテゴリ1件だけ、n不足、df負、危険な数値を所定コードで拒否|
|EFA-B06|相関oracle|2値・5件法・非対称分布・異なるカテゴリ数。閾値とρを別に比較|
|EFA-B07|相関失敗・非正定値|疎セル、境界±.9999、失敗注入、非PD行列。抽出へ進まず補正なし|
|EFA-B08|ULS/ML|同じRの目的・制約・最適化uと報告ψを照合。下限start・全失敗を保持|
|EFA-B09|回転|none/Varimax/Promax、S=ΛΦ、diagΦ=1、h²正解、斜交の加算寄与なし|
|EFA-B10|不適解|負ψ、境界u、特異Φ、回転失敗、|pattern|>1でも単独判定しない|
|EFA-B11|平行分析|項目分布保持、双方同相関・同固有値、seed再現、候補0、失敗反復でnull|
|EFA-B12|候補比較|q別の成功/失敗を全件保持。主q失敗を別qで置換しない|
|EFA-B13|得点|連続regression/Bartlett fit/predict一致、近似ラベル、順序得点拒否、rowId join|
|EFA-B14|推論|ULS系のχ²等null、MLのみ033式・適用条件、境界解の推論不可|
|EFA-B15|重み・再現|datasetのsurvey/frequencyを拒否、明示noneで別試行、設定/版/hash/start保存|
|EFA-B16|UI/統合|PCP選択とactive交差、非対象行null、stale拒否、KeepAlive・dataset切替・local/static|
|EFA-B17|実務プロファイル|5件法・N=1000/2000、良好分布でPearson主結果を選べる。N=999/1000や絶対歪度1前後で強制routingしない|
|EFA-B18|同条件ペア|fit行・項目・逆転・欠損・q・回転・MINRESを固定、共通置換index。主MLを比較MINRESで上書きしない|
|EFA-B19|因子整合|既知の符号反転/置換で差0、Φも変換、曖昧対応でindeterminate。Procrustesだけで差を消さない|
|EFA-B20|比較指標|既知の負荷量/共通性/Φ差、割当変更、PA3対4、異qの係数差null、曖昧項目の扱い|
|EFA-B21|判定・失敗|目安直前/一致/超過、片側失敗、PA不能、境界解、無断fallbackなし、同等性証明と表示しない|
|EFA-B22|比較保存・性能|comparisonId、主結果独立表示、副解析cancel/stale、N×p×K×PA反復の実測、rows/PCP非干渉|

## 4. CFA受入マトリクス

|ID|検証内容|fixture・判定|
|---|---|---|
|CFA-C01|モデル構造|2因子×3項目、marker固定1、重複/未所属/未知/交差負荷拒否|
|CFA-C02|尺度・閾値|順序theta残差1、切片0、閾値自由、std.all再構成、6/7カテゴリでordinal|
|CFA-C03|識別|df<0、df=0、Jacobian/情報特異、因子相関1近傍。dfだけで成功にしない|
|CFA-C04|WLSMV|閾値/相関/Γ順序・scale/対角点推定/完全推論情報を照合|
|CFA-C05|MLR|非正規連続fixture、MLとの点推定関係・SE/testの相違、normal尤度規約|
|CFA-C06|通常ML|同一完全ケースによる標準推論、標本共分散分母とN倍率を照合|
|CFA-C07|ULSMV追加|同条件WLSMVとの比較と独立golden。小標本・低負荷で失敗も記録|
|CFA-C08|適合度|standard/scaled/robustを個別キー照合、baseline失敗/非PD/df0で理由付きnull|
|CFA-C09|不適解・未収束|負分散、SE不能、境界、未順序閾値、optimizer失敗。状態を分離|
|CFA-C10|欠損・ウェイト|完全ケース一致、ordinal FIML拒否、survey/frequencyを黙って非加重化しない|
|CFA-C11|独立性|同一/一部重複/非重複split/別dataset不明/モデル再編集。intentだけで認定しない|
|CFA-C12|安全なrunner|悪意ある列ラベル・因子名・任意式がR構文にならない、未導入時の能力表示|
|CFA-C13|API/保存|版競合、cancel、失敗trial、SE不能、full statistics/hash、表export、stale|
|CFA-C14|画面/環境|モデル表と図の一致、キーボード操作、KeepAlive、得点操作false、static未対応|

CFA-C11では、EFA感度比較の親・両子結果の探索行を解決し、感度比較が一致しても独立確認済みにならないことを追加検証する。CFA-C05では5件法を明示近似したMLR経路も検証する。

## 5. 合成データ計画

[fixture計画](fixtures/FACTOR_EXTENSIONS_FIXTURES.md)に生成モデルと変換条件を定義する。乱数標本での真値との近さをoracle一致の代わりにしない。主要条件はN=1000/2000、5件法、対称で各カテゴリ十分な分布とする。N=100/300、負荷.4/.7、2/4/7カテゴリ、非対称・異なる分布・潜在非正規も追加し、標本数による方式の普遍順位づけはしない。小標本の一回成功を安定性の証明にしない。

性能はN=1000/2000×p=12/30/60×K=5（追加2/7）×PA反復100/500の代表組合せをlocalとPyodideで測定する。主結果表示まで、比較完了まで、相関・PA別時間、ピークメモリ、中断応答を分けて記録する。「大標本なら比較コストは問題ない」と未測定のまま完了判定しない。測定値からUIの進捗とキューを調整し、分析対象行や反復数を黙って減らさない。

## 6. 完了証拠

各段階はcommitまたは入力snapshot hash、実行コマンド、runtime、試験件数、最大誤差、診断例、画面操作記録、未実施を残す。本体数値・API・GUI・ビルド・配布は別ゲート。設計Schemaの成功件数や旧42件を、新EFA/CFAの数値検証件数として合算しない。


---

<a id="doc-22"></a>

出典ファイル：[references/source_audit.md](references/source_audit.md)

# 添付ソース・既存仕様の照合記録

確認日：2026-09-12。静的コード照合を実施した。ここに示す行番号は添付package(1).zipを展開した元ファイルの1始まり行番号であり、提案ファイルの行番号ではない。実行・E2E確認済みという意味ではない。

## 1. 入力アーカイブの同定

|ファイル|bytes|SHA-256|
|---|---:|---|
|`feature.zip`|1366452|`f40dc5812064962234e5923d569d89ccc32e61b253e4b7f88e1bcd3580712ed6`|
|`package(1).zip`|80494001|`9a14dc6e1f879f6d7cc9fe0e861ac7b61ba74250f4b3d2e3e22efcff6f287d01`|
|`package.zip`|80494001|`9a14dc6e1f879f6d7cc9fe0e861ac7b61ba74250f4b3d2e3e22efcff6f287d01`|
|`davis-pcp-local(1).zip`|1031580|`461abff34f6647ab8e14099d4dbd6e76dc15e41b968382d76dbebe2a8a9369d4`|

package.zipとpackage(1).zipのSHA-256は同一。実装設計の基準はpackage(1).zip。local配布は実行用snapshotとして参照し、フロントエンド開発用ファイルの有無はsource版を基準とした。

## 2. 実装接続箇所

|確認ファイル|該当行・symbol|確認事項|
|---|---|---|
|[fullstack/backend/app/main.py](../../fullstack/backend/app/main.py)|`include_router`: 67,68,69,70,71,72等<br>`/api/v1`: 67,68,69,70,71,72等|API router登録|
|[fullstack/backend/app/domain/context.py](../../fullstack/backend/app/domain/context.py)|`class AnalysisContext`: 25<br>`def collect_revisions`: 48<br>`def check_revisions`: 56<br>`def scope_hash`: 89<br>`def resolve_scope`: 95|既存context、版、scope、行ID集合|
|[fullstack/backend/app/domain/analysis_columns.py](../../fullstack/backend/app/domain/analysis_columns.py)|`class AnalysisColumns`: 14<br>`def prepare`: 19<br>`def resolve_analysis_columns`: 43|MA dependenciesとモデル入力列の絞込|
|[fullstack/backend/app/domain/codebook_adapter.py](../../fullstack/backend/app/domain/codebook_adapter.py)|`def normalize_code`: 17<br>`def analysis_series`: 199<br>`categoryOrder`: 133,142,210,214,249,252等<br>`CODEBOOK_REVERSE_RANGE_MISSING`: 273|コード正規化、ordinal数値化、逆転範囲|
|[fullstack/backend/app/algorithms/summaries/core.py](../../fullstack/backend/app/algorithms/summaries/core.py)|`categoryOrder`: 63,68,201,299,301,346等<br>`invalid`: 64,65,67,72,88,94等|閉じた有効領域とinvalid|
|[fullstack/backend/app/algorithms/summaries/crosstab.py](../../fullstack/backend/app/algorithms/summaries/crosstab.py)|`def _split_missing`: 120<br>`include_missing`: 133,168<br>`separate_not_applicable`: 135,137,168|欠損/非該当カテゴリの意味|
|[fullstack/backend/app/domain/weight_mode.py](../../fullstack/backend/app/domain/weight_mode.py)|`def `: 16<br>`weightMode`: 1,29,36,43|weightMode互換規則|
|[fullstack/backend/app/domain/survey_weight.py](../../fullstack/backend/app/domain/survey_weight.py)|`def `: 21,34,50,66,122,131等<br>`frequency`: 146,148,170,185,189<br>`survey`: 3,51,147,170,186|重み宣言・値検証|
|[fullstack/backend/app/algorithms/survey/design.py](../../fullstack/backend/app/algorithms/survey/design.py)|`def `: 21,56,60,64,68,74等<br>`fpc`: 51,97,102,103,106,109等|調査設計列・FPC|
|[fullstack/backend/app/algorithms/survey/covariance.py](../../fullstack/backend/app/algorithms/survey/covariance.py)|`def `: 16,58|既存共分散helperの境界監査対象|
|[fullstack/backend/app/storage/dataset_store.py](../../fullstack/backend/app/storage/dataset_store.py)|`def lock`: 109<br>`def get_dataframe`: 229<br>`def load_codebook`: 599<br>`def mask_revision`: 370<br>`def commit_data_change`: 407|snapshot/版/原子的変更の接続先|
|[fullstack/backend/app/domain/provenance.py](../../fullstack/backend/app/domain/provenance.py)|`def new_operation_id`: 44<br>`class ProvenanceStep`: 53<br>`def fingerprint_payload`: 80|派生列の来歴|
|[fullstack/backend/app/api/models.py](../../fullstack/backend/app/api/models.py)|`@router`: 45,180,366,377,396<br>`_results`: 28,359,368,370|既存PCA等。新APIの共有サービスとは分離|
|[fullstack/frontend/src/api/client.ts](../../fullstack/frontend/src/api/client.ts)|`const BASE`: 3<br>`pyodide`: 1,19,68,88,108<br>`downloadBlob`: 49|local/static共通通信・static exportの制約|
|[fullstack/frontend/src/engine/pyodide.worker.ts](../../fullstack/frontend/src/engine/pyodide.worker.ts)|`loadPackage`: 72<br>`numpy`: 73<br>`scipy`: 74<br>`serialQueue`: 7|既存Python実行とパッケージ|
|[fullstack/frontend/src/main.tsx](../../fullstack/frontend/src/main.tsx)|`Route`: 4,70,77,104<br>`models`: 14,23,31,32,48|router登録|
|[fullstack/frontend/src/app/KeepAliveOutlet.tsx](../../fullstack/frontend/src/app/KeepAliveOutlet.tsx)|`ROUTE_COMPONENTS`: 35,96,113|ページ保持登録|
|[fullstack/frontend/src/app/AppShell.tsx](../../fullstack/frontend/src/app/AppShell.tsx)|`ANALYSIS_NAV_ITEMS`: 44,60,432,433|ナビゲーション登録|
|[fullstack/frontend/src/app/store.ts](../../fullstack/frontend/src/app/store.ts)|`selectionApplied`: 101,163,461<br>`activeRowIds`: 34,35,60,89,103,122等<br>`hovered`: 39,64,117,118,163|L1/L2・選択交差|
|[fullstack/scripts/build_static.py](../../fullstack/scripts/build_static.py)|`ROOT =`: 19<br>`FRONTEND_DIR =`: 20<br>`BACKEND_DIR =`: 21<br>`0.27.7`: 25|静的配布のパスとruntime宣言|
|[fullstack/backend/requirements.txt](../../fullstack/backend/requirements.txt)|`numpy`: 5<br>`scipy`: 7<br>`pydantic`: 3|添付版の依存宣言|
|[fullstack/frontend/package.json](../../fullstack/frontend/package.json)|`"scripts"`: 6<br>`"test"`: 12<br>`"build:static"`: 10|FEビルド・検証コマンド|

## 3. 既存仕様で更新が必要な点

|原資料|確認箇所|本設計の確定処理|
|---|---|---|
|[feature.zip/tasks/DAVIS-FEAT-027-028.md](../../tasks/DAVIS-FEAT-027-028.md)|`isExplorative`: 96,260<br>`rowIds`: 69,75,234|MCAのnK分母をnmへ変更。選択scopeの専用selectedRowIdsと探索ラベルへ統一。PCP部分は維持。|
|[feature.zip/tasks/DAVIS-FEAT-020-DESIGN.md](../../tasks/DAVIS-FEAT-020-DESIGN.md)|`上限`: 41<br>`離脱`: 41|計算の勝手な間引き・ページ離脱時の破棄を導入しない。今回のページ分割は転送/描画の分割。|
|[feature.zip/tasks/DAVIS-FEAT-021-022.md](../../tasks/DAVIS-FEAT-021-022.md)|`survey`: 6|重み種別とordinalの解釈を分離し、unsupportedの黙認を防ぐ。|
|[feature.zip/tasks/DAVIS-FEAT-025-026.md](../../tasks/DAVIS-FEAT-025-026.md)|`commit`: 682<br>`provenance`: 7,140,184,275,307,308,309,310,311,312,313,353,365,659,678,686<br>`revision`: 104,142,176,183,271,294,299,327,352,354,356,360,363,373,377,395,548,573,579,603,634,651,658,659|派生列・原子的保存・版追跡を維持。|

## 4. 接続時の注意（観測事実と設計判断）

`AnalysisColumns.prepare`は要求対象を返すため、重み・ID・目的変数を同じ戻り配列に残ると仮定しない。別配列はrowIdで整列する。categoryOrderの閉領域判定とvalueLabelsの表示機能は区別する。ordinal列の既存analysis_seriesをカテゴリMCAへ流用するとコードの同一性が変わるため、用途を分ける。

`client.downloadBlob`のstatic制約を回避するため、新分析のexportは通常APIのJSON文字列からFE Blobを構築する。`build_static.py`はROOT=parents[1]の後にfullstackを付けており、添付配置では二重fullstackとなる可能性がある。この記述を実在パスassertのリリースゲートとして扱い、ビルド成功済みとはしていない。

既存survey helperのsingleton/FPC経路は新回帰の安全な分散契約を無条件には満たさないため、共通model_covarianceを別途作る。既存helper全体がすべて誤りだという断定ではない。

新規6分析のroute/kernelは、このsnapshotの既存models/regression/logistic等の調査では確認できなかった。別ブランチ・未添付差分に存在しないと断定するものではない。取り込み時に同名route/機能が先行実装されていれば、新規二重登録ではなく本契約に統合する。

## 5. 実装者による基準版確認

同梱`source_manifest.json`は照合したファイルのSHA-256一覧。設計を適用する作業treeが異なる場合は差分を確認し、rename済みの接続先を対応表へ記録する。hash不一致だけでアルゴリズムを旧仕様へ戻さない。ユーザーの元ZIPやソース全文は成果物ZIPへ再同梱していない。


---

<a id="doc-23"></a>

出典ファイル：[references/FACTOR_EXTENSIONS_SOURCE_AUDIT.md](references/FACTOR_EXTENSIONS_SOURCE_AUDIT.md)

# Feature 033 EFA・033c CFA：既存構成・接続箇所の確認

確認日：2026-09-13。現ワークスペースの文書構成と接続先を静的に確認した。過去の添付ZIPに対する[source_audit.md](references/source_audit.md)のhashは更新せず、今回の確認とは区別する。

## 1. 文書配置と優先関係

既存analysis-specsはfeature/、tasks/、contracts/、fixtures/、validation/、references/、README、Markdown/HTML一括閲覧、SHA256SUMSからなる。033 EFAと033c CFAも同じ配置を使う。

|文書|033 EFA/033cでの扱い|
|---|---|
|33_exploratory_factor_analysis.md|現行033 EFAの機能仕様正本。連続MLと順序EFAの範囲を集約|
|DAVIS-FEAT-033-DESIGN.md|現行033 EFAの実装設計正本。ML目的・回転・連続得点、MINRES、PA、感度比較を自己完結して定義|
|33_maximum_likelihood_factor_analysis.md／33b_exploratory_factor_analysis.md／DAVIS-FEAT-033B-DESIGN.md|移動案内。現行契約として参照しない|
|00_common_analysis_contract.md / COMMON-DESIGN|scope、版、欠損分類、選択、保存、KeepAliveを継承|
|RESULT_CONTRACT.md|efa/cfa method、状態・結果・exportは拡張契約で追加|
|analysis_requests.py|既存型を変更せず新factor_extension_requests.pyが共通contextを再利用|
|VALIDATION_REPORT.md|2026-09-12の42件は旧設計の参照実績として保持。新統計実装の実績にしない|

033cのR/lavaanローカル境界と静的実行未対応は、共通設計の全分析local/static同一kernel方針に対する033c固有の追加設計。自動互換レイヤーや旧APIの並行運用は追加しない。

## 2. 現ソースで確認した接続先

|既存ファイル（リポジトリ基準）|確認対象|
|---|---|
|fullstack/backend/app/api/analysis_results.py|GET結果、select、predict、materialize、exportの既存route|
|fullstack/backend/app/main.py|API登録の接続先|
|fullstack/frontend/src/app/KeepAliveOutlet.tsx|ページ保持登録|
|fullstack/frontend/src/app/AppShell.tsx|ナビとKeepAlive表示|
|fullstack/frontend/src/main.tsx|ページroute登録|
|fullstack/backend/requirements.txt|SciPy宣言。新統計エンジンの利用可能性・Pyodide一致をこれだけで保証しない|
|fullstack/frontend/src/engine/pyodide.worker.ts|NumPy/SciPyのロード、直列実行、IDBFS。R実行環境の既存提供とはみなさない|
|fullstack/backend/app/domain/codebook_adapter.py|analysis_seriesの順序得点化とisReversed処理。新順序相関では変換順序と二重逆転に注意|

新EFA/CFAの予定ファイル名は詳細設計内に列挙する。現存する関連routeがあることと、追加契約に対応済みであることは別。API本体・FE・依存・run-productionの動作確認は今回の設計検証に含めない。

## 3. 変更範囲

成果物はfeature/analysis-specs以下の文書・設計入力契約・契約検証と、既存案内の更新。既存本体の変更、他分析の実装、開発タスクの進捗変更、ビルド・配布は行わない。新しい資料の整合性は[拡張検証報告](validation/FACTOR_EXTENSIONS_VALIDATION.md)で報告する。


---

<a id="doc-24"></a>

出典ファイル：[references/PRIMARY_SOURCES.md](references/PRIMARY_SOURCES.md)

# 一次資料・採用根拠

033 EFA／033c CFAの根拠は[拡張一次資料](references/FACTOR_EXTENSIONS_SOURCES.md)に追加する。新しい順序経路・推論の設計は各個別仕様を参照する。

確認日：2026-09-12。書誌情報と公開一次資料を参照し、引用は各URLにつき最小限に留めた。出力数式は本設計の定義と独立参照計算に基づく。閾値・API・機能範囲・エラーポリシーは製品として採用した規約であり、原典で唯一許容される方法だという主張ではない。

URLのmaster/stableは将来更新される。製品のoracle fixtureを更新する際は取得commit・実行パッケージ版・入力hashを併記し、Webの現在版を過去の検証版と取り違えない。原典全文・ライブラリコードは配布ZIPに含めない。

<a id="s-ca"></a>

## S-CA：通常CA：原著による実装・表示規約

参照先：`https://www.jstatsoft.org/article/view/v020i03`

原文の最小引用：`different scaling options for biplots`

確認・採用：CAとMCAが同じ名前の図ではなく、質量・寄与・表示スケーリングを区別する原著。本文のSVD式は定義から独立導出し、2×2解析解・転置不変性で検証した。

差異・範囲：supplementary点や3D等をすべて実装するという約束ではない。

<a id="s-mca"></a>

## S-MCA：FactoMineR MCA：指示行列方式と補正慣性

参照先：`https://raw.githubusercontent.com/cran/FactoMineR/master/R/MCA.R`

原文の最小引用：`method="Indicator"`

確認・採用：完全指示行列方式を比較対象にする。設問数に依存する補正慣性を確認。

差異・範囲：Burt法・自動ventilation・原典既定の欠損処理は採用しない。境界で全補正固有値0となる場合を明示した。

<a id="s-famd"></a>

## S-FAMD：FactoMineR FAMD：混合行列の正規化

参照先：`https://raw.githubusercontent.com/cran/FactoMineR/master/R/FAMD.R`

原文の最小引用：`QualiAct <- t(t(QualiAct)/sqrt(prop))`

確認・採用：数値の加重標準化、カテゴリ指示列のsqrt(p)正規化、カテゴリ重心・寄与の規約を比較した。

差異・範囲：暗黙の平均補完は採用しない。sqrt(p(1−p))標準化やMCAのsqrt(m)は混入させない。UIでは個体空間と相関円を区別する。

<a id="s-hc3"></a>

## S-HC3：Statsmodels HC3 標準誤差

参照先：`https://www.statsmodels.org/stable/generated/statsmodels.regression.linear_model.OLSResults.HC3_se.html`

原文の最小引用：`heteroskedasticity robust standard errors.`

確認・採用：非加重HC3の外部参照先。実行検証では別途インストール済みStatsmodels 0.14.6をoracleに用いた。

差異・範囲：公開stableドキュメントの版と検証環境の版は同一ではない。frequencyは非加重データを実際に複製したoracleとの一致を定義とした。

<a id="s-wls"></a>

## S-WLS：Statsmodels WLS：重みの意味

参照先：`https://www.statsmodels.org/stable/generated/statsmodels.regression.linear_model.WLS.html`

原文の最小引用：`The weights are presumed to be (proportional to) the inverse of the variance of the observations.`

確認・採用：WLSの精度重みと調査ウェイトが異なることを確認した。

差異・範囲：survey重みをWLSに渡しただけの標準誤差を流用しない。frequency/精度/surveyを混同しない。

<a id="s-survey"></a>

## S-SURVEY：R survey：PSU集約・領域推定・FPC

参照先：`https://raw.githubusercontent.com/cran/survey/master/R/survey.R`

原文の最小引用：`First collapse over PSUs`

確認・採用：PSU単位集約、領域外の0スコア、層内分散、FPC・singletonの処理経路を確認した。

差異・範囲：本版は一段Taylor設計に限定。singletonを無警告0扱いにせず、certaintyの根拠がない場合は推測不能。R survey全機能を再実装する設計ではない。

<a id="s-fa"></a>

## S-FA：R stats factanal：最尤因子分析

参照先：`https://www.stat.ethz.ch/R-manual/R-patched/library/stats/html/factanal.html`

原文の最小引用：`Perform maximum-likelihood factor analysis`

確認・採用：正規共通因子モデル、uniqueness最適化、下限0.005、回転・得点、境界解への注意を確認した。

差異・範囲：初期値5組・seed・失敗条件は本製品の確定設定。調査ウェイトの疑似最尤推定は本版では対象外。

<a id="s-fa-src"></a>

## S-FA-SRC：R factanal 実装：得点・適合度計算

参照先：`https://raw.githubusercontent.com/wch/r-source/trunk/src/library/stats/R/factanal.R`

原文の最小引用：`sc <- zz %*% solve(cv, Lambda)`

確認・採用：regression得点は標本相関を使う規約、回転後の因子相関、最尤適合度の補正を確認した。

差異・範囲：コードを逐語移植しない。標本相関と再現相関は別に保存し、得点の規約を変えない。

<a id="s-rot"></a>

## S-ROT：R stats：Varimax/Promax

参照先：`https://stat.ethz.ch/R-manual/R-devel/library/stats/html/varimax.html`

原文の最小引用：`Rotation Methods for Factor Analysis`

確認・採用：回転方式の比較先。無回転・直交・斜交の出力と因子相関の区別を設計した。

差異・範囲：Promaxの非加算的な負荷二乗和を、直交と同じ累積寄与率として表示しない。

<a id="s-clogit"></a>

## S-CLOGIT：Statsmodels ConditionalLogit

参照先：`https://www.statsmodels.org/stable/generated/statsmodels.discrete.conditional_models.ConditionalLogit.html`

原文の最小引用：`Do not include an intercept in this array.`

確認・採用：グループ化された0/1選択データの条件付き尤度と、共通切片を除く識別性を確認した。

差異・範囲：1選択/集合の場合を選択型oracleに使用。回答者クラスター補正・frequencyブロック複製・完全順位stage化・分離LPは本設計で別途定義・検証した。

<a id="s-svd"></a>

## S-SVD：SciPy exact SVD

参照先：`https://docs.scipy.org/doc/scipy/reference/generated/scipy.linalg.svd.html`

原文の最小引用：`The singular values, sorted in non-increasing order.`

確認・採用：薄型SVD、gesdd/gesvd、降順特異値を使う数値接続先。

差異・範囲：近似ランダムSVDへの暗黙fallbackは設けない。符号・縮退空間は不定であるため不変量を比較する。

<a id="s-lstsq"></a>

## S-LSTSQ：SciPy rank-aware least squares

参照先：`https://docs.scipy.org/doc/scipy/reference/generated/scipy.linalg.lstsq.html`

原文の最小引用：`Compute least-squares solution to the equation`

確認・採用：SVDベースの最小二乗とrank判定の実装接続先。

差異・範囲：rank欠損を最小ノルム解で黙って成功させず、モデル仕様の識別不能として返す。

## 参照できなかった経路と代替

一部のsurveyドキュメントとFAMD参照URLは通常取得・r.jina.ai経由の再試行でも利用できなかった。その本文を根拠にしたとは扱わず、上記の公式/CRANソースとR公式マニュアルを確認できた経路として採用した。R本体・FactoMineRの実行照合はこの成果物作成時には行っていない。


---

<a id="doc-25"></a>

出典ファイル：[references/FACTOR_EXTENSIONS_SOURCES.md](references/FACTOR_EXTENSIONS_SOURCES.md)

# Feature 033 EFA・033c CFA：一次資料と設計判断

確認日：2026-09-13。製品の初期値、対応範囲、API、停止条件は製品設計であり、原典が要求する普遍的な規則ではない。公開文書の確認はソフトの実行・数値検証を意味しない。

## 1. 確認した一次資料

|ID|資料|確認内容と対応|
|---|---|---|
|FX-POLY|[polycor::polychor](https://search.r-project.org/CRAN/refmans/polycor/html/polychor.html)|潜在二変量正規・閾値・two-step/MLの区別。033 EFAのtwo-stepを選定し、同条件のoracleにする|
|FX-FA|[psych::fa](https://search.r-project.org/CRAN/refmans/psych/html/fa.html)|MINRES/OLS/ULSの近縁性、目的関数差、斜交のpatternとstructure。方法名だけの一致を同値としない|
|FX-ULS|[factor_analyzer公開ソース](https://factor-analyzer.readthedocs.io/en/latest/_modules/factor_analyzer/factor_analyzer.html)|ULS profile目的の実装照合対象。パッケージの既定補完や回転後共通性を無検査で採用しない|
|FX-ML|[R stats::factanal](https://search.r-project.org/R/refmans/stats/html/factanal.html)|通常MLの正規性、独自性下限、回転と得点。033の連続経路を参照|
|FX-SMOOTH|[psych::cor.smooth](https://search.r-project.org/CRAN/refmans/psych/html/cor.smooth.html)|相関行列の非正定値と平滑化。033 EFA初期版は停止し原行列を変更しない|
|FX-PA|[psych::fa.parallel](https://personality-project.org/r/psych/help/fa.parallel.html)|観測・乱数比較と順序相関の利用。033 EFAは項目別置換・全相関固有値という製品規約を明示|
|FX-CAT|[lavaan categorical data](https://lavaan.ugent.be/tutorial/cat.html)|WLSMVのDWLS点推定と完全重み情報を用いる補正、順序経路のFIML制限|
|FX-EST|[lavaan estimators](https://lavaan.ugent.be/tutorial/est.html)|MLRのHuber–White SEと補正検定、normal/Wishartの違い。CFAはnormal規約|
|FX-CFA|[lavaan CFA example](https://lavaan.ugent.be/tutorial/cfa.html)|項目・因子を指定する測定モデルと結果読解。EFA回転から独立した機能|
|FX-SCALE|[lavaan model syntax 2](https://lavaan.ugent.be/tutorial/syntax2.html)|尺度設定と固定・自由パラメータ。初期CFAはmarker固定1の単純構造|
|FX-OPTIONS|[lavaan lavOptions](https://search.r-project.org/CRAN/refmans/lavaan/html/lavOptions.html)|parameterization、推論設定、sampling weightが別指定であること。解決済みオプションを保存|
|FX-FIT|[lavaan fitMeasures](https://search.r-project.org/CRAN/refmans/lavaan/html/fitMeasures.html)|通常/scaled/robustの区別、カテゴリカルのロバスト指標とPD条件。取得不能は理由付きnull|
|FX-SCORE|[lavaan lavPredict](https://search.r-project.org/CRAN/refmans/lavaan/html/lavPredict.html)|連続とカテゴリカルで異なる得点方式。順序EFA得点は初期版から分離|
|FX-CONTINUOUS|[Rhemtullaほか（2012）PubMed要旨](https://pubmed.ncbi.nlm.nih.gov/22799625/)|比較対象はロバスト連続MLとカテゴリカルLS。カテゴリ数・閾値等に依存する結果で、5件法の通常MLやN=1000の無条件保証ではない|
|FX-SIMULATION|[EFAtoolsシミュレーション文書](https://mdsteiner.github.io/EFAtools/articles/Simulation_and_power.html)|特定の潜在モデルによるカテゴリ化と相関減衰の例。数値例は全5件法に共通する減衰量ではない|
|FX-RETENTION|[Brandenburg（2024）因子数決定と相関種別](https://pmc.ncbi.nlm.nih.gov/articles/PMC11362475/)|NESTを中心とした条件別の利点・コスト。後続の負荷量推定や全PA手法へ無条件に一般化しない|
|FX-ORDINAL-PA|[Garridoほか（2013）PubMed要旨](https://pubmed.ncbi.nlm.nih.gov/23046000/)|先行研究にはPearson PAが同等以上の条件があるが、当該研究では大きな歪みへの弱さを示し順序PAを推奨。片方の記述だけで普遍順位を作らない|

## 2. 方法論上の採用判断

カテゴリ数やNだけの固定境界は設けない。7件法を自動連続扱いしない。順序を連続近似する場合は測定水準の変更ではなく分析上の近似として明示する。ポリコリックとピアソンは推定対象の異なるモデル化として説明する。

主要用途の同一国内一般調査・N=1000〜2000・5件法という利用条件に対して、良好な分布でのPearson＋ML/MINRESを主要選択肢とする。実際の差は同条件の感度比較で確認する。これは製品の利用条件と比較UXの設計であり、引用研究からN=1000を統計的境界として導いたものではない。感度分析の一致は同等性検定ではなく、両推定対象に共通する真のモデルの証明でもない。

最小二乗系を一つに絞って目的関数・境界制約・対角の扱い・初期値を固定する。MLを旧式の比較用だけと位置づけない。WLSMVとULSMVの普遍順位、小標本での収束保証、固定適合度カットオフによる確認済み判定は採用しない。

CFAのSE・検定・適合度は同じエンジンと同じfitに由来する値を採用する。WLSMVという指定名と実際の点推定がDWLSであることは矛盾ではない。点推定・推論の各層を保存し、単なるULSとMV補正を区別する。

## 3. 関連研究の位置づけ

カテゴリ数・分布・N依存の比較研究、ULS/DWLSの比較、推定法別適合度の研究は、普遍的な切替基準や保証を設けない背景として扱う。以下は追加精読・検証条件設定の参考文献であり、本成果物で全文精査・数値再現を実施したものではない。

- Rhemtullaほかの要旨はFX-CONTINUOUSとして確認した。全文・シミュレーションの再現は未実施。
- [順序モデルと連続モデルの仮定に関する議論](https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2020.589965/full)
- [Foreroほか：DWLSとULSのMonte Carlo比較](https://www.researchgate.net/publication/236623594_Factor_Analysis_with_Ordinal_Indicators_A_Monte_Carlo_Study_Comparing_DWLS_and_ULS_Estimation)
- [大きな順序因子モデルの推定条件](https://pmc.ncbi.nlm.nih.gov/articles/PMC6506988/)
- [Xia・Yang：順序データのRMSEA/CFI/TLIと推定法](https://link.springer.com/article/10.3758/s13428-018-1055-2)

公開文書の版は閲覧時に更新されうる。実装時のoracleは取得した版とソースhashを保存して固定し、本書の閲覧日だけをライブラリ版の固定とみなさない。


---

<a id="doc-26"></a>

出典ファイル：[fixtures/README.md](fixtures/README.md)

# 合成fixture

033 EFA／033c CFAの追加データとoracle条件は[拡張fixture仕様](fixtures/FACTOR_EXTENSIONS_FIXTURES.md)を参照する。追加数値fixtureは未生成であり、既存ML期待値を順序相関・ロバストCFAの検証実績として扱わない。

すべて個人を含まない人工データ。seed=20260912。数式の参照検証用であり、実際のアンケート結果やDAVIS-PCPのAPI応答ではない。

`ca_2x2.csv`は手計算可能な二元表。`mixed_survey.csv`はMCA/FAMD用。`linear_regression.csv`はfrequency展開比較用。`factor_exact_correlation.csv`は6変数2因子の既知相関を標本相関として厳密に持つデータ。`conjoint_choice_analytic.csv`はbrandだけの2択・3対1で係数=log(3)/2。価格列はなく、価格の推定やWTPを検査するデータではない。評点・順位テンプレートはそれぞれ別CSV。

`expected_values.json`の生成器はvalidation/generate_fixtures.py。将来の実装試験ではこのJSONを固定したoracleとして読み、実装値に合わせて自動上書きしない。生成時の環境はvalidation/VALIDATION_REPORT.mdに記録。


---

<a id="doc-27"></a>

出典ファイル：[fixtures/FACTOR_EXTENSIONS_FIXTURES.md](fixtures/FACTOR_EXTENSIONS_FIXTURES.md)

# Feature 033 EFA・033c CFA：合成fixture仕様

版1.0／2026-09-13。ここでは作成すべき数値検証データを定義する。新EFA/CFAのraw標本・R golden値はまだ生成していない。既存factor_exact_correlation.csvは連続ML用の補助であり、順序相関・CFAロバスト推論の証拠として代用しない。

## 1. 基本測定モデル

6項目、2因子。Λの所属負荷はq1=.8、q2=.7、q3=.6（因子1）、q4=.8、q5=.7、q6=.6（因子2）、交差負荷0。Φ=[[1,.3],[.3,1]]、ψj=1−λj²。Σ=ΛΦΛ′+diagψで対角1。非対角の既知例：Σ12=.56、Σ14=.192、Σ36=.108。この解析行列で再現相関と斜交共通性を確認する。

標本はη~N(0,Φ)、ε~N(0,diagψ)を独立に生成しx*=Λη+ε。生成seedとPRNG、元の連続標本を保存する。カテゴリ閾値の例は2値=[0]、5件法=[−1.2,−.4,.4,1.2]、7件法=[−1.5,−1,−.5,0,.5,1]。非対称条件は5件法=[−2,−1.5,−1,0]。主要fixtureはn=1000/2000の5件法・対称分布とし、n=100/300は小標本の補助条件にする。

CFAのmarker+1／theta残差1への尺度変更後のパラメータは元Λの値と直接比較しない。生成元のΣと標準化パラメータを理論比較し、非標準化は同じ制約のR goldenと比較する。

## 2. 不変性と失敗fixture

|ID|基本データからの変換|期待|
|---|---|---|
|ordinal_recode|カテゴリコードを順序維持で不等間隔に置換|ポリコリック不変、連続コードPearsonを代用品にしない|
|ordinal_reverse|q2のカテゴリ順序を反転|対応する相関の符号変換、共通性不変|
|item_permutation|q6,q2,q4,q1,q5,q3へ並べ替え|columnIdで復元して行列・PA一致|
|missing_classified|別行に無回答・非該当・閉領域外コード|主排他理由と詳細分類、fit行集合が一致|
|constant/unobserved|q3を定数化／中間カテゴリを全て未観測|明示停止、暗黙カテゴリ削除なし|
|sparse_pairs|周辺は全水準あり、二変量セルに0/少数|セル診断、境界・未収束なら停止|
|non_pd|対相関が同時整合しない対称行列をkernelへ注入|固有値と原因を保存、平滑化なし|
|nonconverged|solverの失敗を制御注入|結果へのfallbackなし、元attemptを保持|
|heywood|高相関・因子数過大条件または診断入力注入|負ψや境界を隠さない|
|pa_failed|指定反復に相関失敗を注入|成功反復のみで分位値を計算しない|
|cfa_baseline_failed|baseline推定失敗を注入|対応CFI/TLIだけnull、別指標の状態を保つ|

rowIdは合成固定ID。入力例のsurvey-demoとは実データを結びつけない。重複回答者判定用にsame/partial/disjointの集合と、系譜不明の別datasetを用意する。

## 3. 出力とoracle管理

実装時の保存予定はraw CSV、codebook JSON、model JSON、oracle CSV/JSON、R生成script、sessionInfo、入力/出力SHA256。full raw dataを小さく切った画面fixtureを数値goldenに混ぜない。製品adapterとは独立してRを実行し、期待値の捏造や手動の成功値埋込みをしない。

PAは置換indexまたはストリーム生成規約を保存して同一反復データを両実装へ供給する。RとNumPyに同じ整数seedを渡しただけでは同一乱数にならないため、同一seedの結果同士をそのまま一致試験にしない。

## 4. 感度分析の追加fixture

|ID|条件|検査|
|---|---|---|
|survey_5_balanced_1000/2000|5件法、対称、全カテゴリ観測、同じ母集団で別seed|Pearson主結果とPolychoric副結果、実際の差を保存。全seedで小差になることを期待値に捏造しない|
|survey_5_skewed|一部または全項目を非対称閾値へ変更|相関差・因子数候補・負荷量差、適切な警告|
|survey_5_heterogeneous|項目ごとに対称・非対称・端集中を混在|分布距離と問題項目、曖昧割当の可視化|
|ordinal_latent_nonnormal|潜在因子または誤差を非正規生成、構成を固定保存|Polychoricの潜在正規仮定が外れた条件。常にPolychoricが正解というテストにしない|
|alignment_permutation|同一Λ/Φに既知のHで順序・符号変換|整合後の差0、共通性と再現相関不変|
|alignment_ambiguous|近重複列・ゼロノルム因子・複数最適割当|曖昧状態、割当変更数を確定しない|
|sensitivity_known_delta|整合済み行列に既知の変化を与える|最大/中央値差、共通性のΦ寄与、目安=.10の前後と等号|
|different_retention|PA候補が3/4となる制御入力|因子数差。異qモデルの係数比較null、固定q比較は別表示|
|secondary_failure|Polychoric推定または一方のPAを失敗注入|主結果保持、比較不能、失敗を一致0としない|

自動要約のテストでは数値比較用の制御行列と、統計推定を通すraw標本を分ける。例示値0.026等を計算結果の期待値として流用しない。所定の主結果選択と比較条件を保存し、任意の符号・因子順に結論が依存しないことを確認する。


---

<a id="doc-28"></a>

出典ファイル：[validation/VALIDATION_REPORT.md](validation/VALIDATION_REPORT.md)

# 設計参照計算・契約の検証報告

実行日：2026-09-12。対象は同梱の独立参照計算とPydantic入力契約。DAVIS-PCP本体へ新分析を実装した結果ではない。

## 1. 実績

`test_reference_design.py`を実行し、42ケースが成功した。ログは`pytest_output.txt`、機械可読結果は`pytest_results.xml`。入力例12件はPydanticで検証し、JSON Schema12件を生成した。数値・割合の有限性、構文エラーの拒否例も含む。

```
42 passed in 1.13s
```

上記時間は実行ログに記録された実績であり、実装作業や本体性能の見積ではない。

## 2. 実行環境

Python 3.13.5。NumPy 2.3.5、SciPy 1.17.0、Statsmodels 0.14.6、Pydantic 2.13.4、pytest 9.0.2。詳細はenvironment.json。

この環境は添付requirementsやPyodide版と同一ではない。Statsmodelsは数値oracle用途だけで、製品に新規導入する依存ではない。

## 3. 実行した比較

CAの2×2解析解、表倍率・転置・零周辺、MCAの指示行列CA同値・全慣性・射影・度数複製・Benzécri、FAMDの標準化・全慣性・カテゴリ重心・寄与・η²、回帰のStatsmodels classical/HC3・frequency展開、surveyの手計算PSU/FPC/領域0スコアを検証した。

ML因子分析は合成相関の再構成、profile勾配の有限差分、Varimax/Promaxによる共分散不変性と得点変換を確認した。選択型は解析解とStatsmodels ConditionalLogit、回答者反復、frequencyブロック展開、分離LP、順位stageの積を確認した。

reference_kernels.pyは、純粋な整った配列を受ける数学参照実装である。元アプリのコードブック、欠損分類、API例外、結果保存、UI、網羅的な業務入力検証を含まない。例として参照CAは独立表にrank0を返すが、本体サービスはCA_ZERO_INERTIAとして422に整形する設計である。参照choiceの最適化手順も製品設計の全サービスフローを置換しない。

## 4. 未実施

DAVIS-PCP新規API/結果store/FE/PCPの統合試験、既存suite全件実行、local/staticのE2E、Pyodide内HiGHSスモーク、R FactoMineR/factanal/surveyの実行照合は未実施。本体への実装はこの依頼の成果物ではない。Rscriptは作業環境で利用できなかった。

42ケースは代表的な数式・契約の検証であって全受入IDを消化した件数ではない。未実施項目はtasks/ACCEPTANCE_AND_HANDOFF.mdに具体的な実装試験として引き継いだ。

## 5. 再実行

リポジトリルートから `cd feature/analysis-specs` で本書群のルートへ移動して実行する。インターネットのある環境では任意の独立venvへrequirements-reference.txtを導入できる。実行時そのものはネットワーク不要。

```bash
python -m pip install -r validation/requirements-reference.txt
python contracts/analysis_requests.py
cd validation
python generate_fixtures.py
python -m pytest -q test_reference_design.py --junitxml=pytest_results.xml
```

fixtureは合成データ。ユーザーのアンケート回答は含めていない。generate_fixtures.pyは期待値を再生成するため、意図しないoracle更新を避ける場合は実行せず既存fixturesでpytestだけを動かす。


---

<a id="doc-29"></a>

出典ファイル：[validation/FACTOR_EXTENSIONS_VALIDATION.md](validation/FACTOR_EXTENSIONS_VALIDATION.md)

# Feature 033 EFA・033c CFA：設計成果物の検証報告

対象日：2026-09-13。対象は設計文書、入力契約、Schema、入力例、文書間参照。EFA/CFAの本体数値エンジンの検証ではない。

既存のartifact_qa.json、environment.json、pytest_output.txt、pytest_results.xmlは2026-09-12の参照検証記録として保持する。追加033 EFA/033c CFAの現在の検証範囲は本報告を参照する。

## 1. 検証対象

機能仕様2件、詳細設計2件、拡張契約、受入計画、fixture仕様、一次資料、ソース接続記録。実行可能入力契約は既存AnalysisContextV2を参照する独立した設計モジュールとする。文書は既存033との優先関係・初期対応・未対応・エンジン受入条件を照合する。

## 2. 実行記録

バンドルPython 3.12.14、Pydantic 2.13.5、標準ライブラリunittestで新規入力契約テスト34件が成功した（0.036秒）。複数の入力条件はsubTestで検証し、件数はunittestが報告するテストメソッド数で記録する。旧VALIDATION_REPORT.mdの42件とは合算しない。

検証内容はEFA/CFA入力例2件、生成Schema2件とPython型の一致、順序カテゴリの維持、連続近似時のCFA推定器選択、ordinal treatment混在拒否、因子割当・重複・marker・EFA自由度・欠損方針・ウェイト設定・未知キーの拒否。記録は[factor_extensions_contract_output.txt](validation/factor_extensions_contract_output.txt)。JSON Schemaだけではmodel_validatorの意味制約を表せないため、Pythonでの再検証が必要である。

感度分析の追加検証は、明示近似確認、既定off、元ordinal制約、PA必須、主ML保持と比較MINRES固定、整合方式固定、目安の範囲・有限性、CFAへの比較入力拒否を含む。感度比較kernel、因子整合・差分値・自動要約の数値試験は実装受入として残る。

リポジトリルートからの実行コマンド（PythonはPydantic v2が利用可能な環境を指定する）：

```text
python -m unittest discover -s feature/analysis-specs/validation -p test_factor_extension_contracts.py -v
```

文書は機能仕様・詳細設計・契約・受入計画の初期対応範囲を相互照合し、通常／scaled／robustの区別、順序得点・ウェイト・欠損の未対応条件を確認した。分割Markdown31文書のローカルリンク140件について、ファイル参照先の欠落0件を確認した（外部サイトの継続稼働や全Markdown見出しfragmentの検証を意味しない）。一括閲覧は分割ファイルから再生成する。

一括Markdown/HTMLは固定31文書から生成した。HTMLには一意のIDが43件あり、ローカルリンク202件のファイル存在と同一HTML内fragmentを検査し、欠落0件。外部文書への見出しfragmentは検査対象外。生成時の機械記録はfactor_extensions_artifact_qa.json。Markdown描画には既存Node.jsとmarked 17.0.5を使用し、アプリのビルドは行っていない。

## 3. 未実施

- polycor/psych/factanalの新EFA数値oracle、R lavaanのCFAパラメータ・SE・適合度golden照合。
- 新しい順序標本fixtureの生成、統計シミュレーション、数値エンジン・依存の製品受入。
- 新API・結果保存・PCP・KeepAlive・local/static統合、run-production.batでの実機確認。
- 本体の全体テスト、アプリケーションビルド、配布物検証。

これらは設計作成の欠落実績を成功で埋める対象ではなく、[実装受入条件](tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)として明示的に残す。設計上の採用エンジンを「検証済みエンジン」と表示できるのは当該受入通過後。

## 4. 再検証

契約の対象テストはvalidation/test_factor_extension_contracts.py。既存の本体suiteではなく設計入力の検証である。実行環境と結果件数は第2節で記録する。文書を変更した場合は分割ファイルを正本として、一括Markdown/HTMLおよびSHA256SUMSを更新する。

一括版の再生成はリポジトリルートから次を実行する。Node.jsとmarkedの別の配置を使用する場合は`--node`と`--marked`でそれぞれ実行ファイルとmarked.esm.jsのパスを指定する。生成対象は固定文書一覧であり、並行作業の別フォルダを取り込まない。

```text
python feature/analysis-specs/validation/publish_specifications.py
```

## 5. 033／033b集約の文書検証

2026-09-13に、旧033の連続ML資料と033b EFA資料を現行Feature 033 EFAへ集約した。ここでの記録は文書構造・生成物の検証であり、EFA/CFAの数値エンジン受入ではない。旧VALIDATION_REPORT.mdの42件を含む既存の歴史的検証記録は変更していない。

バンドルPythonでpublish_specifications.pyを実行し、現行の一括閲覧対象29文書、HTML ID 41件、ローカルリンク205件、欠落0件を確認した。旧033、033b、033B設計は移動案内として残し、一括閲覧の正本文書集合から除外した。新033仕様・新033設計、033cからの033参照、EFARequest／efa.schema.json／入力例への入口、EFA-B01〜EFA-B22の所属を確認した。

SHA256SUMSは現行86エントリを再計算し、全エントリの再照合で不一致0件を確認した。033cから新033への第2節・第6節参照、拡張契約から新033設計第7節への参照は、対象見出しと一致することを確認した。
