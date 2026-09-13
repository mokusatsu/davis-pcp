# DAVIS-FEAT-034：コンジョイント 実装詳細化設計書

版1.0／対応仕様：[Feature 034](../feature/34_conjoint_analysis.md)。統計単位は回答者、選択集合は回答者×タスク、物理行はプロフィールという3階層を保持する。

## 1. 実装分割・接続

新規`backend/app/domain/conjoint_data.py`、`algorithms/models/conjoint_encoding.py`、`conjoint_ratings.py`、`conjoint_choice.py`、`conjoint_simulation.py`、`api/conjoint.py`を作る。ratingsの数値最小二乗はFeature32の純粋coreを再利用し、HTTP APIを内部呼出ししない。choiceとrankingは同じstage尤度kernelを使う。

FEは`features/models/ConjointPage.tsx`、`ConjointMapping.tsx`、`ConjointSimulator.tsx`。route `/models/conjoint`、POST `/api/v1/models/conjoint`。

## 2. 入力型と段階検証

```json
{"context":{"datasetId":"conjoint-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"none","missingPolicy":"exclude"},"mode":"choice","columns":{"respondentId":"respondent_id","taskId":"task_id","alternativeId":"alternative_id","response":"chosen"},"attributes":[{"columnId":"brand","kind":"categorical"},{"columnId":"price","kind":"linear","utilityRange":[100,300]}],"ratingEffects":"pooled","confidenceLevel":0.95,"maxIterations":1000}
```

mode=ratings|choice|ranking。columnsの任意項目はavailability、optOutIndicator。ratingEffectsはratingsでのみ有効、他modeでは既定pooled以外を拒否。属性>=1、同じ列の属性重複不可。mappingのID/response列と属性列を重複使用しない。すべてのIDは非欠損、キーはtupleとして扱い、文字区切り結合による衝突を起こさない。

属性categoricalはnominal/ordinal、linearはinterval/ratio。categoricalのreferenceLevel省略はcatalogの最後の通常value水準。linearのutilityRange省略はfit内の最小/最大、明示時はfinite lower<upperで訓練範囲外でも指定範囲であることを警告して許可。価格属性は`priceAttribute`でlinear属性1列を任意指定する。指定しなければWTPは出さない。

### 2.1 完全性と欠損の処理順

1. 全datasetのID列からtask indexを作る。scopeがchoice/rankingのタスクの一部rowだけを含む場合、欠損除外やavailability判定より先にCONJOINT_PARTIAL_TASKを返す。未選択タスクは対象外、選択されたタスクは元の全raw rowが必要。全datasetの他タスクのresponse/属性を読む必要はない。
2. mapping IDの欠損、タスク内alternative重複、回答者に矛盾するweight/designは422。これらを単なる欠損に変えない。
3. availability省略は全true。指定時はboolean、数値0/1、正規化後の文字列"0"/"1"だけを認め、false/0→利用不可、true/1→利用可能と固定する。それ以外の二値コード（例1/2、はい/いいえ）をcategoryOrderから推測せず、事前の明示的派生列化を求め422。optOutIndicatorも同じ変換規約を使い、欠損をfalseにしない。falseは分析不使用。choiceでresponse=1のfalse行、rankingで順位があるfalse行は矛盾として422。
4. responseの非欠損値に対してchoiceは0/1、rankingは正整数、ratingsはfinite numericを検証する。choiceで1が複数、rankingで順位重複は即422。response欠損があるタスクは全体除外であり、残存0件のchoiceを「選ばれなかった」と解釈しない。
5. choice/rankingの有効候補に属性またはresponse欠損が一つでもあればタスク全体を除外する。非欠損の不正response/不正属性コードは422。ratingsは属性/response欠損行を除外し、不正値も共通invalid件数へ分類して除外する。
6. 残ったchoiceタスクの選択数=1、rankingの順位集合=1..J、J>=2を検証する。scopeで回答者の一部タスクだけを使うことは許すが、task単位選択であることをmetaへ記録する。
7. 回答者weightがmissingならその回答者のscope内rowをすべてmissing_weight除外、zeroならzero_weight除外。負/非有限/frequency非整数は422。スコープ外を含む同回答者のweight値が一致しない場合はCONJOINT_RESPONDENT_WEIGHT_CONFLICT。

false availability行はfitCountに含めず、structural_task_exclusion理由をavailability_excludedとして補助内訳に記録する。除外件数は物理行単位で共通の和を満たす。得点欠損の巻き添え行もstructural_task_exclusionにする。

### 2.2 opt-out

