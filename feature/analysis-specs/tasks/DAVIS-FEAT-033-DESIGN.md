# DAVIS-FEAT-033：最尤因子分析 実装詳細化設計書

版1.0／対応仕様：[Feature 033](../feature/33_maximum_likelihood_factor_analysis.md)。抽出法はMLのみ。PCAは相関構造の診断に使えても、抽出失敗の代替法にしない。

拡張時は[033b詳細設計](DAVIS-FEAT-033B-DESIGN.md)と[033c詳細設計](DAVIS-FEAT-033C-DESIGN.md)を優先する。本書のML目的・回転・連続得点規約は033bから明示参照する。frequency対応・平行分析なし等の適用範囲は033bの個別規約で置き換える。

## 1. 接続とAPI

新規`backend/app/algorithms/models/factor_analysis_ml.py`、`algorithms/models/factor_rotations.py`、`api/factor_analysis.py`、`frontend/src/features/models/FactorAnalysisPage.tsx`。route `/models/factor-analysis`、POST `/api/v1/models/factor-analysis`。

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"none","missingPolicy":"exclude"},"variables":[{"columnId":"q1"},{"columnId":"q2"},{"columnId":"q3"},{"columnId":"q4"},{"columnId":"q5"},{"columnId":"q6"}],"nFactors":2,"method":"ml","rotation":"varimax","scoreMethod":"regression","uniquenessLower":0.005,"nStarts":5,"maxIterations":2000,"seed":42}
```

variablesは3以上で重複なし。ordinal時のscore/ackは回帰と同じ。missingPolicyはexcludeのみ。survey解決時はFA_SURVEY_WEIGHT_UNSUPPORTED、利用者の明示none操作以外のfallback禁止。uniquenessLowerは[1e-6,0.1]、nStarts1..20、maxIterations100..20000の明示設定範囲（データ行数制限ではない）。nFactorsは1以上p未満、df制約をデータ依存で検証する。

## 2. 標本相関と識別可能性

非加重ならf_i=1、frequencyなら整数f_i。N=Σf、mean=Σf x/N、S=Σf(x−mean)(x−mean)'/(N−1)、sd=sqrt(diagS)、R=diag(sd)^−1 S diag(sd)^−1。N>p、各sd>0を要求し、RにCholesky分解を行う。正定値でない場合FA_NON_POSITIVE_DEFINITE。完全相関・多重共線性を修正して通さない。

q=nFactors、df=((p−q)²−p−q)/2。df<0ならFA_UNDERIDENTIFIED、df=0なら点推定は許すが適合度検定p/通常RMSEAはnull。q<p、q>=1。標本数に対する「5倍/10倍」は警告にとどめ統計的必要十分条件としない。

## 3. ML目的関数と最適化

相関変数モデルR≈Σ=L L'+Ψ、Ψ=diag(ψ)、ψ_j∈[lower,1]。

固定ψでEVD：`C=diag(ψ)^−1/2 R diag(ψ)^−1/2 = E diag(d) E'`、dを降順とする。`L(ψ)=diag(sqrt(ψ)) E_q diag(sqrt(max(d_1..q−1,0)))`。

目的関数は常に完全式を使う。

`F(ψ)=logdetΣ+trace(R Σ^−1)−logdetR−p`。

d_q<=1の場合にも成立するよう、上位qの簡略化式だけに依存しない。ΣのCholeskyでlogdetとsolveを計算する。Fは理論上>=0、-1e-10程度の丸めだけ0にclip。大きな負値は内部エラー。Σ/Rの明示逆行列はscore・勾配など必要な場合もsolveから求める。

可微分な範囲のprofile勾配は`diag(Σ^−1−Σ^−1 R Σ^−1)`。計算ではA=solve(Σ,I)、gradient=diag(A−A@R@A)。EVD重複やd=1の境界でgradientが不安定ならそのstartを失敗候補として記録し、有限差分で検証する。微分のテストをなくして自動差分へ丸投げしない。

