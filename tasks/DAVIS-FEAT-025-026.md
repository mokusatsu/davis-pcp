# Feature 25 / 26 実装仕様・引き継ぎ

状態: 未実装（仕様の詳細化と受入条件の定義まで）

対象仕様:

- [Feature 25: データ来歴・補完マスクと再現パッケージ](../feature/25_data_provenance.md)
- [Feature 26: 2変量クロス集計表と調整済み残差ビュー](../feature/26_crosstab_view.md)

この文書は、別のエージェントが実装を開始できるように、現在の実装との差分、実装単位、API契約、ページ間連携、テスト、証跡、完了判定を固定する。元仕様のモックや例にある名前をそのまま実装するのではなく、現在のリポジトリに存在するルート、ストア、コードブック、Selection、KeepAliveを正本とする。

## 0. 引き継ぎ時点の確認

### 0.1 現在確認できる実装

- fullstack/backend/app/storage/dataset_store.py はデータ、メタデータ、コードブックを別ファイルへ保存し、dataRevision と valuesFingerprint を更新する。原データのスナップショット、操作履歴、補完マスクはまだ永続化していない。
- fullstack/backend/app/api/datasets.py には変換、削除、補完、計算のデータ変更ルートがある。これらのルートは dataset_store.save() を呼ぶが、来歴操作とマスクを記録していない。
- fullstack/frontend/src/app/store.ts の履歴はSelectionのUndo/Redoであり、データ変更の来歴ではない。この2種類の履歴を同じ配列へ混ぜてはならない。
- fullstack/frontend/src/app/AppShell.tsx がナビゲーション、データロード、セッション保存を担当する。セッションにはSelectionやグループが保存されるが、Feature 25の来歴、マスク、PCP設定はまだ含まれていない。
- fullstack/frontend/src/features/table/TablePage.tsx はコードブックの表示名、カテゴリ順、__rowId__、All/Selectedスコープを扱う。補完マスク表示は未実装である。
- fullstack/frontend/src/features/pcp/useDatasetColumns.ts と fullstack/frontend/src/engine/pcpRenderer.ts は、リビジョンをキーにした列データと線描画を担当する。マスクは別APIから疎行列で取得し、列データキャッシュへ巨大なマトリクスを直接入れない。
- fullstack/backend/app/api/summaries.py には通常のSummaryとLine Mosaicがあるが、/summaries/crosstab は存在しない。
- fullstack/backend/app/algorithms/summaries/ にCrosstabアルゴリズムはない。subgroup.py にはカイ二乗と調整済み残差の既存実装があるため、Feature 26では式を再実装して差分を作らず、共通ヘルパーへ抽出して再利用する。
- fullstack/frontend/src/features/crosstab/、Crosstabルート、専用ナビゲーションはまだない。実際のナビゲーションは AppShell.tsx の VIS_NAV_ITEMS / ANALYSIS_NAV_ITEMS、KeepAliveルートは KeepAliveOutlet.tsx が正本である。
- fullstack/frontend/src/app/store.ts の selectionApplied({rowIds, operation: add|replace|subtract|toggle, label}) がページ間Selectionの正規入口である。Crosstabから別のSelection状態を直接書き換えてはならない。

### 0.2 守る境界

- 作業ツリーの既存変更をreset、clean、checkout、無関係な削除で失わない。Feature 19〜24の変更と未コミットファイルを保持する。
- datasetId、__rowId__、dataRevision、schemaRevision、scopeHash、Selection、active row、hidden row、グループ、KeepAliveを変更したときは、必ず変更前後のページを実操作で確認する。
- データ変更の来歴とSelectionの操作履歴を別管理する。Selectionだけの操作で dataRevision を増やさない。
- 既存のAnt DesignのCard、Alert、Tag、Table、Segmented、Modal、FocusTarget、余白、配色、キーボード操作を踏襲する。新しい独自ナビゲーションや別デザインシステムを追加しない。
- 既存APIを削除または別名へ置換しない。新しい共通コンテキストが未移行の経路を黙って成功させる場合は、未移行であることをメタデータまたは明示エラーで判別できるようにする。
- NaN、Infinity、秘密情報、絶対パスをAPI、セッション、再現パッケージへ出さない。
- 実装完了後に対象範囲のテストと実ブラウザ確認を行う。文書作成段階ではコードテスト、全体ビルド、巨大な全体テストは行わない。

## 1. 共通データ契約

Feature 25とFeature 26は同じコンテキスト契約を使用する。別ページで似たフィールドを定義してはならない。

### 1.1 Revision

| 項目 | 定義 | 変更契約 |
|---|---|---|
| dataRevision | 現在の値、行集合、派生列を表す版。既存APIが使用する型を維持する | transform、impute、calculate、delete、revert、importのデータ変更で増える |
| schemaRevision | コードブック、列名、カテゴリ順、尺度、欠損定義を表す版 | codebook更新、列追加、列削除、列名変更で増える |
| operationId | 来歴の不変な操作識別子 | 各データ変更へ一意に発行し、再利用しない |
| scopeHash | 実際に分析へ投入したrowId集合をソートしてSHA-256化した値 | 表示順、ページング、Selectionの内部順序に依存しない |

元仕様の rev-0、sch-2 は説明用の文字列であり、既存APIの数値型を無理に文字列へ変更しない。リクエストの期待値とレスポンスの値は、現行APIの型を保ちつつ、ハッシュ計算時だけ正規化する。

