# Feature 033 EFA・033c CFA：設計成果物の検証報告

対象日：2026-09-13。対象は設計文書、入力契約、Schema、入力例、文書間参照。EFA/CFAの本体数値エンジンの検証ではない。

既存のartifact_qa.json、environment.json、pytest_output.txt、pytest_results.xmlは2026-09-12の参照検証記録として保持する。追加033 EFA/033c CFAの現在の検証範囲は本報告を参照する。

## 1. 検証対象

機能仕様2件、詳細設計2件、拡張契約、受入計画、fixture仕様、一次資料、ソース接続記録。実行可能入力契約は既存AnalysisContextV2を参照する独立した設計モジュールとする。文書は既存033との優先関係・初期対応・未対応・エンジン受入条件を照合する。

## 2. 実行記録

バンドルPython 3.12.14、Pydantic 2.13.5、標準ライブラリunittestで新規入力契約テスト34件が成功した（0.036秒）。複数の入力条件はsubTestで検証し、件数はunittestが報告するテストメソッド数で記録する。旧VALIDATION_REPORT.mdの42件とは合算しない。

検証内容はEFA/CFA入力例2件、生成Schema2件とPython型の一致、順序カテゴリの維持、連続近似時のCFA推定器選択、ordinal treatment混在拒否、因子割当・重複・marker・EFA自由度・欠損方針・ウェイト設定・未知キーの拒否。記録は[factor_extensions_contract_output.txt](factor_extensions_contract_output.txt)。JSON Schemaだけではmodel_validatorの意味制約を表せないため、Pythonでの再検証が必要である。

感度分析の追加検証は、明示近似確認、既定off、元ordinal制約、PA必須、主ML保持と比較MINRES固定、整合方式固定、目安の範囲・有限性、CFAへの比較入力拒否を含む。感度比較kernel、因子整合・差分値・自動要約の数値試験は実装受入として残る。

リポジトリルートからの実行コマンド（PythonはPydantic v2が利用可能な環境を指定する）：

```text
python -m unittest discover -s feature/analysis-specs/validation -p test_factor_extension_contracts.py -v
```

文書は機能仕様・詳細設計・契約・受入計画の初期対応範囲を相互照合し、通常／scaled／robustの区別、順序得点・ウェイト・欠損の未対応条件を確認した。分割Markdown31文書のローカルリンク140件について、ファイル参照先の欠落0件を確認した（外部サイトの継続稼働や全Markdown見出しfragmentの検証を意味しない）。一括閲覧は分割ファイルから再生成する。

一括Markdown/HTMLは固定31文書から生成した。HTMLには一意のIDが43件あり、ローカルリンク202件のファイル存在と同一HTML内fragmentを検査し、欠落0件。外部文書への見出しfragmentは検査対象外。生成時の機械記録はfactor_extensions_artifact_qa.json。Markdown描画には既存Node.jsとmarked 17.0.5を使用し、アプリのビルドは行っていない。

## 3. 未実施

- polycor/psych/factanalの新EFA数値oracle、R lavaanのCFAパラメータ・SE・適合度golden照合。
- 新しい順序標本fixtureの生成、統計シミュレーション、数値エンジン・依存の製品受入。
- 新API・結果保存・PCP・KeepAlive・local/static統合、run-production.batでの実機確認。
- 本体の全体テスト、アプリケーションビルド、配布物検証。

これらは設計作成の欠落実績を成功で埋める対象ではなく、[実装受入条件](../tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)として明示的に残す。設計上の採用エンジンを「検証済みエンジン」と表示できるのは当該受入通過後。

## 4. 再検証

契約の対象テストはvalidation/test_factor_extension_contracts.py。既存の本体suiteではなく設計入力の検証である。実行環境と結果件数は第2節で記録する。文書を変更した場合は分割ファイルを正本として、一括Markdown/HTMLおよびSHA256SUMSを更新する。

一括版の再生成はリポジトリルートから次を実行する。Node.jsとmarkedの別の配置を使用する場合は`--node`と`--marked`でそれぞれ実行ファイルとmarked.esm.jsのパスを指定する。生成対象は固定文書一覧であり、並行作業の別フォルダを取り込まない。

```text
python feature/analysis-specs/validation/publish_specifications.py
```

## 5. 033／033b集約の文書検証

2026-09-13に、旧033の連続ML資料と033b EFA資料を現行Feature 033 EFAへ集約した。ここでの記録は文書構造・生成物の検証であり、EFA/CFAの数値エンジン受入ではない。旧VALIDATION_REPORT.mdの42件を含む既存の歴史的検証記録は変更していない。

バンドルPythonでpublish_specifications.pyを実行し、現行の一括閲覧対象29文書、HTML ID 41件、ローカルリンク205件、欠落0件を確認した。旧033、033b、033B設計は移動案内として残し、一括閲覧の正本文書集合から除外した。新033仕様・新033設計、033cからの033参照、EFARequest／efa.schema.json／入力例への入口、EFA-B01〜EFA-B22の所属を確認した。

SHA256SUMSは現行86エントリを再計算し、全エントリの再照合で不一致0件を確認した。033cから新033への第2節・第6節参照、拡張契約から新033設計第7節への参照は、対象見出しと一致することを確認した。
