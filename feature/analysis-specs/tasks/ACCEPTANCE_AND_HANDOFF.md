# 実装順序・受入条件・引き継ぎ

版1.0。これは実装タスクの完了条件であり、この成果物作成時の試験実績ではない。実績はvalidation/VALIDATION_REPORT.mdを参照。

033 EFA／033c CFAは[拡張受入計画](FACTOR_EXTENSIONS_ACCEPTANCE.md)を適用する。現行033のEFA受入条件を適用し、旧ML専用資料の受入条件は使わない。CFAはEFA完成後の独立段階で、ローカルlavaanと静的実行未対応の能力境界を個別に検証する。

## 1. PR/タスク分割

|順序|変更単位|先行条件|完了条件|
|---|---|---|---|
|A|V2入力契約・共有前処理・数値共通部・結果store|基準版差分確認|既存API非破壊、scope/invalid/weight/行ID一致|
|B|CA kernel→表→回答者API→画面|A|解析解、カテゴリ選択、零質量、local/static一致|
|C|MCAとFAMDを別kernel/画面で実装|A,BのSVD/カテゴリ基盤|m/K正規化、FAMD標準化、寄与・cos2・射影|
|D|回帰core＋Taylor model_covariance|A|OLS/HC3/frequency複製、設計PSU、識別不能|
|E|EFA（Pearson ML／MINRES、Polychoric MINRES）→平行分析→回転→得点・感度比較|A|EFA-B01〜B22、ML目的関数、相関・回転不変性、得点能力規約|
|F|CJデータ検証→ratings→choice→ranking→simulate|A,D|タスク完全性、回答者SE、分離、効用・WTP|
|G|共通保存/export/PCP/E2E/配布統合|B〜F|原子的保存・idempotency・stale・KeepAlive・静的版|

UIを先に架空レスポンスへ固定して、後から数式や実装の都合でfield名・比率単位を変えない。初期にはfixtureから同じ契約のmockを生成し、API完成時にserializer契約テストを差し替える。

## 2. 既存仕様の更新リスト

Feature27のMCA部分はFeature30へ置換リンクを付ける。旧nK正規化、selected scopeにrowIds、isExplorative=false、weight未対応の無警告実行を新しい期待値に更新する。Feature27/28のPCP・ヒットテスト・スクロール等の試験は維持。

Feature17〜26のrole/scale/categoryOrder/MA/weight/provenance契約は原則維持。新APIのstrict化を既存全routeへ強制しない。既存Api AnalysisContext型にoptional拡張を無制限に重ねず、新V2を明示定義する。

statsmodels/prince/factor_analyzer/FactoMineRをproduction依存へ追加しない。NumPy/SciPy計算をlocalとPyodideで共通化する。SciPyの公開最新版への追従をこの機能追加に便乗させない。添付依存とブラウザruntimeの組合せを別々に記録する。

## 3. 受入マトリクス

