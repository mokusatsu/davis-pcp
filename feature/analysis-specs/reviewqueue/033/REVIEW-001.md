# Feature 033 EFA 実装レビュー 001

判定: **要修正。数値計算・対象行・版管理・画面に未解消事項がある。**

- 日付: 2026-09-13
- 対象: `REPORT.md`（SHA256 `65DEA4BD84960B93A06ECDB942298460FC4FA02332C5C5BFB71B993A422775EA`）。
- HEAD: `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`、未コミット変更を含む。
- 基準: `feature/analysis-specs/feature/33_exploratory_factor_analysis.md`、`tasks/DAVIS-FEAT-033-DESIGN.md`、`tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md`（後二者はanalysis-specs配下）。旧033・033bの移動案内は受入基準にしていない。
- 確認範囲: 新規API・前処理service・回転／平行分析／ULS、共通APIへの接続、画面、対象試験、報告の受入証拠。

## E001 [P1] 平行分析が全列へ同じ行置換を適用する

`fullstack/backend/app/algorithms/models/factor_parallel.py:58`で反復ごとに1本の行置換だけを生成し、66行で全列に同じidxを適用する。serviceの571行と感度比較からの呼出しも独立列置換を渡していないため、項目間の関連が保持される。帰無分布が元の相関行列そのものになり、PA候補と感度比較の因子数判断が成立しない。

隔離検証では200行4列・100反復の参照分位と観測固有値の最大差が`7.216449660063518e-16`だった。反復×項目ごとに独立の置換を作り、その同じ置換群をPearson／Polychoric間で共有すること。分布保持と項目間関連の破壊を別々に検証する。EFA-B11/B18/B22。

## E002 [P1] Varimaxの更新式が設計の目的関数と異なる

`factor_rotations.py:98`〜100の角度は`sum(u²-v²)`・`2sum(uv)`だけを使い、Varimaxの列二乗平均に関する補正がない。設計6.1のKaiser正規化後のSVD更新式とも一致しない。再現相関が保たれるだけでは、指定した回転法の正しさを示せない。

固定6項目2因子の負荷行列で、正規化後の`sum(var(loadings²))`は実装`0.14344705865371077`、設計記載のSVD反復`0.22552247190894098`となった。設計の更新式を実装し、同規約の独立oracleで確認すること。PromaxもこのVarimaxに依存する。EFA-B09。

## E003 [P1] 符号正準化をPhiへ反映できずPromaxの再現相関が変わる

`factor_rotations.py:49`で負荷量を先に反転した後、58行で反転済みの列を調べるため、返すHに元の符号反転が含まれない。163〜164行でpatternだけ符号が変わり、Phiの対応する符号は変わらない。再構成チェックはこの処理の前にしかない。

固定seedの6×2行列で、status=successにもかかわらず`max(abs(Pattern @ Phi @ Pattern.T - L @ L.T)) = 0.3253603520633942`を再現した。符号と置換を1つのHで保持し、最終pattern・Phi・structure・変換行列へ一貫して適用すること。最終出力の再構成も確認する。EFA-B09/B10。

## E004 [P2] 得点なしのMLで標本数が0となり推論が消える

`fullstack/backend/app/services/factor_analysis_service.py:506`は標本数をscore_zから取り、得点を要求しないと0にする。APIの325〜332行はscoreMethod=noneでscore_zを作らない。既定の得点なしMLと候補比較で、実際には十分な完全ケースがあるのに参考推論が不能になる。

同じ200行のML要求で、scoreMethodだけregressionからnoneへ変更するとinferenceStatusが`available`から`unavailable`へ変わった。fit集合のnを得点計算とは独立して渡すこと。EFA-B14。

## E005 [P1] 空scopeが全件になり、画面の標本scopeも全件を使う

`factor_analysis_service.py:136`はscope_idsが空だと絞り込みを省略する。selectedRowIds=[]でAPIが200を返し、fitCount=200となることを再現した。空selectedをallに変更しないという設計2の条件に反する。空の場合もfilterし、完全ケースなしとして処理すること。

