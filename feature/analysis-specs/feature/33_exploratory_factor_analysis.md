# Feature 033：探索的因子分析（EFA）機能仕様書

版1.1／2026-09-13／状態：設計確定、数値エンジン・本体実装の受入は未完了。
実装詳細：[DAVIS-FEAT-033-DESIGN](../tasks/DAVIS-FEAT-033-DESIGN.md)。関連：[入力・結果契約](../contracts/FACTOR_EXTENSIONS_CONTRACT.md)、[受入計画](../tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)。

## 1. 目的・範囲

アンケート項目の共通因子構造を探索する。主要利用条件は同一国内の一般的なアンケート、N=1000〜2000程度、5件法中心とする。順序尺度のモデル化にはポリコリック相関と最小残差法（MINRES／ULS系）を提供し、明示した連続近似のPearson＋ML／MINRESも提供する。因子数の候補、回転、欠損・相関・解の診断、再現可能な設定、Pearson／Polychoric感度分析を含める。

5件法でカテゴリ分布が概ね対称、床・天井への極端な集中がなく、各カテゴリが十分観測される場合、連続近似を合理的な実務選択肢として提示する。N=1000を統計的境界にはしない。ベル型ヒストグラムは単一項目の連続正規性や多変量正規性の証明ではなく、手法間の一致も潜在モデルの正しさの証明ではない。

現行のEFAは非加重・完全ケースのみである。PCA、PAF、混合相関・ポリシリアル、順序プロビット因子、確認的因子分析、構造方程式、pairwise、FIML、内部補完は対象外とする。CFAは独立した[Feature 033c](33c_confirmatory_factor_analysis.md)で扱う。旧Feature 033の連続ML資料とFeature 033bは移動案内であり、本書より優先しない。

## 2. 入力・測定水準・前処理

POST /api/v1/models/factor-analysis は [EFARequest](../contracts/factor_extension_requests.py) を受け、結果 method は efa、schemaVersion は factor_extensions.1 とする。生成Schemaは[efa.schema.json](../contracts/schemas/efa.schema.json)、入力例は[efa.request.json](../contracts/examples/efa.request.json)である。旧[FactorAnalysisRequest](../contracts/analysis_requests.py)と[factor_analysis.schema.json](../contracts/schemas/factor_analysis.schema.json)は旧連続ML資料の参照検証資産であり、現行API入力ではない。旧入力を自動変換せず、旧形式は明示的に拒否する。

3項目以上を選ぶ。測定水準はコードブックまたは根拠付きの分析時指定から解決し、カテゴリ数・標本数・分布形状で自動変更しない。

|入力状態|既定候補|制御|
|---|---|---|
|全項目が連続|Pearson＋ML|多変量正規性の前提を表示。MINRESも選択可能|
|順序尺度を順序モデルとして扱う|Polychoric＋MINRES／ULS系|潜在応答と閾値を仮定する旨を表示|
|順序尺度の連続近似|Pearson＋MLまたはMINRES|項目ごとの明示同意と等間隔順位得点が必要|
|順序と連続のモデル化が混在|実行不可|混合相関・ポリシリアル経路は初期版未対応|
|名義・ID・文字列・MA親・水準不明|実行不可|対象列または測定水準の確認が必要|

順序項目は許容コード、カテゴリ順序、逆転指定を分析情報として保存する。カテゴリ順序を数値コードやラベルの辞書順から生成しない。逆転は確認済み順序の反転として一度だけ適用し、元の順序と最終順序を保存する。連続近似では最終位置を1..Kの等間隔得点にする。コードブック変換済み列への二重逆転を防ぐ。

全対象項目の完全ケースを固定する。無回答・非該当・不正値を区別し、除外理由と項目別件数を返す。既存補完値の利用は共通契約の use_current_values に従い、補完件数と来歴を明記する。datasetの解決済みウェイトが存在する場合は FA_WEIGHT_UNSUPPORTED で拒否し、設定を none へ変更して続行しない。

未観測の許容カテゴリ、定数、項目ごとの実観測カテゴリ不足、n<=p、q>=p、df<0、非正定値または数値的特異な相関行列は停止条件である。カテゴリの削除・統合、nearPD、ridge、cor.smooth、因子数の自動削減は行わない。

## 3. 相関・抽出・因子数

Pearson相関は同じfit集合から ddof=1 の標本共分散と標本標準偏差で求める。Polychoricは全項目で共通の完全ケース集合を使う二段階推定であり、項目閾値を項目対で共有する。2値項目は同じ推定系のtetrachoric特殊形とする。0.5加算、カテゴリ統合、負確率のclip、相関行列補正は行わない。相関未収束、境界推定、非正定値は抽出へ進めず、対別診断と試行を保存する。

抽出法は Pearson 経路のMLと、Pearson／Polychoric双方の単一MINRES／ULS系である。MLをPolychoricへ適用せず、未収束時に別の抽出法へ切り替えない。MLの完全目的関数、勾配、複数start、Varimax／Promax、連続得点、参考推論は[実装詳細](../tasks/DAVIS-FEAT-033-DESIGN.md)に定義する。MINRES／ULS系は目的関数識別子 uls_profile_full_v1 を保存し、非対角MINRESのSSEと混同しない。

