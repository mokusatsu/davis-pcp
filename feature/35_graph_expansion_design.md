# Feature 035 グラフ拡大表示の共通化設計

版: 1.1 / 更新日: 2026-09-14 / 状態: 設計書作成済み・実装未着手

- [移行・撤去台帳](35a_graph_expansion_inventory.md)
- [検証計画](35b_graph_expansion_validation.md)
- [設計タスク](../tasks/DAVIS-FEAT-035-DESIGN.md)
- [実装タスク](../tasks/DAVIS-FEAT-035.md)
- [35→35a→35bの順次実装プロンプト](35_graph_expansion_implementation_prompt.md)

## 1. 目的と確定範囲

全対象グラフを共通Reactコンポーネント GraphPanel に所属させ、拡大開始、画面フィット、倍率変更、スクロール、終了を一元化する。描画方式はSVG・Canvas・HTMLのまま維持する。

拡大前後・倍率変更後・スクロール後も、ポインタ位置と操作対象が一致することを必須とする。既存の点クリック、ブラシ、hover、カテゴリ選択、集合演算、右クリック、軸操作の有無と意味は変更しない。選択できない図へ新たな選択を追加せず、選択能力のレジストリも導入しない。

対象外の表・情報パネルからは拡大ボタン、拡大ラッパー、拡大専用レイアウトを撤去する。通常表示、表操作、保存・CSV出力、分析、中央selectionを維持する。グラフ選択の「Focus（行の絞り込み）」は拡大表示とは別機能であり、撤去しない。

対象・拡大単位の正本は移行台帳とする。既存の描画ライブラリ変更、統計計算・API・データ契約・色分け仕様の変更、表の新たな拡大設計は範囲外。

## 2. 現状と根拠

確認対象はmaster / HEAD 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31に未コミット変更を含む作業ツリー。因子分析・コンジョイントの未追跡ソースも含む。以下は静的調査による構造上の事実であり、実ブラウザでの不具合再現結果ではない。

| 現状 | 根拠 | 設計上の対応 |
|---|---|---|
| 通常・フィット・倍率指定で子のラッパー階層が変わる | [FocusMode.tsx](../fullstack/frontend/src/features/common/FocusMode.tsx) | 描画Reactツリーとportalのコンテナを固定 |
| 他の拡大対象はreturn nullになる | 同上 | 非対象をアンマウントしない |
| 50/75%をminWidth/minHeight 100%が制限する | 同上 | 描画面とスクロール範囲を明示的な寸法で管理 |
| ページごとのCol/Cardが拡大対象の外側に残る | [RelationshipsPage.tsx](../fullstack/frontend/src/features/relationships/RelationshipsPage.tsx) | 共通の画面上位領域で表示 |
| SVGへの上書きがDOMの深さに依存する | [viz.css](../fullstack/frontend/src/theme/viz.css) | GraphPanelの直属レイヤーのみを制御 |
| Canvasに固定600×420の描画バッファがある | [RelationshipCanvas.tsx](../fullstack/frontend/src/features/relationships/RelationshipCanvas.tsx) | 表示倍率とDPRに応じた描画バッファ更新 |
| SVGの座標をラッパーの矩形から計算する箇所がある | [LinearRegressionFigure.tsx](../fullstack/frontend/src/features/models/LinearRegressionFigure.tsx)、[EfaScoreFigure.tsx](../fullstack/frontend/src/features/models/EfaScoreFigure.tsx) | 実際のSVG座標系に逆変換 |
| 全ページがKeepAliveで残る | [KeepAliveOutlet.tsx](../fullstack/frontend/src/app/KeepAliveOutlet.tsx) | pageKey・datasetId・対象の有効性を照合 |
| 旧識別子を使う拡大テストが残る | [test_focus_zoom.py](../fullstack/e2e/test_focus_zoom.py) | 台帳の対象から検証ケースを更新 |

## 3. 構成と責務

