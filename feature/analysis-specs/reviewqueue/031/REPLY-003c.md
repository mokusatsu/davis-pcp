# Feature 031 FactoMineR oracle比較報告

## 環境

- Rscript: `C:\Program Files\R\R-4.6.1\bin\Rscript.exe`（R 4.6.1）
- FactoMineR: 2.17（`packageVersion` 確認）
- 欠損なしfixtureのためR側の既定補完と本体の完全ケース除外の差は発生しない。

## 入力の規約揃え

- fixture: test_120と同一の24行（seed 11、不均等3水準a/b/c＋2水準x/y、数値2列）。`.temp/famd-oracle-24.csv` にid・数値（17桁）・カテゴリを保存し、RとPythonで同一行列を読んだ。
- R側: `factor(cat1, levels=c('a','b','c'))`、`factor(cat2, levels=c('x','y'))` で列順を本体のcategory_blocks [(0,3),(3,5)] と一致させた。`FAMD(base, ncp=Inf, graph=FALSE)`。
- 本体側: `run_famd_numeric(y, G, weights=None, category_blocks=[(0,3),(3,5)])`。加重ddof0・B=(G-p)/sqrt(p)はFAMD固有の数値契約どおり。
- 加重側: `row.w=rep(c(1,2),12)` と本体 `weights=tile([1,2],12)` を対応させ、さらに本体の×100不変も確認した。

## 比較結果（符号合わせ後）

- 非加重:
  - 固有値 maxdiff: 3.1e-15（prod [1.637947, 1.343003, 0.970771, 0.590791, 0.457488]）
  - 個体座標 maxdiff/軸: 8.4e-15, 6.2e-15, 5.1e-15, 3.1e-15, 4.4e-15
  - 数値相関・カテゴリ重心 maxdiff: 全軸 1e-15〜5.4e-15
- 加重（row.w）:
  - 固有値 maxdiff: 4.0e-15（[1.755317, 1.286853, 0.884676, 0.606272, 0.466883]）
  - 個体座標 maxdiff: 全軸 4.2e-15〜6.0e-15
  - 本体×100 maxdiff: 0.0

## 成果物

- `.temp/famd-oracle.R`、`.temp/famd-oracle-w.R`（Rスクリプト）
- `.temp/famd-oracle-24.csv`（入力hashの代わりに24行・17桁数値を固定）
- `.temp/famd-oracle-eig.csv`、`famd-oracle-ind.csv`、`famd-oracle-quanti.csv`、`famd-oracle-quali.csv`、`famd-oracle-w-eig.csv`、`famd-oracle-w-ind.csv`

## 残る注意

- R側の `var$coord`・`quali.var$v.test` は取得のみで照合対象外（本体契約にない量）。
- static再ビルドとPyodide内FAMD実行、rank1実操作は引き続き残作業。
