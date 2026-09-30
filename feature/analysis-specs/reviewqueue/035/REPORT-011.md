# 拡大中ポップアップ・PCA Canvas・選択メニュー修正報告

## 目的

拡大 dialog 内で軸ラベルの設問ポップアップが背面へ回る問題、PCA Canvas の拡大時の解像度低下、拡大中に既存の選択操作へ到達できない問題を修正する。

## 修正内容

| 区分 | 対象 | 修正 |
|---|---|---|
| dialog 内 popup | `GraphPanel`、`ColumnQuestionTooltip` | `GraphPanel` の子が現在の graph ID を文脈から取得できるようにした。設問 Tooltip は拡大対象に限り dialog 内の popup root を使い、通常表示は従来どおり `body` を使う。 |
| Canvas 解像度 | PCAバイプロット、PCA主成分散布図行列、Q-Qプロット | GraphPanel 子で得る実表示倍率、DPR、viewport revision を既存Canvas描画effectへ中継する。`canvasBufferSize` により backing buffer と transform を更新し、描画 host・Canvas要素・分析API要求は再作成しない。 |
| 選択メニュー | `GraphExpansionBar`、`PointerSelectionDropdown` | 拡大バー右端に選択数とポインター選択メニューを配置した。集合演算、解除、Focus、Delete、全復帰を既存Redux actionで実行する。PCP以外ではPCP専用ヒット判定を表示しない。内側の Select と menu も dialog 内 popup root を使う。 |

## 既存挙動

- クリック時の toggle と、矩形選択時の集合演算は変更していない。
- Focus、Delete、解除、全復帰は既存の共有 selection reducer を利用する。
- Canvas の論理座標変換は `clientToCanvas` のままとし、表示倍率・スクロール後も同じ論理座標を使う。
- viewport 変更は描画effectだけを再実行し、PCAおよびQ-Qの分析API要求条件には加えない。

## 検証

- Vitest: `graphExpansion`、`pointerSelection`、`pcaBrushScale`、`columnQuestionTooltip`、`pcaManual`、`pcaPointColor` の6ファイル50件が合格。
  - 拡大中の設問 Tooltip が dialog 内 popup root に入ることを確認。
  - 選択メニューが dialog 内に表示され、未選択時の解除・Focus・Deleteが無効、全復帰が有効であることを確認。
  - DPR 2、125%拡大時のPCAバイプロットCanvasが 1440 x 960 から 1800 x 1200 へ更新され、transform が 2.5 倍になることを確認。
  - 0.5、1、2倍の表示矩形で、PCAバイプロットと行列のクリック・矩形選択が同じ論理行IDへ到達することを確認。
- `npm.cmd run build`: ライセンス確認、TypeScript、Vite build が成功。
- 実画面: Iris組込みサンプルでPCAを実行し、PCAバイプロットを拡大した。右端の選択メニューに集合演算・解除・Focus・Delete・全復帰が表示されること、125%表示でCanvasが崩れないこと、ベクトル設問 `sepal_length_cm` のポップアップが dialog 前面に表示されることを確認。
- 配信確認: 8420番ポートは起動前から待受済みだったため、新規 `run-production.bat` はbindしなかった。既存の `http://127.0.0.1:8420/` はHTTP 200を返し、応答本文は今回のbuild後の `fullstack/frontend/dist/index.html` と完全一致した。

## 未完了事項

Feature 035 全体について、最新差分への明示的なレビューOKは未受領である。既存待受プロセスは停止していないため、8420を新規にbindする起動確認が必要な場合は、所有者を確認したうえで別途実施する。
