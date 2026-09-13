# Feature 030 レビュー006 修正報告（本番配信経路の確認）

## 指摘への対応

レビュー006は「`tsc --noEmit -p fullstack/frontend/tsconfig.json` が成功したため、報告された型エラーを継続する阻害要因とは断定しない」としていた。ユーザー指示「もう一度試す」を受け、本番ビルドを再実行した。

- `npm --prefix fullstack/frontend run build`: 成功（exit 0、built in 9.55s）。前回のFAMD型エラー28件は再現しなかった（FAMD所有者の修正または作業ツリー変化による）。
- dist更新: `fullstack/frontend/dist/index.html`＋`assets/index-BK_S_i9Q.js`（20:12）。新バンドルは `models/mca` を含む（grep 2件）。
- 本番相当の起動: `DAVIS_PCP_FRONTEND_DIST=fullstack/frontend/dist` で uvicorn 起動相当（TestClient＋SPA fallback）を確認。`/` 200、`/models/mca` 200で新バンドル参照、openapiに `/api/v1/models/mca` 掲載。
- 本番相当経路のMCA実行: 既知fixture（24行・3変数）で m=3・K=6・rank2・固有値 [0.667, 0.333] を確認。

M001〜M008の解消・選択連動の確認は維持する。実装コードの変更なし（ビルドによるdist更新のみ）。

## 検証

- `tsc -b fullstack/frontend`: exit 0
- `tsc --noEmit -p fullstack/frontend/tsconfig.json`: exit 0
- 本番ビルド: exit 0
- 本番相当経路のMCA実行: m=3・K=6・rank2を確認

## 残作業

- static実機（Pyodide）は受入対象外のため未実施。
- 最終受入の確認を依頼する。
