# RELEASE NOTES — DAVIS-PCP Fullstack v2.0.0

## 概要

静的Iris版 v1.0.0 をベースに、Pythonバックエンド・永続化・分析エンジンを備えたフルスタック版。単一localhost URLで動作し、外部通信なし。

## v1.0.0からの主要変更

### 追加

- 任意データimport(CSV/TSV/Parquet/Arrow/ARFF/SQLite、content-based判定、encoding自動推定)
- stable row identity(3層優先)とcanonical Parquet storage+決定論fingerprint
- Python authoritative軸順(golden fixture一致: JAR Component/Permute、原論文解釈、相関セリエーション)
- ページ分割UI: PCP / Table / Distribution / Relationships(ペアプロット+ヒートマップ+ファセット) / Clusters / Models / Statistics / Overview
- クラスタリング6方式 + シルエット幅図 + PCA散布図 + Dendrogram部分木選択
- 外れ値検出4方式(IQR/robust z/Isolation Forest/LOF)
- 決定木(木構造SVG描画・リーフクリックでrow集合を全ビューへ投影)/ランダムフォレスト
- 記述統計ページ(統計表+カテゴリ色分けヒストグラム)
- SQLite session(optimistic concurrency)+ static v1 migration + job system(cancel guard)
- CSV/Parquet/Arrow export(formula injection中和付き)

### 変更(ユーザーフィードバック反映)

- 配色を検証済みパレットへ全面刷新(context=グレー、selection=青アクセント、グラフ背景は白)
- v1の軸上コントロール(移動/反転)を復元、PCP上部は「軸順」「描画設定」「選択」ドロップダウンに整理
- 名義尺度での色分けを追加(1つなら既定、複数なら正規化エントロピー最小の列を自動選択)
- jitterをv1仕様に準拠(pixel/初版raw±0.1、名義軸にも適用)
- Distribution: カテゴリ別ボックス構成に戻し、矩形ブラシ+Add/Replace/Subtract/Toggle+縦横配置
- 選択行サイドバー折りたたみボタンを右寄せに配置(全ページ共通)

## 既知の制約

- E2E browserはChromiumのみ実行(Firefox/WebKit未実行)
- WebSocket job progressはE2E未網羅(polling fallbackで検証)
- 高解像度PNG/SVG exportはv1のCanvas PNG相当まで(viewport screenshot)

## 移行

`MIGRATION_FROM_STATIC_V1.md` 参照。
