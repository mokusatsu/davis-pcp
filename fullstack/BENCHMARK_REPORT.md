# BENCHMARK_REPORT — DAVIS-PCP Fullstack v2.0.0

実測環境: Windows 11 / Python 3.12 / Node 24 / Chromium (Playwright headless)

| 項目 | 実測値 | 備考 |
|---|---:|---|
| backend unit tests 全体 | 7.3s (100件) | pytest -q |
| frontend build (vite) | 6.0s | tsc + rollup |
| E2E 10シナリオ全体 | 9.4s | Playwright Chromium |
| Iris import → canonical Parquet | <50ms | 組込みsample |
| Arrow view転送(150行) | ~1.2KB | IPC stream |
| ordering componentJar(Iris) | ~1ms | API runtimeMs |
| KMeans k=3 (Iris, zscore) | ~8ms | API runtimeMs |
| 決定木 depth=4 学習+membership | ~7ms | API diagnostics.runtimeMs |
| PCP初回描画(150行5軸) | <16ms/frame | Canvas 2D、DPR対応 |

## 大規模データに関する制約

100,000行×30軸の専用fixtureによる計測は本版では未実施。現状のスケーラビリティ対策:
- Arrow IPC転送、Web Workerでのexact brush hit-test、Table仮想ページング(25/50/100行)
- summaries のfingerprint cache

sampling表示(GUIへの全行数/表示行数明示)は未実装。次版の課題。
