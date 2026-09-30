# Feature 034 再レビュー007 対応報告

日付: 2026-09-14／対象: REVIEW-007.md（G007-01〜07）。

## 修正内容

- G007-01: rankingの連動図を第1位確率の1次元図（Y=行順）に変更。全点が描画され、点選択・範囲選択ができる。残差未提供を明示し、便宜座標を作らない。handleBrushもrankingでは行順で範囲判定する。
- G007-02: 予測応答時に開始モデル世代・版を照合（resultId・dataRev・schemaRev）。fit開始時に旧予測・診断を失効させ、待機表示を解除する。保存元が旧予測に変わらない。モデル間での予測ID流用はAPI側も404で拒否されることを検証した。
- G007-03: 診断にresultId・要求世代をひもづけ（diagResultId・diagSequence）。表示は現在のモデルと照合し、モデル変更・dataset変更で古い表と待機状態を初期化する。成功・失敗・finallyの各経路で世代照合する。
- G007-04: diagnostics exportを実際のタスク／ステージ診断に接続。conjoint_run.pyでdiagnosticRows（respondent_intercept/stage/taskの実体行）をdetailsに保持し、exportはその列・値を返す。件数はtotalと一致することを検証した（4回答者→stage4＋task4=8件）。旧来の行確率フォールバックは診断実体がない場合のみ。
- G007-05: 効用範囲の下限・上限を独立保持し、反対側を補正しない。不正な大小は表示＋実行時検証（inputErrors・canRun連動）で扱う。canRunにも範囲条件を追加し、報告との不一致を解消した。
- G007-06: dataset変更effectでsaveSequence・diagSequenceも進め、保存・診断の待機状態を明示的に解除する。保存応答は開始dataset・世代で照合し、旧応答の通知・再取得を防ぐ。startedResultIdのvoid捨ては残さず、保存要求自体が開始モデルにひもづく構造を維持した。
- G007-07: fit開始時にsetRowsLoading(false)で明示的に処理し、無効化された要求のfinallyへ依存しない。dataset変更effectでもsetRowsLoading(false)・setDiagLoading(false)を追加した。

## 検証

- FE型検査: tsc -b 成功。本番ビルド: vite build 成功。
- 実ブラウザ: test_conjoint_e2e・test_cj_gui2・test_cj_gui3・test_cj_gui4の計8 passed（8420配信）。
- バックエンド: test_conjoint_api・test_150_conjointの計13 passed。全体回帰443 passed（R依存除く）。
- 追加検証: 診断実体の件数・列・値（total=export行数）、モデル間予測ID流用404、WTP直列化（前回修正分）。
- R照合: survival::clogit係数一致、CR1手計算一致（前回実施分）。

## 残作業

実ブラウザでの代表的一連操作の画面証跡の整理、Pyodide対象外の明記、run-production.bat確認は引き続き残作業。
REVIEW-007の7項目は上記の通り完了版で対応した。未検証の受入条件が残るため全体完了扱いにしない。
