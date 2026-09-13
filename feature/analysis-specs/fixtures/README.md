# 合成fixture

033b EFA／033c CFAの追加データとoracle条件は[拡張fixture仕様](FACTOR_EXTENSIONS_FIXTURES.md)を参照する。追加数値fixtureは未生成であり、既存ML期待値を順序相関・ロバストCFAの検証実績として扱わない。

すべて個人を含まない人工データ。seed=20260912。数式の参照検証用であり、実際のアンケート結果やDAVIS-PCPのAPI応答ではない。

`ca_2x2.csv`は手計算可能な二元表。`mixed_survey.csv`はMCA/FAMD用。`linear_regression.csv`はfrequency展開比較用。`factor_exact_correlation.csv`は6変数2因子の既知相関を標本相関として厳密に持つデータ。`conjoint_choice_analytic.csv`はbrandだけの2択・3対1で係数=log(3)/2。価格列はなく、価格の推定やWTPを検査するデータではない。評点・順位テンプレートはそれぞれ別CSV。

`expected_values.json`の生成器はvalidation/generate_fixtures.py。将来の実装試験ではこのJSONを固定したoracleとして読み、実装値に合わせて自動上書きしない。生成時の環境はvalidation/VALIDATION_REPORT.mdに記録。
