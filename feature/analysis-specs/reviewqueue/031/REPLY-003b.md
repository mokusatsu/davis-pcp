# Feature 031 残作業の追加報告（REVIEW-003の残項目）

対象: REVIEW-003.md §検証と残る受入項目（カテゴリ実ポインタclick、相関円3軸/rank1証拠、FactoMineR oracle、本番配信経路）
HEAD: 未コミット実装を含む（FAMD新規＋共有基盤のFAMD必須追加のみ。他機能の共有差分には触れていない）。

## 1. カテゴリ点の実ポインタclick選択（達成）

- 原因は実装の不具合ではなく検証手順の問題だった。カテゴリ図が画面外（スクロール位置）にあり、実ポインタ座標が点に届いていなかった。`scrollIntoView({block:'center'})` 後に実ポインタclickすると、pointerdown:circle→pointerup:circle→click:circle が発火し、解決ボタンが有効化された。
- 実ポインタでの確認: カテゴリ点click→「原行IDへ解決して選択 (1)」有効→解決実行→sidebar 選択行50/active150/全150（Iris、setosa 50行の1カテゴリ）。
- 証拠: .temp/famd-catclick-fixed.png（click後の有効化）、.temp/famd-catclick-resolve.png（解決後のsidebar 50行）。
- brushガード（点上でのブラシ開始抑止）は正常に機能し、clickを吸収する副作用はない。

## 2. 相関円の3軸・変数関係図の証拠（達成）

- 個体図のY軸を第3軸へ変更→相関円は「第1軸 相関 [-1,1]」「第3軸 相関 [-1,1]」と表示（F003の連動が実操作で機能）。
- 変数関係図（famd-relation-svg）は第1軸r²（sepal_width 0.5216）と第3軸r²（0.2740）を同時表示。
- 証拠: .temp/famd-axis3-evidence.png。
- rank1画面の実操作は未実施。rank1では相関円の第2軸名を抑止し、個体図は1軸表示になるコード経路のみ（FamdFigure.tsxのshown分岐、CorrelationCircleのrank抑止）。

## 3. FactoMineR oracle比較（未検証として記録）

- 環境にRscriptが存在しないためFactoMineR FAMD比較は実行できない。`which Rscript` なし。
- 代替として設計付属の独立参照カーネル `feature/analysis-specs/validation/reference_kernels.py` のfamdと照合済み（固有値・F・重心・相関・η²差分0）。これはR oracleの代わりにはならない。
- 比較条件（row.w、加重ddof0、欠損処理、行列順、重心規約）を揃えたR比較は未実施のまま残す。

## 4. 本番配信経路の確認（部分的）

- `run-production.ps1` は `frontend/dist` があればビルド省略＋uvicorn :8420起動であることを確認（バッチ自体は未実行）。
- static配布物の実体 `dist/static/pyodide/backend_app.zip`（113ファイル）はFAMD APIを含まない旧版であることを確認（app/api/famd.pyなし、MCAのapi/mca.pyもなし）。現在の `fullstack/backend/app`（116ファイル）にはfamd.pyがあり、static workerは同じFastAPIをASGI呼出しするため、再ビルドすればFAMDが配布される構造である。
- ビルド（`npm run build` / `build:static`）は明示許可なしのため未実施。必要性とコマンドは以下。FAMDを本番・staticで使うには再ビルドが必要。
  - `cd fullstack/frontend && npm run build`（本番dist更新）
  - `python fullstack/scripts/build_static.py`（backend_app.zip更新、FAMD同梱）

## 回帰

- backend FAMD＋MCA＋CA（test_100/110/111/120/121）: 37 passed
- frontend famd.test.tsx: 1 passed
- tsc: FAMDファイルのエラーなし（LinearRegressionPageの他者エラーはFAMD無関係）

## 残作業

- FactoMineR FAMDのR比較（R環境の準備が必要）。
- static再ビルドとPyodide内FAMD実行の確認（ビルド許可が必要）。
- rank1画面の実操作証拠（該当データを用意すれば可能）。
