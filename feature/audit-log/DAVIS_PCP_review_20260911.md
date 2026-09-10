# DAVIS-PCP 静的配布版・アンケート分析レビュー

レビュー日: 2026年9月11日（日本時間）  
対象: `davis-pcp-static(1).zip`  
SHA-256: `3a6197e32e1e58e179ed4ccefbb47f7827a0d77d69d93757b331fc516b9ba66e`

## 結論

機能数の不足よりも、「同じデータ・同じ対象者・同じ設問定義を各機能が同じ意味で扱うこと」に重大な不整合がある。とくに、サブグループ検証、意味的欠損、逆転項目、感度分析、補完と復元については、影響する機能の結果を確証や報告値として使用する前に修正が必要。

本書は33項目を整理した。内訳はAPI再現29項目、計算関数での再現2項目、ソース確認のみ2項目。各項目は複数の関連症状をまとめたもので、テストの成功率や網羅率を表す数ではない。P0は当該機能の利用前に修正・無効化が必要、P1は主要な分析機能の信頼性を損なうため優先修正、P2は入力契約・探索方式など次段階で是正する問題を意味する。

## 検証方法と限界

添付ZIPを展開し、同梱`static/pyodide/backend_app.zip`のPythonソースとフロントエンド配布JSを照合した。数値・API検証では、同梱Pyodideと同梱パッケージをNodeから起動し、実アプリのASGI APIを呼び出した。ホストPC用Pythonでアルゴリズムを別実装した試験ではない。Python 3.12.7、Polars 1.18.0、SciPy 1.14.1、scikit-learn 1.6.1で、CSVインポート26回を含む114回のAPI呼び出しを記録した。原ファイルは変更していない。配布用の再現ハーネスも別のクリーンなWASM環境で同じ114回のAPI試験を最後まで実行し、動作を確認した。再実行ログは`evidence/replay_check/`に保存した。試験完了は製品が合格したことを意味しない。

ブラウザのローカルURL読み込みは`ERR_BLOCKED_BY_ADMINISTRATOR`で制限された。このためPCPのドラッグ、ブラシ、描画、キーボード操作、ブラウザのIndexedDB/IDBFS永続化、再読込、実ブラウザでのダウンロードの完了は未確認。UIとの対応は配布JSの読解で確認した範囲に限る。ブラウザE2Eが完了したとは評価していない。大規模データ性能、全アルゴリズムの数学的正当性、全画面の操作網羅も保証しない。時系列データ機能の欠落は評価対象にしていない。

NodeではMEMFSを使用し、Web WorkerのPython初期化部分を再利用した。ブラウザのイベントループやストレージ層との相違がある。WASMのParquet読込不具合は同じ配布パッケージで再現したもので、IDBFSの実測とは区別する。

## 優先度一覧

| ID | 優先度 | 確認方法 | 問題 |
|---|---|---|---|
| A01 | P0 | API再現 | サブグループ検証が群間差ではなく評価データ全体の平均とゼロを比較する |
| A02 | P1 | API再現 | 候補固定の説明に反して再探索し、候補ハッシュも条件を十分に表現しない |
| A03 | P1 | API再現 | k分割交差検証が最初の1分割しか評価しない |
| A04 | P1 | API再現 | 独立データ検証がデータセット内連番IDの重複を同一回答者と誤認する |
| A05 | P0 | API再現 | 二択設問の該当カテゴリが不定で、同じ探索の増減方向が反転する |
| A06 | P1 | API再現 | 指定した最小群サイズが内部で緩和され、設定未満の群が提示される |
| A07 | P1 | API再現 | 3カテゴリ名義尺度を評価せず、通常の探索0件として返す |
| A08 | P2 | ソース確認のみ | ビーム幅が品質に基づく探索幅になっていない |
| B01 | P0 | API再現 | 欠損コードの適用が機能ごとに異なり、同じ設問の有効N・平均が一致しない |
| B02 | P0 | API再現 | 逆転項目の尺度が部分集団と欠損コードに依存し、加重平均とも一致しない |
| B03 | P1 | API再現 | 重み列の欠損コードを実際の重みとして使う |
| B04 | P1 | API再現 | 調査ウェイトの任意の倍率でクロス集計のp値が激変する |
| B05 | P1 | API再現 | 複数回答集計がUIから送られた重みを黙って無視する |
| B06 | P1 | API再現 | コードブックに未出現の選択肢を足すだけでクロス集計の検定が消える |
| C01 | P0 | API再現 | 対象0件のactive/sample scopeが全データへ拡大する |
| C02 | P1 | API再現 | 復元抽出で選ばれた重複回数が、その後の集計で失われる |
| C03 | P1 | API再現 | KDAが対象行の指定を受けず全データで分析する |
| C04 | P0 | API再現 | 発見したサブグループを感度分析へ渡すと、差ではなく全体平均を評価する |
| D01 | P0 | API再現 | 感度分析の平均差の信頼区間に、全体平均の標準誤差を使用する |
| D02 | P1 | API再現 | bootstrapBとseedを表示するが、感度分析でブートストラップしていない |
| D03 | P1 | API再現 | 名義尺度の数値コードを外れ値として除外する |
| D04 | P1 | API再現 | 目的変数が定数または説明力ゼロでも最優先キードライバーを提示する |
| D05 | P1 | API再現 | 決定木のクラス割合を人数へ直接整数化し、人数が0になる |
| D06 | P1 | API再現 | 決定木の内部ノードに所属する行が0件として記録される |
| E01 | P0 | API再現 | 補完処理が欠損コード99を学習データとして扱い、誤った値を書き込む |
| E02 | P0 | API再現 | 名義尺度・複数回答の列に平均補完を適用し、存在しない選択肢コードを作る |
| E03 | P1 | 計算関数で再現 | 補完の空列指定と不正な定数が、安全側ではなくデータ更新へ進む |
| E04 | P1 | 計算関数で再現 | 条件付き補完が、補完対象として選んでいない説明変数を使わない |
| E05 | P1 | API再現 | 別データとして補完すると、新しく埋めたセルのマスク・操作履歴が残らない |
| E06 | P0 | API再現 | 同梱WASM環境で原データ・スナップショットの読込が失敗し、Undoと再現パッケージ出力が動かない |
| E07 | P1 | ソース確認のみ | Undoの状態復元がデータ値だけで、コードブックや補完マスクを過去状態に戻さない構造 |
| F01 | P2 | API再現 | 全項目空欄のCSVレコードを無通知で削除する |
| F02 | P2 | API再現 | 存在しない回答者IDをサンプリング対象として受け入れる |

