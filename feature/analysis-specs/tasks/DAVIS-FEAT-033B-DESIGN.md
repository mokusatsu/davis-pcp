# DAVIS-FEAT-033b：EFA 実装詳細化設計書

版1.1／2026-09-13／対応：[033b機能仕様](../feature/33b_exploratory_factor_analysis.md)。本書のAPIとファイルは実装予定であり、既存実装済みという意味ではない。

## 1. 接続・責務・実装境界

画面は既存033の予定route `/models/factor-analysis`をEFAとして一本化し、POST `/api/v1/models/factor-analysis`の新入力を[別契約](../contracts/factor_extension_requests.py)のEFARequestで定義する。旧033入力の互換変換は行わない。結果methodは`efa`、schemaVersionは`factor_extensions.1`。

|予定ファイル（fullstack/基準）|責務|
|---|---|
|backend/app/api/factor_analysis.py|構文検証・サービス呼出し|
|backend/app/services/factor_analysis_service.py|scope snapshot、尺度解決、重み拒否、段階実行、保存|
|backend/app/algorithms/models/ordinal_correlations.py|閾値・ポリコリック・項目対診断|
|backend/app/algorithms/models/factor_analysis_minres.py|単一のULS系目的関数と最適化|
|backend/app/algorithms/models/factor_analysis_ml.py|033の通常ML目的関数と診断|
|backend/app/algorithms/models/factor_rotations.py|033のVarimax／Promax規約|
|backend/app/algorithms/models/factor_parallel.py|項目別置換、同一相関推定、固有値比較|
|backend/app/algorithms/models/factor_sensitivity.py|Pearson／Polychoricの同条件比較、因子整合、差分診断|
|frontend/src/features/models/FactorAnalysisPage.tsx|既存分析ページの設定・診断・結果・得点連動|

既存のcontext、codebook_adapter、analysis_columns、analysis-results、provenance、storeを接続先とする。main.tsx、KeepAliveOutlet.tsx、AppShell.tsxへ登録する。現行ソースの確認範囲は[接続記録](../references/FACTOR_EXTENSIONS_SOURCE_AUDIT.md)。共通基盤が未完成の箇所を完成済みと仮定しない。

NumPy/SciPyでlocal／Pyodide共通kernelを作り、Rのpsych・polycor・factanalを独立oracleとする。既存の本番依存方針を維持し、factor_analyzerをそのままproduction依存へ追加しない。下記ULS系仕様は検証対象を一つに絞るための採用仕様であり、検証済みと表示できるのは受入通過後。oracle不一致のまま公開せず、目的関数・制約の差を記録して設計版を改訂する。

## 2. 前処理と意味検証

1. 所有dataset、data/schema/mask revision、明示scopeを確定し必要項目だけsnapshot取得。空selectedをallへ変えない。
2. 宣言されたweightを既存resolverで解決。有効ウェイトがあれば`FA_WEIGHT_UNSUPPORTED`。dataset設定をnoneへ勝手に変更しない。
3. measurementはコードブックまたは明示した分析時指定を根拠付きで解決。未知・名義・ID等は拒否。analysis overrideはコードブックを書き換えない。
4. 許容コードを既存normalize_codeで照合。categoryOrderは許容される順序カテゴリの完全な並び、重複なし。欠損・非該当用コードを回答カテゴリへ含めない。許容領域外はinvalid。コードブックと異なるorderは確認した分析時overrideとして保存する。
5. 逆転はraw code→確認済みカテゴリ位置→最終順序を一度だけ適用する。変換済みanalysis_seriesの逆転をさらに反転しない。連続近似では最終位置を1..Kの等間隔得点にする。連続変数の逆転は前処理列として作成し、ここではreverse=false。
6. 全対象項目の有効値を持つ完全ケース集合を固定。排他主理由はinvalid→missing（無回答・非該当を含む）の順、詳細診断では両者を別件数にする。主件数は`scopeCount=fitCount+excludedCount`。不正値の除外を黙って行わず設定画面・結果で件数を表示する。
7. 連続列sd>0、順序列の実観測カテゴリ≥2、全許容カテゴリ観測済み、n>p、q<p、df=((p−q)²−p−q)/2≥0を要求。n>pは本版の数値入力条件であり一般的な必要標本数の結論ではない。df=0は記述解のみ。欠損が多いことによる母集団代表性の変化を注記する。