choice/rankingのみ。各taskに最大1行、optOutIndicator=1で識別する。opt-out行の全属性design値を0、ASC値を1に固定し、通常行のASCは0。opt-out行の属性セルは欠損を許し値を無視するが、無視した属性が非欠損なら警告する。ratingsではopt-out設定を拒否。opt-outの選択頻度が0/100%等で有限最尤解がない場合は分離検査で止める。opt-outの有無がタスク間で違うことは許す。

## 3. effect codingと学習用辞書

属性jがK水準ならK−1列。非基準水準kは自身の列1・他列0、基準水準は全列−1。通常プロフィールの属性効用はβ_jk、基準効用は−Σ_{k<K}β_jk。K=2ならcode±1なので係数は二水準効用差の半分である。水準効用の和=0が必須。

linear属性はx−μ_train。μ_trainはfit通常プロフィール行の正重み平均（同回答者の各プロフィール行に同じwを使う）。この中心は係数の単位を変えず、opt-out ASCの基準を明示するため保存する。utilityRangeは重要度算出用で、学習値のclip範囲ではない。

辞書は属性順→水準順で固定。未観測水準を0係数として追加せずomittedLevelsへ返す。codebookで有効だが学習時未観測の水準も予測時は未知扱い。属性全体に1水準しかない場合CONJOINT_CONSTANT_ATTRIBUTE。

## 4. 評点型モデル

### 4.1 pooled