## A. 探索と検証

### A01 [P0] サブグループ検証が群間差ではなく評価データ全体の平均とゼロを比較する

確認方法: API再現。

再現条件: A群120人を平均1.2、B群120人を平均4.2にした240行を作り、groupを属性、qを比率尺度の質問に設定。classic探索後、候補を固定して検証する。別途、全回答から2.5を引いた同じ構造のデータでも同条件で検証する。

実際の結果: 元データはeffectSize=2.6194、pValue=0.0（APIで小数6桁に丸められた値）。平行移動後はeffectSize=0.1194、pValue=0.507215。両データの群間差は同じ3.0なのに検証判定が変わる。コードはframe=eval_dfの全行にttest_1samp(vals,0.0)を適用し、平均をeffectSizeとして返す。

影響: 「この属性の回答が高い／低い」という発見を検証していない。1〜5の尺度と中心化した尺度で結論が変わる。isExploratory=falseはこの誤った量に付与される。

修正方針: 候補条件を評価データに適用し、事前に固定した対象群・比較群・対象カテゴリ・効果量を評価する。平均差、割合差、モデル差を明示的に分岐させる。一般的な独立2群平均差なら、設計に合った標準誤差・検定を用いる。単にttest_1sampをttest_indへ置き換えるだけでは候補固定の問題は解決しない。

回帰テストの合格条件: 全値に同じ定数を加えても平均差・平均差の検定結果が不変。異なる候補条件を渡すと実際の対象群・比較群が変化する。検証結果に群別有効Nと推定対象を記録する。

証跡: `batch1: verification.holdout / verification.pinned、batch4: verification_shift`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/mining.py:229-273`。行番号付き抜粋は`source_excerpts/A01.txt`。

### A02 [P1] 候補固定の説明に反して再探索し、候補ハッシュも条件を十分に表現しない

確認方法: API再現。

再現条件: 探索済みcandidateIdsとcandidateSetHashを渡して検証。元関数を変更せず呼び出し記録だけを追加し、内部呼び出しを観察する。modernでは同じ120行に対し属性gと属性hを切り替える。

実際の結果: 固定候補の検証中にrun_subgroup_miningが168行、min_group_size=30で呼ばれた。classicのIDはins_001等の連番。modernの条件はrule.conditionsにあるのに、ハッシュは存在しないitem.conditionを参照する。gの条件とhの条件でcandidateSetHashが完全一致した。

影響: 探索時に選んだ仮説と検証した仮説の同一性を保証できない。ハッシュ関数の衝突ではなく、ハッシュ対象の情報欠落。全体データで探索した後の分割を、独立な確認として扱う問題も残る。

修正方針: 候補を条件AST・比較対象・対象カテゴリ・効果量・データ/スキーマrevision・探索scopeの不変オブジェクトとして保存する。検証はこのオブジェクトを読み、再探索しない。ハッシュを正規化した完全な候補内容から生成する。確認用データを探索段階から分離する。

回帰テストの合格条件: 検証中の探索関数呼び出し回数が0。g=Aからh=X、閾値、対象カテゴリを変更すればハッシュが変わる。並べ替えだけでは仮説IDが変わらない。

証跡: `batch5: verify_discovery_trace、batch4: hash_g / hash_h`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/mining.py:151-157`、`app/api/mining.py:203-228`、`app/api/mining.py:378-384`、`app/algorithms/mining/subgroup.py:328-340`。行番号付き抜粋は`source_excerpts/A02.txt`。

### A03 [P1] k分割交差検証が最初の1分割しか評価しない

確認方法: API再現。

再現条件: 240行にmethod=cross_validation、k=5を指定。

実際の結果: nSelection=192、nEvaluation=48の1回の評価のみ。実装はevaluation_ids=folds[0]で、foldごとのループがない。

影響: 表示は交差検証でも、実態は1/5を評価にした単一分割。分割間の安定性を評価できない。

修正方針: k分割の全foldを処理して、各観測が一度ずつ評価対象になる方式と、候補の選択・統合規則を定義する。未実装の間は単一分割と表示する。

回帰テストの合格条件: 各rowIdの評価回数が1、全foldの結果が保存される。k=5とholdoutの処理経路を区別できる。

証跡: `batch1: verification.cross_validation`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/mining.py:174-181`。行番号付き抜粋は`source_excerpts/A03.txt`。

### A04 [P1] 独立データ検証がデータセット内連番IDの重複を同一回答者と誤認する

確認方法: API再現。

再現条件: 別々に作成したCSVを通常のインポートAPIで2つ取り込み、後者を独立検証データに指定する。

実際の結果: 422 VERIFICATION_SCOPE_OVERLAP。「独立データに同一rowIdが混入しています。」と返る。双方に自動採番されたROW-000001等を、datasetIdを区別せず比較する。

影響: 通常のインポート経由の独立検証が成立しない。逆に、回答者の実質的な重複は連番だけでは検出できない。

修正方針: 内部行キーを(datasetId,rowId)として扱い、調査をまたぐ回答者重複は明示したrespondentId等の別契約で検査する。内部連番の一致を独立性の根拠にしない。

回帰テストの合格条件: 別々に作成した2つのCSVを検証に使える。明示的に共通回答者IDを設定した重複ケースは拒否または適切に警告する。

証跡: `batch2: independent_validation`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/mining.py:182-199`。行番号付き抜粋は`source_excerpts/A04.txt`。

### A05 [P0] 二択設問の該当カテゴリが不定で、同じ探索の増減方向が反転する

確認方法: API再現。

再現条件: A群yes80%、B群yes20%の二択設問で同一リクエストを4回実行。さらに数値コード1/2の二択に対象カテゴリを整数1と文字列"1"で指定する。

実際の結果: 同じg=Bという条件のdelta_proportionが+0.6、-0.6、+0.6、-0.6と反転した。自動対象はunique().to_list()[0]で、選ばれたカテゴリを結果に記録しない。数値コードで整数1なら80%/20%、文字列"1"なら両群0%になる。

影響: 「60ポイント高い／低い」の意味が実行ごとに変わり、説明から何の割合かも分からない。コードブックの文字列コードと実データ型の不一致も誤集計を生む。

修正方針: 対象カテゴリをUI/APIで明示し、normalize_code等で実データと一貫して比較する。省略時の決定規則を安定化し、選択したカテゴリ・ラベルを全結果、候補ハッシュ、検証に含める。存在しない指定値はエラーにする。

