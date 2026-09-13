# 設計参照計算・契約の検証報告

実行日：2026-09-12。対象は同梱の独立参照計算とPydantic入力契約。DAVIS-PCP本体へ新分析を実装した結果ではない。

## 1. 実績

`test_reference_design.py`を実行し、42ケースが成功した。ログは`pytest_output.txt`、機械可読結果は`pytest_results.xml`。入力例12件はPydanticで検証し、JSON Schema12件を生成した。数値・割合の有限性、構文エラーの拒否例も含む。

```
42 passed in 1.13s
```

上記時間は実行ログに記録された実績であり、実装作業や本体性能の見積ではない。

## 2. 実行環境

Python 3.13.5。NumPy 2.3.5、SciPy 1.17.0、Statsmodels 0.14.6、Pydantic 2.13.4、pytest 9.0.2。詳細はenvironment.json。

この環境は添付requirementsやPyodide版と同一ではない。Statsmodelsは数値oracle用途だけで、製品に新規導入する依存ではない。

## 3. 実行した比較

CAの2×2解析解、表倍率・転置・零周辺、MCAの指示行列CA同値・全慣性・射影・度数複製・Benzécri、FAMDの標準化・全慣性・カテゴリ重心・寄与・η²、回帰のStatsmodels classical/HC3・frequency展開、surveyの手計算PSU/FPC/領域0スコアを検証した。

ML因子分析は合成相関の再構成、profile勾配の有限差分、Varimax/Promaxによる共分散不変性と得点変換を確認した。選択型は解析解とStatsmodels ConditionalLogit、回答者反復、frequencyブロック展開、分離LP、順位stageの積を確認した。

reference_kernels.pyは、純粋な整った配列を受ける数学参照実装である。元アプリのコードブック、欠損分類、API例外、結果保存、UI、網羅的な業務入力検証を含まない。例として参照CAは独立表にrank0を返すが、本体サービスはCA_ZERO_INERTIAとして422に整形する設計である。参照choiceの最適化手順も製品設計の全サービスフローを置換しない。

## 4. 未実施

DAVIS-PCP新規API/結果store/FE/PCPの統合試験、既存suite全件実行、local/staticのE2E、Pyodide内HiGHSスモーク、R FactoMineR/factanal/surveyの実行照合は未実施。本体への実装はこの依頼の成果物ではない。Rscriptは作業環境で利用できなかった。

42ケースは代表的な数式・契約の検証であって全受入IDを消化した件数ではない。未実施項目はtasks/ACCEPTANCE_AND_HANDOFF.mdに具体的な実装試験として引き継いだ。

## 5. 再実行

リポジトリルートから `cd feature/analysis-specs` で本書群のルートへ移動して実行する。インターネットのある環境では任意の独立venvへrequirements-reference.txtを導入できる。実行時そのものはネットワーク不要。

```bash
python -m pip install -r validation/requirements-reference.txt
python contracts/analysis_requests.py
cd validation
python generate_fixtures.py
python -m pytest -q test_reference_design.py --junitxml=pytest_results.xml
```

fixtureは合成データ。ユーザーのアンケート回答は含めていない。generate_fixtures.pyは期待値を再生成するため、意図しないoracle更新を避ける場合は実行せず既存fixturesでpytestだけを動かす。
