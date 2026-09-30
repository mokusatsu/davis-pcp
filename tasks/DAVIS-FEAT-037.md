# DAVIS-FEAT-037

状態: 実装済み・実環境検証待ち

## 目的

分析画面の列選択・色分け・選択操作を整理し、FEDF の端点描画と Kendall-EMM の空結果を利用者に説明可能な状態にする。

## 変更範囲

- 単一選択 `ColumnSelect` の検索既定化
- L1 色分けの操作をグローバルなウェイト選択の右側へ移設
- Likert Comparison と Line Mosaic の上部「選択」メニュー撤去
- 焦点ペアの列選択幅の上限設定
- FEDF プロファイルの 0% / 100% 端点保持
- Kendall-EMM の対象ペア適格性・除外理由を API と画面で表示

## 禁止事項

- 中央 selection、`pcp.colorBy`、Add / Replace / Subtract / Toggle の意味を変更しない。
- Kendall-EMM の最小群サイズ、定数値、未定義の Kendall tau による除外を緩和しない。
- 既存のグラフ拡大表示・ヘッダナビゲーションの未コミット変更を上書きしない。
- 未指示の依存追加、コミット、push、全体テストを行わない。

## 利用者承認済みの判断

- Likert Comparison と Line Mosaic から「選択」メニューを外しても、操作は共通レジストリの現在値（初期値 Replace、他画面で変更された値を含む）に従う。

## 完了条件

1. 単一選択の `ColumnSelect` は明示的に無効化されない限り検索でき、複数選択の検索ダイアログは維持される。
2. L1 色分けはグローバルなウェイト選択の直後で変更でき、PCP 内に重複した列選択UIを残さない。
3. Likert Comparison と Line Mosaic に上部の `SelectionMenu` がなく、選択操作は従来の共通値で dispatch される。
4. 焦点ペアの二つの選択欄は狭い表示幅でも横にはみ出さず、設問全文へ到達できる。
5. FEDF の曲線と塗りつぶしは最小値・最大値まで閉じ、Q4 の最大値が1件のデータでも上端に斜線を作らない。
6. Kendall-EMM の空結果は、有効な数値ペア不足・選択ペアの不適格・群サイズ不足・定数値・未定義 tau を識別できる。
7. 対象ファイルの差分検査と、追加・変更したロジックの限定テストが成功する。

## 検証方針

- フロントエンドは対象コンポーネントの Vitest を限定実行する。
- FEDF と Kendall-EMM は対象の Python unit/API test を限定実行する。
- 本番用ビルドと実ブラウザ確認は別途指示があるまで実施せず、未実施として記録する。

## 開始時記録

- 2026-09-19 JST
- branch: `master`
- HEAD: `70cbfe44`
- 作業ツリーには Feature 035 / 036 などの広範な未コミット変更がある。対象フロントエンド7ファイルにも既存差分があるため、その差分を保持して局所変更のみを追加する。
- `ColumnSelect.tsx` の単一選択検索既定化は本タスク開始前に反映済みで、`tests/codebookDisplay.test.tsx` は 8件成功。

## 実施記録

- 2026-09-19: 利用者が修正方針を承認。実装を開始。
- 2026-09-19: `ColumnSelect` の単一選択で検索を既定有効化。複数選択の検索ダイアログ動作は変更していない。
- 2026-09-19: PCP 内の L1 色分けUIを撤去し、グローバルヘッダのウェイト選択直後に「色分け」ボタン、`ColumnSelect`、凡例を移設した。状態は既存の `pcp.colorBy` を共有する。
- 2026-09-19: Likert Comparison と Line Mosaic のローカル「選択」メニューを撤去し、各グラフのクリック選択は共通レジストリの操作値を引き続き使用する。
- 2026-09-19: 焦点ペアの2つの `ColumnSelect` を幅280px・親幅上限付きの折返しレイアウトにした。長い設問名は共通のラベル表示・ツールチップで到達できる。
- 2026-09-19: FEDFの評価量子点を0%から100%まで含めるよう変更し、曲線・塗りつぶしの端点をデータの最小値・最大値に一致させた。
- 2026-09-19: Kendall-EMMの返却値に `emmDiagnostics` を追加。適格数不足、選択ペア不適格、評価可能な条件なし、群サイズ不足・定数値・未定義tauによる除外数を返し、専用モードの画面で空結果の理由を表示する。

## 検証記録

- `npm.cmd exec tsc -- --noEmit`（`fullstack/frontend`）: 成功。
- `npm.cmd test -- --run tests/codebookDisplay.test.tsx tests/mosaicRequest.test.tsx tests/relationshipProjection.test.tsx tests/miningManual.test.tsx`（`fullstack/frontend`）: 4ファイル・15件成功。既知のjsdom/Ant Design警告のみ。
- `python -m py_compile app/algorithms/distribution/fedf.py app/algorithms/mining/modern_subgroup.py tests/unit/test_fedf.py tests/unit/test_modern_subgroup.py`（Codex同梱Python）: 成功。
- `pytest tests/unit/test_fedf.py tests/unit/test_modern_subgroup.py` は未実行。Codex同梱Pythonに `pytest` がなく、別途確認で `polars` も利用できなかったため、収集前に失敗した。依存追加は行っていない。
- 対象ファイルの `git diff --check`: 成功（改行コード変換予定のGit警告のみ）。
- 本番ビルド、`run-production.bat`、ブラウザでのサンプルデータ再現は、指示に従い未実施。

## 停止条件

- 既存差分と同じ行の競合を安全に解消できない場合。
- 新たな共有状態、外部契約の破壊、または仕様判断が必要になった場合。