全ordinal treatmentならpolychoric/minres/scoreMethod=none、他はpearson。元ordinalのcontinuous_approximationだけは明示同意が必須。混在は`FA_MIXED_MEASUREMENT_UNSUPPORTED`。pairwise、FIML、correctionを構文で受け付けない。

## 3. 相関・閾値の推定

### 3.1 ピアソン

同一fit集合から標本平均、ddof=1の標本共分散S、sd、R=D⁻¹SD⁻¹を計算。行列の転置平均などで大きな非対称性を隠さず、数値丸め範囲だけ対称化した場合も数値処理として記録する。変数別・対別の有効数は全てn。

### 3.2 順序相関

2段階推定を固定する。項目jのカテゴリ累積比率Fjkから有限内部閾値τjk=Φ⁻¹(Fjk)、端は−∞,+∞。全項目で同じ完全ケース集合を用いるため、項目の閾値は全項目対で共有できる。未観測カテゴリは同一閾値または無限内部閾値を生むため停止する。

項目対のセル度数nkl、潜在標準二変量正規の矩形確率pkl(ρ)に対し、`−Σ(nkl log pkl)`をρ∈[−0.9999,0.9999]で最小化する。0件セルは和に寄与しない。度数への0.5加算、カテゴリ統合はしない。2×2も同一式でtetrachoricと記録する。

確率は条件付き正規の一次元積分を用いる。行区間[a,b]、列区間[c,d]に対し `∫[a,b] φ(z){Φ((d−ρz)/sqrt(1−ρ²))−Φ((c−ρz)/sqrt(1−ρ²))} dz`。SciPy積分の絶対・相対許容誤差1e-10を要求し、極端な尾部は生存関数またはlog差分で桁落ちを抑える。負確率・積分誤差超過をclipで救済しない。

bounded scalar solver、xatol=1e-8、maxiter=1000を初期規約とする。粗いρ格子で目的関数形状を点検し、最良区間を含めて探索する。停止成功、有限目的値、有限確率を要求。端点から1e-5以内なら境界推定として抽出を停止する。pair recordにはn、度数表、閾値参照、ρ、最適化回数、誤差、境界フラグ、0セル数、少数セル数を持つ。

相関係数だけのSEをCFA用の漸近共分散として渡さない。本版相関モジュールはCFAの標本統計量・Γ生成器の代用品ではない。

### 3.3 行列検証

対角1・有限・対称・範囲内を確認。固有値の最小値≤1e-10×最大固有値なら数値的非正定値／特異として停止し、Choleskyも要求する。これは数値許容値である。元行列と診断を失敗記録に保存し、nearPD・ridge・cor.smoothを自動適用しない。初期版は明示平滑化も提供しないため`matrixCorrection={applied:false,method:null}`。

## 4. 単一の最小二乗系エンジン

UI名「最小残差法（MINRES／ULS系）」、API extraction=`minres`、実方式`uls_profile_full_v1`。代表的な非対角MINRESの目的値 `Foff=Σ(i<j)(Rij−[L L′]ij)²`も診断値として返すが、以下の最適化目的値と同じ名前にしない。

採用するprofile ULS規約を固定する。対角パラメータu∈[uniquenessLower,1]に対しA(u)=R−diag(u)。上位q固有値・固有ベクトルから `L(u)=E_q diag(sqrt(max(d_q,0)))`、`Fprofile(u)=||A(u)−L(u)L(u)′||F²` を最小化する。対角残差を含む。目的値の2倍・半分を黙って混同しない。

