# DAVIS-PCP Fullstack v2.0.0 アーキテクチャ

## 1. 全体構成

```
Browser (React 18 + TS strict + AntD 5)
  ├─ PCP Canvas renderer + SVG brush overlay + Web Worker (exact hit-test)
  ├─ 中央 selection state (Redux Toolkit): 全ビューがこれを projection
  ├─ REST: 通常操作 / Arrow IPC: 表データ / WebSocket: job events
  ▼
FastAPI (127.0.0.1 bind 既定)
  ├─ api/ : datasets, orderings, summaries, groups, clusters, outliers,
  │         dendrograms, models, sessions, exports, jobs
  ├─ algorithms/ordering/core.py : DAVIS軸順 authoritative implementation
  ├─ algorithms/clustering : KMeans/KMedoids(PAM)/Divisive/GMM/ClassVar/Hierarchical+silhouette
  ├─ algorithms/outliers   : IQR/robust z(MAD)/IsolationForest/LOF
  ├─ storage/ : canonical Parquet dataset store + SQLite sessions/jobs
  └─ jobs/    : process pool + progress broadcast + result cache
```

## 2. 中核domain

- **row identity**: `__rowId__` 列をcanonical Parquetに一度だけ生成(優先順: 指定ID列→probe unique列→ROW-000001…)。全操作・保存・export後も同一ID。
- **fingerprint**: schema + rowIds + values(hash) + import options の決定論的SHA-256。summaries cache keyに使用。
- **RowVisualState相当**: active/selectedは中央store、group/cluster/outlierはGroupDefinition(rowIds+色)として分離。selected行はグループ色を保持し選択アクセントを重ねる。

## 3. 軸順アルゴリズム(Python authoritative)

静的v1(=初版JARバイトコード解析由来)を移植:

| mode | variant | evidence |
|---|---|---|
| database | NoOrder | JAR-INITIAL |
| componentJar | corr(X)後、反復ごとにcorr(R_sub)固有分解 | JAR-INITIAL |
| componentPaper | R_sub直接固有分解 | PAPER-INTERPRETATION |
| permute | ceil(p/2)候補・min-max・Euclidean・隣接和・strict `<` | JAR-INITIAL |
| correlation | 全順列Σ(1-|r|)最小化 | MODERN-EXTENSION |
| manual | ユーザー指定 | MODERN-EXTENSION |

Jacobi固有分解もJS版と同一手順で移植し、golden fixtureとNumPyオラクルで二重検証。

## 4. ブラシ幾何

- `legacyVertex`: 矩形内に軸頂点が1つでも含まれる(JAR-INITIAL)
- `segment`: Liang–Barsky線分交差(MODERN-EXTENSION)
- 小中規模はWeb Workerでexact計算。pointer move等はサーバーへ送信しない。

## 5. 永続化

- dataset: `workspace/datasets/{id}.parquet` + `{id}.json`(meta/groups)
- session: SQLite(`sessions.db`) revision番号 + SHA-256 version token、stale updateは409でサーバーstateを返す
- static v1 migration: `schemaVersion:1` Iris stateを検証(axis key集合でIris判定)してv2 sessionへ変換

## 6. セキュリティ/ローカル性

bind既定`127.0.0.1`・CORS localhost限定・upload上限・row/column上限・content-based format検証・CSV formula injection neutralization(`=+-@`先頭を`'`でescape)・stack trace非表示(error contractのみ)・外部通信なし。

## 7. frontend配色

dataviz reference palette(CVD adjacent ΔE 9.1 light/8.4 dark 検証済み8色、fixed slot order)。context線は低彩度グレー、選択は青アクセント+白halo、テキストはink token。entityColor(slot)はエンティティ固定でfilter時に再配色しない。