新規ファイルは次の4つを基本とする。独立した管理基盤、描画エンジン、プラグイン方式は追加しない。

| 予定ファイル（fullstack/frontend/src/以下） | 責務 |
|---|---|
| features/common/GraphPanel.tsx | 常設の描画host、通常位置のslot、タイトル・拡大入口、固定構造の操作領域と描画面、寸法・倍率の提供 |
| features/common/GraphExpansion.tsx | Provider、単一の拡大session、共通dialog、開始・終了・フォーカス復帰、拡大操作バー |
| features/common/graphCoordinates.ts | client座標からSVG/Canvas論理座標への必要最小限の変換関数 |
| features/common/graphPanel.css | slot、host、操作領域、viewport、スクロール範囲、scale面、popup領域の限定CSS |

既存FocusMode.tsxは全呼出元移行後に削除する。名前だけ残した互換ラッパー、旧targetIdの別名、二つの拡大状態の同期は作らない。移行途中は旧・新双方で拡大を同時に有効化せず、完了時には新方式のみを使用する。

main.tsxでは既存FocusModeProviderの位置を新Providerに置換し、Redux・Ant Designのcontextを維持する。この位置はRouterProviderの外側なので、新Provider自身からuseLocationを呼ばない。Router内のAppShellから正規化pageKeyとdatasetIdをuseLayoutEffectで共通部へ通知し、描画前に古いsessionを終了する。GraphPanelとそのportal子は既存Router配下のReactツリーに残るため、図側のRouter contextも維持する。AppShellのヘッダー・サイドバーをfocusedで消す分岐とFocusBar配置は除去し、拡大時はdialogが上に重なる。KeepAliveのキャッシュ方針は変更しない。

## 4. 同じグラフを保持する表示方式

GraphPanelごとに一つのDOM hostを生成し、React portalの出力先をそのhostに固定する。通常はページ内slotへhostを取り付け、拡大中だけ共通dialogの受け口へ同じhostを移す。戻すと元のslotへ復帰させる。

重要な制約:

- portalのcontainer、key、描画子の型・階層を倍率や拡大状態で変更しない。通常表示とdialogへ別々にcreatePortalして切り替える方式は禁止。
- DOM操作するのはGraphPanelが生成して所有するhostのみ。Reactが直接管理するSVG、Canvas、子ノードをappendChild等で動かさない。
- 元slotには拡大直前の寸法を残し、ページのスクロール位置とレイアウトを保持する。
- グラフのデータ取得・解析・選択状態は従来の所有者に残す。Providerに行データや描画関数を保管しない。
- host移動に伴うCSS継承の差を防ぐため、グラフ自身が必要なフォント・色・背景・寸法をhost内で確定する。ページの祖先セレクタ、closest、委譲イベント、親ResizeObserver依存は移行時に点検する。
- Reactのportalイベントは元のReact親へ伝播するため、ページ親のクリック・キーハンドラが意図せず発火しないことを検証する。
- 非対象グラフは通常位置に残る。拡大操作によるreturn null、key変更、条件付きページ削除はしない。
- StrictModeのsetup/cleanup再実行でhostの重複、二重登録、誤closeが起きないよう、登録はhost同一性で管理する。

共通dialogは常設し、拡大中だけshowModal()で開く。通常時にグラフをdialog内へ置かない。閉じる際はclose()を使用する。ブラウザのtop layerを利用し、ページのoverflow・transform・Col幅の制約から切り離す。OS/ブラウザのFullscreen APIは使用しない。

規格上の根拠: [HTML Standard: dialog](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element)。showModalはモーダル表示、closeは終了のためのAPIである。具体的なReact接続とAnt Design連携は本設計の提案であり、S1の実ブラウザ検証で確認する。

## 5. 公開契約

GraphPanelの入力は以下に限定する。型名は実装時にこの責務のまま定義する。

