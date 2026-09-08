# DAVIS-FEAT-019-019B

状態: 実装済み（全体テストに既存失敗2件あり）

## 目的・範囲
設問別の分母、分布、補助統計、中央選択連携を完成し、コードブックの順序・ラベル・尺度・役割・逆転・欠損定義を表示と分析に適用する。
仕様: `feature/19_question_denominators.md`、`feature/19b_codebook_system_integration.md`。

## 完了条件
- 全体・対象・有効・無回答・非該当の分母が欠損コードとnullを正しく扱う。
- 未観測カテゴリも維持し、Top/Bottom-2と逆転を定義順から計算する。
- カードの分母切替と選択が有効行集合および中央Selectionに一致する。
- PCPのラベル・カテゴリ順序・逆転、Tableのラベル切替、マイニングとモデルのメタデータ適用が動作する。
- CSV/Excelで値ラベルを出力できる。
- コードブック更新後の再計算、補完・変換後のメタデータ保持を検証する。
- 対象テスト、全体テスト、ビルド、ブラウザ確認を区別して記録する。

## 作業境界
開始ブランチ: master。HEAD: 25ace42。
Feature 18関連を含む未コミット変更を引き継ぐ。既存変更の破棄、無関係な修正、コミット・pushは行わない。
一時検証データは `.temp/` に置き、本来のworkspaceデータは変更しない。
破壊的変更や範囲外の問題は停止して報告する。

## 検証
対象pytest/Vitestと型チェックを先行し、対象範囲の問題解消後に全体テストを実行する。
ブラウザではデータ読込、コードブック保存、カード分母切替、PCP選択、軸ラベル・逆転、表切替、マイニングを確認する。

## 実装内容
- CodebookAdapterでコード正規化、役割分離、欠損マスク、カテゴリ順序、順序得点・逆転を共通化。
- 設問別分母、未観測カテゴリを含む分布、分母切替、平均注記・中央値・Top/Bottom-2、中央Selection連携を実装。
- PCP目盛りとホバー、Tableのラベル／生値切替、マイニング条件表示、決定木・森林モデルにコードブックを適用。
- schemaRevisionを集計・列データのキャッシュと分析結果更新に反映。古いモデル結果の取得は409で拒否。
- CSV／Excelの値ラベル出力を追加。欠損コードのラベルも保持。
- 補完・変換後の既存コードブック定義とcolumnIdを保持し、新規列だけを初期推定。
- Arrowから列配列への変換時にnullが0になる問題を修正。PCPの余分な0カテゴリと空欄の誤選択を防止。

## 検証証拠
- バックエンド全体: 243成功・既存失敗2件、85.58秒。`.temp/feature19-backend-final.log`。pytest一時出力は `--basetemp=.temp/feature19-final-pytest` に固定。
- フロントエンド全体: 13ファイル・85テスト成功。`.temp/feature19-frontend-final.log`。
- TypeScript型チェック成功。ライセンス確認20パッケージ成功。
- Vite本番ビルド成功。出力 `.temp/feature19-build/`、ログ `.temp/feature19-build.log`。既存のバンドルサイズ・モジュール外部化警告あり。
- 機能API回帰: `test_summaries_denominators.py` 7テスト成功。分母、欠損、キャッシュ更新、CSV／Excel、役割分離、モデル、相関、数値型の名義尺度を検証。
- 既存コードブックAPIテストで補完・変換後の定義保持を検証。
- Playwright実ブラウザ: 83行のCSV読込、コードブック編集・保存、全83／対象82／有効80／無回答2／非該当1、割合50.0%→48.2%、40人選択、空欄1人選択、表切替、PCP目盛り5水準と逆転、マイニングの日本語条件を確認。最終実行のコンソールエラー0件。
- ブラウザスクリプト `.temp/feature19-browser.py`、証拠 `.temp/feature19-browser/result.json` と同フォルダのPNG。
- `git diff --check` 成功。

## 既存の全体テスト失敗
変更前HEAD `25ace42` のバックエンドを `.temp/feature19-baseline/` に展開し、次の2件が同様に失敗することを確認。証拠: `.temp/feature19-baseline-tests.log`。
- `tests/api/test_api.py::TestDatasets::test_get_meta`: builtinデータの行IDについて、テストは `column:id` を期待するが実装は生成ID。
- `tests/api/test_api.py::TestExports::test_selected_scope`: テストが指定する `IRIS-001` が生成行IDに存在せず、選択CSVがヘッダーのみになる。

この2件は本機能の差分による退行ではなく、全体テスト全件成功の条件は未達。テスト期待値や既存の行ID仕様は変更していない。
