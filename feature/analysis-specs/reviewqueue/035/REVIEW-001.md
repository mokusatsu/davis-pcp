# Feature 035 実装レビュー001

判定: **修正必須・承認保留。現時点では問題なしと判定できない。**

日付: 2026-09-15。対象: REPORT.md〜REPORT-004.md、設計35・台帳35a・検証計画35b、現行共通部と代表描画実装、提出ログ。
`source-hashes-4.txt`に記録されたファイルは現行ファイルと照合し、不一致なし。

## R035-01 [P1] PCPのスクロール描画とSVGの座標系が一致しない

対象: `fullstack/frontend/src/features/pcp/PcpPage.tsx:374`、同435行・968〜1010行付近、`fullstack/frontend/src/engine/pcpRenderer.ts:107`。

REPORT-004でCanvasをstickyからabsoluteへ変更した一方、描画処理は共通viewportのscrollLeft/TopをそのままviewportX/Yへ渡し、rendererはその値を引いている。absoluteのCanvasはDOMスクロールでも移動するため、描画内の移動とDOMの移動が重複する。SVG側はvirtual寸法の座標を保持してDOMスクロールする方式であり、Canvas側と原点が一致しない。共通scaleが1以外の場合は、表示pxのscroll値を論理座標へそのまま渡す問題もある。

さらに横向きPCPのplot-canvas-areaはvirtualWidthを指定しながらmaxWidth:100%で制限し、SVGもwidth:100%になっている。長い軸の仮想幅と、実際の操作面の幅が一致しない構成となる。Canvasだけwidth/heightを2px縮め、SVGを同じ比率にしていない変更も混合描画の一致を保証しない。

修正では、可視窓のCanvasを固定する方式と仮想SVGの移動を整合させ、表示scrollと論理scrollを区別すること。長い軸を持つ横・縦PCP、通常/125%/400%、スクロール前後の同じ軸・線・rowIdを実ブラウザで照合すること。全点矩形150件やscrollWidthの確認だけでは位置一致の証拠にならない。今回、このスクロール条件のブラウザ再現は未実施であり、上記はソース上の座標経路の指摘である。

## R035-02 [P1] 拡大中のPCP右クリックメニューがdialog外へ出る

対象: `PcpPage.tsx:966`のcontextMenu Dropdown、`GraphExpansion.tsx:158`付近。

PCPの右クリックDropdownは`getPopupContainer={() => document.body}`を明示し、共通のpopup受け口を利用していない。native modal dialogの外側は操作対象にならない。

レビューアーが本番配信で再現した。rf_test（100行、x/y）でPCPを拡大し、図中央を右クリックすると、Focus/Delete/Clear/ResetのメニューDOMが生成されるが、dialog内ではない（`closest('dialog')`なし）。メニューは拡大画面の操作対象として現れず、Escapeを1回押すと拡大自体が終了した。仕様の「子popupを先に閉じ、2回目で拡大終了」を満たさない。

dialog内の受け口に接続し、実際にメニュー項目を操作できるようにすること。Providerの`davis:close-graph-popup`イベントもsrc内に受信処理が見当たらず、イベントを発行するだけでは閉じられない。Select/Dropdown/Tooltipの実際の開閉状態とEscapeの処理を合わせて確認すること。

## R035-03 [P2] フィットから縮小すると75%を飛ばす

対象: `fullstack/frontend/src/features/common/GraphExpansion.tsx:376`。

フィット時のstepIndexは-1であり、縮小ボタンが配列index0の50%を選ぶ。設計6.2はフィットからの「−」を75%と規定している。

レビューアーが本番配信のIrisで、拡大→フィット→縮小1回により50%となり、縮小ボタンが無効になることを確認した。フィット→75%→50%の順と、100%からの縮小を検査すること。

## R035-04 [P2] 通常スクロール復元と倍率変更時の中心保持が未実装

対象: `GraphExpansion.tsx:110,124,257`、`GraphPanel.tsx:140`付近。

通常スクロールの保存先はslotの祖先`[data-graph-scroll]`を探索しているが、src内にこの属性を付ける箇所がない。実際のスクロール容器はhost内のgraph-panel-viewportであり、slotの祖先でもない。このため保存・復元処理が対象を取得できない。

setZoomはzoom値を書き換えるだけで、表示中央の論理位置の保持やフィット時の原点復帰を行っていない。拡大先でscrollを変更した後に通常表示へ戻すケースも保証されない。

