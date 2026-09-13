# 添付ソース・既存仕様の照合記録

確認日：2026-09-12。静的コード照合を実施した。ここに示す行番号は添付package(1).zipを展開した元ファイルの1始まり行番号であり、提案ファイルの行番号ではない。実行・E2E確認済みという意味ではない。

## 1. 入力アーカイブの同定

|ファイル|bytes|SHA-256|
|---|---:|---|
|`feature.zip`|1366452|`f40dc5812064962234e5923d569d89ccc32e61b253e4b7f88e1bcd3580712ed6`|
|`package(1).zip`|80494001|`9a14dc6e1f879f6d7cc9fe0e861ac7b61ba74250f4b3d2e3e22efcff6f287d01`|
|`package.zip`|80494001|`9a14dc6e1f879f6d7cc9fe0e861ac7b61ba74250f4b3d2e3e22efcff6f287d01`|
|`davis-pcp-local(1).zip`|1031580|`461abff34f6647ab8e14099d4dbd6e76dc15e41b968382d76dbebe2a8a9369d4`|

package.zipとpackage(1).zipのSHA-256は同一。実装設計の基準はpackage(1).zip。local配布は実行用snapshotとして参照し、フロントエンド開発用ファイルの有無はsource版を基準とした。

## 2. 実装接続箇所

|確認ファイル|該当行・symbol|確認事項|
|---|---|---|
|[fullstack/backend/app/main.py](../../../fullstack/backend/app/main.py)|`include_router`: 67,68,69,70,71,72等<br>`/api/v1`: 67,68,69,70,71,72等|API router登録|
|[fullstack/backend/app/domain/context.py](../../../fullstack/backend/app/domain/context.py)|`class AnalysisContext`: 25<br>`def collect_revisions`: 48<br>`def check_revisions`: 56<br>`def scope_hash`: 89<br>`def resolve_scope`: 95|既存context、版、scope、行ID集合|
|[fullstack/backend/app/domain/analysis_columns.py](../../../fullstack/backend/app/domain/analysis_columns.py)|`class AnalysisColumns`: 14<br>`def prepare`: 19<br>`def resolve_analysis_columns`: 43|MA dependenciesとモデル入力列の絞込|
|[fullstack/backend/app/domain/codebook_adapter.py](../../../fullstack/backend/app/domain/codebook_adapter.py)|`def normalize_code`: 17<br>`def analysis_series`: 199<br>`categoryOrder`: 133,142,210,214,249,252等<br>`CODEBOOK_REVERSE_RANGE_MISSING`: 273|コード正規化、ordinal数値化、逆転範囲|
|[fullstack/backend/app/algorithms/summaries/core.py](../../../fullstack/backend/app/algorithms/summaries/core.py)|`categoryOrder`: 63,68,201,299,301,346等<br>`invalid`: 64,65,67,72,88,94等|閉じた有効領域とinvalid|
|[fullstack/backend/app/algorithms/summaries/crosstab.py](../../../fullstack/backend/app/algorithms/summaries/crosstab.py)|`def _split_missing`: 120<br>`include_missing`: 133,168<br>`separate_not_applicable`: 135,137,168|欠損/非該当カテゴリの意味|
|[fullstack/backend/app/domain/weight_mode.py](../../../fullstack/backend/app/domain/weight_mode.py)|`def `: 16<br>`weightMode`: 1,29,36,43|weightMode互換規則|
|[fullstack/backend/app/domain/survey_weight.py](../../../fullstack/backend/app/domain/survey_weight.py)|`def `: 21,34,50,66,122,131等<br>`frequency`: 146,148,170,185,189<br>`survey`: 3,51,147,170,186|重み宣言・値検証|
|[fullstack/backend/app/algorithms/survey/design.py](../../../fullstack/backend/app/algorithms/survey/design.py)|`def `: 21,56,60,64,68,74等<br>`fpc`: 51,97,102,103,106,109等|調査設計列・FPC|
|[fullstack/backend/app/algorithms/survey/covariance.py](../../../fullstack/backend/app/algorithms/survey/covariance.py)|`def `: 16,58|既存共分散helperの境界監査対象|
|[fullstack/backend/app/storage/dataset_store.py](../../../fullstack/backend/app/storage/dataset_store.py)|`def lock`: 109<br>`def get_dataframe`: 229<br>`def load_codebook`: 599<br>`def mask_revision`: 370<br>`def commit_data_change`: 407|snapshot/版/原子的変更の接続先|
|[fullstack/backend/app/domain/provenance.py](../../../fullstack/backend/app/domain/provenance.py)|`def new_operation_id`: 44<br>`class ProvenanceStep`: 53<br>`def fingerprint_payload`: 80|派生列の来歴|
|[fullstack/backend/app/api/models.py](../../../fullstack/backend/app/api/models.py)|`@router`: 45,180,366,377,396<br>`_results`: 28,359,368,370|既存PCA等。新APIの共有サービスとは分離|
|[fullstack/frontend/src/api/client.ts](../../../fullstack/frontend/src/api/client.ts)|`const BASE`: 3<br>`pyodide`: 1,19,68,88,108<br>`downloadBlob`: 49|local/static共通通信・static exportの制約|
|[fullstack/frontend/src/engine/pyodide.worker.ts](../../../fullstack/frontend/src/engine/pyodide.worker.ts)|`loadPackage`: 72<br>`numpy`: 73<br>`scipy`: 74<br>`serialQueue`: 7|既存Python実行とパッケージ|
|[fullstack/frontend/src/main.tsx](../../../fullstack/frontend/src/main.tsx)|`Route`: 4,70,77,104<br>`models`: 14,23,31,32,48|router登録|
|[fullstack/frontend/src/app/KeepAliveOutlet.tsx](../../../fullstack/frontend/src/app/KeepAliveOutlet.tsx)|`ROUTE_COMPONENTS`: 35,96,113|ページ保持登録|
|[fullstack/frontend/src/app/AppShell.tsx](../../../fullstack/frontend/src/app/AppShell.tsx)|`ANALYSIS_NAV_ITEMS`: 44,60,432,433|ナビゲーション登録|
|[fullstack/frontend/src/app/store.ts](../../../fullstack/frontend/src/app/store.ts)|`selectionApplied`: 101,163,461<br>`activeRowIds`: 34,35,60,89,103,122等<br>`hovered`: 39,64,117,118,163|L1/L2・選択交差|
|[fullstack/scripts/build_static.py](../../../fullstack/scripts/build_static.py)|`ROOT =`: 19<br>`FRONTEND_DIR =`: 20<br>`BACKEND_DIR =`: 21<br>`0.27.7`: 25|静的配布のパスとruntime宣言|
|[fullstack/backend/requirements.txt](../../../fullstack/backend/requirements.txt)|`numpy`: 5<br>`scipy`: 7<br>`pydantic`: 3|添付版の依存宣言|
|[fullstack/frontend/package.json](../../../fullstack/frontend/package.json)|`"scripts"`: 6<br>`"test"`: 12<br>`"build:static"`: 10|FEビルド・検証コマンド|