回帰テストの合格条件: 同じ入力の再実行で対象カテゴリ・符号・説明が不変。整数1とコード"1"が同じカテゴリとして扱われる。全結果にtargetCategoryが存在する。

証跡: `batch3: modern_nominal_2 / binary_category_int / binary_category_str`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/mining/modern_subgroup.py:715-744`。行番号付き抜粋は`source_excerpts/A05.txt`。

### A06 [P1] 指定した最小群サイズが内部で緩和され、設定未満の群が提示される

確認方法: API再現。

再現条件: 40行、A/B各20人のデータでmodernのminGroupSize=30、classicのminGroupSize=100を指定。

実際の結果: どちらも20人の群を返す。modernは警告なし。classicのconfigには100と記録されるが、提示群は20人でwarnings=[]。小標本時に閾値を勝手に下げる分岐がある。

影響: 小規模セグメントの除外という利用者の制約が守られない。後から設定値を見ても有効閾値を追跡できない。

修正方針: 指定閾値をhard constraintとして対象群・比較群の有効Nに適用する。緩和モードが必要なら明示的な選択にし、要求値と実効値を両方返す。

回帰テストの合格条件: 本例では0件または明示的な不足エラー。設定値未満の候補は最終結果に混入しない。

証跡: `batch3: modern_min_size / classic_min_size`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/mining/subgroup.py:170-174`、`app/algorithms/mining/subgroup.py:287-299`、`app/algorithms/mining/modern_subgroup.py:652-656`。行番号付き抜粋は`source_excerpts/A06.txt`。

### A07 [P1] 3カテゴリ名義尺度を評価せず、通常の探索0件として返す

確認方法: API再現。

再現条件: red/blue/greenの名義尺度質問を対象としてmodern standard探索を実行。

実際の結果: HTTP200、questions_evaluated_count=1、insights=[]、warnings=[]。コードでは二択でない非数値カテゴリをcontinueしている。

影響: 「この設問には差がなかった」と「この種類の設問を処理していない」を利用者が区別できない。アンケートでは一般的な入力種別。

修正方針: 対応する多カテゴリの比較を実装するか、対象選択時に非対応を明示する。requested/evaluated/skippedの設問数と理由を分ける。

回帰テストの合格条件: 未対応の場合にskippedTargetsへ列名・尺度・理由を記録し、evaluated_countに算入しない。

証跡: `batch3: modern_nominal_3`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/mining/modern_subgroup.py:722-740`、`app/algorithms/mining/modern_subgroup.py:951-960`。行番号付き抜粋は`source_excerpts/A07.txt`。

### A08 [P2] ビーム幅が品質に基づく探索幅になっていない

確認方法: ソース確認のみ。

再現条件: run_modern_subgroup_miningの候補生成ループを確認。

実際の結果: depth1からdepth2までは候補を展開した後にnext_rule_beam[:beam_width*2]を取る。切り詰め前に品質スコア順へ並べていない。スコア計算は候補生成後。

影響: 既定depth=2ではbeamWidthが候補生成量を期待どおり制限しない。depth>=3では高品質候補より先に生成された候補を優先する構造で、列・条件順序依存を生む懸念がある。性能劣化の具体的な規模は未測定。

修正方針: 各深さで候補を評価し、品質と多様性で選んでから次の展開を行う。実態が全列挙＋上限なら、その名称とパラメータに変更する。

回帰テストの合格条件: 候補数・展開数を記録し、beamWidthの変更が仕様どおり効く。属性列の順序入替で同等の結果が得られることを検査する。

証跡: `ソース確認。大規模入力の性能・順序依存の実測は未実施。`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/mining/modern_subgroup.py:673-718`。行番号付き抜粋は`source_excerpts/A08.txt`。

## B. コードブック・尺度・重み・クロス集計

### B01 [P0] 欠損コードの適用が機能ごとに異なり、同じ設問の有効N・平均が一致しない

確認方法: API再現。

再現条件: q=[1,2,3,4,99,null]で99をmissingCodesに指定し、単純集計、QQプロット、FEDF分布、LOESS、KPI感度分析を比較。

実際の結果: 単純集計は有効4件、平均2.5。QQ/FEDFは99を観測値に含め、有効5件。FEDF平均21.8、最大99。KPI感度分析の基準平均も21.8。LOESSの入力点にも99が残る。

影響: コードブックで欠損を設定しても、別の分析タブでは99点として処理される。単なる表示の違いではなく分析対象そのものが違う。

修正方針: 解析対象生成を共通化し、欠損コード・非該当・逆転・尺度・有効母集団を同じ規則で適用する。生のDataFrameを直接使うエンドポイントを棚卸しする。

回帰テストの合格条件: 同じscope/列の有効Nが機能間で一致。99をnullへ置換した同値データと同じ結果になる。PCAは本テストで99除外ができており、その動作を退行させない。

証跡: `batch1: missing_paths`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/summaries.py:188-202`、`app/api/distribution.py:24-48`、`app/api/regression.py:31-61`、`app/api/robustness.py:89-126`。行番号付き抜粋は`source_excerpts/B01.txt`。

### B02 [P0] 逆転項目の尺度が部分集団と欠損コードに依存し、加重平均とも一致しない

確認方法: API再現。

再現条件: q=[1,1,5]を逆転するinterval質問、全員の重みを1とする。さらに最初の2人だけを集計。別例でq=[1,5,99]、missingCodes=[99]、categoryOrder=[1,2,3,4,5,99]を設定。

実際の結果: 全体の通常平均3.6667に対し加重平均2.3333。部分集団のq=1,1は平均1となり、固定1〜5尺度で逆転した場合の平均5にならない。99をカテゴリ順に含む例では有効値1,5が99,95へ変換され平均97となる。

影響: 同じ回答者の得点が絞り込みによって変わる。全員等重みなのに通常集計と加重集計で逆の結果になる。欠損除外ができていても、逆転の端点に欠損コードが混入する。

修正方針: 逆転の下限・上限を質問の固定尺度として保持する。欠損/非該当コードを端点候補から除外。通常/加重集計が同じ変換済み値を使うようにする。尺度端点未定義なら観測部分集団から黙って推定しない。

回帰テストの合格条件: 全員w=1で通常平均と加重平均が一致。全体と部分集団で各回答者の逆転値が同じ。1〜5尺度の変換後値は1〜5を逸脱しない。

証跡: `batch1: weighted_reverse、batch3: reverse_subset、batch4: reverse_missing_order`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/domain/codebook_adapter.py:227-248`、`app/algorithms/summaries/core.py:260-320`。行番号付き抜粋は`source_excerpts/B02.txt`。

