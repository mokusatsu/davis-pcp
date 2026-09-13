# Feature 033b・033c：一次資料と設計判断

確認日：2026-09-13。製品の初期値、対応範囲、API、停止条件は製品設計であり、原典が要求する普遍的な規則ではない。公開文書の確認はソフトの実行・数値検証を意味しない。

## 1. 確認した一次資料

|ID|資料|確認内容と対応|
|---|---|---|
|FX-POLY|[polycor::polychor](https://search.r-project.org/CRAN/refmans/polycor/html/polychor.html)|潜在二変量正規・閾値・two-step/MLの区別。033bのtwo-stepを選定し、同条件のoracleにする|
|FX-FA|[psych::fa](https://search.r-project.org/CRAN/refmans/psych/html/fa.html)|MINRES/OLS/ULSの近縁性、目的関数差、斜交のpatternとstructure。方法名だけの一致を同値としない|
|FX-ULS|[factor_analyzer公開ソース](https://factor-analyzer.readthedocs.io/en/latest/_modules/factor_analyzer/factor_analyzer.html)|ULS profile目的の実装照合対象。パッケージの既定補完や回転後共通性を無検査で採用しない|
|FX-ML|[R stats::factanal](https://search.r-project.org/R/refmans/stats/html/factanal.html)|通常MLの正規性、独自性下限、回転と得点。033の連続経路を参照|
|FX-SMOOTH|[psych::cor.smooth](https://search.r-project.org/CRAN/refmans/psych/html/cor.smooth.html)|相関行列の非正定値と平滑化。033b初期版は停止し原行列を変更しない|
|FX-PA|[psych::fa.parallel](https://personality-project.org/r/psych/help/fa.parallel.html)|観測・乱数比較と順序相関の利用。033bは項目別置換・全相関固有値という製品規約を明示|
|FX-CAT|[lavaan categorical data](https://lavaan.ugent.be/tutorial/cat.html)|WLSMVのDWLS点推定と完全重み情報を用いる補正、順序経路のFIML制限|
|FX-EST|[lavaan estimators](https://lavaan.ugent.be/tutorial/est.html)|MLRのHuber–White SEと補正検定、normal/Wishartの違い。CFAはnormal規約|
|FX-CFA|[lavaan CFA example](https://lavaan.ugent.be/tutorial/cfa.html)|項目・因子を指定する測定モデルと結果読解。EFA回転から独立した機能|
|FX-SCALE|[lavaan model syntax 2](https://lavaan.ugent.be/tutorial/syntax2.html)|尺度設定と固定・自由パラメータ。初期CFAはmarker固定1の単純構造|
|FX-OPTIONS|[lavaan lavOptions](https://search.r-project.org/CRAN/refmans/lavaan/html/lavOptions.html)|parameterization、推論設定、sampling weightが別指定であること。解決済みオプションを保存|
|FX-FIT|[lavaan fitMeasures](https://search.r-project.org/CRAN/refmans/lavaan/html/fitMeasures.html)|通常/scaled/robustの区別、カテゴリカルのロバスト指標とPD条件。取得不能は理由付きnull|
|FX-SCORE|[lavaan lavPredict](https://search.r-project.org/CRAN/refmans/lavaan/html/lavPredict.html)|連続とカテゴリカルで異なる得点方式。順序EFA得点は初期版から分離|
|FX-CONTINUOUS|[Rhemtullaほか（2012）PubMed要旨](https://pubmed.ncbi.nlm.nih.gov/22799625/)|比較対象はロバスト連続MLとカテゴリカルLS。カテゴリ数・閾値等に依存する結果で、5件法の通常MLやN=1000の無条件保証ではない|
|FX-SIMULATION|[EFAtoolsシミュレーション文書](https://mdsteiner.github.io/EFAtools/articles/Simulation_and_power.html)|特定の潜在モデルによるカテゴリ化と相関減衰の例。数値例は全5件法に共通する減衰量ではない|
|FX-RETENTION|[Brandenburg（2024）因子数決定と相関種別](https://pmc.ncbi.nlm.nih.gov/articles/PMC11362475/)|NESTを中心とした条件別の利点・コスト。後続の負荷量推定や全PA手法へ無条件に一般化しない|
|FX-ORDINAL-PA|[Garridoほか（2013）PubMed要旨](https://pubmed.ncbi.nlm.nih.gov/23046000/)|先行研究にはPearson PAが同等以上の条件があるが、当該研究では大きな歪みへの弱さを示し順序PAを推奨。片方の記述だけで普遍順位を作らない|

## 2. 方法論上の採用判断

カテゴリ数やNだけの固定境界は設けない。7件法を自動連続扱いしない。順序を連続近似する場合は測定水準の変更ではなく分析上の近似として明示する。ポリコリックとピアソンは推定対象の異なるモデル化として説明する。

主要用途の同一国内一般調査・N=1000〜2000・5件法という利用条件に対して、良好な分布でのPearson＋ML/MINRESを主要選択肢とする。実際の差は同条件の感度比較で確認する。これは製品の利用条件と比較UXの設計であり、引用研究からN=1000を統計的境界として導いたものではない。感度分析の一致は同等性検定ではなく、両推定対象に共通する真のモデルの証明でもない。

最小二乗系を一つに絞って目的関数・境界制約・対角の扱い・初期値を固定する。MLを旧式の比較用だけと位置づけない。WLSMVとULSMVの普遍順位、小標本での収束保証、固定適合度カットオフによる確認済み判定は採用しない。

CFAのSE・検定・適合度は同じエンジンと同じfitに由来する値を採用する。WLSMVという指定名と実際の点推定がDWLSであることは矛盾ではない。点推定・推論の各層を保存し、単なるULSとMV補正を区別する。

## 3. 関連研究の位置づけ

カテゴリ数・分布・N依存の比較研究、ULS/DWLSの比較、推定法別適合度の研究は、普遍的な切替基準や保証を設けない背景として扱う。以下は追加精読・検証条件設定の参考文献であり、本成果物で全文精査・数値再現を実施したものではない。

- Rhemtullaほかの要旨はFX-CONTINUOUSとして確認した。全文・シミュレーションの再現は未実施。
- [順序モデルと連続モデルの仮定に関する議論](https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2020.589965/full)
- [Foreroほか：DWLSとULSのMonte Carlo比較](https://www.researchgate.net/publication/236623594_Factor_Analysis_with_Ordinal_Indicators_A_Monte_Carlo_Study_Comparing_DWLS_and_ULS_Estimation)
- [大きな順序因子モデルの推定条件](https://pmc.ncbi.nlm.nih.gov/articles/PMC6506988/)
- [Xia・Yang：順序データのRMSEA/CFI/TLIと推定法](https://link.springer.com/article/10.3758/s13428-018-1055-2)

公開文書の版は閲覧時に更新されうる。実装時のoracleは取得した版とソースhashを保存して固定し、本書の閲覧日だけをライブラリ版の固定とみなさない。