また`FactorAnalysisPage.tsx:86`〜94はsampledRowIdsを送らない。共通resolve_scopeは未指定sampledを全件へ解決するため、画面の「標本」を選んでも標本集合を使わない。中央のsampling状態から実際の行IDを送ること。EFA-B16。

## E006 [P1] 連続項目の欠損コードとmask・補完来歴が反映されない

`factor_analysis_service.py:173`でmissingCodesを取得するが、174〜193行の連続経路では使用しない。完全ケース判定も243〜245行では有限数かどうかだけを見る。200行の先頭値をmissingCodesに設定した検証で、期待199行に対しfitCount=200・missingCount=0となった。`api/factor_analysis.py:740`以降の予測も同じ問題を持つ。

さらに前処理は値だけを読み、無回答／非該当mask、既存補完の情報を参照せず、imputed_cellsは0固定である。公開metaも478行でmask_revision=Noneとする。欠損・非該当・不正値・補完を区別する共通前処理規約へ接続し、fit／predictで同じ判定を使用すること。EFA-B04/B13/B15。

## E007 [P1] EFAのpredict/materializeが古い結果を拒否しない

`api/analysis_results.py:354`・378はEFAへ直接分岐する。`api/factor_analysis.py:687`のpredictは所有datasetと現在／結果の版を検証せず、795行のmaterializeは要求と現在の版だけを照合し、fit結果の版を照合しない。

fit後に列保存で版を更新し、最新contextで古いresultIdにpredictとmaterializeを要求したところ、どちらも200となった。古いfitでの新規予測・保存は409とし、同一payloadの保存再送だけは保存済み応答を返すこと。ロック内の再確認も必要。predictでは異なるdatasetのcontextも拒否すること。EFA-B16。

## E008 [P1] materializeの保存元・冪等性契約が成立しない

`api/factor_analysis.py:810`はreq.sourceにかかわらずfitのrowsを読む。prediction用capabilitiesを公開しているのに、予測IDを指定した保存でもfit値を使う。また826〜829行はpayload hashを冪等キーに組み込むため、同じidempotencyKey・違うpayloadを別要求として扱う。実際に同じキーで列名を変更した保存が200・idempotentReplay=falseとなった。

保存元に応じて正しい行を解決すること。キーとpayloadを別に保存・比較し、異なるpayloadはIDEMPOTENCY_CONFLICTとすること。再送応答には元のdataRevision/schemaRevisionと作成列情報を保持し、UIが版を推測して加算しないこと。EFA-B13/B16。

## E009 [P1] 得点の実ポインタ選択・相互ハイライトが未実装で旧応答も適用される

`FactorAnalysisPage.tsx:145`は500行を一度だけ取得し、得点画面は先頭50行表と「先頭200行を選択へ反映」だけである。得点図・実ポインタの点／矩形選択・中央選択の相互ハイライトがない。既定のN=1000〜2000でも後半行を画面から扱えない。

157〜168行の選択応答にはsequence・dataset・data/schema版照合がなく、応答待ち中にdatasetを切り替えても旧rowIdsを適用する。新結果のrows取得前に旧rowsも消していない。200行固定の選択を実装済みの図上選択として扱わず、全ページの取得と結果ID対応、応答反映直前の版照合、実ポインタ選択・ハイライトを実装・確認すること。200行固定を仕様上の上限にしない。EFA-B16。

## E010 [P2] 保存する因子番号が出力列名の末尾から決まる

`FactorAnalysisPage.tsx:185`〜187は列名の末尾数字をscore番号とする。例えば因子1を`score2026`という名前で保存するとscore:2026を要求し、因子数2以上で`score2`へ改名すると因子2の値を保存する。出力名の変更が値を変えてしまう。保存対象の因子と列名を別々に選択・保持すること。

## E011 [P1] 比較・失敗試行がメモリだけで、主結果から独立した中断もできない

`api/factor_analysis.py:31`〜32の辞書だけにattempt/comparisonを格納し、取得APIも辞書しか読まない。プロセス再起動で消失し、保存された主結果のcomparisonIdが404となる。dataset削除や版変更の検証も取得時にない。