| 入力 | 契約 |
|---|---|
| graphId | 台帳の識別子。ページを含め一意。列・設問別は表示名でなく安定したcolumnId/groupIdを末尾に付ける |
| title | 画面タイトルとdialogのアクセシブル名 |
| available | 現在のタブ・ページ・結果で表示可能か。非表示タブの図へ誤って開かないために使用 |
| sizing | responsive または intrinsic。下記寸法契約に従う |
| intrinsicSize | intrinsicの場合のみ、軸・凡例を含む描画全体の論理幅・高さ。内容変更で更新 |
| controls | 既存の軸切替・選択メニュー・図設定等を渡す枠。共通部は内容や選択可能性を解釈しない |
| children | 既存描画子。通常・拡大で同じ位置に一回だけ描画 |

GraphPanel配下ではuseGraphViewportから論理幅・高さ、実表示scale、DPR、寸法変更revisionを取得できる。propsで受け取る既存図へは所有ページから渡してよい。描画データ・選択データは含めない。

ProviderのsessionはgraphId、pageKey、datasetId、zoom、登録host、復帰slot、起点ボタンを持つ。登録情報はDOM参照と表示メタデータだけ。入力グラフの生成・解析・取得は行わない。登録されていないIDや非表示の対象の開始要求は失敗させ、現在のページを拡大状態にしない。

pageKeyはKeepAliveの正規化と一致させる（末尾スラッシュを除去し、ルートは/pcp）。datasetIdと併せて照合する。IDに実データ値や表示名を埋め込まない。

「図へ移動」ボタンは、所有ページで該当タブを選択し、GraphPanelがavailableとなった後にそのIDを開く。まだマウントされていない図のために空のdialogを開かない。要求中にroute/datasetが変わったら要求を破棄する。

## 6. 表示・倍率・スクロール契約

### 6.1 領域

host内のReact/DOM構造は常に次の順とする。

1. タイトル・操作行（拡大時は戻す、フィット、倍率操作を表示）。
2. controls領域（既存の操作。倍率を適用しない）。
3. viewport（残りの幅・高さ、overflow:auto）。
4. extent（倍率適用後の占有幅・高さを確保）。
5. surface（論理寸法で描画し、左上原点のscaleを一度だけ適用）。
6. popup受け口（surfaceの外、拡大中はdialog内）。

dialogはビューポートを使用し、操作領域の実測高さを差し引いた残りをviewportにする。固定高さの推測値で図を重ねない。戻すボタンは小画面でも常に到達可能にする。拡大操作バーのドラッグ機構は廃止し、上部固定の共通操作行へ置換する。グラフ固有のドラッグ操作は維持する。

### 6.2 フィットと倍率

Vw,Vhをviewportの内容領域、W,Hをsurfaceの論理サイズとする。

- responsive: W=Vw、H=Vh。描画側がこの論理寸法で軸・点を再配置する。fitScale=1。
- intrinsic: W,Hは図の固有寸法。fitScale=min(Vw/W,Vh/H)。図全体の縦横比を保つ。
- フィットはz=1。数値倍率100%も同じ視覚サイズとする。
- 実表示scale s=fitScale×z。extent幅=W×s、高さ=H×s。
- 倍率は50、75、100、125、150、200、300、400%。フィットから「＋」は125%、「－」は75%。
- surfaceにはtransform:scale(s)、transform-origin:0 0を共通部が一度だけ適用する。extentにはmin-width/min-height:100%を設定しない。
- 軸・凡例・点・HTML棒を含めsurface全体に倍率を適用する。固定pxのHTML要素も確実に拡大する。controls・popupにはscaleを適用しない。
- 拡大倍率のために個別グラフでzoomを再乗算しない。グラフ固有のデータ軸ズーム等が存在する場合は独立して保持する。
- フィット時は原点へ戻す。数値倍率の変更時は表示中央の論理位置を保ち、スクロール可能範囲へクランプする。
- 通常表示では従来のサイズ・スクロールを維持し、拡大sessionの倍率は適用しない。拡大終了後、元の通常スクロール位置を復元する。

