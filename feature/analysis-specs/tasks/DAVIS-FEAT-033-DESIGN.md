# DAVIS-FEAT-033：探索的因子分析（EFA）実装詳細化設計書

版1.1／2026-09-13／対応：[Feature 033](../feature/33_exploratory_factor_analysis.md)。本書のAPIとファイルは実装予定であり、既存実装済みという意味ではない。

現行の入力正本は[EFARequest](../contracts/factor_extension_requests.py)、生成Schemaは[efa.schema.json](../contracts/schemas/efa.schema.json)、結果・能力・診断の正本は[拡張契約](../contracts/FACTOR_EXTENSIONS_CONTRACT.md)である。旧FactorAnalysisRequest、factor_analysis.schema.json、旧033／033b文書は参照検証資産または移動案内であり、現行APIの互換入力ではない。

初期版は全経路で非加重・完全ケースである。旧033のfrequency対応、ML専用、平行分析なし、順序相関対象外の規約を引き継がない。EFA-B01〜EFA-B22が本設計の受入IDである。CFAは[033c](DAVIS-FEAT-033C-DESIGN.md)の独立機能で、本書の完了条件ではない。

## 1. 接続・責務・実装境界

画面は route /models/factor-analysis、POSTは /api/v1/models/factor-analysis、結果methodは efa、schemaVersionは factor_extensions.1 とする。

|予定ファイル（fullstack/基準）|責務|
|---|---|
|backend/app/api/factor_analysis.py|構文検証・サービス呼出し|
|backend/app/services/factor_analysis_service.py|scope snapshot、尺度解決、ウェイト拒否、段階実行、保存|
|backend/app/algorithms/models/ordinal_correlations.py|閾値・ポリコリック・項目対診断|
|backend/app/algorithms/models/factor_analysis_minres.py|単一ULS系目的関数と最適化|
|backend/app/algorithms/models/factor_analysis_ml.py|Pearson ML目的関数、得点、参考診断|
|backend/app/algorithms/models/factor_rotations.py|Varimax／Promax規約|
|backend/app/algorithms/models/factor_parallel.py|項目別置換、同一相関推定、固有値比較|
|backend/app/algorithms/models/factor_sensitivity.py|Pearson／Polychoricの同条件比較、因子整合、差分診断|
|frontend/src/features/models/FactorAnalysisPage.tsx|設定、診断、結果、得点連動|

既存のcontext、codebook_adapter、analysis_columns、analysis-results、provenance、storeを接続先とし、main.tsx、KeepAliveOutlet.tsx、AppShell.tsxへ登録する。共通基盤が未完成の箇所を完成済みと仮定しない。

NumPy/SciPyでlocal／Pyodide共通kernelを作り、Rのpsych・polycor・factanalを独立oracleとする。factor_analyzer、psych、polycor、factanalをproduction依存へ追加しない。仕様だけで数値一致を達成済みと表示せず、oracle不一致は目的関数・制約・回転規約を確認して設計差分として記録する。

## 2. 入力・前処理・識別可能性

1. 所有dataset、data/schema/mask revision、明示scopeを確定し、必要項目だけをsnapshot取得する。空selectedをallへ変更しない。
2. 既存resolverでweightを解決し、有効なdatasetウェイトがあれば FA_WEIGHT_UNSUPPORTED を返す。weightModeをnoneへ黙って変更しない。
3. measurementはコードブックまたは根拠付き分析時指定で解決する。未知・名義・ID・MA親・countは拒否し、分析時指定でコードブックを変更しない。
4. 順序項目は既存normalize_codeで許容コードを照合する。categoryOrderは許容順序カテゴリの完全な重複なし配列で、欠損・非該当用コードを含めない。表示ラベル、辞書順、数値間隔から順序を作らない。
5. 逆転は raw code → 確認済みカテゴリ位置 → 最終順序の順で一度だけ適用する。連続近似は最終位置1..Kを等間隔得点にする。連続変数の逆転は前処理済み派生列として扱い、ここでreverse=trueを受け付けない。
6. 全対象項目に有効値を持つ完全ケースをfit集合とする。主除外理由は invalid、次にmissing（無回答・非該当を含む）とし、詳細診断では両者を別件数にする。scopeCount=fitCount+excludedCountを維持する。既存補完値の使用は共通契約のuse_current_valuesに従い、補完来歴を保存する。
7. 連続列は標本標準偏差が正、順序列は実観測カテゴリが2以上で全許容カテゴリが観測済み、n>p、1<=q<p、df=((p-q)^2-p-q)/2>=0を要求する。n>pは数値入力条件であり一般的な必要標本数の結論ではない。df=0は記述解を許すが通常の適合度推論をnullにする。