### 1.2 AnalysisContext

分析系のリクエストは次のフィールドを共通モデルへ正規化する。JSONのsnake_case/camelCaseは既存APIの規約に合わせ、内部モデルは一つにする。

    {
      "datasetId": "dataset-uuid",
      "expectedDataRevision": 12,
      "expectedSchemaRevision": 4,
      "scope": "selected",
      "rowIds": ["r-001", "r-002"],
      "weightColumn": "survey_weight",
      "missingPolicy": "exclude",
      "imputationPolicy": "use_current_values",
      "candidateSetHash": null
    }

必須判定:

- datasetId、期待リビジョン、scope、missingPolicyは、移行済み分析ルートでは必須とする。
- scope=explicitのときだけ rowIds を必須とし、重複を除去した後の順序を正規化する。
- scope=all|active|selected|sampled のrowIdsはサーバー側の現在のSelection/active/sampled集合から解決し、クライアントの古い集合をそのまま信用しない。
- weightColumn は調査ウェイト列だけを指定する。サンプリング抽出の内部ウェイトを調査ウェイトとして流用しない。
- リクエスト開始時点で期待リビジョンと現在値が一致しない場合は、計算を開始せず ANALYSIS_INPUT_STALE（HTTP 409）を返す。
- rowIdが存在しない、異なるデータセットのIDが混ざる、同一列を行列変数に指定するなどの入力はHTTP 422の固有コードで返す。

### 1.3 ResultMeta

移行済み分析レスポンスのトップレベルに次を含める。

    {
      "meta": {
        "datasetId": "dataset-uuid",
        "dataRevision": 12,
        "schemaRevision": 4,
        "scope": "selected",
        "scopeHash": "sha256:...",
        "scopeCount": 240,
        "effectiveN": 228,
        "missingCount": 12,
        "weightApplied": false,
        "weightColumn": null,
        "imputationMaskRevision": 3,
        "algorithmVersion": "crosstab-1",
        "isExplorative": true,
        "warnings": []
      }
    }

effectiveNは実際に計算へ入った行数、missingCountはmissingPolicyで除外された行数とする。scopeCountと重み付きの総量を同じ欄へ入れない。未定義の値は0ではなくnullで返す。

### 1.4 API移行の進め方

1. fullstack/backend/app/domain/context.py にPydanticの共通モデルと、scope解決、scopeHash、revision検証のヘルパーを作る。
2. FastAPIの分析ルートを列挙し、ルート名、入力モデル、AnalysisContextの有無、ResultMetaの有無を一覧化する。列挙漏れを完了扱いにしない。
3. Feature 26のCrosstabを最初から共通モデルで実装する。
4. Feature 25の受入対象として、既存のsummary、mining、relationship、robustness、PCA等の全分析ルートを順に移行する。未対応ルートが残る場合は、タスク一覧へ分割して未完了にする。
5. 静的/Pyodide経路が同じ分析を提供する場合も、同じJSON契約を使う。未対応なら無言で別計算をせず、ANALYSIS_CONTEXT_UNSUPPORTEDを表示する。

<a id="feature-25-実装仕様"></a>

## 2. Feature 25 実装仕様

### 2.1 完成形と対象外

完成形は、データ変更を行った時点の入力、出力リビジョン、対象行・セル、パラメータ、時刻、アルゴリズム版、マスクを復元できる状態である。原データは現在値と別に保持し、Revertは履歴を削除しない。

今回の対象:

- データ変更操作の来歴とリビジョンの分離
- 原データへの復帰、任意履歴への復帰、データ来歴のUndo/Redo
- 補完マスクの永続化、Table/PCP表示、行フィルタ
- AnalysisContext/ResultMetaの共通化
- 再現パッケージのエクスポート、検証付きインポート
- 既存セッション、Selection、KeepAliveとの整合

今回の対象外:

- 共同編集、ユーザー権限、クラウドストレージ
- 操作履歴を無制限に圧縮する仕組み
- GUIの独自デザインシステム
- 原データ自体を上書きする機能

### 2.2 来歴の永続モデル

#### 2.2.1 追加ファイル

DatasetStoreの既存ファイルを壊さず、dataset IDごとに次のサイドカーを追加する。実際のディレクトリ配置は既存Storeの命名規約に合わせるが、論理名は固定する。

- provenance.json: 文書メタデータ、操作配列、現在のカーソル
- raw.parquet またはraw CSV相当: 初回import直後の値と __rowId__
- revisions/<dataRevision>.parquet: 任意履歴へ戻すための値スナップショット
- imputation-mask.json: 疎なセル単位のマスク

rawスナップショットはdatasetの最初の値を保存し、その後のtransformやimputeで変更しない。スナップショットを作成できないimportは、データ作成を成功扱いにしない。

#### 2.2.2 ProvenanceStep

各要素は次の意味を持つ。

    {
      "operationId": "op-uuid",
      "parentOperationId": "op-parent-or-null",
      "operation": "import|transform|impute|calculate|delete_column|schema_update|view_filter|materialize_filter|revert|undo|redo",
      "params": {},
      "targetRowIds": ["r-001"],
      "targetCells": [{"rowId": "r-001", "columnId": "bmi"}],
      "inputDataRevision": 11,
      "outputDataRevision": 12,
      "inputSchemaRevision": 4,
      "outputSchemaRevision": 4,
      "algorithmVersion": "impute-mean-1",
      "timestamp": "2026-09-10T00:00:00Z",
      "createdBy": "local-session"
    }

