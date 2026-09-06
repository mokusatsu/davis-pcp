# 静的v1.0.0からのmigration

## 対象

静的版 `davis-pcp-iris.html` の「JSON状態export」(`davis-pcp-iris-state.json`、`schemaVersion: 1`)。

## 手順

1. フルスタック版を起動しIrisをimport(組込みsampleで可)
2. `POST /api/v1/sessions/migrate-static-v1` に `{"state": <エクスポートJSON>}` を送る
   (bodyが `{app, exportedAt, state}` 形式でも内包stateを自動展開)

## 変換内容

| v1 | v2 session state |
|---|---|
| order / visibleKeys / reversed | axis key を canonical列名へ変換 (`sepalLength`→`sepal_length_cm` 等) |
| selected / active | `selectedRowIds` / `activeRowIds`(IRIS-nnn IDはそのまま維持) |
| jitterEnabled/Mode/Amount/Seed | `jitter{enabled,mode,amount,seed}` |
| lineOpacity / lineWidth / showContext | `rendering{...}` |
| tableSort / pageSize | `table{...}` |
| orientation / orderMode | 正規化して保存 |

## 検証と拒否

- `schemaVersion !== 1` → 400 `MIGRATION_UNSUPPORTED_SCHEMA`
- axis key集合がIris 5軸以外 → 400 `MIGRATION_NOT_IRIS_FIXTURE`
  (他datasetへの誤適用を防止)