さらに369〜375行は感度比較が終わるまで主結果を返さず、comparisonIdは完了後に初めてクライアントへ渡る。cancel APIは辞書のstatusを書き換えるだけで計算側が見ないため、実際の副解析を中断できない。所有dataset・revisionに紐づく永続artifact、先に取得可能なcomparisonId、区分処理での中断確認と主結果独立表示を実装すること。失敗時の対別診断・start情報もartifactへ保持すること。EFA-B07/B08/B22。

## E012 [P2] 必須の結果・診断表示が不足する

`FactorAnalysisPage.tsx:309`以降の結果タブはpattern＋共通性、PA固有値表、比較状態の短い表示が中心である。structure、Phi、独自性、観測／再現相関、残差行列、最適化・分布・相関診断、ML参考推論、スクリープロット、因子表示名、感度比較の差分表が表示されない。「負荷量・残差」というタブにも残差表はない。異常解の理由と手法間差を利用者が評価できるよう、仕様4・6の情報を表示すること。

200行のstale判定は応答のresultStateだけで、保存・編集後の現在版を反映しない。結果の版と中央data/schema/maskの版を照合して表示・操作制御へ反映すること。

## E013 [P1] 測定水準・重みの解決を画面／要求の値だけで決める

`factor_analysis_service.py:142`〜154は要求のmeasurement/treatmentをそのまま採用し、コードブックのscaleType・role・MA親や分析時指定の根拠を検証しない。数値化可能な名義列等をAPIからcontinuousと指定して通せる経路が残る。コードブック由来の水準と明示指定を照合し、対象外列を拒否すること。

画面は`FactorAnalysisPage.tsx:90`でweightMode=noneを固定し、datasetウェイトの存在確認や利用者の明示的な非加重選択を経ない。dataset重みはまず拒否し、明示noneを別試行とするEFA-B15の経路をUIでも維持すること。EFA-B01/B15。

## 実施した検証と受入証拠

- 隔離workspaceで`test_efa_kernels.py`11件＋`test_efa_api.py`3件: **14 passed**。
- `tsc --noEmit -p fullstack/frontend/tsconfig.json`: **成功**。
- 追加検証: `.temp/review-033-check.py`。毎回`.temp`内に独立workspaceを作り、実データを変更しない。E001〜E007の上記数値／API挙動とE008の同一キー別payloadを確認した。
- 回転の比較は設計に記載された式を直接計算した。外部R oracleは今回再実行していない。
- 実装修正・ビルド・全体試験・実ブラウザ操作は行っていない。Pyodide実ブラウザ操作検証は対象外。
- 報告のpolychoric最大差は2.03e-05／1.81e-05で、初期基準atol1e-5より大きい。rtol併用で通るか判断できる各要素の値・許容誤差判定を示すこと。最大差だけで達成とは判定しない。
- ULSのpsych照合、B02/B03の再符号化・逆転・列順不変性、失敗反復、境界・回転失敗、比較指標／中断、通常ブラウザ統合、代表サイズでの性能測定は未完了。既存14件の成功はこれらの完了を示さない。今回の指摘を解消してから必要な回帰検証へ進むこと。

## 対象ソースSHA256

- `api/factor_analysis.py`: `D340212A38F895933D2505457B95F1AE7962BA57D9ABEA71547B7D37DF3378C9`
- `services/factor_analysis_service.py`: `115DA1F8C3A551460081815130A095C01C74CF643882CC22A2286E970863D1E0`
- `algorithms/models/factor_parallel.py`: `6AD02E047E1D5ABB9C2657BDB58C9C0B2C779F9E20B1B84351765CD1654B6FEA`
- `algorithms/models/factor_rotations.py`: `A02200759A875637D4B76CB80638B34795D42D9CA6F05790C4B5EF5E8770925C`
- `FactorAnalysisPage.tsx`: `8BAA53145974B56AF054E9F82BAAF808FD388FF041070C27A4FCED346BE8CAA0`