これは対角の扱い・境界制約を明示したULS系の一方式であり、全実装のMINRESと完全同一とは主張しない。factor_analyzerの公開ULS profile実装と、R psychのMINRESによる再現相関を別の比較対象にする。関数名の一致だけで同値と判定しない。

optimizerはL-BFGS-B、ftol=1e-12、gtol=1e-7、maxls=50、maxiter入力値。微分可能な領域で勾配は`−2 diag(A−LL′)`、有限差分で検証する。重複固有値の境界では勾配・解の再現性を診断する。初期uはclip(1/diag(solve(R,I)),lower,1)、追加startはseedを固定したPCG64によるUniform(max(lower,.05),.95)。選択基準は033と同じ有限性・solver成功・projectedGradientInf≤1e-5、最小目的値、同値1e-10ならstart番号順。

最終共通性h²=diag(LL′)、報告する独自性ψ=1−h²。最適化変数uをψと同一とみなさず、両方と差を返す。u境界、ψ≤lower+1e-6、ψ<−1e-8、h²>1+1e-8を個別診断する。負のψを0に修正しない。無効解は記述診断のみで、得点・推論・派生列保存を無効にする。

MLは[033詳細設計](DAVIS-FEAT-033-DESIGN.md)の第3節を採用する。MLからULS系への自動切替をしない。各startの成功／失敗は残す。全start失敗は422、部分結果を有効resultIdにしない。

## 5. 因子数・平行分析

観測と比較側はともに「対角1の全相関行列の降順固有値」とする。縮約相関の共通因子固有値ではないことを`eigenvalueDefinition=full_correlation`として画面・manifestに示す。PCAを因子抽出として実行する意味ではない。

帰無データはfit行列の項目別独立置換。各項目のカテゴリ度数または連続値分布を厳密に維持し、項目間関連を壊す。反復数既定500（100..10000）、比較分位点.95、seed42。PRNG=PCG64、列処理順はcolumnIdによる固定順、返却は要求項目順。ストリームを推定startと分ける。各反復で観測と同じ相関推定・行列診断を通す。

成功反復だけへのすり替えを防ぐため、失敗反復の再抽選をしない。一つでも相関推定失敗・非正定値があれば全予定反復の診断を保存し、平行分析の候補と分位値はnull／`PA_REPLICATE_FAILED`。EFA本体が成功した場合はその結果を保持し、平行分析未完了と明示する。

分位値は各固有値順位の線形補間分位点（NumPy method=linear）。観測値が比較値を厳密に超える先頭からの連続順位数を候補kとする。0も返し、1に切り上げない。後順位で再び超えた場合は全超過順位も示す。モデルとして許されるqの範囲は別に提示し、kが範囲外でも黙って切り詰めない。利用者は手動nFactorsを確定する。

compareFactorsは追加候補の明示整数配列。主nFactorsも含む候補集合の各モデルを同じfit行・R・回転規約で計算し、各qの目的値・RMSR・共通性・診断・試行参照を返す。失敗候補を一覧から落とさない。主qの失敗なら全実行を失敗記録とし、成功した別qを主結果に置換しない。比較用モデルの得点は主qを明示して別実行するまで保存不可。

## 6. 回転・得点・推論

Varimax（Kaiser正規化）、Promax power=4、停止条件、符号・因子順は033第4節と同じ。L→Λ、Φ、S=ΛΦを保存し `ΛΦΛ′=LL′`をatol1e-8で確認。因子順序・符号変換をΦと得点にも適用。ψとh²を回転後に再確認する。Promax時ssLoadingsとvarianceRatiosはnull。

得点noneならcapabilities.rows/projection/materialize=false。ピアソン・適切な解・明示得点法なら033第5節の標本Rを使うregressionとpatternを使うBartlettを使用。定義をモデルΣへ変更しない。連続近似ではscoreInterpretation=`continuous_approximation`を列来歴にも残す。欠損予測行はnull。順序経路のEBM等は未実装として得点選択自体を拒否する。

