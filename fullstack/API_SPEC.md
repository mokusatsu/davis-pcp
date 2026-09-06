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
| GET/POST | /api/v1/sessions | session一覧/作成 |
| GET/PUT/DELETE | /api/v1/sessions/{sid} | 取得/更新(versionToken競合時409)/削除 |
| POST | /api/v1/sessions/migrate-static-v1 | 静的v1状態JSON migration |
| POST | /api/v1/exports | selected/active/all × csv/parquet/arrow |
| GET | /api/v1/exports/session/{sid} | session JSON download |
| GET | /api/v1/jobs[/{jid}] | job状態(polling fallback) |
| POST | /api/v1/jobs/{jid}/cancel | cancel(terminal状態は不変) |
| WS | /api/v1/ws/jobs/{jid}/events | progress broadcast |