paramsは再現に必要な値だけをJSON化し、絶対パス、トークン、巨大なDataFrame、個人情報を入れない。対象全件を記録する場合も、rowIdの順序は正規化する。

操作配列はappend-onlyとし、Undo、Redo、Revertで過去要素を削除または書き換えない。現在位置は currentOperationId として別に持つ。枝分かれが生じた場合も、親操作への参照で表す。画面上の行フィルタやSelectionの変更は view_filter として条件とscopeHashを記録できるが、dataRevisionを増やさない。フィルタ結果を新しいdatasetとして物理化する操作だけを materialize_filter とし、値のスナップショットと新しいdataRevisionを作る。

#### 2.2.3 Undo/Redo/Revert

- Undoは親スナップショットを復元し、新しい operation=undo を追加する。元の操作は履歴に残る。
- Redoは現在カーソルから一意に選べる子操作だけを再適用し、新しい operation=redo を追加する。子が複数ある場合は REDO_AMBIGUOUS（HTTP 409）とする。
- Revertは指定した targetDataRevision または targetOperationId のスナップショットを復元し、新しい operation=revert を追加する。rawへ戻る場合は targetDataRevision=rawDataRevision とする。
- 復元後も現在の dataRevision は新しい値になる。古いrevisionへ同じ番号で戻さない。
- Revertでコードブックだけを戻すことはできない。schemaRevisionを変える操作はschema用エンドポイントで明示する。
- Undo/Redo/Revertには expectedDataRevision と expectedSchemaRevision を受け、競合時は変更せず409を返す。

#### 2.2.4 原子性と障害時の扱い

1. dataset lockを取得する。
2. 期待revisionを検証する。
3. 新しい値、マスク、provenance、metaを一時ファイルへ書く。
4. 全ファイルのchecksumを検証する。
5. renameで同時に切り替える。
6. 途中で失敗したら、現行値と来歴の組を変更せず、PROVENANCE_COMMIT_FAILEDを返す。

データだけが進み、来歴だけが失われる状態を成功扱いにしてはならない。操作を再送したときは同じidempotency keyで二重の操作を作らない。

### 2.3 補完マスク

#### 2.3.1 マスク要素

マスクは密な二次元配列ではなく、補完されたセルだけの疎な要素で保存する。

    {
      "rowId": "r-002",
      "columnId": "bmi",
      "methodId": "mean",
      "methodLabel": "平均値補完",
      "originalMissingReason": "user_missing",
      "createdByOperationId": "op-uuid",
      "inputDataRevision": 11,
      "maskRevision": 3
    }

値そのものはraw snapshotで復元する。マスク要素へraw値や秘密情報を複製しない。

#### 2.3.2 操作別のマスク規則

- in-place imputeは、元値が欠損で実際に値を設定したセルだけを追加する。元から値があるセル、処理対象外セルは追加しない。
- 列追加を伴うcalculateは、新しい列を自動的に補完済みとしない。入力列のマスクを結果列へ伝播する場合は、propagatedFromと式を明示する別仕様を追加してから実装する。
- transformで列名が変わる場合はcolumnIdを不変IDとして保持し、表示名だけを追随させる。列削除では該当マスクを削除し、来歴に削除数を記録する。
- 新しいdatasetを作るimputeは、元datasetのraw参照とコピーしたマスクを新datasetの来歴へ記録する。元datasetのマスクは変更しない。
- rawへrevertすると現在値のマスクは空になる。過去のマスクは履歴とraw snapshotから取得可能な状態を維持する。

#### 2.3.3 マスクAPI

GET /api/v1/datasets/{datasetId}/imputation-mask

クエリ:

- rowIds: 任意。指定時はそのrowIdだけ返す。
- columnIds: 任意。指定時はその列だけ返す。
- expectedDataRevision: 必須。現在値と不一致なら409。

レスポンス:

    {
      "datasetId": "dataset-uuid",
      "dataRevision": 12,
      "maskRevision": 3,
      "entries": [
        {
          "rowId": "r-002",
          "columnId": "bmi",
          "methodId": "mean",
          "methodLabel": "平均値補完",
          "createdByOperationId": "op-uuid"
        }
      ],
      "scopeHash": "sha256:..."
    }

entriesは指定scopeに存在するものだけを返し、全件をReduxへ保存しない。クライアントキャッシュのキーはdatasetId、dataRevision、columnIds、scopeHashとする。

### 2.4 データセットAPI

#### 2.4.1 Revert

POST /api/v1/datasets/{datasetId}/revert

リクエスト:

    {
      "targetOperationId": "op-raw-or-null",
      "targetDataRevision": null,
      "expectedDataRevision": 12,
      "expectedSchemaRevision": 4
    }

targetOperationIdとtargetDataRevisionのどちらか一つを指定する。未指定のraw復帰は許可しない。レスポンスには新しいcurrentDataRevision、currentOperationId、maskRevision、schemaRevision、ResultMeta相当の警告を返す。

#### 2.4.2 再現パッケージのエクスポート

GET /api/v1/datasets/{datasetId}/export_package

Content-Typeはapplication/zipとする。ZIPの構成:

- manifest.json: packageVersion、datasetId、作成時のrevision、ファイル一覧、sha256
- data/raw.csv: raw値と __rowId__
- data/current.parquet: エクスポート時点の現在値
- metadata/codebook.json
- metadata/provenance.json
- metadata/imputation-mask.json
- metadata/session-state.json

manifestにはアプリの秘密、アクセストークン、絶対パスを入れない。current.parquetを再現できない場合はexportを成功扱いにしない。

#### 2.4.3 再現パッケージのインポート

POST /api/v1/datasets/import_package

- multipart/form-dataのZIPを受け取る。
- manifest、ファイル名、sha256、JSON schema、 __rowId__ の一意性、codebookとデータ列の整合を検証する。
- インポート成功時は新しいdatasetIdを発行し、既存datasetを上書きしない。
- packageのdatasetIdと現行datasetIdが同じでも、新規IDを発行する。
- checksum不一致、未知のpackageVersion、欠損ファイル、列不整合はHTTP 422の固有エラーとする。
- インポート後に現在値、raw、来歴、マスク、session-stateが一致することを検証し、失敗時は部分datasetを残さない。

### 2.5 AnalysisContext/ResultMetaの実装

- fullstack/backend/app/domain/context.py を新設し、Pydanticモデル、revision検証、scope解決、scopeHash生成を置く。
- 各分析APIは個別に似た scope、weightColumn、missingPolicyを増やさず、共通モデルまたはアダプターを使用する。
- isExplorativeは分析モードから算出し、クライアントの表示値を信頼しない。
- algorithmVersionは式、ライブラリ、主要パラメータが変わるたびに更新する。単なるビルド番号にしない。
- effectiveN、missingCount、weightApplied、imputationMaskRevisionを返し、画面の注記とエクスポートへそのまま利用できるようにする。
- stale応答はフロントで破棄する。遅れて返ったold revisionの結果でPCP、Table、Selection、Crosstabを上書きしない。

### 2.6 フロントエンド実装

#### 2.6.1 ストア

fullstack/frontend/src/app/store.ts へ次の状態を追加する。既存のSelection historyと分離する。

- provenance.currentDataRevision
- provenance.currentSchemaRevision
- provenance.currentOperationId
- provenance.steps
- provenance.rawDataRevision
- provenance.maskRevision
- provenance.maskFilter（all、hasImputed、noImputed）

stepsはパネル表示に必要な要約だけを保持し、mask entriesはAPIキャッシュへ置く。dataset切替、import、revertでは古いmask cacheを破棄する。

#### 2.6.2 ProvenanceHistoryPanel

配置はOverviewPageまたは既存Dataset Card内とし、独立した新デザインを作らない。必須操作:

- Revert to Raw
- 任意stepへのRevert
- Undo/Redo
- Export Reproduction Package
- Import Reproduction Package

操作中は対象revisionとdatasetIdを固定して二重送信を防ぐ。成功後はdataset再取得、Arrow view再取得、codebook再取得、mask再取得を一つの更新として行う。Selectionが存在しないrowIdを含む場合は既存のSelectionクリーニング規則に従う。

#### 2.6.3 Table

- 補完セルには背景色だけでなく、methodLabelまたは補完アイコンとaria-labelを表示する。
- テーブル上部にAll / Has Imputed / No Imputedを配置する。初期状態はAll。
- フィルタは既定では表示scopeだけを変更し、中央Selectionを変更しない。利用者がSelectionへ適用を明示した場合だけ selectionApplied を通る。
- rowId、active、selected、hiddenは既存Tableの契約を保つ。フィルタ切替でselected rowを勝手に削除しない。

#### 2.6.4 PCP

PcpRenderSpecへ疎なマスク参照を追加する。

- imputedCells: Record<rowId, Set<columnId>>相当をrenderer入力へ渡す。
- 補完点は常にマーカーを描く。色だけで区別せず、形状または線種と凡例を併用する。
- 補完点に接する線分だけを点線で描く。補完されていない遠い線分まで点線にしない。
- 選択線は既存の選択色と前面描画を維持し、補完マーカーは選択状態を隠さない。
- 軸順変更、MA子列射影、dataRevision変更時にマスクのcolumnIdを再解決する。
- 大規模データではマスクが存在するrowだけを追加描画し、通常線の描画コストを増やさない。
- 凡例とキーボードで到達可能な説明を表示する。

### 2.7 Feature 25受入条件