intrinsicは固定viewBoxのSVG、固定論理座標Canvas、HTML棒・木・行列に用いる。responsiveはPCP等の既存サイズ追従を利用できる図に用いる。移行段階で方式を変えても、描画内容・操作意味は変えず台帳へ記録する。

長いPCP・多変量散布図行列等は、内部の仮想描画サイズと可視領域を混同しない。既存の軸間隔・スクロール設定を維持し、共通倍率は完成した描画面に一度だけ適用する。内部スクロールが必要な図では、共通extentのスクロールと内部スクロール双方について端への到達・座標一致を検証する。拡大を機にサンプリング数や表示軸を減らさない。

### 6.3 再計測とCanvas

ResizeObserverは共通viewportを監視し、同一フレーム内の更新をまとめる。scale済みsurfaceのgetBoundingClientRectから論理寸法を再計算する循環は作らない。幅・高さ0の非表示ページでは最後の有効な寸法を保持し、描画を保留する。再表示時に再計測する。

Canvasは論理サイズと表示サイズを分離する。論理W,Hの描画に対して、実表示scale sとdevicePixelRatioを反映したバッファを用い、描画context側を対応する倍率に設定する。pointer座標にDPRを掛けない。拡大・縮小・DPR変更では再描画するが、解析APIを再実行しない。SVG/HTMLは既存の描画方式を維持する。

最大倍率のCanvasメモリは実測し、既存の仮想化・タイル描画がある場合は維持する。必要な最適化は当該Canvas内部に限定し、共通部に容量推定による利用拒否や新たなデータ制限を設けない。実測で満たせないケースは未達として記録し、画質低下やデータ削減を黙って行わない。

## 7. ポインタ座標契約

全操作はclientX/clientYを入力にし、イベント対象ではなく実際に描画した要素の座標系へ一度だけ変換する。

| 描画 | 変換 |
|---|---|
| SVG | 描画座標を定義するsvgまたはgのgetScreenCTM().inverse()でclient座標を変換。viewBoxの余白、preserveAspectRatio、g transformを含める |
| Canvas | Canvas自体の表示内容矩形に対し x=(clientX-left)×logicalWidth/displayWidth、yも同様。border/paddingは親へ配置し、Canvas本体は0 |
| HTML | DOM要素への通常のhit testを維持。独自ドラッグ計算があればsurface矩形と実scaleから論理座標を求める |
| PCP等の混合描画 | CanvasとSVGオーバーレイの論理寸法・原点・スクロールを一致させる |

- client座標とgetBoundingClientRectは同じ画面座標系。scrollLeft/Topを重ねて加算しない。
- SVGのCTMがnull・逆行列が得られない、Canvasが幅/高さ0の場合は操作を無視する。原点(0,0)への偽クリックを生成しない。
- offsetX/Yや古い親ラッパー矩形への依存を除去する。tooltipは論理点を再び画面座標へ変換するか、元のclient座標を使用し、二重scaleを避ける。
- クリック許容半径・ドラッグ開始閾値など既存の画面px基準は倍率で変化させない。データの包含判定・集合演算・既存の論理単位閾値は変更しない。移行前の単位を記録し、必要な換算だけ行う。
- 点クリック優先、ブラシ開始ガード、pointer capture、右クリック、ホイール等の既存挙動を維持する。
- 拡大切替・リサイズで座標系が変わった場合、進行中のドラッグは確定せず取消し、selectionへのdispatchを追加発行しない。pointercancel/lostpointercaptureで矩形とcaptureを掃除する。
- 選択結果は件数だけでなくrowId集合の一致で検証する。既存不具合が拡大操作の座標正確性を妨げる場合はこの範囲で修正し、選択機能追加には広げない。

## 8. 状態遷移とUI