### B03 [P1] 重み列の欠損コードを実際の重みとして使う

確認方法: API再現。

再現条件: q=[1,5]、w=[1,99]。wのrole=weight、missingCodes=[99]を設定して加重集計。

実際の結果: weightedMean=4.96、weightedN=100、weightMissingCount=0。99を欠損でなく99倍の重みとして扱う。

影響: 無効な1人が全体結果をほぼ決める。重み列をコードブックで管理している見た目と計算規則が不一致。

修正方針: extract_weightsに重み列のコードブック仕様を渡し、欠損/非該当コード、0、負値、無限大を明確な方針で処理する。除外数と理由を返す。

回帰テストの合格条件: 本例は重み99を除外した平均1、または欠損重みの明示的エラーとなる。99倍重みとしては利用しない。

証跡: `batch2: weight_missing_code`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/domain/survey_weight.py:66-113`。行番号付き抜粋は`source_excerpts/B03.txt`。

### B04 [P1] 調査ウェイトの任意の倍率でクロス集計のp値が激変する

確認方法: API再現。

再現条件: 同じ40人の2×2表[15,5;5,15]を、全員w=1と全員w=100で比較。

実際の結果: w=1ではχ²=10、p=0.0015654023。w=100ではχ²=1000、p=1.7958328e-219。CramérのVはともに0.5。加重度数をそのままchi2_contingencyへ渡す。近似で設計効果を推定しない旨の警告は実装済み。

影響: 調査ウェイトの正規化単位を変えただけで証拠の強さが変わる。頻度ウェイトとしての計算と、調査の抽出/補正ウェイトとしての推測を区別できていない。

修正方針: weightTypeを明示し、頻度ウェイトと調査ウェイトを区別する。調査設計に基づく分散・検定を実装できるまで、調査ウェイトは記述統計に限定するか、推測不能を返す。総和をNへ正規化するだけで複雑な調査設計に対応できたとはしない。

回帰テストの合格条件: 調査ウェイトを一律倍にしても同じ推測結果になるか、検定を提供しない。頻度ウェイトの場合だけ「人数を増やす」意味を利用者が明示できる。

証跡: `batch3: cross_weight_scale_one / cross_weight_scale_hundred`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/summaries/crosstab.py:275-295`。行番号付き抜粋は`source_excerpts/B04.txt`。

### B05 [P1] 複数回答集計がUIから送られた重みを黙って無視する

確認方法: API再現。

再現条件: 有効回答者2人で、選択肢Aを選んだ人の重み1、Bを選んだ人の重み10。MA集計へweightColumn=wを指定。

実際の結果: weightColumnあり/なしの両方でA50%、B50%。リクエスト型にweightColumnがなく、extraとして捨てられる。フロントエンドは通常集計とMA集計へ同じ重み指定を送る。MA結果には重み無視の警告がない。

影響: 通常設問と複数回答設問で同じ重み設定が異なる意味になる。正しく加重した回答者割合ならA9.09%、B90.91%になる例。

修正方針: MAの有効回答者分母・選択肢分子を同じ重みで集計し、回答者ベース/延べ回答ベースを分ける。未対応なら明示的に拒否し、UIに未加重と表示する。

回帰テストの合格条件: 本例が9.09%/90.91%、またはunsupportedとして扱われる。黙って50%/50%にはしない。

証跡: `batch4: ma_before、batch5: ma_weight_omitted / ma_weight_requested`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/multi_response.py:37-55`、`app/api/multi_response.py:218-290`。行番号付き抜粋は`source_excerpts/B05.txt`。

### B06 [P1] コードブックに未出現の選択肢を足すだけでクロス集計の検定が消える

確認方法: API再現。

再現条件: 40人の2×2表[15,5;5,15]に対し、データは変更せず行カテゴリのcategoryOrder/valueLabelsへ未出現Cを追加。

実際の結果: 追加前はχ²=10、p=0.0015654、V=0.5。追加後はχ²/p/Vがnull、dfは2。「期待度数5未満」の警告はあるが、ゼロ周辺カテゴリによる計算不能を正確に示していない。

影響: 設問の選択肢を完全に定義するという正常なコードブック運用で、検定結果が失われる。表示カテゴリ数と計算に使える表の次元が混同される。

修正方針: 表の表示には0件カテゴリを残す一方、検定用にはゼロ周辺行・列を除いた有効表を作る。自由度、期待度数、Vを有効表から一貫して計算し、除外カテゴリを記録する。構造的ゼロは別問題として扱う。

回帰テストの合格条件: 未出現C追加前後で有効な2×2検定結果が一致。表示にはC=0件を保持し、計算自由度は1。

証跡: `batch2: cross_baseline / cross_unobserved_category`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/summaries/crosstab.py:244-295`。行番号付き抜粋は`source_excerpts/B06.txt`。

## C. 対象者集合と機能間連携

### C01 [P0] 対象0件のactive/sample scopeが全データへ拡大する

確認方法: API再現。

再現条件: 40行のデータにcontext.scope=active、activeRowIds=[]を指定してクロス集計。selectedRowIds=[]とも比較。

実際の結果: activeの空配列は40件全体を返す。selectedの空配列は0件。共通resolve_scopeのactive/sample分岐がif notでNoneと空配列を同一視する。

影響: 条件に一致する回答者がいないのに、全体の分析を表示する危険がある。UIからこの状態へ至るクリック操作そのものは未確認だが、実際の集計APIで再現済み。

修正方針: None（未指定）と[]（明示的に0件）を区別する。scopeとID配列の契約を共通化し、解析対象を暗黙に広げない。

回帰テストの合格条件: active=[]、sampled=[]、selected=[]はいずれもscopeCount=0。集計結果0件またはEMPTY_SCOPEで、全体へフォールバックしない。

証跡: `batch1: empty_scopes、batch2: cross_empty_active / cross_empty_selected`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/domain/context.py:95-126`。行番号付き抜粋は`source_excerpts/C01.txt`。

### C02 [P1] 復元抽出で選ばれた重複回数が、その後の集計で失われる

確認方法: API再現。

再現条件: q=[0,10]からwith_replacement、size=10、seed=42で抽出し、返されたsampledRowIdsとsampledRowWeightsを単純集計へ渡す。

実際の結果: 抽出APIは0を6回、10を4回選び、回数も正しく返す。集計はis_inで一意の2行へ戻り、n=2、平均5。抽出結果10件の平均は4。

影響: 復元抽出はできても、解析が復元抽出標本の解析にならない。UIのブートストラップ用途と機能が接続されていない。

修正方針: 観測IDの集合とは別に抽出multiplicityを解析コンテキストに持ち、各計算へ伝えるか、抽出単位IDを持つ別標本を作る。抽出回数ウェイトと調査ウェイトを混同しない。

回帰テストの合格条件: 本例の標本サイズ10・平均4が後段の要約/モデルに保持される。元のユニーク回答者数2は別フィールドで残る。

証跡: `batch3: bootstrap`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/observations.py:69-90`、`app/api/summaries.py:29-39`、`app/api/summaries.py:64-76`。行番号付き抜粋は`source_excerpts/C02.txt`。