MINRESの推論は全てnot_implemented。KMOは可逆Rから記述指標として計算できる。Bartlett球面性、通常MLのχ²/RMSEAはピアソン＋MLのみ033第6節の条件で返す。境界・不適解なら推論欄をnullとし、元の計算値が必要なら診断artifactへ参考値として分離保存する。MLの通常近似をscaled／robustと名付けない。

## 7. 保存・エラー・性能

共通manifestに加え、fit/excluded行ID、変換辞書、R、閾値、pair診断、raw loadings、最終行列、start履歴、PA設定・全反復固有値、候補比較を保存。原回答は共通snapshotだけとし、POSTに全行・全分割表を詰めずdiagnosticsのページ出力で取得する。model.npzにpickleを含めない。

canonical fingerprintは行集合と内容hash、測定水準、元／適用order、逆転、欠損、要求／適用方法、全数値設定、実装版を含む。UIの表示閾値は含めない。列順変更は出力の並びに反映するが数値の不変性試験はIDで揃える。

422の代表コード：FA_CATEGORY_ORDER_REQUIRED、FA_UNOBSERVED_CATEGORY、FA_CONSTANT_COLUMN、FA_CORRELATION_NONCONVERGENCE、FA_CORRELATION_BOUNDARY、FA_NON_POSITIVE_DEFINITE、FA_UNDERIDENTIFIED、FA_NONCONVERGENCE、FA_ROTATION_NONCONVERGENCE、FA_WEIGHT_UNSUPPORTED。各detailsはstage/columnIds/pairIds/attemptIdを含む。失敗試行は診断専用に保存し、有効モデルとしてselect/predict/materializeを受け付けない。

計算段階ごとに進捗を表示。相関推定・PAは直列化／区分実行し、logical cancel時の古い応答をrunSequenceで破棄する。推定対象を画面のページ件数へ縮めない。実メモリ不足は503、容量見積による任意の行数拒否ゲートは追加しない。

入力エラーは項目直下と上部一覧に表示し、実行失敗時には一覧へフォーカス、一覧から入力へ移動できるようにする。診断は色だけに依存せず項目名・状態・理由を表示する。表の列見出し、グラフの軸・凡例・数値表の代替表示を付ける。設定変更時の自動フォーカス移動やKeepAlive非表示ページの通知は行わない。

## 8. 実装ゲート

相関oracle→単一ULS系oracle＋ML→PA→回転と不適解→感度比較→契約/API/保存→FE/PCP→localとPyodideを順に検証。仕様のみの段階では数値一致を達成済みとしない。具体的fixture・許容差・公開条件は[受入計画](FACTOR_EXTENSIONS_ACCEPTANCE.md)に定義する。

## 9. Pearson／Polychoric感度分析

### 9.1 対象・設定・主解析との関係

初期版は全項目の元measurementがordinalの場合に提供する。カテゴリ数2以上で技術的には利用できるが、5件法中心の比較を標準UXとする。continuous混入はこの比較機能では未対応。主解析のtreatmentは全ordinalまたは全continuous_approximationとし、主解析の尺度混在禁止を維持する。

sensitivityAnalysis.enabled=trueには独立したapproximationAcknowledged=trueとparallelAnalysis.enabled=trueを要求する。主が順序モデルであっても比較側の連続近似を明示確認する。主が連続近似の場合も比較設定の同意を保存する。比較側MINRESにするため主の指定MLを勝手に変更せず、必要なら主ML＋比較用Pearson-MINRES＋Polychoric-MINRESの3モデルを保持する。

各比較子モデルのcorrelation以外は同じにする。項目ID・行集合・有効N・逆転・許容値・欠損処理・q・回転・ULS目的・制約・最適化start・シードを揃え、scoreMethod=none。Pearson側は最終カテゴリ順位1..Kを使い、原コードが1,2,4,8でもその間隔を利用しない。副結果の得点を主結果の得点として保存しない。

利用者の主結果選択は保存して自動変更しない。比較結果から「こちらを主結果として使う」を選ぶ場合は、要求と適用設定を明示した別実行にする。比較子モデルを無断でPCPへmaterializeしない。