| ID | 完了条件 | 必須証跡 |
|---|---|---|
| 25-AC01 | dataRevisionとschemaRevisionが別々に増減し、codebook更新で値revisionが不必要に変わらない | Store/API pytest |
| 25-AC02 | import、transform、impute、calculate、delete、schema更新の全データ変更が不変operationとして記録され、画面フィルタはview_filterとしてdataRevisionを増やさず記録できる | provenance JSON fixture |
| 25-AC03 | operationに入力/出力revision、親、params、対象row/cell、時刻、algorithmVersion、fingerprintがある | schema検証 |
| 25-AC04 | Undo、Redo、任意Revert、Revert to Rawが履歴削除なしで動作し、Redo分岐は409になる | backend integration |
| 25-AC05 | stale expected revision、並行更新、途中書込み失敗で値だけまたは来歴だけが更新されない | lock/409/障害fixture |
| 25-AC06 | raw snapshotが初回値とrowIdを保持し、現在値の補完や変換で変わらない | raw roundtrip |
| 25-AC07 | 補完されたセルだけにmethodId、methodLabel、元欠損理由、operationIdが永続化される | imputation mask pytest |
| 25-AC08 | rename、delete、transform、new dataset、revertでマスク規則が仕様通りになり、元datasetを壊さない | API regression |
| 25-AC09 | mask APIがrevision、scopeHash、疎なentriesを返し、無関係なセルを返さない | API contract |
| 25-AC10 | TableのAll/Has Imputed/No Imputed、補完アイコン、methodLabel、aria-labelが既存Selectionを壊さず動作する | Vitest + browser |
| 25-AC11 | PCPの補完点・隣接点線・凡例が表示され、選択線、軸順、MA射影、KeepAliveを保持する | renderer test + browser |
| 25-AC12 | 移行済み全分析ルートがAnalysisContextを受け、ResultMetaへrevision、scopeHash、effectiveN、missingCount、algorithmVersion、isExplorativeを返す | endpoint inventory + API tests |
| 25-AC13 | stale結果、古いdataset、古いscopeの非同期応答が画面状態を上書きしない | delayed response test |
| 25-AC14 | ZIPにraw/current/codebook/provenance/mask/session/manifest/checksumが入り、秘密情報と絶対パスがない | package inspection |
| 25-AC15 | package importがchecksumとschemaを検証し、新datasetIdで現在値、raw、履歴、マスク、Sessionを復元する | roundtrip integration |
| 25-AC16 | local、static/Pyodideが同じ契約を使用し、未対応経路は明示エラーになる | local/static report |
| 25-AC17 | Overview、Table、PCP、分析ページ、dataset切替、Save/Load、KeepAliveを実操作し、Selectionとscopeが保持される | E2E操作ログ |
| 25-AC18 | 対象pytest、Vitest、TypeScriptチェック、run-production.bat確認と成果物hashが記録される | .temp/feature25-26/ evidence |

### 2.8 Feature 25検証シナリオ

1. datasetを読み込み、raw revisionと初期Selectionを記録する。
2. Tableで欠損を確認し、平均値補完を実行する。
3. Provenance panelにimpute stepと対象セルが現れ、TableとPCPで同じセルが補完表示になることを確認する。
4. Has Imputedを表示し、Selectionへ適用しない限り中央Selectionが変わらないことを確認する。
5. transform、calculate、codebook変更、undo、redo、revert rawを順に実行し、revisionと履歴を比較する。
6. Save session、Export package、Import packageを行い、新datasetでrowId、codebook順、mask、Selection、PCP軸を確認する。
7. TableからCrosstabへ移動し、scopeが一致することを確認する。

<a id="feature-26-実装仕様"></a>

## 3. Feature 26 実装仕様

### 3.1 完成形と対象外

完成形は、コードブックに従う2つのカテゴリ変数から、実数、行%、列%、全体%、期待度数、ASR、独立性検定、効果量、行IDを同じscopeで計算し、セルクリックでPCP/Tableの中央Selectionへ接続できるページである。

対象:

- categorical codebook順、value label、missing policy
- count、row%、col%、total%の表示切替
- ASR、χ²、df、p値、Cramér's V、期待度数警告
- survey weight、非加重n、weight欠損、zero/no-positiveの明示
- All/Active/Selected/Sampled/Explicit scopeとrevision stale検証
- セルクリックのAdd/Replace/ToggleとPCP連携
- CSV/Excel export

対象外:

- 3変量以上の高次クロス集計
- 数値列を自動的に恣意的な区間へ分割する処理
- 重み付き検定を母集団の厳密な設計効果として扱うこと
- Crosstab独自のSelection store、独自のPCP実装、独自ナビゲーション

### 3.2 入力変数とコードブック

- 行変数、列変数はnominal、ordinal、binaryのいずれかに限定する。interval/ratioは、利用者がコードブックでカテゴリ化した列を選ぶ。
- 非カテゴリ列を指定した場合は CROSSTAB_CATEGORY_REQUIRED（HTTP 422）を返す。値を暗黙にbinningしない。
- 表示ラベルはcodebookのvalueLabels、順序はcategoryOrderを正本とする。データに存在しないカテゴリも0セルとして保持する。
- rowVariableIdとcolVariableIdが同一、または同じcolumnIdへ解決される場合は422。
- missingPolicyは次を固定する。
  - exclude: 欠損と非該当を分母から除外
  - include_missing: 欠損をMissingカテゴリとして両軸へ含める
  - separate_not_applicable: 非該当をNot applicable、その他欠損をMissingとして分離
- 欠損理由はcodebook定義を使い、値ラベルの空文字や文字列NAだけで判定しない。

### 3.3 Crosstab API

POST /api/v1/summaries/crosstab

リクエスト:

    {
      "context": {
        "datasetId": "dataset-uuid",
        "expectedDataRevision": 12,
        "expectedSchemaRevision": 4,
        "scope": "active",
        "rowIds": null,
        "weightColumn": "survey_weight",
        "missingPolicy": "exclude"
      },
      "rowVariableId": "q1",
      "colVariableId": "q2",
      "includeRowIds": true,
      "maxRowIdsPerCell": 10000,
      "inference": "pearson"
    }

scope=explicitのときだけcontext.rowIdsを指定する。includeRowIds=falseは大量表の初回表示用で、セルクリック時に同じcontextとcell keyで行IDを取得できる補助ルートを提供する。

