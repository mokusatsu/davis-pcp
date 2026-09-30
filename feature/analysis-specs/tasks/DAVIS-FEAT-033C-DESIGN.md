# DAVIS-FEAT-033c：CFA 実装詳細化設計書

版1.1／2026-09-13／対応：[033c機能仕様](../feature/33c_confirmatory_factor_analysis.md)。設計上の予定API・ファイルであり、既存機能の実装を示さない。

## 1. 接続と実行エンジン

route `/models/cfa`、POST `/api/v1/models/cfa`、結果method=`cfa`、schemaVersion=`factor_extensions.1`。入力は[CFARequest](../contracts/factor_extension_requests.py)。既存のEFA APIと分離する。予定ファイルはfullstack/backend/app/api/cfa.py、services/cfa_service.py、algorithms/models/cfa_engine.py、algorithms/models/cfa_runner.R、frontend/src/features/models/ConfirmatoryFactorAnalysisPage.tsx。

初期ローカルエンジンはR lavaanを採用し、推定・SE・検定・適合度を同じfitから取り出す。WLSMV/MLRを必須、MLを通常版の照合対象、ULSMVを独立した追加受入対象とする。実装時にR/lavaan/BLAS版とソースhashを固定し、全オプションを解決したengine manifestを作成する。最新版への無条件追従はしない。

033cに限り、共通設計の「NumPy/SciPyのみでlocal/static同時実行」から独立したローカルエンジン境界を定義する。静的PyodideではCFA実行を`CFA_ENGINE_UNAVAILABLE`とし、環境能力と理由を表示する。EFAの静的対応をCFA完了待ちにしない。静的CFAは後続エンジンの同等性検証で別ゲートとする。

Rscriptは設定済み絶対パスから引数配列で起動し、ユーザーの文字列をR式やshellへ補間しない。固定runnerが制限したJSON測定モデルを内部記号v1..vp/f1..fqに変換する。表示ラベルやcolumnIdを構文識別子として流用しない。raw R script、任意式、任意パスをAPI入力で受け付けない。依存不足時の自動インストールや外部計算サービスへの送信は行わない。

## 2. 測定モデルとパラメータ表

連続：`x=ν+Λη+ε`、Eη=0、Varη=Φ、Varε=Θ、Σ=ΛΦΛ′+Θ。Θは対角、非指定負荷量は0。各因子のmarker負荷量を+1、他の所属負荷量を自由、因子分散を自由にする。因子共分散はfreeなら全対自由、orthogonalなら全対0。

順序：同じ線形モデルを潜在応答x*に置き、`Yj=k ⇔ τj,k−1<x*j≤τjk`。probit、theta parameterizationを固定する。単一群で項目の潜在応答切片0、残差分散1、潜在因子平均0とし、内部閾値Kj−1を自由、marker負荷量+1・因子分散自由。項目の潜在応答総分散を1と決め打ちせず、標準化時にΣの対角から求める。

1項目が複数因子に所属、未所属、markerが非所属、因子ID重複、項目数3未満、未知項目を拒否する。これは初期UIの単純構造範囲であり、3項目あれば必ず識別されるという主張ではない。

自由パラメータは安定ID、lhs/op/rhs、fixedValue、freeIndex、label、sourceColumnId/sourceFactorId、scaleを持つ。標本統計量との対応順を保存する。markerの符号を後処理で変更して固定+1と矛盾させない。符号反転は別モデルの設定変更として扱う。

## 3. 前処理・識別性