通常プロフィールのdesign Xに切片を加え、Σ_i w_i Σ_t (y_it−α−x_it'β)²を最小化する。X'WXのrankを検証し、OLS用gelsdで解く。回答者ごとのタスク数でwを割らない。観測の多い回答者が情報を多く提供する構造を保持し、SEでは反復を考慮する。

### 4.2 respondent_fixed

回答者iの有効評点行の平均xbar_i/ybar_iを取り、x~_it=x_it−xbar_i、y~_it=y_it−ybar_i。回答者内のwが一定なのでこの平均は行の単純平均と同じ。切片なしでΣw_i(y~−x~β)²を最小化する。α_i=ybar_i−xbar_i'β、fitted_it=α_i+x_it'β。

within行列のrankが属性係数数p未満ならCONJOINT_WITHIN_RANK_DEFICIENT。回答者1行のケースはwithin情報を提供しないが、他回答者でrankが満たされるなら保持し、当該回答者のαのみ再現する。全員1行なら識別不能。

meanIntercept=Σ_i w_i α_i/Σ_i w_iを新規回答者の参考切片とする。回答行数で加重しない。α_iやmeanInterceptの推測CIは本版未提供。固定効果があることを個人別βがあることと混同させない。

## 5. 選択型・順位型の尤度

choiceのstageはtaskそのもの。rankingは最高順位から順に選ばれた代替案を取り除き、残存集合サイズ>=2までJ−1stageへ展開する。ステージは元taskとrespondentを保持する。

stage sの集合C_s、選ばれたc_s、効用v_sj=x_sj'β、`logP_sj=v_sj−logsumexp(v_s)`。

```
logL = sum_s w_respondent(s) * logP_s,c_s
score_s = x_s,c_s - sum_j P_sj x_sj
H_s = X_s' [diag(P_s) - P_s P_s'] X_s
```

各回答者score U_i=Σ_s∈i score_s、H=Σ_i w_iΣ_sH_s。学習中の確率にnp.exp(v)を直接使わずlogsumexpでoverflowを防ぐ。最後の1選択肢stageは尤度0なので保存しなくてよいが、元行はfit行として残る。

### 5.1 識別可能性・有限解

タスク内でX列を平均中心化した行列のrankがp必要。共通切片はrankを失うので禁止する。さらにchosen対otherの差行列D_sj=x_s,c−x_s,jを構築して完全/準完全分離を検査する。列を非ゼロRMSでスケールしたDで、`maximize sum(Dv)` subject to `Dv>=0, -1<=v_j<=1`をscipy.optimize.linprog(method='highs')で解く。正の最大値>1e-8なら改善方向があるのでCONJOINT_SEPARATIONを返す。設計matrix rank欠損は先に止め、null方向を分離と混同しない。

LP solverが失敗/利用不可ならCONJOINT_SEPARATION_CHECK_FAILEDで止める。PyodideでHiGHSが利用できることをstatic releaseの明示スモークテストにする。分離検査を削除してβの任意上限だけで判定しない。

### 5.2 最適化

内部conditioning用にタスク内変動のRMS scale_jを計算し、scaledX=X/scale_j。初期βscaled=0、scipy.optimize.minimize(method='L-BFGS-B',jac=analytic,ftol=1e-12,gtol=1e-7,maxiter=input,maxls=50)。境界なし、正則化なし。conv条件solver.successかつscoreInfNorm/Σwstage<=1e-6、Hの正定値・full rank、logL finiteを要求する。

最終βoriginal=βscaled/scale。Voriginal=diag(1/scale)Vscaled diag(1/scale)。最適化のための内部scaleを効用単位に残さない。有限解でも情報行列が数値的に特異ならCONJOINT_INFORMATION_SINGULARとし、過度に小さいSEを表示しない。

## 6. 標準誤差・ウェイト

### 6.1 非加重・frequency

主結果は回答者クラスター共分散。ratingsではU_i=Σ_t x_it e_it（固定効果ならwithin x）、H=X'WX。choice/rankingは上式のscore/H。frequency f_iは回答者ブロックをf_i回複製するのでG*=Σ_i f_i、meat=Σ_i f_i U_i U_i'。非加重f=1、G*=回答者数。

`V_CR1 = (G*/(G*−1)) H^−1 meat H^−1`、t参照df=G*−1。ここで採用するCR1はクラスター数補正G/(G−1)のみであり、観測行数による追加因子(N−1)/(N−p)は掛けない。共分散名は`respondent_cluster_CR1_G`とし、statsmodelsの既定cluster補正と無条件に一致すると主張しない。oracleではCR0へG/(G−1)だけを掛けて比較する。

frequencyをw_i=f_iとして`Σ f_i² U_iU_i'`を使うと回答者複製と一致しないため禁止。元の同回答者の全タスクを複製した各コピーに別の仮想回答者IDを付けたoracleで検査する。G*<=1なら点推定のみ、SE/CI/pはnull。

### 6.2 survey

回答者score U_iにw_iを掛け、回答者が属する層/PSUへ集約して共通Taylor meatを用いる。層/PSU/FPCは回答者内で一定。surveyDesignがなければ回答者をPSU、1層とし、回答者独立の近似と表示する。scopeに含まれない回答者も全設計にはscore0で残す。

SE=sqrt(diagV)、t/p/CI参照dfはD=Σ(m_h−1)。有限母集団の単位は回答者またはPSUであり、choiceの行数をM_hにしない。倍率cの不変性をテストする。PSU/層不整合やreplicate weights指定は共通エラー。singleton/df不足は推測不能として係数のみ。

### 6.3 効用表への共分散伝播

カテゴリ水準効用u=Lβで、非基準は単位ベクトル、基準は当該属性係数の−1和。V_u=L V L'。省略水準のSEを0にしない。linear slope/opt-out ASCは対応するβ。重要度・レンジのCIは本版未提供（max/minを含む非線形量への簡易SEを捏造しない）。

## 7. 適合指標・予測評価

ratingsはRMSE/MAE、pooledの中心化R²、固定効果ではwithinR²=1−withinSSE/withinTSSとoverallR²を別に表示する。固定効果の学習R²を未知回答者への予測性能とは呼ばない。

choice/rankingはlogLikelihood、stageCount、taskCount、meanNegativeLogLikelihood=−logL/Σ_s w_s。equal-choice nullはlogL0=−Σ_s w_s log |C_s|、McFaddenR²=1−logL/logL0。これは通常OLS R²ではない。surveyのlogL総量は重み倍率依存なので平均NLLを主指標にする。尤度比χ²/AIC/BICは反復/設計を無視しやすいため本版では提供しない。

choiceのhitRateは最大確率代替案を1位とした予測の正解率。同点は正解がtie集合に含まれる場合1/tie数を加点。rankingの第1位hitRateは最初のstageのみ、全順位loglossは全stageと明記する。予測時の異なるtaskは学習からパラメータを更新しない。

## 8. 任意プロフィールのシミュレーション

`POST /api/v1/models/conjoint/{resultId}/simulate`、body={context,profiles:[{alternativeId,values:{columnId:code_or_number},optOut:false}],includeWtp:false}。contextは同datasetの版確認に使用し、scope=all・weightMode=noneのみ許す（profile集合はdataset行でない）。profilesのIDは一意、通常行は全属性キーのみ、optOutはvalues={}。choice/rankingは2つ以上、ratingsは1つ以上。未知/未観測水準、非有限数値は422。optOutは学習モデルがASCを持つ場合だけ許す。

linearのfit範囲外はextrapolation警告。utility=xβ（ratingsは別に平均切片も含むpredictedRating）。choice/ranking probability=exp(v−logsumexp(v))、合計1。ratingsはprobability=null、firstChoiceShare=最大utilityに同点等分、他0。このモデルは共通βなので回答者ごとの嗜好異質性を創作して分布を作らない。

重要度はカテゴリrange=max(u)−min(u)、linear range=abs(β)*(upper−lower)。importance=range/Σrange。opt-out ASCは属性重要度の分母から除く。すべてrange=0ならnull。選択肢プロフィール集合を変えても、同じ学習utilityRangeに対する属性重要度は自動で変えない。

WTPはpriceAttributeのβ_price<0かつ推測可能CIが0を含まない場合だけ。非価格属性の水準差dに対しΔU=d'β、WTP=−ΔU/β_price。delta勾配g=−d/β_price+ΔU e_price/β_price²、var=g'Vg、t CIを参考値として表示する。比率の厳密CIではないこと、指定価格単位であることを明記する。価格係数不安定はWTP_UNSTABLEでnull、絶対値を取って救済しない。

## 9. 結果・保存

summary={mode,ratingEffects,respondentCount,taskCount,fitProfileCount,stageCount,sumRespondentWeights,frequencyRespondentN,referenceDf,inferenceStatus,covarianceMethod,converged,fitMetrics}。

details={attributes,designColumns,coefficients,levelUtilities,attributeImportance,omittedLevels,respondentIntercepts,taskDiagnostics,optimizer,encoding}。respondentInterceptsはratings fixedのみ、他はnull。respondentIntercepts/taskDiagnosticsは結果データ辞書のページ付き索引とし、全行配列をPOSTへ載せない。coefficientsのJSONキーはestimate/standardError/statistic/pValue/ciLower/ciUpper、levelUtilitiesはattributeId/levelCode/label/utility/standardError/ciLower/ciUpper/referenceLevel。

row結果はrowId/respondentId/taskId/alternativeId/observed/predictedRating/probability/residual/predictionStatus。choiceのresidual=y−P。rankingではprobabilityは第1位確率だけとし、stageごとの確率はtaskDiagnosticsに保存する。rankingのresidualはnull。ratingsのprobabilityはnull。

materialize fieldはpredicted_rating/probability/residual。methodで未提供fieldを拒否する。ranking確率列名の既定はCJ_FirstChoiceProbabilityとし、全順位の確率と混同しない。task全体尤度を各プロフィール行の応答確率として保存しない。

## 10. UI・エラー・テスト順序

mapping wizard→完全性検証→属性・水準一覧→model設定→結果の4段階にする。返されたエラーでは該当respondent/task/row/columnを最大20件提示し、全件数は別表示。値の一覧が切れていても処理対象を20件に減らさない。

主エラー：CONJOINT_PARTIAL_TASK、DUPLICATE_ALTERNATIVE、INVALID_RESPONSE、RESPONDENT_WEIGHT_CONFLICT、CONSTANT_ATTRIBUTE、RANK_DEFICIENT、WITHIN_RANK_DEFICIENT、SEPARATION、NONCONVERGENCE、INFORMATION_SINGULAR、UNKNOWN_LEVEL。すべて422、内部不変条件違反だけ500。

`test_150_conjoint.py`でratings加法fixture→effect utility和0→choice2択解析解→rank stage尤度→クラスターSE→frequency回答者複製→survey倍率→LP分離→opt-out→予測/重要度/WTPを検証する。FEではpartial-task拒否と明示task拡張、新規回答者の固定効果予測ラベル、probabilityとfirstChoiceShareの違いをE2Eで確認する。

モデルが有限解を持たないデータを、テスト成功のために正則化して通すことは受入違反。階層ベイズや潜在クラスは将来追加時に別method/algorithmVersionとし、本版logitの別名で導入しない。

## 一次資料との対応

[S-CLOGIT](../references/PRIMARY_SOURCES.md#s-clogit)、[S-SURVEY](../references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。

## 11. タスク全体への明示的スコープ拡張

`POST /api/v1/models/conjoint/expand-scope`、入力は`{context,columns}`でConjointExpandScopeRequestを用いる。contextの版を検証し、columnsのIDマッピングから全datasetのtask indexを読む。選択された各rowが属する(respondentId,taskId)の全raw row（availability=falseも含む）を保存順・重複なしで返す。responseや属性の欠損をこの段階で除外しない。

応答は`{status:'success',datasetId,dataRevision,schemaRevision,originalRowCount,expandedRowCount,addedRowCount,expandedRowIds,scopeHash}`。空scopeは全て0/[]。データを変更せず、PCPの選択も勝手に更新しない。UIは追加件数を示し、ユーザーの明示ボタンでscope=explicit,rowIds=expandedRowIdsの新contextを作る。他scope用配列は除去する。推定の重み・欠損設定は元draftを保持し、実行時に改めて版を検証する。APIが返した配列をそのまま自動再実行することは禁止。