レスポンスの論理形:

    {
      "meta": {
        "datasetId": "dataset-uuid",
        "dataRevision": 12,
        "schemaRevision": 4,
        "scope": "active",
        "scopeHash": "sha256:...",
        "scopeCount": 200,
        "effectiveN": 195,
        "missingCount": 5,
        "weightApplied": true,
        "weightColumn": "survey_weight",
        "algorithmVersion": "crosstab-1",
        "isExplorative": false,
        "warnings": ["WEIGHTED_INFERENCE_APPROXIMATION"]
      },
      "rowCategories": [{"id": "1", "label": "Label 1", "order": 0}],
      "colCategories": [{"id": "A", "label": "Category A", "order": 0}],
      "cells": [
        {
          "rowCategoryId": "1",
          "colCategoryId": "A",
          "rowLabel": "Label 1",
          "colLabel": "Category A",
          "unweightedCount": 35,
          "count": 40.5,
          "rowPct": 35.0,
          "colPct": 77.8,
          "totalPct": 17.5,
          "expectedCount": 22.5,
          "asr": 3.42,
          "significance": "**",
          "rowIds": ["r-001", "r-005"],
          "rowIdCount": 35,
          "rowIdsTruncated": false
        }
      ],
      "rowTotals": [{"categoryId": "1", "unweightedCount": 100, "count": 100.0, "rowPct": 100.0}],
      "colTotals": [{"categoryId": "A", "unweightedCount": 45, "count": 45.0, "colPct": 100.0}],
      "grandTotal": {"unweightedCount": 200, "count": 200.0},
      "statistics": {
        "chi2": 34.56,
        "df": 2,
        "pValue": 0.0003,
        "cramersV": 0.41,
        "inferenceMethod": "weighted_pearson_approximation",
        "expectedLt5Count": 0,
        "expectedLt5Ratio": 0.0,
        "smallMarginalWarnings": []
      },
      "warnings": []
    }

レスポンスは内部では完全精度を保持し、UIだけが表示時に丸める。分母が0の割合は0.0ではなくnullを返す。

### 3.4 集計と統計の正本

#### 3.4.1 度数と分母

- 無ウェイト時のcountは行数、unweightedCountも同じ整数である。
- ウェイト時のcountは有効なsurvey weightの合計、unweightedCountは行数である。両者を同じ欄へ上書きしない。
- rowPct = cell.count / rowTotal.count * 100
- colPct = cell.count / colTotal.count * 100
- totalPct = cell.count / grandTotal.count * 100
- 分母が0ならnullを返す。表全体が空の場合、統計量はnullで警告を返す。
- weightがnull、NaN、Infinity、文字列、負値の場合は WEIGHT_VALUE_INVALID（HTTP 422）。0は計算へ寄与しないが、unweightedCountとweightZeroCountへ残す。
- 有効な正のweightが一つもない場合は WEIGHT_NO_POSITIVE（HTTP 422）。
- weight欠損の行はweightMissingCountとしてmetaへ出し、無ウェイト行として混ぜない。
- survey weightは度数、割合、expected、ASR、weighted Pearsonの統計量だけへ適用し、scopeの行選択、rowIds、カテゴリ順、missingPolicyの判定、非加重nには適用しない。scope=sampledの抽出ウェイトもsurvey weightへ自動昇格させない。

#### 3.4.2 ASR

ASRは既存Subgroupの式と一致させる。

    ASR = (O - E) / sqrt(E * (1 - rowProportion) * (1 - colProportion))

E=0または分母0のセルはasr=null、significance=""とする。閾値は固定する。

- abs(asr) >= 3.29: ***
- abs(asr) >= 2.58: **
- abs(asr) >= 1.96: *
- それ未満: 空文字

正のASRは過剰代表、負のASRは過少代表として表示する。赤/青だけに依存せず、記号、aria-label、凡例を併用する。

#### 3.4.3 χ²、Cramér's V、期待度数

- 無ウェイトはPearsonの独立性検定を使用する。
- df = (rowCount - 1) * (colCount - 1)。空カテゴリを除外した数ではなく、実際に表へ表示するカテゴリ数を基準にし、全0行列はnullとする。
- CramersV = sqrt(chi2 / (N * min(rowCount-1, colCount-1)))。分母0ならnull。
- expectedLt5CountとexpectedLt5Ratioを返す。ratioが0.20を超える場合は EXPECTED_COUNT_LT5 警告を付ける。
- 2x2、無ウェイト、整数度数、利用者が明示的に選んだ場合だけFisher exactを計算できる。自動でPearsonからFisherへ置換しない。responseへ inferenceMethod=fisher_exact を記録する。
- ウェイト時はweighted countを使ったPearson近似として計算し、WEIGHTED_INFERENCE_APPROXIMATIONを必ず警告する。survey design effectを推定したと表示しない。

#### 3.4.4 小標本

- row/col marginalの無ウェイトnが30未満のカテゴリには SMALL_MARGINAL_N バッジを付ける。
- expected <5警告と小標本警告を一つにまとめない。
- 警告がある場合も結果を隠さず、推論の限界を表と統計サマリーへ表示する。

### 3.5 行ID取得とSelection連携

