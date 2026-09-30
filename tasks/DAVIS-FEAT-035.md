# DAVIS-FEAT-035

状態: 実装済み・レビュー待ち（2026-09-19 の拡大中popup・PCA Canvas解像度・選択メニューの追加修正を検証済み。Feature 035 全体のレビューOKは未受領）

## 目的

全対象グラフの拡大表示をGraphPanelへ統一し、ポインタ座標・状態保持を保証する。対象外の拡大は撤去する。

## 正本

- [詳細設計](../feature/35_graph_expansion_design.md)
- [移行・撤去台帳](../feature/35a_graph_expansion_inventory.md)
- [検証計画](../feature/35b_graph_expansion_validation.md)
- [設計作業の記録](DAVIS-FEAT-035-DESIGN.md)
- [順次実装プロンプト](../feature/35_graph_expansion_implementation_prompt.md)
- [通常表示レイアウト修正報告](../feature/analysis-specs/reviewqueue/035/REPORT-007.md)
- [通常表示レイアウト横断修正報告](../feature/analysis-specs/reviewqueue/035/REPORT-008.md)
- [追加グラフ表示修正報告](../feature/analysis-specs/reviewqueue/035/REPORT-009.md)
- [通常表示レイアウト・可変ラベル横断修正報告](../feature/analysis-specs/reviewqueue/035/REPORT-010.md)

## 範囲

共通GraphPanel/GraphExpansion/座標変換/CSS、main/AppShell接続、台帳G01〜G51の所有ページと描画子、X01〜X12の拡大撤去、関連テストと証拠、通常build、run-production.batでの確認、レビュー指摘の修正・再検証を含む。KeepAliveや共有選択コンポーネントは必要な接続変更だけとする。通常buildは実装スコープに含まれており、追加のビルド指示待ちは不要。

## 2026-09-19 追加修正

- 拡大中の軸ラベルTooltipをdialog内のpopup領域へ出し、最前面で操作可能にする。
- PCAバイプロットと同じCanvas viewport取得経路を持つPCA行列・Q-Qプロットで、表示倍率とDPRに応じた描画バッファを再生成する。
- 拡大バー右端に、既存の選択状態・集合演算・解除・Focus・Delete・全復帰を使う選択メニューを追加する。PCPだけは既存のヒット判定も表示する。
- 選択意味、Redux状態、描画host同一性、KeepAlive、分析API要求回数を変更しない。

## 禁止事項

- 選択可能性・集合演算・統計仕様・APIの変更、描画方式の一律統一。
- データ削減・サンプリング変更による拡大性能の代替、表の新しい拡大機構の追加。
- 旧targetIdの互換層、旧新拡大sessionの同時運用を最終成果物へ残すこと。
- 無関係な未コミット変更の上書き、コミット/push。
- 最初から巨大な全体テストを行うこと。

## 開始条件

実装指示を受けた後、S0でbranch/HEAD/git statusと対象ファイルの既存差分を記録する。他の進行タスク・同じファイルの実装と競合しない担当範囲を確定する。実装担当にはAGENTS.mdのclaude_coder等の委譲規則を適用する。

## 完了条件

- G01〜G51の移行と必要な操作検証が合格。
- X01〜X12が対象外として整理され、既存の拡大入口が撤去済み。
- V01〜V15の必須ケースが証拠付きで合格し、該当しない項目の根拠が明記されている。
- 描画方式と既存選択仕様が維持され、旧拡大参照が残っていない。
- 通常buildに成功し、最新の変更版をrun-production.batで確認済み。
- 差分・文書・テスト記録が同期している。
- reviewqueue/035に報告書・修正対応を格納し、レビュー担当から最新の修正版への明示的なレビューOKを受領している。

## 段階と状態

