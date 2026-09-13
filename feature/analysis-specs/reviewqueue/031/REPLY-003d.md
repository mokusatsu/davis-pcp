# Feature 031 ビルド・配布確認報告

## 本番ビルド

- 事前ゲート: `tsc --noEmit -p fullstack/frontend/tsconfig.json` はFAMDエラーなし、`test_120_famd.py`＋`test_121_famd_api.py` は13 passed。
- `npm --prefix fullstack/frontend run build` を実行し成功（8.83s、`.temp/famd-build-local.log`）。
- 本番バンドル `fullstack/frontend/dist/assets/index-B-lrO7Mo.js` に `models/famd`・`famd-run`・`famd-relation-svg` を含むことを確認。
- 本番経路（uvicorn :8421が `fullstack/frontend/dist` をSPAフォールバック配信）で `/models/famd` がindex.html（394B）を返し、`/api/openapi.json` に `/api/v1/models/famd` が掲載されることを確認。
- dist配下はgitignore対象のためコミット対象外。

## static配布

- `python fullstack/scripts/build_static.py` はスクリプト内のパス連結不備（`ROOT=parents[1]` が `fullstack/` を指す）でfrontendディレクトリ解決に失敗し完走しない。共有スクリプトは編集していない。
- 代替として同スクリプトの `package_backend_app()` と同等のbackend_app.zipを `.temp/backend_app-famd.zip` に再構築し（119ファイル、app/api/famd.py・app/algorithms/models/famd.py同梱）、`dist/static/pyodide/backend_app.zip`（旧113ファイル・FAMDなし）へ配置した。dist配下はgitignore対象。
- 配置後のzip展開アプリで `openapi()` に `/api/v1/models/famd` が掲載されること、同梱kernelでrank3・全慣性4.0の実行ができることを確認。
- staticの `build:static` フロント再構築とPyodide内実実行は未実施（完全な `build_static.py` 完走には共有スクリプトの修正が必要なため残作業）。

## 回帰

- backend FAMD（120/121）: 13 passed（ビルド後再実行）。