### C03 [P1] KDAが対象行の指定を受けず全データで分析する

確認方法: API再現。

再現条件: A群30人はq=2x、B群30人はq=-2x。同じデータで全体とA群のrowIdsだけを指定してKDAを比較。

実際の結果: A群だけを指定してもn_valid=60、R²=0。A群30人の線形関係は完全である。KdaRequestにrowIdsがなく、UIもdatasetId/outcome/driversのみを送る。

影響: PCP等で対象を絞って他の分析をしても、KDAだけ全体の分析へ戻る。分析対象の統一という機能間契約が成立しない。

修正方針: KDAにもscope・revision・重み対応状態を含む共通コンテキストを適用する。少なくとも現仕様の間は全データ対象と明示し、選択対象に対する結果と誤認させない。

回帰テストの合格条件: A群指定でn_valid=30、R²=1。全体指定でn_valid=60、R²=0。UIの対象範囲表示とレスポンスscopeHashが一致する。

証跡: `batch4: kda_full / kda_subset`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/models.py:382-419`。行番号付き抜粋は`source_excerpts/C03.txt`。

### C04 [P0] 発見したサブグループを感度分析へ渡すと、差ではなく全体平均を評価する

確認方法: API再現。

再現条件: A群平均1.2、B群平均4.2の240行に対し、candidate.type=subgroup_diff、candidate.rowIds=A群120人、targetColumn=qを指定。

実際の結果: baseline.n=240、effectSize=2.7。候補rowIdsがある場合にgroup_column/compareをNoneへ落とし、候補の行一覧は計算関数へ渡していない。

影響: 対象群対補集合の平均差-3.0を確認したいのに全体平均2.7の感度分析になる。modern探索結果からの連携先として推定対象が変わる。

修正方針: candidate.rowIdsから対象群マスクを作り、解析scope内の補集合と比較する。候補typeに応じた入力の排他/必須条件を検証する。

回帰テストの合格条件: 群差のbaselineは-3.0、対象群/補集合各120件。候補をB群に変えると+3.0。KPI平均と群間差を同じフィールドでも混同しない。

証跡: `batch2: sensitivity_candidate_rows`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/robustness.py:89-126`。行番号付き抜粋は`source_excerpts/C04.txt`。

## D. 感度分析とモデル結果

### D01 [P0] 感度分析の平均差の信頼区間に、全体平均の標準誤差を使用する

確認方法: API再現。

再現条件: A=[0×10,2×10]、B=[-0.5×10,1.5×10]。外れ値を除かない閾値100で平均差の感度分析を実行し、独立2群のWelch法と照合。

実際の結果: 差は0.5。アプリの95%区間は[0.1765,0.8235]、ゼロを含まない。Welchの95%区間は[-0.1568002,1.1568002]、ゼロを含む。実装のSEは両群を連結した標準偏差/√総Nで、平均差のSEではない。

影響: 区間が不適切に狭まり、ゼロをまたぐかという解釈が変わる。isRobust=trueも返るが、この例は除外0件なので、区間修正だけでisRobust自体が必ずfalseになるとは主張しない。

修正方針: 独立2群平均差ならSE=√(s1²/n1+s2²/n2)と適切な自由度・分位点を使う。対応のある回答や調査ウェイトを扱う場合は別の設計を適用する。

回帰テストの合格条件: 本例の区間が参照値に一致。入力群サイズが不均衡な場合、分散が異なる場合も参照実装と照合する。

証跡: `batch2: sensitivity_ci`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/robustness/sensitivity.py:97-117`。行番号付き抜粋は`source_excerpts/D01.txt`。

### D02 [P1] bootstrapBとseedを表示するが、感度分析でブートストラップしていない

確認方法: API再現。

再現条件: 同じ入力でbootstrapB=200,seed=42とbootstrapB=1,seed=17を指定。

実際の結果: 同じ区間が返る。実装ではseedを「_ = seed」で捨て、bootstrap_bをレスポンスに記録するだけ。区間計算は正規近似の1.96倍で、再抽出ループはない。

影響: 解析条件に見えるパラメータが計算へ反映されず、結果の再現説明も誤る。乱数を使っていないため同じ結果になること自体ではなく、実装と説明の不一致が問題。

修正方針: 実際の再抽出と推定量再計算を実装するか、解析的区間と表示しbootstrapB/seedを要求しない。methodとCI methodを分けて返す。

回帰テストの合格条件: bootstrapを選んだ場合に指定回数だけ再計算される。解析的方式の場合はbootstrapパラメータを返さないか未使用と明記する。

証跡: `batch2: sensitivity_ci / sensitivity_bootstrap1`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/robustness/sensitivity.py:27-36`、`app/algorithms/robustness/sensitivity.py:50-75`、`app/algorithms/robustness/sensitivity.py:128-145`。行番号付き抜粋は`source_excerpts/D02.txt`。

### D03 [P1] 名義尺度の数値コードを外れ値として除外する

確認方法: API再現。

再現条件: 名義尺度の属性を1=95人、2=5人とコード化し、群間差の感度分析を実行。全く同じ所属をA/Bへ置き換えて再実行。

実際の結果: 1/2では少数群の5人が外れ値扱いされ、422「効果量を計算できません」。A/Bでは200、除外0件。コードはgroup_columnも数値外れ値の入力へ追加する。

影響: 年齢そのものではなく「性別コード」「地域コード」等を数値の大小として処理し、少数カテゴリを消してしまう。

修正方針: 外れ値検出に入れる列を尺度と役割で制限し、群を定義する名義変数を数値距離に使わない。回答の品質判定と少数セグメントの除外を区別する。

回帰テストの合格条件: 1/2とA/Bの同値な符号化で同じ除外対象・群差・有効Nになる。