| 段階 | 状態 | 証拠 |
|---|---|---|
| S0 基準取得 | 完了 | branch master・HEAD 70cbfe44・既存差分を保持し対象記録へ集約 |
| S1 共通部・代表系統 | 完了 | 共通4ファイル＋G01〜G03・G46、unit 14件・実ブラウザS1 16/16相当・rowId一致 |
| S2 基本可視化 | 完了 | G04〜G19・G50〜G51、unit 50件・実ブラウザS2 28/28 |
| S3 分析可視化 | 完了 | G20〜G45・G47〜G49、unit 41件・実ブラウザS3 38/38＋実行後到達 |
| S4 撤去 | 完了 | X01〜X12、旧FocusMode削除、旧参照0、s4-verify 7/7 |
| S5 全対象検証 | 完了 | 指摘済み9グラフの限定再検証に加え、G06〜G11・G14〜G28・G31〜G51の通常表示監査・修正を完了。追加の棒グラフ・分析図修正はREPORT-009、頑健性分析・重複表題・HTML図の通常幅・可変SVGラベル保護はREPORT-010。対象Vitestと全Vitestを再実行した。 |
| S6 通常build・本番起動 | 完了 | 最新差分の `npm.cmd run build` 成功、8420の既存待受サーバーが最新 `dist/index.html` と一致してHTTP 200を返すことを確認。新規 `run-production.bat` は既存待受のためbindしなかった。 |
| 実装後レビューループ | 監視待ち | reviewqueue/035 REPORT.md初版格納、10分間隔、明示的なレビューOKで終了 |

## 停止条件

座標・状態保持の共通方式がS1で成立しない場合は全図へ広げず再設計する。分析/選択の仕様変更、互換設計、対象外の大規模変更が必要な場合は判断を求める。S6も必須として完遂する。環境・権限等で実行できない場合は原因と未実施項目を記録し、実行できていないテストやbuildを完了扱いにしない。レビューOK未受領の間は監視・指摘修正を継続する。

## 実施記録