## 3. 既存仕様で更新が必要な点

|原資料|確認箇所|本設計の確定処理|
|---|---|---|
|[feature.zip/tasks/DAVIS-FEAT-027-028.md](../../../tasks/DAVIS-FEAT-027-028.md)|`isExplorative`: 96,260<br>`rowIds`: 69,75,234|MCAのnK分母をnmへ変更。選択scopeの専用selectedRowIdsと探索ラベルへ統一。PCP部分は維持。|
|[feature.zip/tasks/DAVIS-FEAT-020-DESIGN.md](../../../tasks/DAVIS-FEAT-020-DESIGN.md)|`上限`: 41<br>`離脱`: 41|計算の勝手な間引き・ページ離脱時の破棄を導入しない。今回のページ分割は転送/描画の分割。|
|[feature.zip/tasks/DAVIS-FEAT-021-022.md](../../../tasks/DAVIS-FEAT-021-022.md)|`survey`: 6|重み種別とordinalの解釈を分離し、unsupportedの黙認を防ぐ。|
|[feature.zip/tasks/DAVIS-FEAT-025-026.md](../../../tasks/DAVIS-FEAT-025-026.md)|`commit`: 682<br>`provenance`: 7,140,184,275,307,308,309,310,311,312,313,353,365,659,678,686<br>`revision`: 104,142,176,183,271,294,299,327,352,354,356,360,363,373,377,395,548,573,579,603,634,651,658,659|派生列・原子的保存・版追跡を維持。|

## 4. 接続時の注意（観測事実と設計判断）

`AnalysisColumns.prepare`は要求対象を返すため、重み・ID・目的変数を同じ戻り配列に残ると仮定しない。別配列はrowIdで整列する。categoryOrderの閉領域判定とvalueLabelsの表示機能は区別する。ordinal列の既存analysis_seriesをカテゴリMCAへ流用するとコードの同一性が変わるため、用途を分ける。

`client.downloadBlob`のstatic制約を回避するため、新分析のexportは通常APIのJSON文字列からFE Blobを構築する。`build_static.py`はROOT=parents[1]の後にfullstackを付けており、添付配置では二重fullstackとなる可能性がある。この記述を実在パスassertのリリースゲートとして扱い、ビルド成功済みとはしていない。

既存survey helperのsingleton/FPC経路は新回帰の安全な分散契約を無条件には満たさないため、共通model_covarianceを別途作る。既存helper全体がすべて誤りだという断定ではない。

新規6分析のroute/kernelは、このsnapshotの既存models/regression/logistic等の調査では確認できなかった。別ブランチ・未添付差分に存在しないと断定するものではない。取り込み時に同名route/機能が先行実装されていれば、新規二重登録ではなく本契約に統合する。

## 5. 実装者による基準版確認

同梱`source_manifest.json`は照合したファイルのSHA-256一覧。設計を適用する作業treeが異なる場合は差分を確認し、rename済みの接続先を対応表へ記録する。hash不一致だけでアルゴリズムを旧仕様へ戻さない。ユーザーの元ZIPやソース全文は成果物ZIPへ再同梱していない。