最適化はscipy.optimize.minimize(method='L-BFGS-B',jac=gradient,bounds)。ftol=1e-12、gtol=1e-7、maxiterは入力、maxls=50。初期ψ_0=clip((1−0.5q/p)/diag(R^−1),lower,1)。残りstartはnp.random.default_rng(seed)でUniform(max(lower,0.05),0.95)をp成分独立に生成。seedと各startの初期ψ・終了status・F・iterations・projectedGradientNormを記録する。

候補採用はsolver.successかつfiniteかつprojectedGradientInfNorm<=1e-5。境界成分のprojected gradientは、下限でgradient>0または上限でgradient<0なら0にする。成功候補のF最小を採用し、差が1e-10以下ならstart indexが小さいもの。全失敗ならFA_NONCONVERGENCEで422、負荷量を正常モデルとして返さない。

採用ψからLを再計算し、学習時のq列を保持する。ゼロの因子列が含まれる場合はeffectiveFactorRank<qの警告を出し、Bartlett得点係数が求められなければ得点計算不能としてFA_SCORE_UNIDENTIFIEDを返す。因子数を勝手に減らして成功させない。

## 4. 回転

### 4.1 none

Lの各列符号を最大絶対負荷が正となるように決定し、負荷二乗和の降順（同率は元列順）に並べる。Φ=I。常に同じ変換を因子得点へ適用する。

### 4.2 Varimax

Kaiser正規化を固定する。h_j=sqrt(Σ_l L_jl²)、ゼロ行は0行として残し、B_j=L_j/h_j（非ゼロ）。T=I、最大500回、各反復Λ=BT、C=B'[Λ³−Λ diag(colSums(Λ²))/p]、C=U D V'、T_new=UV'。目的値d=ΣdiagDを用い、改善がrelative1e-8未満なら収束。正規化を戻してL_v=(BT)*h。

Σ=L_v L_v'+Ψが元とrtol1e-9で一致することを検証。500回で収束しなければFA_ROTATION_NONCONVERGENCE、noneへ暗黙fallbackしない。回転後二乗負荷和順に列を並べ、符号を正準化する。

### 4.3 Promax