全ordinal treatmentなら polychoric/minres/scoreMethod=none、ordinal treatmentを含まない場合はpearsonとする。continuousと明示したcontinuous_approximationの混在は許可する。ordinal→continuous_approximationには項目ごとのapproximationAcknowledged=trueが必須である。真の順序treatmentと連続treatmentの混在は FA_MIXED_MEASUREMENT_UNSUPPORTED とする。pairwise、FIML、correction、重み付き推定は受け付けない。

未観測カテゴリ、定数、n不足、df負、危険な数値、非正定値は自動的に修正・削除・統合しない。失敗試行は診断として保存し、有効resultId、rows、projection、materializeには公開しない。

## 3. 相関・閾値・行列検証

### 3.1 Pearson

同じfit集合から、nをfit行数として標本平均、ddof=1の標本共分散 S、標本標準偏差 D、相関 R=D^-1 S D^-1 を求める。大きな非対称性を転置平均で隠さず、丸め範囲の対称化だけを数値処理として記録する。変数別・対別の有効数はすべてnである。

### 3.2 Polychoric

二段階推定を固定する。項目jのカテゴリ累積比率 F_jk から有限内部閾値 tau_jk=Phi^-1(F_jk) を求め、端点は -infinity、+infinity とする。全項目で同じ完全ケース集合を使うため、項目閾値は全項目対で共有する。未観測カテゴリは無限内部閾値を生むため停止する。

項目対のセル度数 n_kl と潜在標準二変量正規の矩形確率 p_kl(rho) に対し、負の対数尤度 -sum(n_kl log p_kl) を rho in [-0.9999,0.9999] で最小化する。0件セルは和に寄与しない。度数への0.5加算、カテゴリ統合、負確率のclipは行わない。2×2も同じ式でtetrachoricとして記録する。

行区間[a,b]、列区間[c,d]の矩形確率は次の条件付き一次元積分を用いる。

P = integral_a^b phi(z) { Phi((d-rho z)/sqrt(1-rho^2)) - Phi((c-rho z)/sqrt(1-rho^2)) } dz

積分は絶対・相対許容誤差1e-10を要求し、極端な尾部は生存関数またはlog差分で桁落ちを抑える。積分誤差超過、負確率、非有限確率はclipなどで救済せず相関推定失敗とする。bounded scalar solverはxatol=1e-8、maxiter=1000とし、粗いrho格子で目的関数形状を確認して最良区間を含む探索を行う。有限目的値、有限確率、停止成功を要求し、端点から1e-5以内は境界推定として抽出を停止する。pair recordにはn、度数表、閾値参照、rho、最適化回数、積分誤差、境界フラグ、0セル数、少数セル数を保存する。

相関係数だけのSEをCFAの漸近共分散として渡さない。この相関モジュールはCFAの標本統計量・Gamma生成器の代用品ではない。

### 3.3 行列検証

Rは対角1、有限、対称、範囲内を要求する。最小固有値が 1e-10×最大固有値以下なら数値的非正定値または特異として停止し、Choleskyも要求する。元行列と診断を失敗記録に保存し、nearPD、ridge、cor.smoothを自動適用しない。matrixCorrectionは applied=false、method=null とする。

## 4. 抽出エンジン

### 4.1 単一のMINRES／ULS系

