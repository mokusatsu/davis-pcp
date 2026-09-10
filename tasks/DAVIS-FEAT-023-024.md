# Feature 23 / 24 実装引き継ぎ

状態: 未完了（実装・限定検証・実ブラウザ証跡が未完了）

対象仕様:

- [Feature 23: 手法名称の正確化と特徴重要度の分離表示](../feature/23_method_naming_and_importance.md)
- [Feature 24: 探索・検証の分離と感度分析](../feature/24_exploration_verification_sensitivity.md)

元仕様にある「公式手法へ置換するか、実際の近似に合わせて名称を変えるか」という選択は、今回の引き継ぎでは名称変更の経路を正本とする。公式実装への置換は別タスクとし、今回の完了条件には含めない。

## 0. 引き継ぎ時点の確認

### 0.1 現在の実装

- fullstack/backend/app/algorithms/mining/feature_ranking.py は relieff、mutualInfo、randomForest、fStatistic、pcaDispersion とBorda統合を返す。
- 同ファイルの分類・回帰Random Forestは、Permutationを要求すると feature_importances_ とPermutationの平均を同じimportancesへ代入している。これがFeature 23の最優先修正箇所である。
- fullstack/backend/app/api/mining.py の特徴ランキング経路は POST /mining/feature-ranking（公開プレフィックス込みで /api/v1/mining/feature-ranking）である。仕様書のGET例に合わせて別ルートを追加しない。
- fullstack/frontend/src/features/mining/FeatureRankingPage.tsx は現在、1つの表でRF (MDI)を表示する。MDIとPermutationの2列表示はない。
- 同ページのTop-K適用は中央のactiveEntitiesSetとvariableOrderReorderedを通る。画面変更でSelection、PCPの軸順、KeepAliveを壊さない。
- fullstack/backend/app/algorithms/robustness/engine.py はquality_valsを作り、品質下位行の除外スイープ、Jackknife、Bootstrapを実行する。新しい感度分析は明示的なbaseline対sensitivity比較として追加する。
- fullstack/backend/app/api/robustness.py は現在 /robustness/evaluate だけを提供する。既存エンドポイントを削除せず、/robustness/sensitivityを追加する。
- ModernSubgroupMiningView.tsxのminingModeはauto / standard / emm_kendallという探索アルゴリズム用である。これを探索・検証の推論モードへ変更してはならない。
- SubgroupMiningPage.tsxのclassic経路はp_valueとq_valueを常に表示する型になっている。探索モードではbackendの計算、JSON応答、画面表示の三段階でp値を無効にする。
- Robustness画面には「品質除去」「品質下位」が残っている。ユーザー向け文言は「数値的外れ度に基づく感度分析」へ更新する。

### 0.2 守る境界

- 作業ツリーの既存変更をreset、clean、checkout、無関係な削除で失わない。Feature 19〜22の変更を巻き戻さない。
- 中央Selection、__rowId__、scopeHash、schemaRevision、dataRevisionを全API・全画面で保持する。候補の表示更新だけでPCP/Tableの選択を変更しない。
- 調査ウェイトは今回の統計量へ暗黙に適用しない。非対応経路はweightApplied=falseまたはWEIGHT_UNSUPPORTEDを返す。
- 既存Ant DesignのCard、Tag、Alert、Modal、Row/Col、FocusTarget、KeepAlive、色、余白、キーボード操作を維持する。
- 実装だけで完了にしない。契約、統計fixture、GUI操作、回帰、local/static/run-production.batの証跡を分けて残す。

## 1. 共通契約

### 1.1 APIメタデータ

新設・変更する応答には、データセットを特定できる場合はdatasetId、schemaRevision、dataRevision、scopeHash、scopeCount、usedRowsを含める。scopeHashは入力rowId集合をソートして計算し、表示順やページングで変わらない。

revisionまたはscopeがリクエスト開始後に変わった場合は既存のANALYSIS_INPUT_STALE契約で失敗させ、古い結果を画面へ適用しない。

### 1.2 欠損、非対応、空結果

- 数値計算に使えない値は除外数を返し、0に置換して成功扱いにしない。
- 対象が空、検証分割が成立しない、必要な群が不足する場合は422を返す。意味のないp値、効果量、CIを返さない。
- 非対応手法を近い数値で代用しない。methodStatus=unsupported、weightApplied=false、または固有エラーコードで表す。
- NaN、InfinityをJSONへ出さず、欠損はnullとする。

### 1.3 非同期境界