- 各cellは、計算scope内の実際のrowIdを返す。最大数を超えたときは先頭ではなく安定ソート順で返し、rowIdCountとrowIdsTruncated=trueを付ける。
- rowIdsTruncated=trueのセルクリックは、同じdatasetId、revision、scopeHash、row/col category keyを使って全rowIdを取得する補助APIへ切り替える。別のscopeを暗黙に使わない。
- Cell actionは既存の selectionApplied へ operation=add|replace|toggle とlabelを渡す。Replaceは現在の中央Selection、Add/Toggleは同じrowId集合に対して既存規則を適用する。
- セルクリックでPCPへ移動またはPCPを再描画するときも、datasetId、dataRevision、schemaRevision、scopeHashを保持する。
- Crosstabの表示モード切替、weight切替、missingPolicy切替は結果だけを更新し、Selectionを変更しない。
- dataset切替、KeepAlive復帰、遅延応答時に、前datasetのrowIdを新datasetへ適用しない。

### 3.6 バックエンド実装単位

#### 26-BE1 共通計算ヘルパー

fullstack/backend/app/algorithms/summaries/crosstab.py を新設し、次を純粋関数に分離する。

- codebookカテゴリとmissing policyの解決
- scope rowの取得とscopeHash
- 無ウェイト/ウェイト度数の作成
- 分母別percentage
- expected、ASR、significance
- Pearson/Fisher/Cramér's V
- rowId上限とtruncated情報
- warnings、algorithmVersion、ResultMeta

既存 subgroup.py のASR式はこのヘルパーへ移し、Subgroupの既存テストが同じ値になることを確認する。テストを通すために式を二重実装してはならない。

#### 26-BE2 API

fullstack/backend/app/api/summaries.py にPOST /crosstabと、truncated cell用のrow ID取得ルートを追加する。入力モデルは domain/context.py を使用し、weight検証、revision検証、カテゴリ検証をAPI層で一貫させる。

既存 /summaries と /summaries/line_mosaic を削除しない。共通メタデータの追加で既存フロントが壊れる場合は、レスポンスの既存キーを残したままmetaを追加する。

#### 26-BE3 エクスポート

既存 /exports の一般データ出力と混同しない。Crosstab結果のCSV/XLSXは、API responseと同じrevision、scope、weight、missingPolicy、表示モードを含む専用exportを用意するか、完全なresponseをクライアント側で保存する。

最低限の出力列:

- rowCategoryId、rowLabel、colCategoryId、colLabel
- unweightedCount、count、rowPct、colPct、totalPct
- expectedCount、asr、significance、rowIdCount

先頭が=、+、-、@のラベルはCSV/XLSXの式として解釈されないようにエスケープする。画面で丸めた値だけを保存せず、metadataシートまたは先頭行へ元の分析条件を残す。

### 3.7 フロントエンド実装単位

#### 26-FE1 ルートとナビゲーション

- fullstack/frontend/src/features/crosstab/CrosstabPage.tsx、CrosstabTable.tsx、必要な型/API hookを新設する。
- main.tsxへ /crosstab を追加する。
- KeepAliveOutlet.tsx のroute component mapへ同じrouteを追加する。KeepAlive対象外にしてページ再訪で条件を失わない。
- AppShell.tsx の既存 ANALYSIS_NAV_ITEMS または VIS_NAV_ITEMSへCrosstabを追加する。src/components/Navigation/TopMenu.tsxを新設してはならない。

#### 26-FE2 コントロール

上部のCard内にrow variable、col variable、survey weight、scope、missing policy、表示モード、Exportを配置する。既存のColumnSelect、codebook labels、FocusTarget、Alert、Segmentedの見た目へ揃える。

- row/col選択が未完了ならAPIを呼ばず、必要項目をAlertで示す。
- APIリクエストごとにdatasetId、expected revisions、scopeHash相当の入力を固定する。
- 実行中にdataset、Selection、weight、missingPolicy、row/colが変わったら古い結果を破棄する。
- display modeはCount、Row%、Col%、Total%を切り替える。mode切替だけでは再計算しない。

#### 26-FE3 表と統計カード

- 表の行列順はcodebook順。Total行、Total列を固定する。
- cellは表示値、補助のn、ASR記号、警告バッジ、選択操作を含む。
- Hoverだけで情報を伝えず、選択可能であることをaria-labelで示す。
- 統計カードにχ²、df、p、Cramér's V、inferenceMethod、expected警告、小標本警告、weight statusを表示する。
- ウェイト時は加重度数と非加重nを明確に分ける。weight未適用を無標記にしない。

#### 26-FE4 Selection/PCP

- cell clickでAdd/Replace/Toggleを選べる既存のbrush operationを再利用する。
- 成功後はTable、PCP、他分析ページへ同じ中央Selectionが表示される。
- rowIdsTruncatedのときは行ID取得中の状態を出し、取得前に部分集合でSelectionしない。
- Selectionの操作はCrosstab専用sliceへ閉じ込めず、既存storeのactionをdispatchする。

### 3.8 Feature 26受入条件