scope・版・欠損・重み・categoryOrder・逆転は[033 EFA設計第2節](DAVIS-FEAT-033-DESIGN.md#2-入力前処理識別可能性)の前処理を再利用し、完全ケースのみとする。同節のEFA専用n>p・q・自由度条件はCFAへ引き継がず、以下のCFAモデルで検査する。raw相関のユーザー持込モードは初期版なし。連続項目は元の分析単位の値を渡し、EFAのddof1相関への標準化を勝手に適用しない。連続近似は確認済み等間隔順位値を渡す。

識別は事前構造検証、自由度、推定後Jacobianの列rank、情報行列のrankと条件数で判定。連続の標本統計量数はp+p(p+1)/2、順序はΣ(Kj−1)+p(p−1)/2。自由度は当該統計量数と制約を適用した独立自由パラメータ数から求め、エンジン値と照合する。冗長制約やデータ依存特異をdf≥0だけで許可しない。

df<0は停止。df=0は点推定を条件付きで許し、モデル適合の検定・RMSEA/CFI/TLIをnullとする。十分なNの固定境界は設けず、定数・未観測カテゴリ・計算不能・実測rank不足など具体的原因で停止する。

## 4. 四つの計算層

|層|入力→出力|禁止事項|
|---|---|---|
|標本統計量|raw fit行→共分散／閾値・相関・Γ|EFAのpair別SEをΓと呼ばない|
|パラメータ推定|統計量・モデル・推定重み→θhat|単なるULS負荷量をULSMVと名付けない|
|推論|θhat・Jacobian・情報行列・Γ→SE・検定・補正量|通常SEでロバストSEを代用しない|
|適合度|target/h1/baselineの対応する統計量→指標|通常・scaled・robustを混合しない|

順序の標本統計量sは閾値＋相関の一意成分、Γはsqrt(n)(s−σ)の漸近共分散として、順序・次元・Nによるscale規約を必ず記録する。点推定はWLSMVで対角重み、ULSMVで単位重みを使うが、推論は完全な漸近共分散情報を要する。lavaan内部の標本統計量・WLS.V・NACOV・parameterTable・test設定を取り出し、正規化や並びをadapterで検証する。

連続ML/MLRはlavaanのnormal likelihood、meanstructure=true、missing=listwiseを固定し、内部のN分母共分散・尤度規約を保存する。033 EFAのN−1/Bartlett補正式をCFAへ流用しない。MLRのSE/testはエンジンが解決した方式を返す。ロバスト性は標準誤差と検定の補正の意味に限定する。

runnerはestimator、ordered項目、parameterization、meanstructure、std.lv=false、missing、likelihood、SE/test、optim.method、最大反復・許容誤差を解決済み設定として返す。初期adapterはNLMINB、最大反復20000とし、収束許容値は選定したエンジン版の値を固定manifestに記録してgolden生成前に凍結する。これは公開UIの任意エンジンオプションではない。エンジンが指定した推定器を別方式へ変えた場合は、WLSMV内部のDWLSのように定義に含まれるもの以外をエラーとする。

## 5. 結果抽出と標準化

非標準化推定値は元のパラメータ表順。std.lv（因子標準化）とstd.all（因子・観測または潜在応答の標準化）を別フィールドにする。`stdAllLoading_jf = Λjf sqrt(Φff)/sqrt(Σjj)`。`Dφ=diag(diagΦ)`として`factorCorrelation=Dφ^(-1/2) Φ Dφ^(-1/2)`。SE・CIの標準化版はエンジンがその定義で返すものだけ採用し、点推定を割った倍率で通常SEを代用しない。

順序閾値は有限内部閾値を推定尺度付きで返す。外端の±∞はJSON数値として返さず、境界種別文字列で表す。固定残差分散1と標準化残差分散Θjj/Σjjを混同しない。順序の再現相関は`Dσ=diag(diagΣ)`として`Dσ^(-1/2) Σ Dσ^(-1/2)`で、観測回答コードの相関ではない。共通性はstd.all尺度のdiag(ΛΦΛ′)/diagΣとして返す。

負のΘ/Φ対角、Φ非正定値、|因子相関|≥1、未順序閾値、特異Jacobian、境界・非収束を診断。不適解に対するSE/CI/検定は公開推論欄をnullとし、エンジンの生値は診断用に分離する。SEのみ不能で点推定が許容される場合は`solutionStatus=admissible`、`inferenceStatus=unavailable`を許す。

## 6. 検定統計量・適合度の契約

返却は[拡張結果契約](../contracts/FACTOR_EXTENSIONS_CONTRACT.md)の`fitMeasures[]`。metric、variant、engineKey、value、補正法、N/df、availabilityとreasonCodeを一組とする。

|表示指標|通常版エンジンキー|scaled版|robust版|
|---|---|---|---|
|χ²/df/p|chisq / df / pvalue|chisq.scaled / df.scaled / pvalue.scaled|独立した値を捏造しない。scaled検定と補正名を使用|
|CFI/TLI|cfi / tli|cfi.scaled / tli.scaled|cfi.robust / tli.robust|
|RMSEA/CI|rmsea / rmsea.ci.lower / rmsea.ci.upper|各キーのscaled系列|各キーのrobust系列|
|SRMR|srmr|提供なしはnull|提供なしはnull|

実エンジンのキーとCIキーの位置は採用版で存在検査し、登録した対応表を固定する。CI水準は入力confidenceLevelをfitMeasuresのRMSEA CI設定へ明示伝達する。指標の標準キー名を生成規則だけで推測しない。availabilityはavailable/not_applicable/not_implemented/failed。未提供キーはnullと理由を返す。

target model、baseline model、h1の推定器、統計量種別、補正係数、shift、df、元エンジンtestオブジェクト参照を保存する。相関行列PD検査を無効化してrobust指標を強制しない。baseline不適合・未収束ならCFI/TLIの関連variantをnull、RMSEA等は個別条件で判断する。通常のカットオフによる自動合否なし。

AIC/BICはML/MLRの比較可能な同一データ・同一観測変数・同一尤度規約のみ。初期UIはモデル比較機能を持たず、WLSMV/ULSMVで尤度を捏造しない。修正指標と自動モデル探索は初期版対象外。将来のscaled差の検定は専用検定を用い、補正χ²同士の単純な差で代用しない。

## 7. EFAからの草案と独立性

`sourceEfaResultId`は同一所有者の保存結果を解決し、元のdata lineage、fit行ID集合、設定hash、モデル作成時点を記録する。標準は利用者による手動割当。草案機能を設ける場合も負荷量閾値で自動確定せず、全項目の単純構造割当を確認してCFAモデルとして保存する。

同一dataset lineageなら行ID交差のcountを算出し、重複>0ならsame_data。非重複で事前に固定されたsplitとmodel hashが確認できる場合はholdout_recorded。別datasetで同一回答者の判別情報がなければunknown。externalの選択だけでconfirmedとしない。meta.isExplorative=trueを維持し、analysisPurpose=confirmatory_model、validationEvidenceで確認の意味を分離する。

探索元EFAに感度比較が付随する場合は親resultIdからcomparisonId・両比較子結果・探索使用行の和集合を解決する。主結果だけを探索使用データと見なし、比較で使った行を未使用holdoutと誤認しない。同じscopeに固定した初期仕様では集合は同じになることを検証する。比較のsmall_observed_differenceをCFAモデルの独立検証済みフラグへ変換しない。

5件法・N=1000〜2000の良好分布に対する明示連続近似はMLRの主要利用例とし、元measurementがordinalでもtreatmentで推定器を選ぶ。CFA自身のWLSMV対MLR自動感度比較は初期版には追加しない。将来実施する場合は同じ指標・同じ制約でも観測得点と潜在応答の推定対象・尺度が違うことを整合させ、EFAの行列差比較をそのまま流用しない。

## 8. API・保存・画面・運用

共通の409 stale、422 input/estimation、503 resourceと原子的result publishを使う。計算時の失敗はattemptIdに診断を保存し、正常モデルとして公開しない。対応エンジンが未導入なら503 `CFA_ENGINE_UNAVAILABLE`、ULSMVが未検証なら422 `CFA_ESTIMATOR_NOT_VALIDATED`。Rの警告を捕捉し、SE失敗と非収束を同一分類にまとめない。

manifest、parameter table、sample statistics、Γ/WLS.V参照、test/fit measures、モデル制約、engine版・hash、fit/excluded行ID、sourceEfaResultIdと独立性根拠を保存する。raw RオブジェクトをPython pickleへ変換しない。必要な数値・文字列をJSON/NPZ/Parquetへ明示変換し、raw engine logは内部診断としてパスを公開しない。

rows/projection/materialize/simulation=false、selectionKinds=[]。CFA図上の因子・項目クリックでReduxの回答者選択を変更しない。設定モデルと結果モデルhashを表示し、変更後に旧結果を新モデルの結果として見せない。KeepAlive・dataset切替・logical cancel・版照合・exportは既存規約を使用する。

入力エラーは対応項目の直下と上部のエラー一覧に併記する。実行失敗時は一覧見出しへフォーカスを移し、一覧から各入力へ移動できるようにする。推定診断の警告は色だけで区別せず、状態名・対象項目・修正可能な設定をテキストで示す。進捗は読み上げ対応、非表示KeepAliveページからの重複通知を抑制する。

本番実装時はrun-production.batによるローカル画面確認を受入に含める。ビルド・配布検証は実施指示がある段階で行い、設計資料作成やkernel試験と区別する。

## 9. 未実装ゲート

R同梱方式・ライセンス・依存固定・runner起動の製品検証、単純構造のoracle、SE/適合度variant、失敗診断、API/保存/FE、追加ULSMVを順に完了させる。これらは実装前の未検証事項であり、WLSMV/MLRの名前だけを選択肢へ追加して完了としない。[受入計画](FACTOR_EXTENSIONS_ACCEPTANCE.md)を参照。