各ページは既存のrequestVersionと入力コンテキスト比較を維持する。datasetId、revision、rowId集合、候補hash、モード、設定のいずれかが変わった応答を破棄する。ページ離脱、KeepAlive再訪、再実行で古い結果がSelectionやPCP状態を上書きしない。

<a id="feature-23-実装仕様"></a>

## 2. Feature 23 実装仕様

### 2.1 名称と計算の正本

内部ルーティングキーは移行中の呼び出しを壊さないため残してよいが、レスポンスのdisplayName、画面ラベル、tooltip、説明文、ログ、テスト期待値では下表の名称だけを使う。

| 現在の呼称 | 今回の表示名 | 実際の計算 | 適用範囲 |
|---|---|---|---|
| TabDiff | 実験的条件付き補完 | Gaussian条件付き平均と周辺頻度による近似 | 欠損補完の実験機能 |
| Φk / Phik | 補正V（Cramér's V系） | 補正Cramér's V系。公式PhiKとは呼ばない | Surpriseのカテゴリ関連 |
| 相互情報量（教師なし） | 平均絶対相関（教師なし代理指標） | 他特徴量との絶対相関の平均 | targetなしの特徴ランキング |
| 相互情報量（教師あり） | 相互情報量 | mutual_info_classifまたはmutual_info_regression | targetありの特徴ランキング |
| Wasserstein距離 | 絶対平均差 | 現行の平均差の絶対値 | TabDiff診断の分布差 |
| ReliefF（教師なし） | 分散（教師なし代理指標） | 現行の列分散 | targetなしの特徴ランキング |
| ReliefF（教師あり） | ReliefF | 現行の教師ありReliefF近似 | targetありの特徴ランキング |

tooltipには式またはアルゴリズム、欠損処理、教師あり/教師なし、現在のscopeを含める。名称だけを変えて旧名の式説明を残さない。

### 2.2 MDIとPermutationの分離

compute_feature_rankingsの役割を次のように分ける。

1. randomForestまたはmdiはmodel.feature_importances_だけを保持する。これがMDIである。
2. use_permutation_importance=trueかつ教師ありで行数が足りる場合だけ、別のpermutation_train配列を計算する。
3. Permutationの平均値は負値を0へ丸めない。importanceMeanとimportanceStdを符号付きで返す。
4. MDIとPermutationを足し合わせたり平均したり、同じBorda順位へ投入したりしない。既存rankingsのBordaは指定されたMDIなどの手法だけで計算する。
5. 教師なしのPermutationはavailable=falseとし、画面では「教師ありのみ」と表示する。
6. 学習データ上のPermutationはmetadataでscope=trainと記録する。独立検証用Permutationとは別物である。

### 2.3 Feature 23バックエンド作業

#### 23-BE1 名称監査

- feature_ranking.pyの教師あり/教師なし分岐に応じたmethodIdとdisplayNameを返す。
- tabdiff.pyとsurprise.pyの結果へmethodId、表示名、formula、scopeを追加する。
- 旧名がユーザー向け文言に残っていないことを文字列監査する。移行用aliasはdeprecatedAlias=trueとし、画面へ出さない。

#### 23-BE2 重要度計算

- feature_ranking.pyの315〜326行付近の混合平均を削除する。
- Random ForestのMDIとPermutationのseed、repeats、scoring、対象行数、target型をmetadataへ記録する。
- Permutationの分散が計算できないときはnullまたはavailable=falseとし、MDIへフォールバックしない。
- rankings、importance.mdi、importance.permutation_trainのfeature名と順序を決定的にする。

#### 23-BE3 API応答

既存POST /mining/feature-rankingを維持し、次のブロックを追加する。既存rankings利用箇所は同一変更内で更新し、混合値を返さない。

    {
      "importance": {
        "mdi": [
          {"featureName": "Feature_A", "importance": 0.35, "rank": 1}
        ],
        "permutation_train": [
          {"featureName": "Feature_A", "importanceMean": 0.19, "importanceStd": 0.03, "rank": 1}
        ]
      },
      "importanceMetadata": {
        "mdi": {"available": true, "scope": "train", "model": "RandomForest", "criterion": "gini"},
        "permutation_train": {
          "available": true, "scope": "train", "repeats": 5, "seed": 42,
          "scoring": "model_default", "evaluatedRows": 200
        }
      },
      "metadata": {
        "warnings": [
          "訓練データ上の重要度は予測への貢献であり、因果効果ではない",
          "相関した変数間では重要度が分散する場合がある"
        ]
      }
    }

