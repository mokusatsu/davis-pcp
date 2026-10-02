# Feature 035：正則化重回帰と可搬Predict

版1／2026-10-02。承認済み「正則化重回帰と予測コード出力の設計案」の初期範囲を実装する。Feature 032 のOLSの推定・推論・保存形式は変更しない。旧形式を推測する互換読込や自動移行は行わない。

## 1. 範囲

重回帰画面の手法選択から Ridge / Lasso / Elastic Net を利用する。非加重、宣言済みfrequency、数値・カテゴリの主効果、明示確認済みordinal得点、点予測に対応する。survey、時系列/グループCV、交互作用、非線形変換、モデル内補完、目的変数標準化の設定、区間推定は初期対象外。未対応の指定は拒否し、無視や非加重への自動切替をしない。

正則化結果にOLSのSE、t、p、CI、F、調整済R²、AIC/BIC、Cook距離、leverageを付けない。RMSE/MAE/R²は記述指標であり、R²は切片の有無にかかわらず加重平均周りのTSSを使う。CV選択スコアは独立テスト精度ではない。予測評価には学習行との重複件数を表示する。

## 2. 最適化と前処理

目的関数は Σw(y−予測)²/(2Σw) + λ{ρ||θ||₁+(1−ρ)||θ||₂²/2}。切片は罰則対象外。各学習fold/最終refitの正の重みを合計nに正規化し、Ridge alpha=nλ、Lasso/Elastic Net alpha=λ とする。重みの一律倍率に不変で、固定λのfrequencyは整数展開と同じ意味になる。CVは元の行単位で分割し、頻度の複製を別foldへ分けない。

λは正の有限値。λ=0は通常の重回帰へ案内する。ρ=0はRidge、ρ=1はLassoを使用し、Elastic Netの自動探索は0.01以上1未満。ソルバー、許容誤差、反復上限、収束を保存する。未収束候補はCVで不成立として明示し、全候補不成立なら完了モデルを作らない。

カテゴリは学習foldで実際に観測された全水準のone-hotを使用する。定義済み未観測水準と定義域外の値を区別し、未知値を全ゼロへ置換しない。欠損/非該当は型付き水準であり、ユーザーの文字列コードと衝突しない。missingCodesは欠損コード全体、notApplicableCodesはその部分集合。

実際に用いた各特徴量のoffset/scaleを保存する。切片なしでは中心化しない。定数列は明示して保持し、微小分散の規則と警告を記録する。重み・モーメント計算はWindowsでlongdoubleがfloat64の場合にも対応する。表現不能な場合は明示エラーとし、偽の定数・ゼロ係数・完全適合へ置換しない。

## 3. CV

固定seedのshuffled K-foldを明示選択する。独立行の適合性についてJSON trueでの確認を必須とし、既知のPSU・層・複製ウェイト設計がある場合は拒否する。行数不足でfold数を勝手に変更しない。

分割後、学習foldだけで観測カテゴリ、定数処理、平均・SDを学習する。同じ分割で全候補を比較し、検証加重SSEの合計÷検証重み合計を最小化する。RMSEはその平方根。検証側に未学習カテゴリが現れる場合は、その行を黙って除外せずCVを不成立とする。最終パラメータで全学習対象をrefitする。

split方式、seed、割当fingerprint、候補、fold別件数/重み/SSE/収束、学習前処理監査を保存する。アプリ内の詳細は行割当を持てるが、可搬モデルには行ID一覧を出さない。上流で行った変換・補完を含む漏洩防止は未確認と明示する。

## 4. 表示と実行の分離

係数表の初期値は元単位。数値は他条件一定で1単位、ordinalは1順位得点の差、カテゴリは表示基準からの予測差を表す。切片は数値入力0・表示基準カテゴリの場合の値。元単位/比較用標準化/両方、表示基準、精度・科学表記は再学習せず、モデルID・実行係数・予測値を変更しない。

比較用標準化はb×加重SD(x)/加重SD(y)、ddof=0。カテゴリに付けず、定数yなど未定義の場合はnullと理由を表示する。原単位へ戻した値が表現不能でも、実行式が計算できれば予測を維持し、表示のみnullと理由を返す。丸めゼロと学習係数の厳密なゼロを区別する。

実行正本は targetOffset + targetScale × {fitIntercept + Σθj[(φj−offsetj)/scalej]} の固定順加算。大きいoffsetで桁落ちする元単位の展開式や画面の丸め値を推論に使用しない。初期fitのtargetOffset/Scaleは0/1だが、runtimeは一般のアフィン変換を検証可能な契約を持つ。