証跡: `batch2: sensitivity_group_numeric_True / sensitivity_group_numeric_False`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/robustness/sensitivity.py:69-96`。行番号付き抜粋は`source_excerpts/D03.txt`。

### D04 [P1] 目的変数が定数または説明力ゼロでも最優先キードライバーを提示する

確認方法: API再現。

再現条件: q=5で全員一定、xだけが変化するデータをKDAへ入力。加えてC03の全体R²=0のデータでも確認。

実際の結果: 定数目的変数でR²=1、importance_raw=1、importance_pct=100、傾き0、「最優先キードライバー」、warnings=[]。R²=0の例でもimportance_raw=0なのにimportance_pct=100、同じ推奨文が付く。

影響: 説明すべきばらつきがない、または説明力がないのに施策優先度を生成する。定数目的変数のR²を有限値へ補正する方針自体より、その値を有効な重要度として解釈する連鎖が問題。

修正方針: 目的変数の分散ゼロを分析不能として扱う。重要度総和ゼロでは構成比を未定義/0とし、最優先という文言を出さない。モデル成立性をドライバーの順位付けより先に判定する。

回帰テストの合格条件: 定数目的変数に推奨ドライバーを返さない。R²=0・全係数0なら「説明力なし」と返し、100%重要度を生成しない。

証跡: `batch4: kda_constant / kda_full`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/models/kda.py:86-105`、`app/algorithms/models/kda.py:165-213`。行番号付き抜粋は`source_excerpts/D04.txt`。

### D05 [P1] 決定木のクラス割合を人数へ直接整数化し、人数が0になる

確認方法: API再現。

再現条件: yes/no各20人の40行で分類木を作成し、返されたtreeStructuresを確認。

実際の結果: root.count=40だがvaluesはno.count=0、yes.count=0、ratioはいずれも0.5。tree_.valueの割合をint(c)にしている。

影響: ノード人数と内訳が矛盾する。木の学習自体が失敗したという証拠ではなく、返却構造・説明の不具合。

修正方針: 同梱scikit-learn 1.6.1のtree_.valueの意味に合わせる。人数は到達観測から数えるか割合×weighted_n_node_samplesで復元し、非加重人数と加重度数を区別する。

回帰テストの合格条件: rootのクラス人数が20/20で合計40。各ノードの内訳合計がノードNと一致し、加重時も列名で区別される。

証跡: `batch1: tree、batch4: tree_details`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/models.py:112-159`。行番号付き抜粋は`source_excerpts/D05.txt`。

### D06 [P1] 決定木の内部ノードに所属する行が0件として記録される

確認方法: API再現。

再現条件: D05の木のtreeStructuresとmembership構造を確認。

実際の結果: 根ノードはcount=40、rowIdsCount=0。内部ノード39件もrowIdsCount=0。tree.applyで得た葉IDと各内部nodeIdを比較しており、内部ノードに誰も所属しない構造になる。

影響: 内部ノードから回答者を取り出す契約と整合しない。UIで内部ノードをクリックできるか、クリック時の挙動は未確認。

修正方針: 内部ノードはdecision_pathまたは子孫葉の集合から所属行を取得する。葉のみ対応ならAPIとUIをleaf専用として限定する。

回帰テストの合格条件: 根の所属行が40件、内部ノード39件。各親の所属集合が左右の子の和集合と一致する。

証跡: `batch4: tree_details`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/models.py:112-122`、`app/api/models.py:161-170`。行番号付き抜粋は`source_excerpts/D06.txt`。

## E. 欠損補完・履歴・復元

### E01 [P0] 補完処理が欠損コード99を学習データとして扱い、誤った値を書き込む

確認方法: API再現。

再現条件: q=[1,2,3,4,99,null]、missingCodes=[99]で平均補完のプレビューとinPlace確定。

実際の結果: 補完が数える欠損はnullの1件だけ。fillValue=21.8を実データへ書き込み、99はそのまま残る。正しい観測値1〜4の平均は2.5。

影響: B01の欠損解釈不一致が、表示だけでなくデータ更新へ波及する。誤った値を以後の解析の観測値に近い形で残してしまう。

修正方針: 補完前に意味的欠損マスクを生成する。通常欠損と非該当/スキップを区別し、補完可能なセルだけを対象にする。学習用データから欠損コードを確実に除外する。

回帰テストの合格条件: 通常欠損として定義した99とnullは対象として認識され、平均2.5で補完される。非該当と定義したセルは補完しない。

証跡: `batch1: missing_paths / impute_missing_commit / impute_missing_values`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/datasets.py:1040-1145`、`app/algorithms/imputation/core.py:49-110`。行番号付き抜粋は`source_excerpts/E01.txt`。

### E02 [P0] 名義尺度・複数回答の列に平均補完を適用し、存在しない選択肢コードを作る

確認方法: API再現。

再現条件: 複数回答A/Bを0/1の名義尺度列として定義。行は[1,0],[0,1],[null,0]。A列に平均補完を確定する。

実際の結果: Aのnullが0.5になる。HTTP200で保存され、MA診断はpartial=1からinvalid=1へ変わる。

影響: 欠損を直す操作が不正回答を生成する。列の物理型が数値でも回答尺度は連続量とは限らない。

修正方針: 補完可能な方式を尺度・MAグループ制約で制限する。0/1、許容カテゴリ、排他選択、最大選択数等を確定前に検証し、不正値をコミットしない。

回帰テストの合格条件: MA列へmeanを指定すると拒否するか、許容値だけを生成するカテゴリ用手法へ明示的に切り替える。補完でinvalidNが増えない。

証跡: `batch4: ma_before / ma_impute / ma_values_after / ma_after`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/datasets.py:1071-1145`、`app/algorithms/imputation/core.py:70-110`。行番号付き抜粋は`source_excerpts/E02.txt`。

### E03 [P1] 補完の空列指定と不正な定数が、安全側ではなくデータ更新へ進む

確認方法: 計算関数で再現。

再現条件: impute_dataframeにcolumns=[]を渡す。別途、数値列へstrategy=constant、options.constant_value="invalid"を渡す。

実際の結果: 空の列指定で全列が対象となり、qとxの両方が補完される。不正な定数は例外で止まらず0に置換される。後者は正しいoptionキーconstant_valueで再確認済み。

影響: 「何も選んでいない」「入力に誤りがある」状態で意図しない値を生成する。API/UIからの全経路到達性ではなく、保存処理が利用する計算関数の再現。

修正方針: Noneと[]を区別する。定数の型変換失敗・範囲外・未定義カテゴリを検証エラーにする。未指定の既定値と不正指定のフォールバックを分ける。

回帰テストの合格条件: columns=[]ではno-opまたは明示エラー。invalidでは更新0件かつエラー。元DataFrameとprovenanceが変わらない。