利用不能時もpermutation_trainを空配列で返し、理由をreasonへ入れる。「未実行」と「値0」を区別できる応答にする。

#### 23-BE4 検証

- 同一fixtureでMDIとPermutationを計算し、別配列、別メタデータ、符号付きPermutationが返ることを確認する。
- 特定のMDI値とPermutation値を使った回帰で、混合平均が返らないことを確認する。
- 教師ありMI/ReliefF、教師なし代理指標、補正V、絶対平均差のラベルと式を確認する。
- activeRowIds、revision、MA子列の既存射影、importanceScopeを壊さない。

### 2.4 Feature 23フロントエンド作業

#### 23-FE1 FeatureRankingPage

- レスポンス型へimportanceとmetadataを追加する。
- MDIを左列、Permutation Importance（訓練データ）を右列のCard/バー一覧で表示する。既存Borda表、Top-K、共通Variable Selectorへの適用は残す。
- MDI欄に高カーディナリティバイアス、Permutation欄に訓練データ・過学習影響の注意書きを出す。
- 教師なしではPermutation欄を「教師ありのみ」とし、0.0の棒を描かない。
- taskTypeに応じてラベルを切り替え、教師なしmutualInfoを「相互情報量」と表示しない。
- 狭い幅では縦積み、通常幅では2列とし、既存のAnt Designの配色と余白へ揃える。

#### 23-FE2 関連画面

- SurpriseAssociationView.tsxのPhik表示、heatmap title、table title、Inspectorを「補正V」へ統一し、式とカテゴリ変数への適用範囲をtooltipで説明する。
- ImputationModal.tsxのTabDiff表示、説明、Tagを「実験的条件付き補完」へ統一する。
- 全てのⓘはキーボードで到達でき、aria-describedbyまたは同等の説明関係を持つ。

### 2.5 Feature 23受入条件

| ID | 完了条件 | 必須証跡 |
|---|---|---|
| 23-AC01 | 全対象手法の計算実体と表示名が一致し、近似を公式名で呼ばない | backend unit、旧名検索 |
| 23-AC02 | 教師ありMI/ReliefFと教師なし代理指標のラベル・式・scopeが分岐する | fixture JSON、画面 |
| 23-AC03 | TabDiff、Phik、Wassersteinの表示が正本名称へ統一され、旧名がユーザー向けに残らない | frontend grep、Vitest |
| 23-AC04 | MDIとPermutationが別配列・別メタデータで返り、混合平均が存在しない | pytest API、混合値回帰 |
| 23-AC05 | Permutationの負値・標準偏差・repeats・seed・train scopeが保持される | pytest fixture |
| 23-AC06 | 教師なしPermutationが未対応として明示され、0値への偽装がない | pytest、画面 |
| 23-AC07 | FeatureRankingがMDI/Permutationの2列、注意書き、式tooltipを表示する | Vitest、実ブラウザ |
| 23-AC08 | SurpriseとImputationの全表示箇所が新名称となり、tooltipがscopeと計算を説明する | Vitest、文字列監査 |
| 23-AC09 | Top-K、中央Selection、PCP遷移、KeepAlive、dataset切替が同じrowId/軸順を保つ | 実ブラウザ操作ログ |
| 23-AC10 | scopeHash、revision、欠損数、MA射影、遅延応答破棄が既存契約のまま通る | 限定テスト |
| 23-AC11 | Feature 23対象のpytest/VitestとTypeScriptチェックが通る | .temp/feature23-24/tests/feature23.* |
| 23-AC12 | local、static、run-production.batで2列画面と名称を確認し、生成物hashを記録する | .temp/feature23-24/reports/feature23-production.json |

<a id="feature-24-実装仕様"></a>

## 3. Feature 24 実装仕様

### 3.1 推論モードとアルゴリズムモードを分離する

| API/画面 | 既存modeの意味 | Feature 24で追加する項目 |
|---|---|---|
| POST /mining/subgroups | 現在は未使用 | analysisMode: exploration / verification |
| POST /mining/modern-subgroup | auto / standard / emm_kendallの探索アルゴリズム | inferenceMode: exploration / verification |
| ModernSubgroupMiningView | miningModeは探索アルゴリズム選択 | inferenceModeを別stateで追加 |

modernのmodeをexploration/verificationへ上書きしてrun_modern_subgroup_miningを壊してはならない。classicの正本はanalysisMode、modernの正本はinferenceModeとする。

### 3.2 探索モード