- 2026-09-19: 拡大中の軸ラベルTooltipを dialog 内 popup root へ送るようにし、native dialog の背面に回る不具合を解消した。PCAバイプロット、主成分散布図行列、Q-Qプロットは GraphPanel 子で得た表示倍率・DPR・revision を既存Canvas描画effectへ中継し、Canvasを再作成せず描画バッファだけを更新する。拡大バー右端には選択数、集合演算、解除、Focus、Delete、全復帰を含む既存選択メニューを追加し、PCPだけはヒット判定を表示する。対象Vitest 6ファイル50件と通常buildは成功。IrisでPCA実行後、拡大中のバイプロット125%表示、選択メニュー、設問ポップアップ前面表示を実画面で確認した。8420は起動前から別プロセスが待受しており、新規起動はbindしなかったが、HTTP応答が最新 `dist/index.html` と完全一致することを確認した。詳細は REPORT-011。Feature 035全体のレビューOKは未受領のまま維持する。
- 2026-09-19: 通常表示を横断して追加修正した。頑健性分析の結論選択欄を折返し可能にし、固定幅のHTML図を親列幅へ追従させた。GraphPanelと内側Cardの重複表題を整理し、TGT相関円、CA/MCA/FAMD、分布、決定木、意外性散布図などの可変ラベルを短縮・境界内配置・完全名参照へ統一した。焦点ペアCanvasは300 x 210の表示矩形でも論理座標の選択が保たれる回帰を追加した。対象Vitest、全Vitest 64ファイル285件、通常build、`run-production.bat` の8420 HTTP 200、通常幅の横超過なしを確認した。詳細は REPORT-010。Feature 035全体のレビューOKは未受領のまま維持する。
- 2026-09-19: 追加で確認された棒グラフ・分析図の表示不具合を修正した。対話型棒グラフは共有L1/L2行色でカテゴリ内訳を塗り、hover詳細を絶対配置にした。意外性散布図と補正V熱マップは軸・注釈・見出しの余白を統一し、ランキングと判別図の重複見出し・端部ラベルを整理した。決定木の余分な外枠、重回帰設定欄の行高、PCA凡例の横並びも修正した。対象Vitest 9ファイル28件、全Vitest、通常build、8420の実画面を確認した。詳細は REPORT-009。Feature 035全体のレビューOKは未受領のまま維持する。
- 2026-09-19: 追加の画面確認で、対話型棒グラフが共有L1/L2色解決を参照していないこと、hover詳細が通常フローに入って描画領域の高さを変えることを確認した。あわせて、意外性象限図の下側注釈とX軸ラベルの競合、補正V熱マップだけの縦書き列見出し、ランキング・判別図のGraphPanelと内側Cardの重複見出し、SVG端部ラベルの切れ、決定木の余分な外枠、重回帰設定欄の過大な行高、PCA凡例の横並び強制を対象に修正を開始した。共通のSVGラベル境界調整は存在せず、既存の `truncateText` と個別のtooltip/ellipsisだけであることを確認した。
- 2026-09-18: 利用者の追加指示により、既に個別修正した G01〜G05・G12〜G13・G29〜G30 を除く42グラフ（G06〜G11・G14〜G28・G31〜G51）の通常表示を再監査する作業を開始した。確認観点は、描画 surface と intrinsicSize の一致、surface 内に混在した説明・凡例・Card 境界、不要な縦横スクロール、ResizeObserver の自己参照、横並び強制、popup の transformed surface 内への閉じ込めである。開始時の branch は master、HEAD は 70cbfe44 で、既存の未コミット変更を保持する。
- 2026-09-19: 42グラフの横断監査・修正を完了。通常の intrinsic GraphPanel を自然高・非変形とし、SVG/Canvas の border-box 化を共通適用した。G06/G07 は親列幅追従、G08 は SVG境界、G14 は実外形寸法、G16/G17 は Canvas外枠、G19 はモザイク実外形と折返し、G28/G33 は縦横比を個別修正した。限定Vitest 7ファイル57件と通常buildは成功。隔離データ環境の分布・記述統計画面で内部スクロール0、ページ横超過0、console error 0を確認した。詳細は REPORT-008。既存 Feature 035 全体のレビューOKは未受領のまま維持する。
- 2026-09-18: 通常表示レイアウト修正を実施。GraphPanel は通常時に fit/zoom transform を適用せず、intrinsic host/viewport の flex 縮小を止めた。PCP tooltip は portal 化し、BoxPlot/Q-Q/FEDF/Loess/Relationships/Surprise は描画・凡例・説明・境界の寸法責務を分離した。`run-production.bat` の 127.0.0.1:8420（1440x900）で BoxPlot 900x1622、Q-Q 680x440、FEDF 1097x727、Loess 790x530、Relationships heatmap 450x300・pair 600x420、Surprise quadrant 500x400・heatmap 400x300、PCP 1129x598 を確認し、対象 viewport の縦スクロール高は surface と一致、ページ横方向のはみ出しはなかった。対象 Vitest 5ファイル13件と `npm.cmd run build` は成功。詳細は `reviewqueue/035/REPORT-007.md`。既存 Feature 035 全体のレビューOKは未受領のまま維持する。
- 2026-09-18: 通常表示の図ごとの zoom レイアウト不具合を受け、Feature 035 のレビュー対応を再開。GraphPanel が非拡大時にも intrinsic の fitScale を適用していること、描画領域へ Card・説明・border が混在していること、PCP の手製 tooltip が transformed surface 内にあることを確認した。対象の未コミット変更は保持し、V03（実寸法）、V04（スクロール）、V10（popup）を最新差分で再検証する。
- 2026-09-14 S0〜S6を実施。開始時 branch master・HEAD 70cbfe44・既存の未コミット変更をresetせず保持。
- 共通基盤4ファイル新規、G01〜G51移行、X01〜X12撤去、FocusMode.tsx削除、旧テスト対応付け。
- frontend全suite 63ファイル258テスト合格、tsc成功、通常build成功（bundle fec2884a・2026-09-14 23:47 JST）、8420配信一致・代表操作確認。
- V07・V10・V11・V12一部は未実施のためテスト完了としない。詳細は reviewqueue/035/REPORT.md（初版）。
- 監視対象 reviewqueue/035、最終確認 2026-09-14 23:55 JST、処理済みレビューなし。
- 監視タイマー識別子 6331181c（10分間隔・セッション限定）。重複タイマーなし。