| イベント | 結果 |
|---|---|
| 表示中の対象で拡大 | 起点・通常寸法・スクロールを保存、host移動、dialog表示、fit、戻すボタンへfocus |
| 同一対象の重複開始 | no-op。hostやdialogを重複生成しない |
| 別対象の開始 | 既存sessionを終了して復帰させ、新対象がavailableなら開始 |
| 倍率変更 | surfaceのscale・extent・必要なCanvas解像度のみ更新 |
| フィット | z=1、現viewportから再計測、スクロール原点 |
| 戻す / Escape | 子popupが開いていれば先に閉じる。それ以外は共通終了処理 |
| route/dataset変更 | sessionと保留中の開始要求を破棄。KeepAliveの別ページへ持ち越さない |
| 図を含むタブが非表示・結果消失・設問削除 | session終了。元slotが無ければhostを安全に解放 |
| 結果・選択・色の通常更新 | 拡大状態を保持して既存描画更新。再解析を誘発しない |
| ウィンドウサイズ/DPR変更 | 再計測・描画、進行ドラッグ取消し |
| unmount/例外 | dialog、登録、pointer capture、イベントを解放。空の画面を残さない |

終了は一つの冪等処理へ集約し、dialog closeイベントとReact cleanupの重複を許容する。通常はhostをslotへ戻してdialogを閉じ、復帰先が有効なら起点ボタンへfocusを戻す。route/dataset切替時は旧ページへfocusやスクロールを戻さず、新ページの通常動作に従う。

Ant DesignのSelect/Dropdown/Tooltip/PopoverはGraphPanel内のpopup受け口へ描画する。getPopupContainerだけで扱えないModal/Drawer等は該当箇所のgetContainerも確認する。bodyへの明示portalを残すとdialogの背面・操作不能になるため、代表例の実操作をS1で検証する。既存の外側ダイアログ内にあるビニング・補完プレビューは、拡大を閉じると外側ダイアログと入力値へ復帰する。

背景クリックでは閉じない。拡大は戻す・Escapeで終了する。共通dialogのアクセシブル名は現在の図名にする。倍率のアイコンボタンには名前を付ける。既存選択操作はcontrolsに残し、共通部で新たな選択メニューを全図へ配布しない。

## 9. 移行方針

- グラフのみをGraphPanelで包み、解析結果Tabs全体・数値表・フォームを含めない。
- タイトル・軸選択・凡例・必要なページングは図に付随する操作として残す。設定値のstate所有者は移動しない。
- Likert/MA比較は一覧・比較単位を維持。設問ごとの個別拡大を同時追加しない。
- TGT主図と軸寄与円は一つの対象。軸寄与円の独立拡大は追加しない。
- 図への誘導ボタンはgraphIdへの明示的な開始に置換し、結果表自身を拡大しない。
- 既存CSSからfocus用のSVG子孫全体指定を削除。個別図の通常サイズ制約は通常時のみに残す。
- 削除すべき旧参照と保持すべき行絞り込み・ツリー展開を台帳で区別する。

## 10. 実装段階・担当範囲

各段階は前段の証拠を確認してから進める。全体テストを初手に実行しない。

| 段階 | 変更範囲 | 出口条件 |
|---|---|---|
| S0 基準取得 | 台帳、現行対象、既存テスト、起動経路の再確認 | 対象ごとの通常操作・不具合再現・既存差分を記録。新規グラフ差分を台帳に追加 |
| S1 共通部と代表4系統 | 共通4ファイル、main/AppShell、G01〜G03・G46（PCP、Relationships、LinearRegressionFigure/Page） | 同一host維持、SVG/Canvas/HTMLの倍率・座標、popup、KeepAliveが実ブラウザで合格 |
| S2 基本可視化 | 台帳G04〜G19、G50〜G51の所有ページ・描画子 | 分布・設問・比較・PCA・TGT・ダイアログ内図を移行し対象限定テスト合格 |
| S3 分析可視化 | 台帳G20〜G45・G47〜G49 | 全分析図・タブ・動的結果の移行完了、選択仕様維持 |
| S4 対象外の撤去 | 台帳X01〜X12、FocusMode、viz.css、旧呼出元 | 対象外拡大なし、旧拡大参照0、通常の表・Focus操作維持 |
| S5 全対象検証 | 検証計画の全行、該当E2E・既存回帰 | グラフごとの証拠が揃い、未実施/未達を分離 |
| S6 本番起動確認 | ビルド更新後のrun-production.bat | 配信bundleと変更版一致、代表操作・全対象入口が本番起動で確認済み |