証跡: `batch3: impute_empty_columns、batch5: invalid_constant_actual_key`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/imputation/core.py:49-69`、`app/algorithms/imputation/core.py:125-138`。行番号付き抜粋は`source_excerpts/E03.txt`。

### E04 [P1] 条件付き補完が、補完対象として選んでいない説明変数を使わない

確認方法: 計算関数で再現。

再現条件: q=[1,2,3,null]、x=[10,20,30,40]でcolumns=[q]の実験的条件付き補完を実行。欠損行のxだけ4000に変更し、同じseedで再実行。

実際の結果: どちらもqの補完値は2.8995342155160015。入力行列はtarget_colsから作られ、xは条件付けの入力から除外される。

影響: 1列だけ補完したい一般的な利用で、観測済み他列を利用するという条件付き補完の意図が成立しない。xから完全な外挿をすべきだと主張しているのではなく、xが全く参照されない問題。

修正方針: targetColumnsとpredictorColumnsを分離する。補完しない観測済み列も予測に利用できるようにし、利用列を診断情報へ返す。

回帰テストの合格条件: target=q、predictor=xという指定が可能。推定モデルの入力にxが含まれることを直接検査し、予測変数を変える感度テストを追加する。

証跡: `batch5: conditional_impute_unselected_predictor`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/algorithms/imputation/tabdiff.py:32-92`。行番号付き抜粋は`source_excerpts/E04.txt`。

### E05 [P1] 別データとして補完すると、新しく埋めたセルのマスク・操作履歴が残らない

確認方法: API再現。

再現条件: q=[1,null,3]にmean、inPlace=falseで派生データを作成し、そのコードブック・provenance・maskを読む。

実際の結果: qは2で埋まるが、新データのmask.entries=[]、maskRevision=0。操作履歴はimportのみで、補完セルの記録がない。コードブックのordinal、valueLabels、categoryOrderは保持されていた。

影響: 観測値と今回の補完値を識別できず、補完値を除外した分析や感度分析・再現に支障がある。コードブック消失とは別の問題。

修正方針: 派生時に引き継ぐ既存マスクと、今回の補完で作成したマスクをマージする。原データと補完操作をたどれる履歴として記録し、親データ参照の依存条件も明示する。

回帰テストの合格条件: 新データのq・2行目がimputedとして記録され、方法と元値nullを追跡できる。既存のコードブック継承は維持する。

証跡: `batch4: derived_impute / derived_metadata`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/datasets.py:327-390`、`app/api/datasets.py:1115-1145`。行番号付き抜粋は`source_excerpts/E05.txt`。

### E06 [P0] 同梱WASM環境で原データ・スナップショットの読込が失敗し、Undoと再現パッケージ出力が動かない

確認方法: API再現。

再現条件: 通常インポート→補完→undoを実行。スナップショットファイルの存在を確認し、read_rawとexport_packageも実行。

実際の結果: 実在するrevision 1のParquetに対して、type object builtins.PyLazyFrame has no attribute new_from_parquet。Undoは422 PROVENANCE_SNAPSHOT_MISSING、原データ/出力はPROVENANCE_RAW_MISSING。通常のget_dataframeにはPyArrowフォールバックがあるがread_snapshot/read_rawにはない。フロントのdownloadBlobはstatic未対応として常に例外を投げる。

影響: ファイルが本当に無いのではなく読込APIの不適合。補完を確定した後に元へ戻せず、再現用に出力する経路も成立しない。同梱WASM上の再現であり、ブラウザIDBFSを直接試した結果ではない。

修正方針: 通常・raw・snapshotのParquet I/Oを同じWASM対応層へ統一する。エラーコードを欠落と破損/機能非対応で分ける。出力UIをworkerのバイナリ応答へ接続するか、機能自体を明示的に無効化する。

回帰テストの合格条件: 配布するWASMそのものでimport→impute→undo→redo→export→importの往復を検査し、値・コードブック・マスク・履歴が復元される。

証跡: `batch4: imputation_undo、batch5: raw_read / snapshot_exists / package_export。UI出力経路はコード確認。`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/storage/dataset_store.py:175-188`、`app/storage/dataset_store.py:260-289`、`app/api/datasets.py:1491-1520`。行番号付き抜粋は`source_excerpts/E06.txt`。

### E07 [P1] Undoの状態復元がデータ値だけで、コードブックや補完マスクを過去状態に戻さない構造

確認方法: ソース確認のみ。

再現条件: _restore_revisionとcommit_mutationに渡す引数を確認。

実際の結果: 過去のDataFrameを読む一方、通常Undoのmaskはmask_nowからコピーし、codebook=Noneで現在のコードブックを維持する。

影響: E06を直した後も、値だけ戻って補完フラグや列仕様は現在のままという潜在的不整合が残る。列変換やコードブック操作を含むUndoの契約を明確にする必要がある。

修正方針: revision単位の状態を値・スキーマ/コードブック・マスク・履歴カーソルの一組として保存・復元する。データ値だけのrevertならUIでその限定を明記する。

回帰テストの合格条件: 補完のUndoで今回付いたマスクだけが戻り、Redoで再付与。列/コードブック変更を戻す契約なら同時に復元する。

証跡: `ソース確認のみ。E06の読込エラーが先に発生するため、この不整合をUndoの正常完了後に実測してはいない。`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/datasets.py:1312-1335`、`app/api/datasets.py:1375-1393`。行番号付き抜粋は`source_excerpts/E07.txt`。

## F. インポートと入力契約

### F01 [P2] 全項目空欄のCSVレコードを無通知で削除する

確認方法: API再現。

再現条件: ヘッダq1,q2の後に1,2、カンマのみの行、3,4という3レコードをインポート。

実際の結果: rowCount=2。read_delimitedがany(cell.strip() for cell in row)で全項目空欄のレコードを除く。

影響: 完全無回答者も1件として保持したい調査では分母と取り込み件数が変わる。物理的な空行の無視と、区切り文字を持つ空回答レコードの削除が同一視される。

修正方針: 空レコードの保存/除外をインポート方針として選択可能にし、除外した場合は件数と理由を表示する。

回帰テストの合格条件: 保持方針ならrowCount=3。除外方針なら入力3件/除外1件/出力2件を明示する。

証跡: `batch2: blank_record`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/services/import_service.py:224-242`。行番号付き抜粋は`source_excerpts/F01.txt`。

### F02 [P2] 存在しない回答者IDをサンプリング対象として受け入れる

確認方法: API再現。

再現条件: activeRowIds=[does-not-exist]、size=1で観測サンプリングAPIを呼ぶ。