- 既定値はexploration。何も選択しない場合は必ず探索モードになる。
- 候補探索、効果量、分布差、人数、scopeは返すが、p値、q値、信頼区間を計算しない。
- 応答はisExploratory=true、p_value=null、q_value=null、confidence_interval=nullとする。
- UIには「🔍 探索的候補」と「この結果は全データ上の探索であり、母集団への確証ではありません」を表示する。
- classicのFDR alphaは探索モードでは非表示または無効化し、p値のためだけに使わない。
- 検証へ移るときは候補ID、条件、target、候補生成時scopeHash、rowId集合のhashを固定する。検証リクエストで候補を再探索しない。

探索応答の最小形:

    {
      "analysisMode": "exploration",
      "algorithmMode": "auto",
      "isExploratory": true,
      "candidateSetHash": "sha256:...",
      "insights": [
        {
          "id": "candidate-1",
          "condition": "A == 'High'",
          "effect_size": 2.5,
          "n": 240,
          "p_value": null,
          "q_value": null,
          "confidence_interval": null,
          "is_exploratory": true
        }
      ]
    }

### 3.3 検証モード

検証は探索結果から明示的に遷移した場合だけ可能とする。

    {
      "method": "holdout",
      "test_size": 0.30,
      "k": 5,
      "correction": "bh-fdr",
      "alpha": 0.05,
      "seed": 42,
      "independent_dataset_id": null
    }

- holdoutは70%を候補固定用、30%を評価用とし、rowIdの重複を許さない。候補条件は評価側で再探索しない。
- cross_validationはk=5を既定とし、候補をfoldごとに再発見しない。fold、seed、評価人数を返す。
- independentはindependent_dataset_idを必須とし、同一datasetのrowId混入を検出して422にする。
- 多重比較補正は候補集合全体を一つのfamilyとし、BH-FDRを既定にする。mHypotheses、補正法、raw p、adjusted pを返す。
- 応答にはtestUsed、selectionScopeHash、evaluationScopeHash、nSelection、nEvaluation、seedを必ず含める。
- split不成立、候補hash不一致、独立データ未指定、群人数不足は、VERIFICATION_CONFIG_INVALID、VERIFICATION_SCOPE_OVERLAP、VERIFICATION_INSUFFICIENT_DATAのいずれかで422にする。

検証応答の最小形:

    {
      "analysisMode": "verification",
      "isExploratory": false,
      "candidateSetHash": "sha256:...",
      "verification": {
        "method": "holdout",
        "testUsed": "two_group_mean_difference",
        "correction": "bh-fdr",
        "mHypotheses": 3,
        "seed": 42,
        "nSelection": 700,
        "nEvaluation": 300,
        "selectionScopeHash": "sha256:...",
        "evaluationScopeHash": "sha256:..."
      },
      "results": [
        {
          "candidateId": "candidate-1",
          "effectSize": 2.4,
          "confidenceInterval": [1.1, 3.7],
          "pValue": 0.004,
          "pAdjusted": 0.012,
          "isExploratory": false
        }
      ]
    }

### 3.4 Feature 24マイニング作業

#### 24-M1 classic API

- SubgroupMiningRequestへanalysisMode、verificationConfig、candidateIds、candidateSetHashを追加する。
- 探索分岐ではrun_subgroup_miningのp値計算を呼ばず、計算後に隠すだけにしない。
- 検証分岐では固定候補、split、検定、BH-FDR、CIを実行し、候補選択と評価のrowId集合を返す。

#### 24-M2 modern API

- ModernSubgroupRequestへinferenceMode、verificationConfig、candidateIds、candidateSetHashを追加する。
- 既存modeをそのままrun_modern_subgroup_miningへ渡す。
- modernの探索結果にもcandidateSetHashと探索注記を付け、classicと同じ検証設定・エラーコードを使う。
- 既存の「この結論の頑健性を検証」ボタンは、検証済みと扱わず、候補固定して検証設定または感度分析へ渡す入口にする。

### 3.5 感度分析APIとエンジン

#### 24-S1 エンドポイント

POST /api/v1/robustness/sensitivity（実装ルートは /robustness/sensitivity）を追加する。既存の /robustness/evaluate は残す。

任意の文字列式をサーバーで評価せず、マイニング結果から渡された構造化候補を正本とする。

    {
      "datasetId": "dataset-id",
      "targetColumn": "score",
      "candidate": {
        "type": "subgroup_diff",
        "groupColumn": "A",
        "compareGroups": ["High", "Other"],
        "rowIds": ["r1", "r2"]
      },
      "outlierMethod": "standardized_deviation",
      "threshold": 3.0,
      "scopeRowIds": null,
      "bootstrapB": 200,
      "seed": 42,
      "expectedSchemaRevision": 12,
      "expectedDataRevision": 34
    }