実viewportのscroll位置を保存し、数値倍率変更では旧scale/newScaleから中心を引き継ぎ、フィットで原点へ戻し、終了時は通常表示の位置を復元すること。非ゼロscrollを使い、開始前・拡大中・倍率変更後・終了後を実測すること。

## R035-05 [P2] PCPの400%描画バッファが表示倍率に追従しない

対象: `PcpPage.tsx:129〜133,359〜365`。

CanvasバッファはframeSize×devicePixelRatioだけで作られ、共通の実表示scaleを反映していない。PCPのuseGraphViewport呼び出しも、このコンポーネント自身が返すGraphPanelのProviderより上にあり、その子Providerの値は取得できない。読み出した値からもscaleは捨てられている。

400%では既存バッファをCSS拡大するだけになり、設計6.3の表示scaleとDPRに応じた描画更新を満たさない。可視窓・既存仮想化を維持した上で、子側で正しいviewport情報を受ける構造と描画バッファを整合させること。DPR1/2・400%で実バッファ寸法、可視領域、メモリ、文字・線の画質を確認すること。データ削減や黙った画質低下で代替しないこと。

## R035-06 [必須] 合格・N/Aの判定を受入条件に合わせ、未実施を完遂すること

初版REPORTのV01は13件合格・36件N/Aで全体合格になっている。`s5-full.json`のN/Aには「結果未生成・条件未成立」「インスタンスなし」が含まれる。検証計画は各分析結果・必要データを用意して全G行の入口を確認することを要求しており、未生成は対象外の根拠にならない。別ログで補完済みならG行と証拠を明示して統合し、未補完は未実施へ訂正すること。

V05も、G20の通常0件・拡大150件の不一致が明記されているため合格にできない。G16の0件についても「変更前からの可能性」は確定した原因ではない。設計7は既存の座標不具合が検証を妨げる場合の修正を対象としている。これらを既存由来という理由だけで除外しないこと。

V07・V10・V11・V12一部は、報告が未実施と明示している点は正確だが、依然として必須条件が未達である。V02/V03/V08/V09も、unit・ラベル・実装上の維持のみで実画面の全条件を満たした扱いにしないこと。

例えば`tests/graphExpansion.test.tsx`の「StrictModeでhostが重複登録されない」という試験は、setupでReact.StrictModeを使用していない。また同ファイルの3件はroute/dataset変更や非同期API増分を検査していない。試験名を実施証拠として転記せず、実際の条件を確認して判定すること。

**実ブラウザで残る操作検証を必ず実施すること。静的確認、入口だけの確認、同件数だけの確認で代替してレビューOKを求めないこと。** 各G行の到達と代表操作、全倍率の寸法、スクロール後のrowId集合、進行ドラッグの取消し、popup、外側Modalの入力保持、非同期処理とAPI増分、DPR/ブラウザ倍率を証拠へ結び付ける。対象限定確認から始め、修正影響のない巨大な全体テストを繰り返す必要はない。

## 今回の確認記録

- 本番UI: `http://127.0.0.1:8420/`、読み込まれたbundleは`index-D2dZy7j0.js`。viewport1280×720、DPR2、Codex内蔵ブラウザ。
- 実操作: Irisで拡大/縮小/戻す、rf_testへdataset切替、再拡大、右クリック、Escape。R035-02/03を再現。dataset切替後の再拡大は成功し、当該経路は不具合として扱わない。
- `source-hashes-4.txt`の現行ファイルとの照合は不一致なし。実装報告の振動追跡ログは2画面サイズでdistinct=1を示すが、R035-01の長い軸・scroll時の座標一致を検査していない。
- 対象限定テスト: frontendで`npm run test -- tests/graphExpansion.test.tsx tests/graphCoordinates.test.ts`を実行。graphCoordinatesの4件成功を確認したが、graphExpansionの結果と全体終了が数分間得られなかったため中断（終了コード1）。7件成功とは記録しない。停止原因は未特定であり、製品不具合とは断定しない。レビュー中に製品コード・buildは変更していない。

修正版のソースsnapshot、対応表、操作ログを同じ035フォルダの対応報告へまとめること。仕様どおり、配信に影響する修正後は通常buildと最新配信物での確認を行う。**上記指摘と必須未実施項目が解消するまで承認保留。**