S1では新Provider接続と旧方式の撤去を一度に全ページへ広げず、作業途中の未移行ページは拡大入口を無効化して共存sessionを防ぐ。この無効化は移行中だけとし、最終成果物の対象図では解除する。

実装の委譲にはリポジトリAGENTS.mdを適用する。claude_coderには絶対cwd、所有ファイル、固定した設計条件、完了条件を渡す。同じworking treeの重複ファイルを並列編集しない。親が最終差分と検証を担当する。設計資料の作成では実装エージェントを起動しない。

## 11. 起動・ビルドと完了判定

[run-production.bat](../fullstack/run-production.bat)は[run-production.ps1](../fullstack/run-production.ps1)経由で起動する。現行スクリプトはfrontend/dist/index.htmlが無い場合にだけnpm run buildを実行する。既存distがある場合、ソース編集だけでは配信内容が更新されない。

ソース実装・対象テスト・開発サーバでの確認と、本番起動の確認は別ゲートだが、両方とも今回の実装スコープに含める。通常build、必要なテスト、本番起動確認、レビュー指摘修正後の再build・再検証まで実施する。ビルドについて追加の指示待ちにしない。fullstack/frontendをcwdとしてnpm run buildを明示的に実行し、生成日時・bundle hash・配信URLを記録してrun-production.batで確認する。既存distを削除して自動buildを誘発する方式や起動スクリプトの変更は不要。static buildは今回必須とする通常buildとは別の配布形式であり、別途指定された場合に追加する。

文書作成完了は実装完了を意味しない。実装完了には検証計画の必須条件とS6の証拠が必要。テスト完了・build成功後はレビュー待ちとし、レビュー担当から最新の修正版に対する明示的なOKを受けてタスクを終了する。報告・監視・指摘修正の手順は実装プロンプト末尾に定義する。

## 12. 課題・変更境界

| 課題 | 解決方針・判定 |
|---|---|
| host移動と既存DOM依存 | S1で要素同一性、イベント伝播、祖先依存、context維持を確認。不合格のまま全図移行しない |
| Canvas高倍率の画質とメモリ | 400%・DPR2・大きい図で実測。グラフ内部の描画最適化で対応し、選択対象やデータ量を変更しない |
| Ant Designのpopupと外側Modal | S1でSelect/Tooltip/context menu、S2で前処理ダイアログを実操作 |
| ドラッグ中のリサイズ | 確定せず取消し。選択結果を変えない |
| 非同期解析や図の消失 | session所有者とavailableを照合し終了。解析の取消方針は既存どおり |
| 動いている他タスクとの競合 | 開始時の差分を再確認。統計仕様・分析コードの変更を取り込んで最小のUI差分にする |
| 古いE2E | 期待仕様を台帳に合わせて更新。selectorを書き換えるだけで合格にしない |
| 起動成果物の鮮度 | S6を必須として追跡。最新ソースをbuildして配信一致を確認し、修正後も必要な再build・再検証を行う |

全図の描画方式統一、選択可能性の変更、分析API変更、後方互換層が必要になった場合は本設計の範囲を超えるため、追加の判断を求める。対象外の拡大撤去は本計画の確定範囲であり、個別の再承認は不要。
