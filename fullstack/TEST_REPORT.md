# DAVIS-PCP Fullstack v2.0.0 テスト報告

## 1. 結論

| 層 | 件数 | 合格 | 失敗 | 主な内容 |
|---|---:|---:|---:|---|
| backend unit/property (pytest) | 67 | 67 | 0 | ordering golden/NumPyオラクル、import matrix、row identity、fingerprint、session/job遷移、clustering partition、dendrogram、outlier |
| backend API integration (pytest) | 33 | 33 | 0 | 全endpoint success/error、404/409/400契約、CSV neutralization、upload上限、migration |
| frontend unit (Vitest) | 11 | 11 | 0 | ブラシ幾何(legacy/segment)、jitter決定論、palette、中央selection代数 |
| E2E (Playwright/Chromium) | 10 | 10 | 0 | 起動→軸順→実ポインタブラシ→Table/Distribution連携→ペアプロット/ヒートマップ→クラスタ(PCA/シルエット)→決定木リーフ→Statistics→session保存 |
| **合計** | **121** | **121** | **0** | — |

静的v1の回帰基準(51試験相当)のうち、アルゴリズムgolden・幾何・集合代数・決定論は backend unit + frontend unit に移植して継続検証している。ブラウザE2E 38試験の相当操作は E2E 10シナリオに集約した。

## 2. 主要な検証内容

### 2.1 ordering golden(初版JAR互換)

- JAR golden matrix: Component=[x1,x3,x2,x0,x4]、Permute=[x2,x3,x1,x4,x0]
- Iris 5軸: componentJar/componentPaper = petalLength→petalWidth→species→sepalLength→sepalWidth
- Permute 4軸 score: 9.961958084685977 / 9.207082574015136(厳密一致)
- strict tie(先行候補維持)、p<3 identity、定数列0相関
- NumPy独立オラクル: 生成matrix 146件で候補/score/勝者一致

### 2.2 import matrix

UTF-8 / BOM / Shift_JIS / quoted delimiter / 重複列名 / header無し / 空ファイル / 不正行 / 定数列 / 全missing / 高カーディナリティ / Parquet magic判定(拡張子無視) / Arrow magic / ARFF / SQLite

### 2.3 row identity

- ユーザー指定ID列 → probe unique列 → 生成ID(ROW-000001…)の優先順
- 生成IDはsort後も行に追随(immutable)
- fingerprint: schema+rowIds+values+optionsの決定論的SHA-256

### 2.4 session / job

- optimistic concurrency: stale tokenで409 + サーバーstate返却
- job状態遷移: cancelled→running/completed は不可(端子状態は不変)

### 2.5 clustering / outlier

- partition equivalence(ラベル置換不変)
- seed再現性、blobs 3群の分離、PAM収束・非空クラスタ
- linkage 4種 × distance 3種、cut threshold
- IQR / robust z(MAD) / Isolation Forest / LOF、欠損・定数列の安全処理

### 2.6 E2E実操作経路

1. 起動(Iris 150行、5軸)
2. 軸順ドロップダウン → Component/JAR初版互換 → diagnosticsにJAR-INITIAL
3. 実ポインタ矩形ブラシ → setosa帯 → sidebar 20-80行
4. Table でcheckbox連動確認
5. Distribution 矩形ブラシ
6. Relationships: ペアプロット/ヒートマップ/ファセット
7. Clusters: KMeans実行 → PCA/シルエット描画 → cluster 1選択伝播
8. Models: 決定木学習 → 木構造SVG → リーフクリックで選択
9. Statistics: 統計表+4ヒストグラム
10. session保存

## 3. 既知の制約

- E2E browserはChromiumのみ(Firefox/WebKitは未実行。環境制約として明記)
- WebSocket job progress は実装済みだがE2E未網羅(polling fallbackで検証)
- 大規模fixture(100k行)のベンチマークは BENCHMARK_REPORT.md を参照