## 5. 入力・出力契約

- 学習: POST /models/regularized-regression。StrictなRegularizedRegressionRequestでOLS推論設定を受け付けない
- 保存: analysis-resultsのmethod=regularized_regression。manifest.portableModelが凍結された正本で、学習後のコードブックを変換辞書として参照しない
- アプリ予測: POST /analysis-results/{id}/predict、interval=none。現在のscope/revisionを検証し、古い結果への新しいデータの予測は再学習へ案内する
- 可搬出力: POST /analysis-results/{id}/export-predict、language=python/javascript/typescript、artifact=model/code/schema/readme/test_vectors/bundle、expectedModelVersion=1。columnMappingはcolumnId→外部キーの明示対応

model.json、predict.py / predict.mjs / predict.ts、input-schema.json、README、test-vectors.jsonを個別にダウンロードできる。ZIPは任意の便宜であり必須ではない。出力済みモデルは現在のデータセットを必要とせず、元のデータセットが編集されても不変。旧結果の出力も保存された版そのものを使用する。

入力はキー付きレコード。目的変数は不要。余分なキーは無視するが、必須キーの欠落を別ラベルで補わない。数値は有限float64またはASCIIの十進/指数文字列で、連続数値の欠損コードはfloat64に解釈した数値同値も適用する。カテゴリ/ordinalは文字列または安全な整数コードのみで、巨大整数・小数コードは文字列入力を要求する。boolを数値へ変換しない。空文字/null/0を区別する。

Predictは行ごとにprediction、status、warnings、modelVersionを返す。不正行はnullと理由にし、他行を巻き込まない。空batchは正常。学習範囲外の有限数値は外挿警告を付け、未知カテゴリ、数値範囲超過、未対応schema、配列長不一致などは明示的に拒否する。

Pythonは標準ライブラリ、JS/TSは標準機能だけで実行する。任意eval、exec、Function、pickle、joblib、API通信は使わない。ラベル・列名・カテゴリを実行識別子へ埋め込まない。JSONは有限値/float64往復精度で保存し、typed binary canonical encodingによるSHA-256で整合性を確認する。hashは発行者の署名ではない。

テストベクトルはモデル契約から構成した合成入力であり、学習行や行IDをコピーしない。ただしモデル自体には予測に必要なカテゴリコード/ラベルが含まれるため、匿名化を保証するものではない。

## 6. 受入試験の対応

| 設計番号 | 主な実装試験 |
|---|---|
| A01 | test_133_regularized_regression.py：3手法/λ変換/収束/固定sklearn参照 |
| A02 | 同：実offset/scale逆変換、アフィンfixture。regularizedRegression.test.tsx：表示だけの切替 |
| A03 | 同：frequency展開、一律重み倍率、fold別n |
| A04 | 同：検証値改変時も学習foldの平均/SD/カテゴリ不変 |
| A05 | test_regularized_export.py：標準ライブラリPython/Node JS/TSとアプリの照合 |
| A06 | kernel/API：切片、定数、微小分散、相関、p>n、ゼロ、全欠損、定数y、Windows数値幅 |
| A07 | runtime/kernel/UI：基準表示、未知/未観測、欠損/非該当、ordinal反転 |
| A08 | test_portable_regression.py：キー順、ラベル重複、明示mapping、欠落/余分/型 |
| A09 | runtime/API：文字列数値、空/null/bool/非有限/巨大整数/Unicode/引用符/prototype名 |
| A10 | runtime/export：丸め非依存、JSON再読込、hash、版拒否、offline実行 |
| A11 | kernel/API/runtime：大offset、表示overflow/underflow、安定実行、外挿 |
| A12 | export：合成ベクトル、行情報禁止、CV metadata allowlist |
| A13 | API/UI：OLS推論非継承、空batch、失敗、取消、dataset/revision、旧版出力 |
| A14 | API/runtime：初期版で未対応交互作用・非線形演算を拒否。将来追加時の個別検証は別段階 |

設計実験D01–D24（手法×重み×中心化×target-scale）、D25–D27（frequency展開）を製品kernel試験へ移した。これに加え、実APIで学習したモデルの独立Python/JS/TS照合と独立sklearn CV oracleで確認する。既存OLS試験、全frontend回帰、backendのunit/API・統計・survey監査はそれぞれの隔離規則で実行する。
