# DAVIS-PCP Fullstack v2.0.0

DAVIS初版のPCP(Parallel Coordinates)操作と軸順アルゴリズムをPython authoritative implementationとして固定し、任意の表形式データをstable row identityのまま複数ビュー(PCP / Data Table / Distribution / Relationships / Clusters / Models)で共有するローカル完結型の分析アプリケーション。

静的版 `DAVIS-PCP-Iris-Static-v1.0.0` の全機能を回帰維持しつつ、FastAPIバックエンド・永続session・job・クラスタリング・決定木/ランダムフォレストへ拡張した。

## 起動方法

### 開発

```powershell
# Windows
./run-dev.ps1
```

```bash
# Linux/macOS
./run-dev.sh
```

- frontend: http://localhost:5173 (Vite dev server, /api を 127.0.0.1:8420 へ proxy)
- backend: http://127.0.0.1:8420 (FastAPI)

### production

```powershell
./run-production.ps1
```

```bash
./run-production.sh
```

frontendを事前ビルドし、FastAPIが同一origin (http://127.0.0.1:8420) から配信する。単一URLで利用可能。

## 必要環境

- Python 3.12以上 (`pip install -r backend/requirements.txt`)
- Node.js 20以上 (`cd frontend && npm install`)

## 主な機能

| ページ | 機能 |
|---|---|
| PCP | DAVIS軸順6モード(NoOrder/Component JAR互換/Component原論文/Permute/相関セリエーション/Manual)、legacy頂点包含OR/線分交差ブラシ、Add/Replace/Subtract/Toggle、Focus/Delete/Reset、多段Undo(Redux history)、軸上コントロール、jitter(pixel/初版raw±0.1)、名義尺度色分け |
| Table | ソート/検索/選択only/ページング、双方向選択連携 |
| Distribution | v1準拠のカテゴリ別箱ひげ図+全点strip、矩形範囲ブラシ、横/縦配置、PCPと色分け連動 |
| Relationships | ペアプロット(対散布図+対角ヒストグラム)、相関ヒートマップ、ファセットプロット |
| Clusters | KMeans/KMedoids(PAM)/Divisive/GMM-EM/Class変数/階層的(Nearest/Farthest/Average/Group Average × Euclidean/Standard Euclidean/City-block)、PCA 2次元散布図、シルエット幅図、Dendrogram部分木選択 |
| Models | 決定木(木構造SVG描画+リーフ選択でrow集合を投影)/ランダムフォレスト、feature importance |
| Statistics | 軸別記述統計表+ヒストグラム(ビン選択) |

共通: 中央selection state(全ビュー即時伝播)、選択行サイドバー(折りたたみ可・右寄せボタン)、session保存(SQLite + optimistic concurrency + revision token)、CSV/Parquet/Arrow export(CSV formula injection neutralization付き)。

PCAページでは通常PCAと独立したSparsePCAも利用できる。非加重の疎な再構成係数、得点計算係数、直接相関、得点図、保存結果のCSV/JSON出力に対応する。設定と指標の意味・計算上限は [SparsePCA](docs/SPARSE_PCA.md) を参照。

保存対象・再開方法・分析の引継ぎと欠損方針は [分析ワークフロー](docs/WORKFLOW_RELIABILITY.md) を参照。

コードブックのライセンス編集・選択時の出典表示・12種類の組込みデータ（Iris/Wineを含む）は [ライセンス情報と組込みデータ](docs/CODEBOOK_LICENSES_AND_SAMPLES.md) を参照。

## import対応形式

CSV / TSV / Parquet / Arrow IPC(Feather) / ARFF / SQLite(.db/.sqlite のtable選択) / 組込みIris sample。
拡張子でなくcontent-basedで形式判定。encoding自動推定(UTF-8/BOM/Shift_JIS/UTF-16/latin-1)。

## 証拠区分

`JAR-INITIAL` / `PAPER-INTERPRETATION` / `LATER-DAVIS` / `RECONSTRUCTED` / `MODERN-EXTENSION` / `SCOPE-REQUIREMENT` をAPI応答・diagnosticsに明示。詳細は `docs/` と `FEATURE_TRACEABILITY.csv`。

## 試験

以下は `fullstack/` から実行する。

backend は通常テスト・統計検証・アンケート監査をそれぞれ新しい Python プロセスで実行する。統計検証とアンケート監査は専用 workspace を設定するため、製品 API を import 済みのプロセスでは収集時に停止する。

統計検証の完全実行には、PATH 上の `Rscript` と R パッケージ `survey` が必要。未導入の場合、live-R 比較テストは自動 skip されずエラーになる。

```bash
# backend unit + property + API integration / statistical + survey audit
(cd backend && \
  python -m pip install -r requirements-test.txt && \
  python -m pytest tests/ --ignore=tests/stats_tests --ignore=tests/survey_audit -q && \
  python -m pytest tests/stats_tests -q && \
  python -m pytest tests/survey_audit -q)

# frontend unit
(cd frontend && npx vitest run)

# E2E (10 tests; サーバーを8425等で起動してから)
python -m pytest e2e/test_e2e.py -q
```

R を使わない統計検証だけを行う場合は、上記の統計検証コマンドを次に置き換える（`backend/` で実行）。`r_oracle` を除外するため、この結果に live-R 比較の検証結果は含まれない。

```bash
python -m pytest tests/stats_tests -m 'not r_oracle' -q
```

詳細は `TEST_REPORT.md`。

## ライセンス / 出典

規範資料は `/DAVIS-PCP` ライブラリ参照。アルゴリズムの出典は `SOURCE_REVIEW_LOG.md`。