因子数は利用者が最終指定する。全相関行列のスクリープロット、項目別独立置換による平行分析、明示した compareFactors の比較を提供する。平行分析は候補を示すだけで nFactors を変更しない。観測・比較側とも対角1の全相関行列の降順固有値を使い、項目分布を厳密に維持する。反復失敗を再抽選・除外せず、失敗時の分位値と候補はnullとする。主qの失敗を別qの成功で置換しない。

回転はPromaxを既定とし、Varimax、無回転を提供する。1因子では適用回転をnoneとし、要求との差と理由を保存する。回転失敗を無回転で置き換えない。Promaxではpattern、structure、因子間相関Phiを別表とし、pattern二乗和を加算可能な因子寄与率として表示しない。

## 4. 結果・診断・推論

pattern、structure、Phi、共通性、独自性、観測相関、再現相関、対角を含む残差、非対角RMSR、最適化履歴、分布・相関診断を返す。computationStatus、solutionStatus、inferenceStatusを分離する。未収束、回転特異、独自性境界、負の独自性、共通性範囲外、特異Phiを明示する。pattern係数の絶対値だけで斜交解を不適と判定しない。

MINRES／ULS系は負荷量・残差を中心に返し、chi-square、CFI、TLI、RMSEA、係数SEを返さない。Pearson＋MLだけが適用条件付きで通常の参考chi-square、df、p値、RMSEA、KMO、Bartlett球面性を返せる。境界・不適解・定義不能な推論値は理由付きnullとし、0を代用しない。MLの通常近似をscaledまたはrobustと表示しない。

表示用の負荷量強調閾値は初期値 abs(0.4) とするが、係数の切捨て、因子選択、解の適否には使わない。因子名は自動断定せず、利用者が表示名を設定できる。

## 5. 得点・保存・PCP

scoreMethodの既定はnoneである。Pearson経路で適切な解かつ明示したregressionまたはbartlettだけ、学習時の標本平均・標本標準偏差・標本相関・得点係数を固定して得点、射影、PCP行選択、派生列保存を有効にする。連続近似を含む場合は continuous_approximation と来歴へ残す。Polychoric経路、得点none、不適解では得点に基づくrows、projection、materialize、PCP操作を無効にする。

回答者得点は全fit行を原rowIdで結合し、対象外・欠損予測行はnullにする。項目・因子のクリックを回答者行選択として扱わない。得点が有効な結果だけ中央selection、既存L1/L2、実ポインタ選択、相互ハイライト、export、保存を利用できる。dataset、列、コードブック、maskの版変更で結果をstaleにし、KeepAliveで設定・結果・スクロールを保持する。

結果・失敗試行・比較は共通の所有dataset、revision、scope、有限JSON、原子的保存、idempotency、stale、削除、ページ出力の規約に従う。EFAの設定、変換、相関、閾値、start、平行分析反復、比較条件、エンジン版とhashを保存する。

## 6. Pearson／Polychoric感度分析

感度分析は全項目の元measurementがordinalの場合に提供する。API既定はoffであり、enabled=true、独立したapproximationAcknowledged=true、parallelAnalysis.enabled=trueを同時に要求する。主結果を変更せず、Pearson-MINRESとPolychoric-MINRESを同じfit行、項目、順序、逆転、欠損、q、回転、制約、start、seed、置換indexで比較する。主MLを比較用MINRESへ置換しない。

両側の因子は絶対congruence最大の一対一割当と符号付き置換で整合し、Phiとstructureにも同じ変換を適用する。元の行列を上書きしない。次善割当との差、低congruence、ゼロノルム、rank不足から曖昧性を判定する。Procrustesは補助の空間診断だけであり、pattern差や割当変更を消すために使わない。

相関・負荷量・共通性・Phiの差、確定因子割当の変更、平行分析候補の差を返す。異なるqの不足列を0で埋めて差を計算しない。片側失敗、平行分析不能、不適解、曖昧整合は「差なし」にしない。比較artifactは主resultIdとは独立し、comparisonIdで進捗、取得、export、cancelを提供する。感度比較の一致を同等性検定、正規性の証明、CFAの独立検証と表示しない。

## 7. 受入

受入IDはEFA-B01〜EFA-B22である。尺度・順序・逆転・欠損・ウェイト拒否、Pearson／Polychoric、ML／ULS系、回転・不適解、平行分析・候補比較、得点、保存、PCP、KeepAlive、感度分析、local/Pyodide、性能を検証する。数値oracle、許容差、実装順序、未実施事項は[受入計画](../tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md)と[検証報告](../validation/FACTOR_EXTENSIONS_VALIDATION.md)を参照する。

## 一次資料との対応

[S-FA](../references/PRIMARY_SOURCES.md#s-fa)、[S-FA-SRC](../references/PRIMARY_SOURCES.md#s-fa-src)、[S-ROT](../references/PRIMARY_SOURCES.md#s-rot)、[拡張一次資料](../references/FACTOR_EXTENSIONS_SOURCES.md)を参照する。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典が唯一の実装方法を要求するという意味ではない。