実際の結果: HTTP200でdoes-not-existがsampledRowIdsへ返る。データセットの行集合との照合がない。

影響: 選択・サンプリングと集計の境界で有効な回答者集合を保証できない。UIの通常操作からの到達は未確認。

修正方針: 入力IDをデータセットとrevisionへ照合し、不明IDを拒否するか、除外数付きで処理する。

回帰テストの合格条件: 未知IDが正常な標本として返らず、混合入力でも失われたIDを追跡できる。

証跡: `batch3: sample_foreign_ids`。`batchN`は`evidence/test_batchN.result.json`の`result`配下を指す。

該当箇所: `app/api/observations.py:34-48`。行番号付き抜粋は`source_excerpts/F02.txt`。

## 誤って問題扱いしていない点

今回の入力例では、重複CSVヘッダは`q`、`q_1`、`q_2`として保持された。通常集計は欠損コード99を除外した。PCAも欠損99を除外して有効3行とした。modern探索のselectedRowIds=[]は全体へ拡大せず0件となった。古いdataRevisionを指定した探索は409 ANALYSIS_INPUT_STALE、不適切な属性/質問role指定は422で拒否された。MAでは部分欠損と不正値を区別していた。派生補完データはコードブックのordinal、順序、値ラベルを保持していた。

配布JSとmethod_names.pyでは「実験的条件付き補完」「補正V（Cramér’s V系）」等の説明が確認できた。内部名や旧互換aliasが残るだけで、正式なTabDiffやPhiKと誤表示していると一律には指摘していない。加重Pearsonについては近似である旨の警告が実在する。警告がないという指摘ではなく、その推測を調査ウェイトとして使用できるかの問題をB04に整理した。

## 修正の順序

最初にA01/A02とC04/D01の「違う量を検証する」処理を停止または修正する。次にB01〜B03、C01〜C03を共通の解析コンテキストと値変換へ統合する。続いてE01〜E07の補完前検証・原データ保存・原子的復元を整え、失敗時に利用者データが意図せず確定されないようにする。その後、A05〜A08の探索契約とB04〜B06の集計契約、D04〜D06のモデル説明を修正する。

個々のエンドポイントに別々の例外処理を足すだけでは再発しやすい。共通契約は少なくともdatasetId、dataRevision、schemaRevision、明示的なscope、rowId集合、抽出multiplicity、意味的欠損/非該当マスク、逆転と尺度、weightTypeとweightColumnを含むべきである。レスポンスには処理前N、対象N、有効N、除外理由、実際に使用した条件を返す。これは機能の追加提案というより、既存機能を接続するための整合性修正である。

## 全体回帰テストで守るべき不変条件

| 操作 | 変わってはいけないもの |
|---|---|
| 各群の全回答に同じ定数を加える | 平均差とその推測結果 |
| 同じデータ・条件を再実行する | 二択の対象カテゴリ、符号、候補の意味 |
| 名義コード1/2をA/Bへ置き換える | 群所属、外れ値判定、群間差 |
| 欠損99を同義のnullへ置き換える | 解析対象と有効値の結果 |
| 全員の重みを1にする | 通常統計と加重統計の一致 |
| 調査ウェイトを一律倍にする | 調査上の情報量と適切な推測結果 |
| 未出現カテゴリをコードブックへ追加する | 実際に観測された表の検定結果 |
| scopeを明示的に空にする | 空であること。全体への拡大は禁止 |
| 復元抽出を後段解析へ渡す | 各回答者が抽出された回数 |
| 部分集団を選択する | 各回答者の固定尺度上の逆転得点 |
| 候補を探索から検証・感度分析へ渡す | 条件、対象イベント、比較対象、効果量 |
| 補完→Undo→Redo | 値、コードブック、補完マスク、操作履歴の整合性 |

## 証跡の読み方と注意

`evidence/api_history.json`は全114回のAPI記録。import用ファイルの内容そのものはこの履歴には含まれないが、CSVは`tests/test_batch*.py`で生成される。`evidence/fixtures_after_tests.json`は試験後のデータで、一部は補完により変更済み。初期データの代わりとして使用しない。

試験はsetup→batch1→batch2→batch3→batch4→batch5の順で同じランタイム内に実行した。batch3の`impute_bad_constant`は誤ったoptionキー`value`を使った初期試行なので、不正定数の根拠には採用していない。正しい`constant_value`での再試験がbatch5の`invalid_constant_actual_key`。batch3の`tree_details=null`はmodelIdではなくresultIdを使う必要があった試験側の事情で、製品不具合としては数えていない。木の実際の取得はbatch4。batch2の`verification_lost_candidate`は候補消失を再現せず成功したため、それ自体を不具合としていない。

UIのソース行は配布されたminified JSの整形コピーに対する行番号で、元のTypeScriptファイルの行番号ではない。`source_excerpts/frontend_contracts.txt`に該当文言と呼び出し部分を記録した。サーバー用Pythonとブラウザの制約を混同せず、修正後は実ブラウザで最終的なE2E確認が必要である。

## 数学・ライブラリ仕様の一次資料

以下は計算式/ライブラリの意味を確認する資料。製品固有の不具合の証拠は添付ソースと上記の実行記録である。引用は必要範囲に限定した。

### S1. SciPy ttest_1samp

原文: `mean of ONE group of scores`。A01: 1標本平均の検定であり、対象群と比較群の差の検定ではない。

出典URL: `https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_1samp.html`

### S2. SciPy ttest_ind

原文: `means of two independent samples`。D01: 独立2群平均差とWelchの信頼区間の参照。実数値照合は同梱SciPy 1.14.1で実施。

出典URL: `https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_ind.html`

### S3. scikit-learn 1.6.1: Understanding the decision tree structure

原文: `provides the proportion of samples reaching a node`。D05/D06: tree_.valueは割合、内部ノード到達はdecision_path。

出典URL: `https://scikit-learn.org/1.6/auto_examples/tree/plot_unveil_tree_structure.html`

### S4. R survey: Contingency tables for survey data

原文: `first and second-order Rao-Scott corrections`。B04: 調査設計を踏まえたクロス表検定の一次資料。引用ページはsurvey 3.18の説明であり、現行版番号の主張には使っていない。

出典URL: `https://r-survey.r-forge.r-project.org/survey/html/svychisq.html`

### S5. SciPy chi2_contingency

原文: `based on the marginal sums of the table`。B06: 周辺度数から期待度数を計算する。ゼロ周辺カテゴリと表示カテゴリを分離する修正方針。

出典URL: `https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.contingency.chi2_contingency.html`