### 9.2 分布プロファイル・推奨表示

fit完全ケースに対し、項目ごとにcategoryCounts、categoryProportions、minCategoryCount、maxCategoryProportion、floorProportion、ceilingProportionを計算する。分母は同じn。floor/ceilingは確認済み順序の両端であり、逆転適用前後の対応を保持する。除外前scopeの有効回答分布は別集計として表示し、両方のNを混同しない。

補助歪度はカテゴリ位置rに対する調整Fisher–Pearson係数とする。mk=n⁻¹Σ(r−mean)^k、g1=m3/m2^(3/2)、`G1=sqrt(n(n−1))/(n−2) g1`（n>2、m2>0）。未定義はnull。任意コードの数値間隔に依存しない。これは順位上の形状要約であり、潜在応答の正規性検定ではない。

異なるKの項目も比較するため、順位位置をu=(r−1)/(K−1)へ揃えた経験CDFの対間最大差をdistributionDistanceとして表示する。各対のCDF距離と最大対を示すが、独立2標本の検定p値は計算しない。同じ回答者の項目対であり、分布差そのものが模型誤りを意味するわけではない。

少数カテゴリ・高い端点占有・大きな|G1|は警告材料。初期の表示目安はcount<5、floor/ceiling≥.5、|G1|>1とするが、数値・目安・該当項目を併記するだけで強制routingしない。主要UXのN=1000〜2000はプロファイル説明用で、999と1000で実行可否や測定水準を変えない。

5件法では「感度比較」を目立つ提案として表示し、主結果の候補をPearson-MINRESとPolychoric-MINRESから同じ操作で選べるようにする。良好な分布を確認した利用者にはPearsonを通常の選択肢として提示する。2〜3件法は順序モデルを原則推奨、4件法や強い非対称は順序モデルを推奨、6〜7件法の良好分布はPearsonを通常候補とする。全て根拠付きの提案であり、測定尺度・設定の自動書換えではない。

### 9.3 同条件の平行分析と因子数

同じfit行列から同じ項目別置換indexを生成し、各反復をPearson側・Polychoric側へ共通供給する。それぞれの観測と帰無側には同じ相関推定を使い、両側のseedだけを同じにして別の置換標本を使うことはしない。第5節の固有値・分位点・失敗反復規約を双方に適用する。

両側のsuggestedFactorsを比較し、差・生固有値・比較分位値を表示する。PA失敗時の候補はnullであって0ではない。共通の指定qにおける負荷量比較と、PAの候補数差を別の結果とする。候補数が異なっても指定qでの感度差は計算できるが、「因子数まで一致」と表示しない。

各側の候補数で別々に抽出する結果はcompareFactorsの別モデルに置く。qが異なる行列の不足列を0で埋めて負荷量差を作らない。異なるqの直接比較はfactorCountDifferenceを返し、loadingsMetrics=null、reasonCode=FACTOR_COUNTS_DIFFER。

### 9.4 因子の整合

標準比較は同じ回転・同じqのpattern P（Pearson）、O（Polychoric）を使う。c_ab=(P_a′O_b)/(||P_a||||O_b||)を求め、Σ|c_ab|を最大化する一対一割当をlinear_sum_assignmentで解く。符号をc_ab≥0へ合わせた符号付き置換Hを保存する。整合後は`Oa=O H`、`Φoa=H′ΦoH`、structureも同じHで変換する。元の行列を上書きしない。

ゼロノルム因子、rank欠損、最適割当と次善割当の目的差≤1e-6はalignmentStatus=ambiguous。次善は採用辺を一つずつ禁止した割当の最良値を使う。q=1では次善なし。対応congruence<.85は低整合警告としてambiguousにする。.85は工学的な表示目安であり因子同一性の検定ではない。曖昧なときは候補対応を表示できるが、確定した割当変更数や「差が小さい」を返さない。

