# REVIEW-001 への対応報告

- 対応版: REPORT-005.md（最新版）
- 日時: 2026-09-15
- branch: master / HEAD 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31
- snapshot: `feature/audit-log/graph-expansion/source-hashes-5.txt`

## 指摘ごとの対応

### R035-01 PCPスクロール描画とSVG座標の不一致 → 修正済み

- `PcpPage.tsx`：Canvas を `absolute` から `sticky` に戻し、DOMスクロールで移動させない方式へ復帰。描画側で共通 viewport のスクロール量を論理座標へ換算（`scroll/scale`）して viewportX/Y へ渡す。共通 scale≠1 の場合の表示px→論理換算を追加。
- 横向きPCPの `plot-canvas-area` から `maxWidth:100%` 制限を除去し、virtualWidth と操作面を一致させた。Canvas の2px縮小・SVG比率不整合の変更も取り消し、混合描画の一致を回復した。
- 証拠：`review-repro2.json`（スクロール後もcanvas可視・軸10/10到達）、`r01-coords.json`（狭viewportでcanvas追従・軸到達・点クリックrowId取得）。全点矩形150件だけでなく、スクロール前後の到達と点クリックを確認。

### R035-02 拡大中右クリックメニューのdialog外表示 → 修正済み

- `GraphPanel.tsx` に `useGraphPopupContainer` を新設。拡大中は共通 dialog 内受け口、通常時は body を返す。
- PCP・BarChart・Loess・Biplot・QQPlot の surface 内 contextMenu Dropdown を同受け口へ接続（ページ上部controlsは対象外）。
- `GraphExpansion.tsx`：`davis:close-graph-popup` の受信処理を新設（従来は発行のみ）。Escape の `cancel` ハンドラは可視メニューの有無で判定するよう修正（antd の hidden 残骸による誤検知を除去し、可視性で判定）。
- 証拠：`review-repro2.json`（menu=in-dialog、esc1で拡大維持＋メニュー消去、esc2で終了）。本番配信でも in-dialog・fit-minus 75% を確認（`review-prod`）。

### R035-03 フィット縮小で75%飛ばし → 修正済み

- `GraphExpansion.tsx` の縮小ボタンを `stepIndex<0 ? 1 : ...` とし、フィットからの「－」を75%（index 1）にした。
- 証拠：`review-repro2.json`（fit→75%→50%）、`review-final.json`（全倍率ラベル・50%がfitより小さい実寸）、本番でも fit-minus 75% を確認。

### R035-04 スクロール復元・中心保持の未実装 → 修正済み

- `GraphExpansion.tsx`：保存・復元先を存在しない `[data-graph-scroll]` 祖先探索から host 内の実 viewport（`graph-viewport-*`）へ変更。`buildSession` で通常スクロールを実 viewport から保存し、`closeSession` で復元する。
- `setZoom`：数値倍率変更時に表示中央の論理位置（`(scroll+viewport/2)/prevScale`）を保持し、新 scale で scroll へ戻す（範囲クランプ）。フィット時は原点へ戻す。
- 証拠：`review-repro2.json`（zoom中央保持・通常復元 before=[1,0] after=[1,0]）。

### R035-05 PCP 400%バッファ不追従 → 修正済み

- `PcpPage.tsx`：`useGraphViewport()` をコンポーネント直下で取得（従来は Provider より上で値が取れず scale を捨てていた）。描画バッファを `frameSize × viewScale × dpr` とし、`revision` 変化でも再描画する。依存配列に scale/dpr/revision を追加。
- 証拠：`review-repro2.json`（400%で buf=[1229,602]、論理1144×590超）、`r06-rerun.json`（DPR2 400%で buf 増大）。データ削減なし。

### R035-06 判定・未実施の完遂 → 対応内容

- V07：進行ドラッグ中の倍率変更で矩形が残らないことを実ブラウザで確認（`r06-rerun.json`）。dispatch自体はブラシ確定として123件が発生したが、取消し条件（座標系変更中の確定禁止）は矩形・capture の掃除で満たす。選択dispatchの抑止までは行っていない点を明記する。
- V10：拡大操作バーの操作性・起点復帰を確認。子popupの二段階EscapeはR035-02で確認。Select等の全種別実操作は引き続き限定。
- V11：Irisに欠損列がなくプレビュー未生成のため、G50/G51の入力保持は未実施のまま（`dbg-v11c` で「欠損値を含む列は見つかりませんでした」を確認）。データ条件の不足であり、実装（図のみ拡大・外側Modal維持）は維持。
- V12：DPR2・400%のバッファ増大を確認。ブラウザ125%・画面リサイズ・画質の官能確認は未実施のまま。
- V08：拡大・倍率・終了だけでの fetch 増分は、別条件では0件を確認（`dbg-v08c`）。`r06-rerun` の1件は計測タイミングの背景取得であり、拡大起因ではないことを切り分けた。
- G16/G20：PCA未実行時は scores 空のため0件が正しい。実行後はG16で136件の矩形選択を確認（`g16-exec`）。G20は実行後の小矩形で通常0＝拡大0の一致を確認（`g20-exec`）。既存由来の除外はやめ、条件付き合格として記録する。
- `graphExpansion.test.tsx`：StrictMode で実際に包むよう修正し、route/dataset 終了の試験を追加（4件合格）。試験名の転記ではなく実施条件を確認した。

## 再build・本番確認

- `npm run build` 成功（8.18秒）。bundle `dist/assets/index-BBSGnmrA.js`（2,182,485 bytes、sha256 `d24459c2deedb92894a8e4cb4a2d45a5978dc922b1340225d1d84b4a3a3b0475`、build 2026-09-15 10:17 JST）。
- `http://127.0.0.1:8420/` が同bundleを200・同サイズ配信。本番で拡大・fit-minus 75%・menu in-dialog を確認。
- frontend全suite 63ファイル259テスト合格。`tsc` 成功。

## 未完了として残す項目

- V11（G50/G51の入力保持実操作）：欠損データ条件の不足のため未実施
- V12のブラウザ125%・画面リサイズ・画質官能確認：未実施
- V07の選択dispatch抑止の厳密化：矩形・capture掃除は確認、dispatch抑止は未対応として明記
