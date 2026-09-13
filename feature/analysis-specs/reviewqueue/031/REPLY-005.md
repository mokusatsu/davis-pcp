# Feature 031 最終受入確認報告（REVIEW-004/005の残2項目）

対象: REVIEW-004.md（F007解消、残4項目）、REVIEW-005.md（コード指摘解消、残2項目: 本番配信経路・rank1画面）
HEAD: 未コミット実装を含む（FAMD新規＋共有基盤のFAMD必須追加のみ。他機能の共有差分には触れていない）。

## 1. 本番配信経路（通常のfrontend/dist＋uvicorn）

- `npm --prefix fullstack/frontend run build` を再実行し成功（F007修正を含む最新ソースで再ビルド、`.temp/famd-build-local2.log`）。
- 本番バンドル `fullstack/frontend/dist/assets/index-B-lrO7Mo.js` に `models/famd`・`famd-relation-svg`・F007文言（「取得軸」「別の分析」）を含むことを確認（変数名はminifyで短縮されるため文言で確認）。
- 本番経路（uvicorn :8421が `fullstack/frontend/dist` をSPAフォールバック配信）で `/models/famd` がindex.html（394B、bundle参照付き）を返すことを確認。
- 同経路の `/api/openapi.json` に `/api/v1/models/famd` が掲載され、既知fixture（24行）でrank5・全慣性5.0の実行・結果表示ができることを確認。
- dist配下はgitignore対象のためコミット対象外。`run-production.ps1` 自体の実行はしていない（起動スクリプトの構造確認はREPLY-003dのまま）。

## 2. rank1画面の操作

- fixture: 数値1列＋2水準カテゴリ1列の2行（rk1c）。APIでrank1・固有値[2.0]を確認。
- 実ブラウザ（独自FE :5175→独自BE :8421）で「rev 1 / scope all (n=2) / 有効 2 / 非加重 / p1 m1 K2 rank 1」を表示。
- 個体図はX軸のみ（「第1軸 (100.0%)」）、Y軸選択なし。偽の第2軸は作らない。
- 相関円は「第1軸 相関 [-1,1]」のみで第2軸名なし（F003のrank1抑止が実操作で機能）。
- 変数関係図（famd-relation-svg）を表示。
- 証拠: .temp/famd-rank1-run.png, famd-rank1-corr.png, famd-rank1-relation.png。
- 注意: rank1データセットはn=2のためFAMD_SMALL_SAMPLE・FAMD_RARE_CATEGORYの警告が出る。これは仕様どおりの注意表示である。

## 回帰

- backend FAMD（120/121）: 13 passed（最終確認時再実行）。
- FAMDファイルのtscエラーなし（前回報告のまま）。

## 残作業

- 完全な `build_static.py` 完走とPyodide内FAMD実実行（共有スクリプトのパス不備のため未実施。backend_app.zipの手動配置確認はREPLY-003dのまま）。