candidate.typeはkpiまたはsubgroup_diffとする。外れ値判定はtarget列と候補条件に関係する数値列の標準化偏差で行い、欠損は外れ値とみなさない。対象列不足、必要群不足、全行除外は422とする。

#### 24-S2 比較結果

    {
      "runId": "run-id",
      "method": "standardized_deviation",
      "threshold": 3.0,
      "baseline": {
        "n": 1000,
        "effectSize": 2.5,
        "confidenceInterval": [1.2, 3.8],
        "direction": "positive",
        "scopeHash": "sha256:..."
      },
      "sensitivity": {
        "n": 980,
        "excludedN": 20,
        "effectSize": 2.4,
        "confidenceInterval": [1.5, 3.3],
        "direction": "positive",
        "scopeHash": "sha256:..."
      },
      "comparison": {
        "relativeChange": 0.04,
        "baselineCiCrossesZero": false,
        "sensitivityCiCrossesZero": false,
        "directionPreserved": true,
        "maxRelativeChange": 0.20,
        "isRobust": true,
        "reason": "direction_and_ci_status_preserved"
      },
      "outlierRowIds": ["r100", "r200"],
      "weightApplied": false
    }

isRobustは文章で曖昧に判定しない。zeroTolerance=1e-12で方向を決め、relativeChange = abs(sensitivity-baseline) / max(abs(baseline), 1e-9)を計算する。directionPreserved=true、relativeChange <= 0.20、baseline/sensitivityのCIが0を跨ぐかどうかが同じ場合だけtrueとする。閾値を変更可能にする場合はrequestとresponseへ記録する。

データセットや中央Selectionを変更しない。outlierRowIdsは説明と任意確認用であり、成功時にRedux選択を差し替えない。調査ウェイトが指定されていても、非加重としてweightApplied=falseを返すか、WEIGHT_UNSUPPORTEDで拒否する。

#### 24-S3 エンジン

- engine.pyへSensitivityAnalyzerまたは同等の明示名とrun_sensitivity_analysis()を追加する。
- baselineと除外後で同じ効果量関数、同じCI方法、同じseedを使う。
- 現在のquality removal sweepは旧evaluateの内部処理として残してよいが、ユーザー向けに「品質下位」を表示しない。自動削除、dataset保存、selection変更は行わない。
- method、threshold、除外行数、除外行ID、scopeHash、revision、bootstrap回数を記録する。

### 3.6 Feature 24フロントエンド作業

#### 24-FE1 探索・検証UI

- SubgroupMiningPage.tsxにinferenceMode stateを追加し、classicのalpha入力を探索/検証に応じて切り替える。
- ModernSubgroupMiningView.tsxは既存miningModeをアルゴリズム選択として残し、別のinferenceMode selectorを追加する。
- 探索カードへ「🔍 探索的候補」、効果量、人数、candidateSetHash、非確証注記を表示する。
- p値・q値・CIのコンポーネントは探索モードでmountしない。0や—をp値の代用として出さない。
- 「検証モードへ移行」で候補を固定したVerificationConfigModalを開く。holdout 70/30、CV k=5、independent、BH-FDR、seed、候補hash、scopeを確認できる。
- 検証結果にはsplit、n、検定名、raw/adjusted p、CI、多重比較familyを表示し、探索バッジを「検証済み候補」に置き換える。

#### 24-FE2 RobustnessPage

- タイトル、Card、Table、tooltip、loading文言の「品質下位」「品質除去」を「数値的外れ度に基づく感度分析」へ変更する。
- SensitivityComparisonPanelでbaselineとsensitivityを2列表示し、n、効果量、CI、方向、相対変化、isRobust理由を表示する。
- 外れ値を自動削除するボタンを設けない。必要なら「除外行を確認」だけを提供し、PCP/Tableへの適用はユーザーが明示した場合に限る。
- サブグループから遷移した候補条件と検証状態を保持し、既存Selection、PCP遷移、focus mode、KeepAliveを変えない。

### 3.7 Feature 24受入条件