|ID|確認|必須fixture/操作と判定|本体の追加先|
|---|---|---|---|
|COM-01|版競合|計算中にdata/schema変更→409、半結果未公開|test_160_new_analysis_api.py|
|COM-02|scope|空selectedは空、active配列省略422、明示未知ID422|同上|
|COM-03|分類|missing/NA/invalid、閉領域外9、literal欠損文字列衝突なし|test_170_new_analysis_context.py|
|COM-04|MA|選ばなかった子のinvalidでも親判定に反映|同上|
|COM-05|重み|negative/NaN/bool拒否、frequency整数、survey倍率不変|同上|
|COM-06|補完来歴|使用セル数・maskRevision・current values表示一致|同上|
|COM-07|保存|rowId join、非対象null、既存列上書き拒否、版+1|test_180_analysis_result_store.py|
|COM-08|再送|成功後通信失敗→同key再送はstaleでも同成功、二重列なし|同上|
|COM-09|store|半保存不可、明示delete、データ削除、再起動後GET|同上|
|COM-10|ページ|2ページ目以降を含めた選択/export、全fit数不変|同上/FE|
|COM-11|状態|KeepAlive復帰、dataset変更、古いrunSequence破棄|frontend/tests/analysisRun.test.tsx|
|COM-12|安全|有限JSON、CSV式注入、ID照合、path traversal拒否|API/FE|
|CA-01|解析解|[[30,10],[10,30]]、λ=.25、主座標±.5、χ²=20|test_100_ca.py|
|CA-02|不変性|表倍率、転置、カテゴリ順、零周辺除外|同上|
|CA-03|境界|全0/独立表/一水準、rank1、survey p=null|同上|
|MCA-01|正規化|m=3、K≠m、ΣP=1、trace=(K−m)/m|test_110_mca.py|
|MCA-02|軸|Benzécri全0時null、縮退空間、全軸寄与和|同上|
|MCA-03|射影|fit再射影・未知水準・重み倍率・MAモード|同上|
|FAMD-01|正規化|不均等カテゴリ、ddof0、trace=p+Σ(Kj−1)|test_120_famd.py|
|FAMD-02|寄与|カテゴリ重心の直接平均、λとλ²の区別|同上|
|FAMD-03|表示|相関円と個体空間分離、r²/η²と寄与率分離|同上/FE|
|LR-01|外部正解|Statsmodels OLS classical/HC3と係数・共分散一致|test_130_linear_regression.py|
|LR-02|frequency|行を整数複製した非加重HC3と一致|同上|
|LR-03|設計|層/PSU/FPC、scope外PSU0、singleton推測不能|同上|
|LR-04|モデル行列|カテゴリ基準、交互作用、切片なし、rank欠損|同上|
|LR-05|診断予測|R²種別、SE/PI、VIF、leverage複製単位|同上|
|FA-01|ML|固定相関、勾配有限差分、複数start、境界・失敗|test_140_factor_analysis.py|
|FA-02|回転|LΦL'不変、pattern/structure、得点変換|同上|
|FA-03|得点|R使用regression/Bartlett、frequency複製、未知行|同上|
|FA-04|推測|df<0/0、sampleR非正定値、survey明示拒否|同上|
|CJ-01|入力|long format、部分task拒否、ID重複、availability|test_150_conjoint.py|
|CJ-02|評点|effect code効用和0、pooled/within識別|同上|
|CJ-03|選択|3対1の解析解β=log(3)/2、P=.75|同上|
|CJ-04|順位|J−1stage、積の尤度、ties/partial未対応|同上|
|CJ-05|SE|回答者反復、frequencyブロック複製、survey倍率|同上|
|CJ-06|分離|完全/準完全分離LP、非収束・情報行列特異|同上|
|CJ-07|simulate|確率和1、ratings第一選好、range固定、WTP符号|同上/FE|
|REL-01|静的|同fixture API一致、HiGHS稼動、SVG/CSV出力|実ブラウザE2E|
|REL-02|回帰防止|既存全backend/FE統計テストが成功|既存全suite|

## 4. 数値一致基準

小規模解析解はatol1e-12、通常のSVD係数/固有値はrtol1e-9,atol1e-10を基本とする。勾配有限差分はstepと相対誤差を記録。MLの独自性・目的値は収束の違いを考慮しrtol1e-5程度から原因を検証し、失敗を通すため無条件に許容差を拡大しない。

軸符号とカテゴリ/列順をそろえる。同一固有値群は座標成分ごとの一致ではなくprojector・Gram行列・再構成で検査する。FAの異なる回転解は再現相関と因子空間から照合する。CIのt参照自由度、HC3定義、CR1補正因子、Rの欠損/row.w、AIC分散パラメータ数を一致させてから比較する。

## 5. 実装者が実行するコマンド

作業treeの依存環境を整え、新規試験を追加した後に実行する。新規API未実装の現時点でこれらが成功したとはしていない。

```bash
# リポジトリルートから
cd fullstack/backend
python -m pytest -q tests/stats_tests
python -m pytest -q tests
cd ../frontend
npm test
npm run build
npm run build:static
```

実ブラウザではlocalとstaticへ同じfixtureを投入し、各分析実行→全ページ取得→PCP選択→列保存→stale確認→再実行→export→KeepAlive復帰を行う。静的配布scriptはfullstackの二重連結を先に実在パスassertし、backend_app.zip中に新モジュールが存在することをZIP一覧で検査する。HiGHSの最小LPが静的worker内で成功しない場合、choice/ranking機能を正常としてリリースしない。

外部oracleのR環境は別途準備し、FactoMineR CA/MCA/FAMD、stats::factanal、surveyを同じ有効データで実行する。Rの既定補完を有効にした値とlistwise除外の値を直接比べない。oracle値更新は生成スクリプト・R/package版・入力hashをセットでレビューする。

## 6. 完了報告の必須内容

変更パス、採用algorithmVersion、各受入IDの結果、コマンドと実行環境、未実施試験、意図した非対応機能、旧仕様を置換した箇所、runtime差分を記載する。「テスト成功」だけでnumerical/contract/API/FE/static/R oracleのどれかを省略しない。

動作の救済として、無警告の無重み化、欠損0埋め、変数自動削除、勝手な標本縮小、分離時だけ正則化、特異値のabs化、推測不能のp=1埋めを導入した場合は本仕様未達とする。対象外機能は画面とAPIの双方で明示する。
