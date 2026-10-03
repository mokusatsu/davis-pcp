# DAVIS-PCP Fullstack v2.0.0 API仕様

OpenAPI: `GET /api/openapi.json` (Swagger UI: `/api/docs`) を正本とする。本書は概要。

共通error contract:

```json
{ "error": { "code", "message", "details", "evidenceClass",
             "recoverable", "suggestedActions", "traceId", "timestamp" } }
```

## endpoints

| Method | Path | 概要 |
|---|---|---|
| GET | /api/v1/health | 疎通確認 |
| GET | /api/v1/datasets | 一覧 |
| POST | /api/v1/datasets/import | multipart upload(CSV/TSV/Parquet/Arrow/ARFF) |
| POST | /api/v1/datasets/import/sample | 組込みIris |
| POST | /api/v1/datasets/probe-sqlite | SQLite table一覧probe |
| POST | /api/v1/datasets/import/sqlite | SQLite table取込(FormData: file,table) |
| GET | /api/v1/datasets/{id} | meta(schema/fingerprint/rowIdentity) |
| PATCH | /api/v1/datasets/{id}/schema | semanticType/role/category修正 |
| POST | /api/v1/datasets/{id}/view | Arrow IPC view(columns/rowIds/limit/offset) |
| DELETE | /api/v1/datasets/{id} | 削除 |
| POST | /api/v1/orderings | 軸順計算(mode/columns/manualOrder) |
| GET | /api/v1/orderings/{rid} | 結果(candidates/trace/evidence) |
| POST | /api/v1/summaries | 記述統計(+correlation、fingerprint cache) |
| GET/POST | /api/v1/datasets/{id}/groups | group層 |
| PATCH/DELETE | /api/v1/datasets/{id}/groups/{gid} | group更新/削除 |
| POST | /api/v1/clusters | kmeans/kmedoids/divisive/gmm/agglomerative/class_variable(+silhouette+pcaProjection) |
| GET | /api/v1/clusters/{rid} | 結果 |
| POST | /api/v1/dendrograms | linkageMatrix取得(階層的のみ) |
| POST | /api/v1/outliers | iqr/robust_z/isolation_forest/lof |
| GET | /api/v1/outliers/{rid} | 結果(outlierRowIds) |
| POST | /api/v1/models | decision_tree/random_forest(treeStructures/leafMembership/featureImportance) |
| GET | /api/v1/models/{rid}[/leaves] | 結果(リーフrow集合) |
| POST | /api/v1/models/logistic | ロジスティック回帰(係数、推論の可否、予測確率) |
| GET/POST | /api/v1/sessions | session一覧（メタデータのみ）/作成 |
| GET/PUT/DELETE | /api/v1/sessions/{sid} | 取得/更新(versionToken必須、競合・dataset不一致時409)/削除 |
| POST | /api/v1/sessions/migrate-static-v1 | 静的v1状態JSON migration |
| POST | /api/v1/exports | selected/active/all × csv/parquet/arrow |
| GET | /api/v1/exports/session/{sid} | session JSON download |
| GET | /api/v1/jobs[/{jid}] | job状態(polling fallback) |
| POST | /api/v1/jobs/{jid}/cancel | cancel(terminal状態は不変) |
| WS | /api/v1/ws/jobs/{jid}/events | progress broadcast |

## 共通分析対象と実行時snapshot

UIの All / Active / Selected / Sampled は共通ヘッダーで選択する。表示用フィルターと、計算開始時に固定した解析対象を区別する。選択ハイライトの変更だけで実行済みモデルを再学習しない。

