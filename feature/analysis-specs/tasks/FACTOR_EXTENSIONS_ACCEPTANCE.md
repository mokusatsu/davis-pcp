# Feature 033b・033c：実装順序・受入条件

版1.0／2026-09-13。以下は実装の受入計画であり、実行済み実績ではない。[検証実績](../validation/FACTOR_EXTENSIONS_VALIDATION.md)と区別する。033のFA01「ML以外を指定できない」等は033bへの受入条件として流用しない。

## 1. 段階と終了条件

|段階|対象|終了条件|
|---|---|---|
|B0|尺度・カテゴリ・欠損・契約|コード順序、逆転、重み、scope、strict入力の意味検証|
|B1|ポリコリック＋単一ULS系＋既存ML|独立oracle、目的値、境界・未収束、失敗経路の照合|
|B2|PA・回転・候補比較・得点・感度比較|再現相関不変性、共通置換、因子整合・差分、順序得点を提供しない|
|B3|EFA API/保存/画面|行IDと版、KeepAlive、PCP、run-production.batで確認|
|B4|EFA静的実行|同一kernelのPyodide数値と状態・保存検証。ビルド実行は別指示に従う|
|C0|CFA runner・依存固定|local R/lavaan、配布可能性、任意式排除、能力応答|
|C1|CFA WLSMV/MLR/ML|測定モデル、識別、点推定・SE・適合度の独立golden照合|
|C2|CFA API/保存/画面|独立性の根拠、失敗診断、KeepAlive、local操作確認|
|C3|追加ULSMV|専用oracle・失敗条件。合格前はUI能力false|

C0以降をB段階の必須条件にしない。CFA静的計算は別機能ゲートで、C2完了が静的CFAを意味しない。設計文書の作成時には本体実装・ビルド・全体試験を実施しない。実装時も対象単位の検証を先に行い、問題を解消してから全体回帰を行う。

## 2. oracleと数値基準

oracleのR script、入力hash、出力、sessionInfo、ライブラリversion/source hash、オプション・乱数規約を保存する。期待値は製品kernelから生成しない。golden更新は製品失敗を解消するために自動承認しない。

|対象|一次比較|受入許容差（初期基準）|
|---|---|---|
|polychoric|polycor::polychor ML=FALSE、同一閾値・maxcor・補正なし|ρ/閾値atol1e-5、整ったfixture|
|ULS profile|factor_analyzer公開profile規約と独立した数式oracle|目的値atol1e-7、再現相関/共通性atol1e-5|
|MINRES系の外部照合|psych::fa(fm=minres)、同じR・q・回転条件|Σhat/h² atol1e-4を初期目標。目的関数・制約差は別記し、一致未達を成功扱いしない|
|ML|R stats::factanal、同じR/下限/初期値/回転|目的値1e-7、Σhat/h²1e-5|
|回転|同規約のoracle、raw/rotated再構成|同じ解のΛΦΛ′の差atol1e-8|
|CFA|別作成した固定R lavaan script（adapterを使わない）|点推定・閾値atol1e-5、SE1e-5、χ²1e-4、CFI/TLI/RMSEA/SRMR1e-5|
|不変性|同じモデルのコード・行・項目変換|deterministic統計量atol1e-8、反復推定atol1e-5|

比較は原則rtol=1e-5も併用し、ゼロ近傍は絶対誤差で判定する。悪条件fixtureを通常精度の成功例と同じ閾値で強制通過させず、失敗・警告の正しさを判定する。因子順・符号を揃え、回転規約が異なる場合はpatternの直接比較ではなく再現相関・共通性・目的値を比較する。SE比較はパラメータ表の尺度・自由/固定を合わせる。

## 3. EFA受入マトリクス

