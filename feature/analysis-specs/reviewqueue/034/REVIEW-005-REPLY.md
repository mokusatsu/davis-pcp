# Feature 034 GUIレビュー005 対応報告

日付: 2026-09-14／対象: REVIEW-005.md（CJ-GUI-01〜18）。

## 対応方針

旧ConjointPage（素のinput/select/table/ul直列・独自構文・JSON textarea）は全面改訂し、重回帰・CA・EFAと同一の操作体系（Card＋Space＋SelectColumn＋Table＋Tabs＋Alert＋Spin＋message、FocusTarget＋凡例＋図保存、中央selection・L1/L2色・範囲選択）に統合した。既存の推定・検証ロジック（runSequence・世代照合・stale・idempotency）は温存している。

## 指摘別対応

- GUI-01: mapping・availability・opt-out・価格をSelectColumn化（値=columnId・表示=ラベル＋列名、任意列はallowClear）。応答列は方式別のplaceholder・説明付き。
- GUI-02: 属性を複数選択化（カテゴリ／線形を分離）。各属性に基準水準・効用範囲（数値検証付き）を表示。価格は登録済み線形属性から選択。
- GUI-03: シミュレーションを編集表化（代替案を行・属性を列、カテゴリは学習水準から選択、線形は学習範囲を表示）。結果は確率／評点の比較表＋警告表示。JSON入力は廃止。
- GUI-04: weightMode初期値をdatasetに変更し、保存済み設定（列・種別）を選択肢に表示。結果に使用した重み種別と回答者単位適用を表示。
- GUI-05: meta.warnings・unavailableReasonsを結果冒頭にAlert表示。重要度null時は算出不能のAlert。除外数・内訳も結果要約に表示。
- GUI-06: rankingでは残差未提供を明示し、残差のある点のみY配置（便宜座標なし）。第1位確率の表示・図名を統一。
- GUI-07: 設定Cardと結果Cardを分離し、結果を「連動図」「係数・効用」「行」「予測・評価」「シミュレーション」「保存・出力」のTabsに整理。
- GUI-08: 設定行をSpace wrap化。固定幅input・固定SVG・textareaは除去し、図は利用可能幅に追従（ConjointFigureはwidth=100%）。
- GUI-09: 方式を「評点／選択／順位」の説明付き表示。応答形式を方式に合わせて提示。opt-outはratingsで無効化。入力検証エラーをAlert表示しcanRunと連動。
- GUI-10: 係数・効用にCI下限／上限・t・pを追加。WTPにSE・CI・単位・状態を追加。重要度に範囲下限／上限と範囲依存の説明を追加。
- GUI-11: 適合指標（ratings: RMSE/MAE/R²、choice/ranking: 平均NLL/McFadden/hitRate）、推測法・自由度、収束情報、タスク診断導線を結果要約に表示。行タブを新設。
- GUI-12: ConjointFigureに軸目盛り・数値ラベル・残差0基準線を追加（niceTicks）。ツールチップはラベル付きtitle。FocusTarget・SVG/PNG保存を接続。
- GUI-13: 共通getColor・L1Legend・範囲ブラシ（handleBrush）・選択演算を接続。行選択と回答者全タスク選択を区別し、中央選択からの表示更新を維持。
- GUI-14: 行・予測を共通Table化（識別・観測・予測・残差・状態を列分離、数値書式統一、先頭50件＋CSV導線）。回答者全タスク選択は独立ボタン。
- GUI-15: 属性表示をcolLabel化（ラベル優先）。予測評価の重複数は日本語で直接表示。「全ページ取得」等の実装文言は除去。
- GUI-16: 保存元・項目・列名の指定導線（LR準拠）を設け、作成列名をmessage通知。stale時は保存・予測・選択を理由付きで無効化（Alert＋行取得ゲート）。
- GUI-17: 計算・行取得・選択・予測・シミュレーション・保存の進行（Spin/loading）・失敗（Alert）・選択件数通知を各所に配置。
- GUI-18: 拡張前後の行数をAlert表示し、実行結果の対象（scope・fit・除外）を結果要約に表示。予測対象を予測タブに明示。設定変更後はdirtyタグで旧結果と区別。

## 検証

- FE型検査: tsc -b 成功。
- 本番ビルド: vite build 成功、distにconjoint-page含有を確認。
- 実ブラウザ: 新規test_cj_gui3（SelectColumn・Tabs・説明文の存在）＋既存test_cj_gui2・test_conjoint_e2eの計6 passed（8420配信）。
- バックエンド: test_conjoint_api・test_150_conjointの計13 passed（変更なし）。
- R照合: survival::clogit照合は別途実施済み（係数一致、CR1手計算一致、sandwichなし）。

## 残作業

実ブラウザでの代表的一連操作（レビュー005確認条件7）の画面証跡の整理、Pyodide対象外の明記、全体回帰、run-production.bat確認は引き続き残作業。
レビュー005の18項目は上記の通り完了版で対応した。未検証の受入条件が残るため全体完了扱いにしない。