UI名は「最小残差法（MINRES／ULS系）」、API extractionは minres、実方式は uls_profile_full_v1 とする。代表的な非対角診断値 F_off=sum_{i<j}(R_ij-[L L']_ij)^2 も返すが、最適化目的値と同名にしない。

対角パラメータ u in [uniquenessLower,1] に対し A(u)=R-diag(u) とする。上位q固有値・固有ベクトルから L(u)=E_q diag(sqrt(max(d_1..d_q,0))) を作り、F_profile(u)=||A(u)-L(u)L(u)'||_F^2 を最小化する。対角残差を含む。目的値の2倍・半分を黙って混同しない。

これは対角の扱い・境界制約を明示したULS系の一方式であり、全実装のMINRESと完全同一とは主張しない。factor_analyzerの公開ULS profile実装と、R psychのMINRESによる再現相関を別の比較対象にする。名称だけで同値と判定しない。

optimizerはL-BFGS-B、ftol=1e-12、gtol=1e-7、maxls=50、maxiterは入力値とする。微分可能な領域の勾配は -2 diag(A-L L') とし、有限差分で検証する。初期uは clip(1/diag(solve(R,I)),lower,1)、追加startはseed固定PCG64のUniform(max(lower,.05),.95)とする。成功候補は有限、solver成功、projectedGradientInfNorm<=1e-5を満たすものとし、目的値最小、差が1e-10以下ならstart番号順で採用する。

最終共通性 h^2=diag(L L')、報告独自性 psi=1-h^2 とする。最適化変数uをpsiと同一とせず、両方と差を返す。u境界、psi<=lower+1e-6、psi<-1e-8、h^2>1+1e-8を個別診断する。負のpsiを0へ修正しない。不適解は記述診断だけを残し、得点・推論・派生列保存を無効にする。

### 4.2 Pearson ML

MLはPearson経路だけで用いる。相関変数モデルは R approximately Sigma=L L'+Psi、Psi=diag(psi)、psi_j in [lower,1] とする。固定psiでは C=diag(psi)^(-1/2) R diag(psi)^(-1/2)=E diag(d) E' を固有値降順で分解し、L(psi)=diag(sqrt(psi)) E_q diag(sqrt(max(d_l-1,0))) for l=1..q とする。

目的関数は完全式 F(psi)=logdet(Sigma)+trace(R Sigma^-1)-logdet(R)-p を常に使う。d_q<=1でも上位qだけの簡略式へ置き換えない。SigmaのCholeskyでlogdetとsolveを計算し、Fは理論上非負、-1e-10程度の丸めだけ0へclipする。大きな負値は内部エラーとする。SigmaやRの明示逆行列は作らずsolveを使う。

可微分領域のprofile勾配は diag(Sigma^-1-Sigma^-1 R Sigma^-1) である。計算では A=solve(Sigma,I)、gradient=diag(A-A R A) とし、重複固有値またはd=1境界で不安定なstartは失敗候補として記録して有限差分で検証する。微分試験を自動差分だけへ委ねない。

最適化は scipy.optimize.minimize(method=L-BFGS-B,jac=gradient,bounds) とする。ftol=1e-12、gtol=1e-7、maxiterは入力、maxls=50。初期psi_0=clip((1-0.5q/p)/diag(R^-1),lower,1) とし、残りstartはseed固定PCG64のUniform(max(lower,0.05),0.95)をp成分独立で生成する。seed、各startの初期psi、終了status、F、iterations、projectedGradientNormを保存する。

成功候補はsolver成功、有限、projectedGradientInfNorm<=1e-5を満たすものとする。境界成分のprojected gradientは下限でgradient>0、上限でgradient<0なら0とする。F最小を採用し、差が1e-10以下ならstart indexが小さいものを採用する。全start失敗は FA_NONCONVERGENCE で422とし、部分負荷量を正常結果として返さない。ゼロ因子列はeffectiveFactorRank<q警告とし、因子数を勝手に減らさない。

## 5. 因子数、平行分析、候補比較

観測・比較側とも「対角1の全相関行列の降順固有値」を使い、eigenvalueDefinition=full_correlation を画面・manifestに保存する。PCAを因子抽出として実行する意味ではない。

帰無データはfit行列の項目別独立置換とし、各項目のカテゴリ度数または連続値分布を厳密に維持し、項目間関連だけを壊す。既定は500反復、許容範囲100..10000、比較分位点.95、seed42、PRNG=PCG64である。列処理順はcolumnIdで固定し、返却は要求項目順にする。推定startとは別ストリームを使い、各反復で観測と同じ相関推定・行列診断を通す。

失敗反復は再抽選・除外しない。1件でも相関推定失敗または非正定値があれば、予定反復すべての診断を保存し、referenceQuantilesとsuggestedFactorsはnull、reasonCode=PA_REPLICATE_FAILEDとする。EFA本体が成功していれば主結果は保持する。

分位値は各固有値順位の線形補間分位点とする。観測値が比較値を厳密に超える先頭からの連続順位数を候補kとし、0を1へ切り上げない。後順位の超過も表示する。kがモデルとして許されるqの範囲外でも黙って切り詰めず、利用者がnFactorsを確定する。

compareFactorsは追加候補の明示整数配列であり、主nFactorsを含む候補集合を同じfit行、R、回転規約で実行する。各qの目的値、RMSR、共通性、診断、試行参照を成功・失敗とも残す。主q失敗なら全実行を失敗記録とし、別qの成功を主結果へ置換しない。比較用モデルの得点は主qを明示して別実行するまで保存しない。

## 6. 回転、得点、推論

### 6.1 回転

1因子では要求回転にかかわらず適用noneとし、理由をmeta.methodSwitchReasonへ保存する。

無回転ではLの各列を最大絶対負荷が正となる符号に正準化し、負荷二乗和の降順（同率は元列順）で並べる。Phi=Iとし、同じ符号付き置換を得点へ適用する。

VarimaxはKaiser正規化を固定する。h_j=sqrt(sum_l L_jl^2)、ゼロ行は0行のまま残し、B_j=L_j/h_jとする。T=Iから最大500回反復し、Lambda=B T、C=B'[Lambda^3-Lambda diag(colSums(Lambda^2))/p]、C=U D V'、T_new=U V'とする。目的値sum(diag(D))の相対改善が1e-8未満で収束する。正規化を戻して L_v=(B T) h とし、L_v L_v'+Psi が元のSigmaとrtol=1e-9で一致することを検証する。未収束は FA_ROTATION_NONCONVERGENCE としnoneへfallbackしない。収束後は二乗負荷和の降順（同率は元列順）で因子を並べ、各列の最大絶対負荷が正となるよう符号を正準化する。

PromaxはVarimax完了後に target=sign(L_v) abs(L_v)^4 を作る。B=least_squares(L_v,target) はrank qを要求し、Phi_0=(B'B)^-1、D=diag(sqrt(diag(Phi_0)))、T_p=B D、L_p=L_v T_p、Phi=D^-1 Phi_0 D^-1 とする。pattern=L_p、structure=L_p Phi、diag(Phi)=1、L_p Phi L_p'+Psiが元のSigmaと一致することを確認する。符号付き置換Hでは pattern_new=L_p H、Phi_new=H' Phi H、structure_new=structure H、score_new=score H とする。Promax後もpattern二乗和の降順（同率は元列順）と符号正準化を表示規約として適用する。これは加算可能な分散寄与の根拠ではない。因子相関が極端に±1に近くrankを失う場合は FA_ROTATION_SINGULAR とする。

### 6.2 得点

scoreMethodの既定はnoneである。Pearson・適切な解・明示した得点法だけがrows/projection/materializeを有効にする。標準化は z=(x-mean)/sd で、meanとsdは学習fit集合のddof=1標本値を固定する。連続近似ではscoreInterpretation=continuous_approximationを結果と派生列来歴に残す。順序経路は得点を拒否し、EBMなどを代替しない。

patternをL、Phi、Psiとする。regression得点係数は B_reg=solve(R,L) Phi、score=Z B_reg とする。Rは標本相関であり、Sigmahatへ置換しない。Bartlett得点係数は B_bart=Psi^-1 L (L' Psi^-1 L)^-1、score=Z B_bart とする。逆行列はCholesky/solveで構成し、rank不足を一般化逆行列で救済しない。斜交でもBartlettはpattern Lを使い、さらにPhiを掛けない。得点分散を1に再標準化しない。fit行をpredictへ通した値と保存得点の一致を検証し、元項目に欠損のある予測行はnullにする。

### 6.3 参考推論と診断

共通性 h^2=diag(L Phi L')、uniqueness=psi、reproducedCorrelation=L Phi L'+diag(psi)、residualCorrelation=R-reproducedCorrelationとする。対角残差を返し、0へ強制しない。非対角RMSRは sqrt(sum_{j<k}(R_jk-Sigmahat_jk)^2/[p(p-1)/2]) とする。全共通分散比は sum(h^2)/p とする。

Pearson＋MLでは F を使い、c=n-1-(2p+5)/6-2q/3、T=cF、df=((p-q)^2-p-q)/2 とする。c>0かつdf>0なら pValue=chi2.sf(T,df)、RMSEA=sqrt(max((T-df)/(df(n-1)),0))とする。c<=0またはdf<=0は対応する推論値をnullにする。psi<=lower+1e-6は BOUNDARY_UNIQUENESS 警告とし、chi-square近似の保証がないことを明示する。

KMOは可逆Rから partialCorrelation_jk=-invR_jk/sqrt(invR_jj invR_kk)、KMO=sum r^2/(sum r^2+sum partial^2) とする。分母0はnullとする。Bartlett球面性の参考検定はPearson＋MLだけで、係数 n-1-(2p+5)/6 が正のとき T_b=-(n-1-(2p+5)/6)logdetR、df_b=p(p-1)/2、chi-square p値を返す。MINRES、係数非正、非正定値その他の適用不能時はstatisticとp値をnullにし理由を返す。KMO/Bartlettを実行可否の自動ゲートに使わない。

MINRES／ULS系のchi-square、CFI、TLI、RMSEA、係数SEはnot_implementedとし、MLの通常近似をscaledまたはrobustと呼ばない。不適解・境界解では公開推論値をnullにし、内部計算値は診断artifactへ分離する。

## 7. Pearson／Polychoric感度分析

### 7.1 対象と共通条件

対象は全項目の元measurementがordinalの場合である。sensitivityAnalysis.enabled=trueには独立したapproximationAcknowledged=trueとparallelAnalysis.enabled=trueを要求する。主treatmentは全ordinalまたは全continuous_approximationであり、混在は拒否する。

比較はPearson-MINRESとPolychoric-MINRESで揃える。主がMLなら主MLを保持し、必要に応じて主ML＋比較用Pearson-MINRES＋Polychoric-MINRESの3モデルを保存する。比較子は項目ID、fit行、n、逆転、許容値、欠損、q、回転、ULS目的、制約、最適化start、seedを共通化し、scoreMethod=noneとする。Pearson側は最終カテゴリ順位1..Kを使い、元コードの数値間隔を使わない。

主結果は比較完了を待たずに公開する。比較子結果を主結果としてmaterializeせず、主結果の設定・fingerprint・PCP選択を比較の完了・失敗・中断で変更しない。

### 7.2 分布プロファイルと平行分析

fit集合に対し、各項目のcategoryCounts、categoryProportions、minCategoryCount、maxCategoryProportion、floorProportion、ceilingProportionを返す。scope除外前の有効回答分布は別集計・別Nとして保存し、fit集合と混同しない。floor/ceilingは確認済み順序の両端であり、逆転適用前後の対応を保存する。順位位置rの歪度は m_k=n^-1 sum(r-mean)^k、g1=m3/m2^(3/2)、G1=sqrt(n(n-1))/(n-2) g1（n>2、m2>0）とし、未定義はnullとする。異なるKは u=(r-1)/(K-1) で揃え、対ごとの経験CDF最大差をdistributionDistanceとして返す。count<5、floor/ceiling>=.5、abs(G1)>1は表示目安であり、実行経路を強制しない。

同じfit行列の項目別置換indexをPearson側・Polychoric側へ共通供給する。両側の観測・帰無に同じ相関推定を使い、同じseedでも別の置換標本を使う実装は禁止する。片側のPA失敗は候補nullであって0ではない。候補数が違う場合も共通指定qの感度差は計算できるが、異qの係数差はnull、reasonCode=FACTOR_COUNTS_DIFFERとする。

### 7.3 因子整合と評価

同じq・回転のpattern P（Pearson）とO（Polychoric）に対し、c_ab=(P_a' O_b)/(||P_a|| ||O_b||)とする。sum abs(c_ab)を最大化する一対一割当をlinear_sum_assignmentで解き、c_ab>=0となる符号付き置換Hを保存する。整合後は O_a=O H、Phi_oa=H' Phi_o H、structureも同じHで変換する。元行列を上書きしない。

ゼロノルム因子、rank不足、最適割当と次善割当の目的差<=1e-6、congruence<.85はalignmentStatus=ambiguousとする。次善割当は採用辺を一つずつ禁止した最良割当を使い、q=1では次善割当なしと記録する。Procrustesは O'P=U D V'、Q=U V'、||OQ-P||_F/||P||_F による補助空間診断だけであり、pattern差・割当変更を置き換えない。

返却する差分は i<j の相関の最大・中央値絶対差、整合済み負荷量の最大・中央値絶対差、共通性差、Phi非対角差、確定因子割当変更数、比較可能数、曖昧数、PA候補差である。q=1のPhi非対角差は0、比較対数は0とする。因子割当は最大絶対負荷>=assignmentThreshold（既定.4）かつ第2位との差>=assignmentMargin（既定.1）で確定する。q=1は第2位条件を持たない。確定しない項目はunassignedとambiguousを区別する。負荷量差・共通性差・Phi差の閾値は各0.10、範囲(0,1]として要求値とともに保存する。

assessmentの優先順は、片側失敗・PA不能・境界・不適解・整合不能ならindeterminate、次に候補差・いずれかの最大差の閾値超過・確定割当変更ならmethod_sensitive、曖昧項目があればindeterminate、すべて揃い候補一致・差が目安以下・確定割当変更0ならsmall_observed_differenceとする。これは同等性検定、正規性証明、CFAの独立検証ではない。

比較はcomparisonIdで queued/running/completed/partial/failed/cancelled、進捗、比較子resultIdまたはattemptId、行・項目hash、置換ストリーム、H、Q、差分、閾値、判定を保存する。GET /api/v1/analysis-comparisons/{comparisonId}、同URLのexport、POST同URLのcancelを提供する。完成artifactは不変とし、stale時は新規比較を公開しない。

## 8. 結果、保存、UI、実装ゲート

保存するEFA結果は拡張契約に従い、fit/excluded行ID、変換辞書、R、閾値、対別診断、raw loadings、最終行列、start履歴、PA設定・全反復固有値、候補比較、engine manifestを含む。model.npzにpickleを含めない。canonical fingerprintは行集合と内容hash、測定水準、元／適用order、逆転、欠損、要求／適用方法、全数値設定、実装版を含み、UI表示閾値は含めない。

422の代表コードは FA_CATEGORY_ORDER_REQUIRED、FA_UNOBSERVED_CATEGORY、FA_CONSTANT_COLUMN、FA_CORRELATION_NONCONVERGENCE、FA_CORRELATION_BOUNDARY、FA_NON_POSITIVE_DEFINITE、FA_UNDERIDENTIFIED、FA_NONCONVERGENCE、FA_ROTATION_NONCONVERGENCE、FA_WEIGHT_UNSUPPORTED とする。失敗試行は GET /api/v1/analysis-attempts/{attemptId} と diagnosticsページで参照可能にし、有効モデル操作に使わない。

得点可能な適切な解だけ中央selection、既存L1/L2、rectangle／row_ids、相互ハイライト、fit得点の派生列保存を提供する。対象外・未計算行はnullにする。項目・因子選択で回答者選択を変更しない。設定・結果・スクロールはKeepAliveで保持し、dataset切替、古い応答、logical cancelを扱う。

UIは「対象と尺度」「因子数」「抽出・回転」「診断」「負荷量・残差」「平行分析・感度比較」の順で読めるようにする。入力エラーは項目直下と上部一覧に表示し、失敗時は一覧へフォーカスする。診断は色だけに依存せず、項目名・状態・理由を表示する。重い相関・PAはキューで直列化・区分実行し、無断のサンプリング、反復削減、画面ページだけの推定、容量見積だけによる任意拒否を行わない。実メモリ不足は503として扱う。

検証は相関oracle→ULS系oracle＋ML→PA→回転と不適解→感度比較→契約/API/保存→FE/PCP→localとPyodideの順に行う。各段階のfixture、oracle、許容差、実装順序、性能計測は[受入計画](FACTOR_EXTENSIONS_ACCEPTANCE.md)を正本とする。R oracleの入力hash、出力、sessionInfo、版・設定を保存し、製品kernelをoracle期待値の生成に使わない。

## 一次資料との対応

[S-FA](../references/PRIMARY_SOURCES.md#s-fa)、[S-FA-SRC](../references/PRIMARY_SOURCES.md#s-fa-src)、[S-ROT](../references/PRIMARY_SOURCES.md#s-rot)、[拡張一次資料](../references/FACTOR_EXTENSIONS_SOURCES.md)を参照する。閾値、API、能力境界、警告方針は製品設計であり、原典が唯一の実装方法を要求するという意味ではない。