|ID|検証内容|fixture・判定|
|---|---|---|
|EFA-B01|尺度routing|2/5/6/7カテゴリはordinalのまま。未知水準・混在・名義拒否。明示近似のみpearson|
|EFA-B02|カテゴリ順序|1..5→10,20,40,80,160の順序保存再符号化でρ不変。ラベル辞書順に依存しない|
|EFA-B03|逆転・列順|一項目逆転で対応行列符号変換、二重反転なし。項目順をIDで揃えて同値|
|EFA-B04|欠損・不正|missing/NA/invalid/補完を含む。listwise集合・件数・行hash一致、pairwise拒否|
|EFA-B05|入力限界|定数、未観測カテゴリ、カテゴリ1件だけ、n不足、df負、危険な数値を所定コードで拒否|
|EFA-B06|相関oracle|2値・5件法・非対称分布・異なるカテゴリ数。閾値とρを別に比較|
|EFA-B07|相関失敗・非正定値|疎セル、境界±.9999、失敗注入、非PD行列。抽出へ進まず補正なし|
|EFA-B08|ULS/ML|同じRの目的・制約・最適化uと報告ψを照合。下限start・全失敗を保持|
|EFA-B09|回転|none/Varimax/Promax、S=ΛΦ、diagΦ=1、h²正解、斜交の加算寄与なし|
|EFA-B10|不適解|負ψ、境界u、特異Φ、回転失敗、|pattern|>1でも単独判定しない|
|EFA-B11|平行分析|項目分布保持、双方同相関・同固有値、seed再現、候補0、失敗反復でnull|
|EFA-B12|候補比較|q別の成功/失敗を全件保持。主q失敗を別qで置換しない|
|EFA-B13|得点|連続regression/Bartlett fit/predict一致、近似ラベル、順序得点拒否、rowId join|
|EFA-B14|推論|ULS系のχ²等null、MLのみ033式・適用条件、境界解の推論不可|
|EFA-B15|重み・再現|datasetのsurvey/frequencyを拒否、明示noneで別試行、設定/版/hash/start保存|
|EFA-B16|UI/統合|PCP選択とactive交差、非対象行null、stale拒否、KeepAlive・dataset切替・local/static|
|EFA-B17|実務プロファイル|5件法・N=1000/2000、良好分布でPearson主結果を選べる。N=999/1000や絶対歪度1前後で強制routingしない|
|EFA-B18|同条件ペア|fit行・項目・逆転・欠損・q・回転・MINRESを固定、共通置換index。主MLを比較MINRESで上書きしない|
|EFA-B19|因子整合|既知の符号反転/置換で差0、Φも変換、曖昧対応でindeterminate。Procrustesだけで差を消さない|
|EFA-B20|比較指標|既知の負荷量/共通性/Φ差、割当変更、PA3対4、異qの係数差null、曖昧項目の扱い|
|EFA-B21|判定・失敗|目安直前/一致/超過、片側失敗、PA不能、境界解、無断fallbackなし、同等性証明と表示しない|
|EFA-B22|比較保存・性能|comparisonId、主結果独立表示、副解析cancel/stale、N×p×K×PA反復の実測、rows/PCP非干渉|

## 4. CFA受入マトリクス

|ID|検証内容|fixture・判定|
|---|---|---|
|CFA-C01|モデル構造|2因子×3項目、marker固定1、重複/未所属/未知/交差負荷拒否|
|CFA-C02|尺度・閾値|順序theta残差1、切片0、閾値自由、std.all再構成、6/7カテゴリでordinal|
|CFA-C03|識別|df<0、df=0、Jacobian/情報特異、因子相関1近傍。dfだけで成功にしない|
|CFA-C04|WLSMV|閾値/相関/Γ順序・scale/対角点推定/完全推論情報を照合|
|CFA-C05|MLR|非正規連続fixture、MLとの点推定関係・SE/testの相違、normal尤度規約|
|CFA-C06|通常ML|同一完全ケースによる標準推論、標本共分散分母とN倍率を照合|
|CFA-C07|ULSMV追加|同条件WLSMVとの比較と独立golden。小標本・低負荷で失敗も記録|
|CFA-C08|適合度|standard/scaled/robustを個別キー照合、baseline失敗/非PD/df0で理由付きnull|
|CFA-C09|不適解・未収束|負分散、SE不能、境界、未順序閾値、optimizer失敗。状態を分離|
|CFA-C10|欠損・ウェイト|完全ケース一致、ordinal FIML拒否、survey/frequencyを黙って非加重化しない|
|CFA-C11|独立性|同一/一部重複/非重複split/別dataset不明/モデル再編集。intentだけで認定しない|
|CFA-C12|安全なrunner|悪意ある列ラベル・因子名・任意式がR構文にならない、未導入時の能力表示|
|CFA-C13|API/保存|版競合、cancel、失敗trial、SE不能、full statistics/hash、表export、stale|
|CFA-C14|画面/環境|モデル表と図の一致、キーボード操作、KeepAlive、得点操作false、static未対応|

CFA-C11では、EFA感度比較の親・両子結果の探索行を解決し、感度比較が一致しても独立確認済みにならないことを追加検証する。CFA-C05では5件法を明示近似したMLR経路も検証する。

## 5. 合成データ計画

[fixture計画](../fixtures/FACTOR_EXTENSIONS_FIXTURES.md)に生成モデルと変換条件を定義する。乱数標本での真値との近さをoracle一致の代わりにしない。主要条件はN=1000/2000、5件法、対称で各カテゴリ十分な分布とする。N=100/300、負荷.4/.7、2/4/7カテゴリ、非対称・異なる分布・潜在非正規も追加し、標本数による方式の普遍順位づけはしない。小標本の一回成功を安定性の証明にしない。

性能はN=1000/2000×p=12/30/60×K=5（追加2/7）×PA反復100/500の代表組合せをlocalとPyodideで測定する。主結果表示まで、比較完了まで、相関・PA別時間、ピークメモリ、中断応答を分けて記録する。「大標本なら比較コストは問題ない」と未測定のまま完了判定しない。測定値からUIの進捗とキューを調整し、分析対象行や反復数を黙って減らさない。

## 6. 完了証拠

各段階はcommitまたは入力snapshot hash、実行コマンド、runtime、試験件数、最大誤差、診断例、画面操作記録、未実施を残す。本体数値・API・GUI・ビルド・配布は別ゲート。設計Schemaの成功件数や旧42件を、新EFA/CFAの数値検証件数として合算しない。