| ID | 完了条件 | 必須証跡 |
|---|---|---|
| 24-AC01 | classic/modernとも既定が探索で、アルゴリズムmodeと推論inferenceModeが分離する | API契約、型チェック |
| 24-AC02 | 探索でp値/q値/CIを計算・返却・表示せず、探索バッジと注記を出す | pytest、Vitest、画面 |
| 24-AC03 | 探索から検証へcandidateId、条件、candidateSetHash、scopeHashを固定して遷移する | request fixture、E2E |
| 24-AC04 | holdoutが70/30、seed固定、selection/evaluation rowIdが排他的である | 分割fixture、重複assert |
| 24-AC05 | CV k=5とindependent経路が明示設定で実行され、未設定・重複は422となる | APIテスト |
| 24-AC06 | 検証結果にtestUsed、CI、raw p、BH-FDR adjusted p、family数、split n、scope hashがある | API JSON |
| 24-AC07 | stale revision、候補hash不一致、群不足、空scopeが古い結果を画面へ適用しない | 限定テスト |
| 24-AC08 | 新しい感度分析API/エンジンがあり、既存robustness/evaluateを壊さない | pytest API、既存テスト |
| 24-AC09 | baselineと除外後を同じ効果量・CI方法で比較し、n・threshold・除外数・methodを表示する | 手計算fixture、画面 |
| 24-AC10 | isRobustが方向、相対変化20%、CIの0跨ぎを固定式で判定する | 境界値unit |
| 24-AC11 | 外れ値除外がdataset、中央Selection、PCP/Tableへ自動反映されず、weightも黙って適用されない | Redux/E2E、weight fixture |
| 24-AC12 | RobustnessPageに比較Panelがあり、旧「品質下位」文言がユーザー向けに残らない | 文字列監査、Vitest |
| 24-AC13 | Feature 24対象pytest/Vitest、TypeScript、E2Eが通る | .temp/feature23-24/tests/feature24.* |
| 24-AC14 | local、static、run-production.batで探索→検証→感度比較→PCP遷移を確認し、hashを記録する | .temp/feature23-24/reports/feature24-production.json |

## 4. Feature 23/24横断E2E

1. Feature RankingでMDIとPermutationを計算し、二つの順位が混ざっていないことを確認する。
2. Top-Kを中央Variable Selectorへ適用し、Table/PCPの軸とrowIdが維持されることを確認する。
3. Subgroup Miningを既定の探索で実行し、探索バッジ、効果量、p値非表示を確認する。
4. 候補を一つ選び、candidateSetHashとscopeを確認してVerificationConfigModalを開く。
5. Holdout 70/30、BH-FDR、seed 42で検証し、selection/evaluationのrowIdが重複せず、CIとadjusted pが表示されることを確認する。
6. 同じ候補をRobustnessへ渡し、「数値的外れ度に基づく感度分析」を実行する。
7. baseline/sensitivityのn、効果量、CI、方向、判定理由を比較し、中央Selectionが勝手に変更されないことを確認する。
8. PCPへ戻り、元の候補選択、軸順、dataset、KeepAlive状態を確認する。
9. dataset切替、row selection変更、再実行、ページ離脱中の遅延応答を発生させ、古い結果が表示されないことを確認する。

## 5. 実装順序と証跡

1. 対象ファイルの既存差分を確認し、Feature 23の名称とAPI契約を固定する。
2. Feature 23のbackend計算分離と限定pytestを完了する。
3. Feature 23のfrontend型、2列、tooltip、Selection回帰を完了する。
4. Feature 24のinferenceMode契約と探索分岐を実装し、p値が実際に計算されないことを確認する。
5. 検証分割、候補固定、FDR、CI、stale guardを追加する。
6. SensitivityAnalyzerと新APIを追加し、baseline/sensitivity境界値をテストする。
7. 探索→検証→感度比較を接続し、Robustnessの旧文言と自動除外経路を監査する。
8. 限定テスト、TypeScript、実ブラウザ、static、run-production.batの順に検証する。全体テストは担当範囲が確定してから実施する。
9. .temp/feature23-24へfixture、期待JSON、操作ログ、画面画像、テスト結果、生成物hashを保存する。
10. 全ACへ証跡パスを記録し、tasks/task-list.mdの状態を更新する。証跡がないACは完了にしない。

## 6. 完了宣言

Feature 23は23-AC01〜12、Feature 24は24-AC01〜14を全てYesにできた場合だけ完了とする。名称だけ変えて計算を確認していない場合、p値を画面から隠しただけでbackendが計算している場合、外れ値を自動削除したままラベルだけを変えた場合、localだけでstatic/run-production.batを確認していない場合は完了にしない。