- `AnalysisContextV2` は `datasetId`、`expectedDataRevision`、`expectedSchemaRevision`、`scope` を持つ
- `active` / `selected` / `sampled` / `explicit` はそれぞれ `activeRowIds` / `selectedRowIds` / `sampledRowIds` / `rowIds` が必須。`[]` は空対象であり、省略や全体を意味しない
- `all` は現在のdataset全行。その他の対象を勝手にAllへ拡張しない
- revision不一致は `ANALYSIS_INPUT_STALE` (409)。`scope=explicit` や追加した `rowIds` 契約に不明rowIdを含む場合は `ANALYSIS_SCOPE_UNKNOWN_ROW` (422)
- 集計の空対象は0件結果、学習・推定の空対象は手法固有の不足エラーを返す。クロス集計の `explicit: []` とセル行ID取得は空結果を返す
- `/analysis-results/{id}/select` とfit結果の列保存は当該runのcontextを使う。予測は予測開始時の共通対象を別snapshotで持ち、予測結果の列保存にもそのsnapshotを使う
- `/pra/evaluate`、`/robustness/evaluate`、`/orderings` は `rowIds` とrevision期待値に対応。省略時は全体、`[]` は全体に戻さない
- `/robustness/sensitivity` の `scopeRowIds` は比較母集団、`candidate.rowIds` はその中の候補群であり別の意味
- `/regression/loess`、`/distribution/fedf` は共通 `rowIds` とrevision期待値を送る。通常サーバーと静的Pyodide版で同じPython APIを利用する

### 標本作成

`POST /datasets/{id}/observations/sample` の `seed` 省略は既定42、`seed: null` は新しい実効seedを生成する。応答には `seed`、`sourceScopeHash`、`sourceOrderHash`、`sourceRowCount`、`sampleId`、data/schema revisionを含める。実際の標本rowIdsとともに保存する。母集団の行順も再現条件に含む。

非復元抽出のみ対応。復元抽出は `SAMPLING_REPLACEMENT_UNSUPPORTED` (422) とし、抽出回数を調査ウェイトへ読み替えない。標本作成および行範囲APIにもrevision期待値を渡せる。

### セッション

セッションstateの追加項目 `workspaceVersion: 1` に、共通行source、使用変数、Active/Selected、標本provenanceを保存する。復元はdataset/revisions/行・列ID/標本記録を検証してから単一actionで適用する。不足する旧記録を推測して補完しない。既存sessionを削除したり、新しい結果履歴UIを導入したりはしない。

### ロジスティック回帰の推論可否

`POST /models/logistic` は情報行列のランクが不足していても、計算できた係数解と予測確率を返す。この場合、個々の係数が一意に識別できることを意味しない。

- `diagnostics.inferenceStatus` と各 `coefficients[].inferenceStatus` は `available` / `unavailable`。各係数の `inferenceReason` は通常 `null`、ランク不足時は `SINGULAR_INFORMATION`
- 推論不可時は `stdError`、`zValue`、`pValue`、`ciLower`、`ciUpper`、`logCiLower`、`logCiUpper` が `null`。`coefficient` / `logOddsRatio` と予測は保持し、`LOGISTIC_INFERENCE_UNAVAILABLE` warningを返す
- `exponentiationStatus.ciLower` / `ciUpper` は推論不可時 `unavailable`。有限の対数値の指数化だけが表現範囲外の場合は従来どおり `overflow` / `underflow` と `null` を返し、対数値は保持する。`null` を0・p=0・OR=1の区間として扱わない

### モデル計算の数値表現範囲

単位の正規化で計算できる結果は保持する。必要な出力を有限値として表現できない場合、非有限値や暗黙の0を成功応答に含めず、明示的な422エラーを返す。

- `LOGISTIC_NUMERIC_RANGE` / `PCA_NUMERIC_RANGE`: `details.stage` が失敗した計算段階を示す。PCAでは計算段階に応じて `details.useCorrelation` も含む
- `LR_NUMERIC_RANGE`: `details.fields` に表現範囲外の項目を示す。`details.partialResult` は計算可能な場合、有限の `estimates`、`standardErrors`、`pValues`、`rSquared`、`adjustedRSquared`、`rmse`、`residualStdError` を保持する。モデル結果や予測結果の保存前に有限性を検証する
- ロジスティック回帰の有限対数値を指数化した場合だけの範囲超過は、このエラーと区別し、上記の指数化statusとnullable OR/CIで返す