まず上記Varimaxを完了。target=sign(L_v)*abs(L_v)^4。`B=least_squares(L_v,target)`、rankq必須。Φ0=(B'B)^−1、D=diag(sqrt(diagΦ0))、T_p=B D、L_p=L_v T_p、Φ=D^−1 Φ0 D^−1。

pattern=L_p、structure=L_pΦ、diagΦ=1。Σ=L_pΦL_p'+Ψを元と照合する。因子並べ替え/符号をH（符号つき置換行列）で行う場合、pattern_new=L_p H、Φ_new=H'ΦH、structure_new=structure H、score_new=score H。このHは一般の斜交変換とは違い直交置換なのでこの式が成り立つ。

Promaxの並べ替えはpatternの二乗和の降順を表示上の規約として採用するだけで、分散寄与を加算する根拠にしない。因子相関が極端に±1に近くrankを失う場合はFA_ROTATION_SINGULAR。

## 5. 因子得点

学習/予測標準化z=(x−mean)/sdは前記標本sd（ddof1、frequency複製同値）を用いる。patternをL、因子相関をΦ、独自性Ψとする。

regression得点係数`B_reg=solve(R,L) Φ`、score=Z B_reg。Rは標本相関であり、Σhatへ勝手に置換しない。この規約はR factanalのregression scoresに合わせる。

Bartlett得点係数`B_bart=Ψ^−1 L (L'Ψ^−1 L)^−1`、score=Z B_bart。逆行列はCholesky/solveから作り、L'Ψ^−1Lがrankqでない場合に一般化逆行列で黙って救済しない。斜交でもpattern Lを使用し、さらにΦを掛けない。

得点の分散が必ず1になるように再標準化しない。regression得点とBartlett得点は一致する必要がない。fit行をpredictに通して同じ値になることを検証する。元項目に欠損がある予測行はnull。

## 6. 適合指標と診断

共通性h²=diag(LΦL')、uniqueness=ψ、reproducedCorrelation=LΦL'+diagψ、residualCorrelation=R−reproducedCorrelation。対角残差も返し、0へ強制しない。数値丸めを超えてh²<0なら内部エラー。

ML乖離Fに対しc=N−1−(2p+5)/6−2q/3、T=cF、df=((p−q)²−p−q)/2。c>0,df>0ならpValue=chi2.sf(T,df)、RMSEA=sqrt(max((T−df)/(df*(N−1)),0))。c<=0またはdf<=0ならstatistic/p/RMSEAの適用不能部分をnullにする。境界ψ<=lower+1e-6ならBOUNDARY_UNIQUENESS警告と、χ²近似が標準的に成立する保証はない旨を添える。

非対角RMSR=sqrt(Σ_{j<k}(R_jk−Σhat_jk)²/[p(p−1)/2])。標準化残差をさらにnや期待分散で割った別指標と混在させない。全共通分散比=Σh²/p。

必須の補助指標KMOはinverseRからpartialCorrelation_jk=−invR_jk/sqrt(invR_jj invR_kk)、KMO=Σ_{j<k}r²/(Σr²+Σpartial²)。分母0はnull。Bartlett球面性の参考検定はT_b=−(N−1−(2p+5)/6)logdetR、df_b=p(p−1)/2、適用可能ならχ²p。ただし本版ではKMO/Bartlettは必須出力とし、係数が非正ならnullで理由を返す。これらの数値を「因子分析してよい/悪い」の自動ゲートに使わない。

AIC/BIC、平行分析、自動因子数選択、ブートストラップCIは本版では提供しない。未提供欄を仮の0で埋めない。

## 7. 結果型

summary={nVariables,nFactors,effectiveFactorRank,fitFunction,chiSquare,modelDf,pValue,rmsea,rmsr,totalCommunalityRatio,kmo,bartlett,converged,boundaryVariables,scoreMethod,rotation}。

details={variables,pattern,structure,factorCorrelation,uniqueness,communality,sampleCorrelation,reproducedCorrelation,residualCorrelation,rotationTransform,optimizerStarts,factorLabels,ssLoadings,varianceRatios}。ssLoadings/varianceRatiosはPromaxではnull。variablesにcolumnId/label/mean/sampleScale/ordinalScoringを含む。loadingsの行はvariables順、列はfactorLabels順を厳守する。

model.npzにR,mean,sd,pattern,Φ,ψ,scoreCoefficientsとrawLoadings/rotationTransformを保存。rawLoadingsと最終patternの変換関係を再構成できるようにする。row結果はrowId/scores。materialize field=score:1..q。

## 8. UI・実装順序・受入

因子数qは入力値を保持し、推定不能なら該当qと理由を表示。負荷閾値|0.4|は表示だけ。回転変更は本版では保存raw MLモデルからの再回転処理をサービス内で行い、新しいresultId/config/fingerprintとして返す。最尤推定の再利用は可能だが表示だけ変更して古い得点列を新回転の得点と称さない。codebookのreverseを変えたらschema staleで再学習が必要。

`test_140_factor_analysis.py`はR生成の固定相関fixture、合成モデルの再現相関、profile gradient有限差分、複数start、境界/非収束、Varimax/Promax不変性、regression/Bartlett得点、frequency展開、rank失敗を含める。回転が異なるoracle同士のpatternを符号補正だけで一致させず、Σhatや因子空間・目的値から比較する。

本体実装のゲートは、数値kernel→収束/境界→回転→得点→API/保存→FE→static。scikit-learn FactorAnalysisのEM既定を単に呼び、指定していない別の下限・初期値・尤度規約に依存する実装は本設計の代替にならない。

## 一次資料との対応

[S-FA](../references/PRIMARY_SOURCES.md#s-fa)、[S-FA-SRC](../references/PRIMARY_SOURCES.md#s-fa-src)、[S-ROT](../references/PRIMARY_SOURCES.md#s-rot)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。