| ID | 完了条件 | 必須証跡 |
|---|---|---|
| 26-AC01 | /crosstabがAppShell、main、KeepAliveの全てへ登録され、再訪で条件と結果を保持する | route/browser |
| 26-AC02 | nominal/ordinal/binary以外を拒否し、codebook label/order、0セル、missing policyが正しく反映される | pytest fixture |
| 26-AC03 | count、row%、col%、total%が同じcell dataから切替でき、0分母はnull、表示丸めはUIだけで行われる | algorithm test |
| 26-AC04 | ASRがSubgroupの共通式と一致し、1.96/2.58/3.29の閾値、方向、記号、凡例が一致する | reference test |
| 26-AC05 | χ²、df、p、Cramér's Vが既知2x3 fixtureと一致し、空/退化表ではnullを返す | scipy/reference test |
| 26-AC06 | expected<5の件数・比率、20%超警告、2x2明示Fisher、小標本n<30バッジが区別される | pytest/API |
| 26-AC07 | survey weightの正値、0、欠損、負値、NaN、Infinity、全非正を検証し、加重countと非加重nを別々に返す | weight fixture |
| 26-AC08 | ウェイト時のexpected、ASR、統計量がweighted Pearson approximationと明記され、sampling weightをsurvey weightに混同しない | API response |
| 26-AC09 | context、revision、scope、scopeHash、missingPolicyを受け、stale時に結果を画面へ適用しない | API + delayed test |
| 26-AC10 | cellのrowIds、rowIdCount、truncated補助取得が安定し、dataset外のrowIdを返さない | API contract |
| 26-AC11 | cell clickのAdd/Replace/Toggleが既存Selectionを通り、PCP/Table/他ページで同じrowIdを表示する | E2E |
| 26-AC12 | display mode、weight、scope、dataset切替、KeepAlive復帰でSelectionと条件の境界が維持される | browser log |
| 26-AC13 | Tableのコードブック表示、PCPの軸、FocusTarget、Ant Design配色、キーボード操作、aria-labelが既存画面と揃う | Vitest + browser |
| 26-AC14 | CSV/XLSXがcount/percent/ASR/metadataを含み、式インジェクションと丸めによる情報損失がない | export inspection |
| 26-AC15 | local、static/Pyodide、run-production.batで同じ計算契約を確認し、未対応時は明示エラーになる | production report |
| 26-AC16 | 対象pytest、Vitest、TypeScriptチェック、既存Summary/Subgroup/Selection回帰が通る | .temp/feature25-26/ evidence |

### 3.9 Feature 26検証シナリオ

1. codebookに順序のある2つのカテゴリ列を用意し、Crosstabを開く。
2. All、Active、Selectedを切り替え、行・列・全体・Count表示の分母とmeta.scopeHashを比較する。
3. ASR記号、色、凡例、期待度数警告、小標本バッジ、統計カードを確認する。
4. survey weightを指定し、加重countと非加重n、weight status、近似警告を確認する。invalid、zero only、missing weightも確認する。
5. 有意セルをReplace、別セルをAdd、同じセルをToggleし、PCP/Table/前ページのSelectionが一致することを確認する。
6. rowIdsTruncatedを意図的に発生させ、補助取得後のSelectionが完全なrowId集合と一致することを確認する。
7. CSV/XLSXを出力し、条件、revision、scope、weight、missingPolicy、表示値、ASR、nが復元できることを確認する。
8. dataset切替、KeepAlive復帰、古いリクエストの遅延返却を行い、別datasetの表やSelectionが表示されないことを確認する。

## 4. 実装順序と分割

別エージェントは次の順に実装する。各段階の対象テストが通るまで次段階へ進まない。

1. 共通context、revision検証、scopeHash、ResultMetaのモデルと単体テストを追加する。
2. DatasetStoreへraw、revision snapshot、provenance、maskの原子保存を追加する。
3. datasetsの全mutating routeへoperation記録、mask更新、stale検証を接続する。
4. Revert、Undo/Redo、package export/importをバックエンド単体・APIテストで固める。
5. Table、PCP、ProvenanceHistoryPanel、storeを接続し、Feature 25の限定E2Eを通す。
6. Crosstab純粋計算、既存SubgroupのASR共通化、APIを実装し、known fixtureを通す。
7. Crosstab page、table、nav、KeepAlive、Selection、exportを接続し、Feature 26の限定E2Eを通す。
8. 全分析endpointのcontext移行表を埋め、未移行ルートを残さない。
9. local/static/run-production.batの実行結果とartifact hashを .temp/feature25-26/ へ保存する。
10. 受入条件の各行をPass/Partial/Failで判定し、PartialまたはFailが一つでもあればタスクを完了にしない。

## 5. 必須証跡の形式

引き継ぎ先は、コードやテストを追加するだけでなく、次の証跡を残す。

- .temp/feature25-26/tests/feature25-backend.txt
- .temp/feature25-26/tests/feature25-frontend.txt
- .temp/feature25-26/tests/feature26-backend.txt
- .temp/feature25-26/tests/feature26-frontend.txt
- .temp/feature25-26/reports/analysis-context-inventory.json
- .temp/feature25-26/reports/provenance-package-inspection.json
- .temp/feature25-26/reports/browser-regression.md
- .temp/feature25-26/reports/production.json

production.jsonには実行日時、commitまたはworking-tree識別、run-production.batの結果、local/staticのURL、確認したdatasetId、dataRevision、schemaRevision、成果物hash、未解決事項を記録する。スクリーンショットだけでAPI契約や統計値の証拠としない。

## 6. 完了判定

この文書のFeature 25-AC01〜18とFeature 26-AC01〜16が全てPassであり、既存Feature 19〜24の回帰、中央Selection、PCP、Table、KeepAlive、dataset切替の確認結果が証跡にある場合だけ、Feature 25/26を完了とする。実装済みのコードがあっても、未移行の分析endpoint、未検証のstatic経路、古い応答の上書き、加重度数と非加重nの混同、raw/provenanceの片側だけの更新が残る場合は未完了として次のエージェントへ引き継ぐ。