追加診断として直交Procrustesによる因子空間の近さを返せる。`O′P=U D V′`、Q=UV′、`||OQ−P||F/||P||F`をprocrustesResidualとする。Qは因子を混合するため、この値でパターン差・因子割当差を置き換えない。斜交ΦにQを適用してから単位対角へ戻さずそのまま相関として扱う実装も禁止する。初期の主整合方式はsigned_permutation固定で、Procrustesは空間診断だけとする。

### 9.5 差分指標・自動要約

|指標|定義|
|---|---|
|correlationMax/MedianAbsDifference|Rpearson−Rpolyのi<j絶対差。異なる推定対象の差であり推定誤差と呼ばない|
|loadingMax/MedianAbsDifference|共通q・整合後patternのp×q絶対差|
|communalityMax/MedianAbsDifference|各側diag(ΛΦΛ′)の項目別絶対差|
|factorCorrelationMaxAbsDifference|整合後Φの非対角絶対差。q=1は0・比較対0件|
|assignmentChangedCount|両側で確定割当を持つ項目のうち、対応後の所属因子が変わった数|
|assignmentComparableCount/ambiguousCount|確定比較対象数／少なくとも片側が曖昧な項目数|
|factorCountDifference|PA候補kP−kO。片側nullならnull|

因子割当は最大絶対負荷≥assignmentThreshold（既定.4）、かつ第2位との差≥assignmentMargin（既定.1）の場合に確定する。q=1は第2位条件なし。それ以外はunassigned/ambiguousを区別し、無理に所属を断定しない。表示用強調閾値とは別設定として保存する。

loadingDifferenceThreshold、communalityDifferenceThreshold、factorCorrelationDifferenceThresholdの既定は各.10。これらは探索比較の表示目安で、統計的同等性マージンではない。利用者変更値と判定バージョンを保存する。

自動要約assessmentは次の優先順とする。

1. 片側失敗、PA不能、境界・不適解、因子整合不能はindeterminate。計算できた差分は残して理由を示す。
2. 両側適切で整合済みかつPA候補差≠0、最大差が各目安を超過、または確定割当変更>0ならmethod_sensitive。
3. 上記の差がなくても曖昧割当項目が残ればindeterminate（AMBIGUOUS_ASSIGNMENT）。
4. 必要比較が揃い、候補数一致・全差が目安以下・全項目の確定割当変更0ならsmall_observed_difference。

画面文言は「設定した目安では差が小さい」「手法による差が見られる」「比較結果の確認が必要」。p値、同等性証明、近似の無影響保証を付けない。手法依存があれば分布・相関差・因子数・問題項目へ移動できるようにし、順序モデル側の診断も確認する。単に差が大きいことだけでPolychoricを正解としない。

### 9.6 非同期状態・保存・性能

主結果は通常のresultIdとして完了後に公開し、比較はcomparisonIdで参照する。POST EFAのenabled指定で比較まで許可されたものとし、別途黙って解析を追加しない。GET `/api/v1/analysis-comparisons/{comparisonId}`でqueued/running/completed/partial/failed/cancelledと段階・進捗を返す。POST同URLの`/cancel`で比較だけ中断できる。主結果の計算値・設定・PCP選択は比較の完了/失敗によって変えない。

両子結果、親resultId、固定snapshot、行・列hash、近似確認、共通置換ストリーム、回転・q・抽出条件、H、Q診断、差分、閾値、判定・理由を保存する。進捗は更新可能だが完成後の比較artifactは不変。同じ版での明示再実行は新comparisonIdにする。dataset版競合では新規比較を公開せずstaleとし、主結果は共通規約でstale閲覧にする。比較結果をCFAへ渡した場合は全探索結果の行集合を来歴に含める。

ポリコリック相関は概ね項目対数p(p−1)/2、PAはそれを反復数倍評価するため、Nだけで実行時間を見積もらない。最終相関・閾値・各側Rを再利用し、同じMINRES主結果は比較の一方として共有できる。local/staticとも重い仕事はキューで直列化し、進捗更新のために区分実行する。無断のサンプリング・反復数削減・タイムアウト後Pearsonだけ成功扱いはしない。
