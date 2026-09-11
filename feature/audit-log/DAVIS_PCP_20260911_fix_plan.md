# DAVIS-PCP 修正計画（2026-09-11 監査・第1次対象）

状態: 計画（実装前）
作成日: 2026-09-11
対象リポジトリ: `C:\dev\davis-pcp`（fullstack/backend, fullstack/frontend）
対象監査:
- `feature/audit-log/DAVIS_PCP_local_audit_20260911.md`
- `feature/audit-log/DAVIS_PCP_review_20260911.md`

---

## 0. 対象と前提

### 0.1 対象指摘（9件）

| # | ラベル | 一言でいうと | 主な所在 |
|---|---|---|---|
| 1 | VERIFY-01 / A01 | 検証が群間差でなく「全体平均 vs 0」を検定している | `app/api/mining.py:253-276` |
| 2 | VERIFY-02 / A02 | 候補を固定すると言いながら検証時に再探索している | `app/api/mining.py:223-240` |
| 3 | VERIFY-04 / A04 | 独立データの連番rowId衝突を「同一回答者」と誤判定している | `app/api/mining.py:200-216` |
| 4 | VERIFY-05 | 候補ハッシュに条件情報が入らず、候補集合を特定できない | `app/api/mining.py:151-154, 401-402`, `app/domain/verification.py:19-26` |
| 5 | WEIGHT-03 / B05 | MA（複数回答）集計が weightColumn を黙って無視する | `app/api/multi_response.py:37-43, 218-301`, `app/domain/multi_response.py:269-372` |
| 6 | WEIGHT-04 / B04 | 補正ウェイトの倍率だけでχ²・p値が激変する | `app/algorithms/summaries/crosstab.py:283-315` |
| 7 | IMPUTE-03 / E04 | 条件付き補完で目的列が唯一の説明変数／プレビューと適用が別物 | `app/algorithms/imputation/core.py:187-279`, `tabdiff.py:64-78`, `api/datasets.py:1045-1067` |
| 8 | IMPUTE-04 / E05 | 派生データセット作成時に、今回の補完マスクと操作履歴が失われる | `app/api/datasets.py:1128-1143, 373-380` |
| 9 | HIST-01〜04 / E07 | Undo が値しか戻さない（スキーマ・コードブック・マスク・履歴カーソル） | `app/api/datasets.py:1307-1345`, `app/storage/dataset_store.py:288-400` |

### 0.2 決定済み事項

- **WEIGHT-03/B05**: 「回答者重みで加重集計を実装」する（未対応アラート方式ではなく実装）。
  プレビューで `weightStatus: "applied"`、`weightColumn` / `weightedN` / `weightMissingCount` を返し、
  `items[]` に `selectedWeighted`（新規）と `pctRespondentUnweighted`（新規）を追加、`pctRespondent` は加重比率にする。
- **VERIFY 系**: 監査の推奨順序に従い、まず検証機能を止めてから作り直す（第1段階）。
- **WEIGHT-04/B04**: 未決。方針はユーザーから後日提示される（→ §0.3、§1.4）。

### 0.3 未決事項

| ID | 未決の内容 | 決定者 | 本計画での扱い |
|---|---|---|---|
| **WEIGHT-04/B04** | 調査ウェイト使用時の χ²・p値・有意マーカーの扱い（下記 A〜D 案） | ユーザー（方針提示待ち） | §1.4 に選択肢と受入条件を用意し、決定後に確定。決定までは実装しない |
| VERIFY-03/A03 | 交差検証が fold 0 しか評価していない（`mining.py:184-199`。`stored_insights` が最後の fold で上書き） | 実装者判断 | 本計画の対象外。VERIFY-02 の改修で同じ関数を触るため、コメントで残す |
| 重み付き検定の設計効果 | Rao-Scott 補正を入れるか（監査 [R3]） | ユーザー | §1.4 の D 案として併記 |

### 0.4 本計画の対象外（対応済み・別件）

- **CTX-01/C01**（空スコープが全体扱い）: `app/domain/context.py` の `resolve_scope` で対応済み（`None`＝全部、`[]`＝空）。
- **WEIGHT-01/B03**（重み列の欠損コード未適用）: `app/domain/survey_weight.py:extract_weights` で対応済み。
- **HIST-05**（データセット削除でスナップショットが残る）: `dataset_store.delete`（`:428-446`）で対応済み。
- **XTAB-02**（セル行IDの再導出）, **E06**（WASM I/O）, **FEDF-01**, **TEXT-01**, **SEC-01**, **PKG-01** など: 別バッチ。

---

## 1. 共通の土台（先に作るもの）

個別修正のうち VERIFY 系 4 件と HIST 系 4 件は、下記の土台を先に作らないと個別対処が場当たりになる。**§1.1 と §1.2 を最初に実装する。**

### 1.1 候補の固定：PinnedCandidate と候補ストア（VERIFY-02 / VERIFY-05 の土台）

**なぜ必要か**: 現状は探索が `ins_001` のような**通し番号のIDしか返さず**、検証はそのIDを頼りに**もう一度マイニングを回して**候補を拾い直している（`mining.py:223-240`）。ハッシュも `{id, condition, target, scopeHash}` の4項目だけで、classic の `condition` は属性名、modern は `item.get("condition")` が常に空文字（`mining.py:401`）なので、**条件が違っても同じハッシュになる**。

#### 1.1.1 新規モジュール `app/domain/mining_candidate.py`

```python
class PinnedCandidate(BaseModel):
    candidateId: str
    algorithm: Literal["classic", "modern"]
    rule: dict[str, Any]        # 正規化済みルール（下記）
    estimand: dict[str, Any]    # 検証で再現すべき対比（下記）
    displayLabel: str           # UI表示用（"Q1 × 年代=20代" など）

class PinnedCandidateSet(BaseModel):
    candidateSetHash: str
    datasetId: str
    dataRevision: int
    schemaRevision: int
    scopeHash: str
    algorithm: str
    parameters: dict[str, Any]   # minGroupSize 等（探索時の値。ハッシュに含める）
    candidates: list[PinnedCandidate]
```

**rule の正規化（決定的JSON）**

- classic 数値: `{"kind":"classic_numeric","attribute":{"columnId":..,"conditionLevel":..,"referenceLevel":..},"question":{"columnId":..,"scaleType":..}}`
- classic カテゴリ: `{"kind":"classic_categorical","attribute":{"columnId":..,"conditionLevel":..},"question":{"columnId":..,"conditionCategory":..}}`
- modern: `{"kind":"modern","conditions":[{"columnId":..,"operator":..,"value":..}, ...],"targetQuestion":..,"targetPair":[...],"targetCategory":..}`

正規化規則: `normalize_code` を通す／`sort_keys=True`／conditions は `(columnId, operator, str(value))` でソート／余分なキーは落とす。

**estimand（検証が再現すべき対比。VERIFY-01 の核心）**

| rule kind | estimand |
|---|---|
| classic_numeric | `{"type":"mean_difference","numerator":"conditionLevel","denominator":"referenceLevel","unit":"question_value"}` |
| classic_categorical | `{"type":"proportion_difference","cell":{"attribute":"conditionLevel","question":"conditionCategory"},"reference":"rest_of_table"}` |
| modern | `{"type":"mean_difference","numerator":"rule_matched_rows","denominator":"complement_within_scope","unit":"targetQuestion"}` |

`estimand` は**探索側（`subgroup._describe_numeric` / `_test_categorical` の `direction`）が埋める**。検証は読むだけ。これにより「探索と検証で対比がずれる」ことが構造的に起きなくなる。

**ハッシュ**

```python
def candidate_set_hash(payload: PinnedCandidateSet) -> str:
    # datasetId + dataRevision + schemaRevision + scopeHash + algorithm
    # + parameters（minGroupSize 等） + 各候補の rule + estimand
    return "sha256:" + hashlib.sha256(canonical_json(payload).encode()).hexdigest()
```

`dataRevision` を含めるので、データを変更した後の検証は自動的に失敗する（黙って別データを検証しない）。

#### 1.1.2 サーバ側での候補集合の保存

探索応答時に候補集合を保存し、検証は**ハッシュでそれを引く**。クライアントから送られたルールは使わない（改竄・取り違え防止）。

- 保存先: `{workspace}/verifications/{datasetId}/{candidateSetHash}.json`
- 追加API:
  - `GET /datasets/{dataset_id}/candidate-sets/{hash}` → 保存済み候補集合（無ければ 404 `CANDIDATE_SET_NOT_FOUND`）
- 検証リクエストは `candidateSetHash` と `candidateIds` のみを受け取る。
  - ハッシュが引けない → 409 `VERIFICATION_CANDIDATE_SET_EXPIRED`「候補集合が失効しました。もう一度探索してください。」
  - `candidateIds ⊄ stored` → 422 `VERIFICATION_CANDIDATE_UNKNOWN`
- 後方互換: 旧クライアントの `candidateIds` のみ／`candidateSetHash` のみ送信は、上記エラーで明示的に落とす（**黙って再探索しない**）。フロントは同一PRで更新する。

**変更ファイル**: 新規 `app/domain/mining_candidate.py`、新規 `app/services/candidate_store.py`、`app/domain/verification.py`（`candidate_set_hash` を新実装に置換）、`app/api/mining.py`。

---

### 1.2 リビジョン状態スナップショット（HIST-01〜04 / E07 の土台）

**なぜ必要か**: 現在のスナップショットは `{datasetId}.revisions/{revision}.parquet` の**値だけ**。復元時にスキーマ・コードブック・マスクの「その時点の状態」が存在しないため、Undo が値だけ戻して他が現在のまま残る（HIST-01/02/04）。また `commit_data_change` は `dataRevision` と `valuesFingerprint` しか更新せず、`meta["fingerprint"]` を触らないため、**Undo後のデータが操作前と同じ fingerprint になり、要約キャッシュが衝突する**（HIST-01）。

#### 1.2.1 スナップショットの拡張

`dataset_store.commit_data_change` が、`{revision}.parquet` に加えて次の3ファイルを同じ**原子的公開処理**（`_publish_files`）で書く。

| ファイル | 内容 |
|---|---|
| `{revision}.state.json` | `{schema, schemaRevision, rowCount, columnCount, rowIdentity, fingerprint}` |
| `{revision}.codebook.json` | そのリビジョンで公開したコードブック全文 |
| `{revision}.mask.json` | そのリビジョン時点のマスク全文 `{maskRevision, entries}` |

読み出しAPIを追加:
```python
def read_revision_state(self, dataset_id, revision) -> dict | None
def read_revision_mask(self, dataset_id, revision) -> dict | None
def read_revision_codebook(self, dataset_id, revision) -> dict | None
def list_snapshots(self, dataset_id) -> list[int]
```

#### 1.2.2 fingerprint の一元化

`values_fingerprint` とスキーマを混ぜる計算が `_finalize_dataset`（`datasets.py:346-355`）、`_impute_dataset`（`:1093-1096`）、`_calculate_dataset_variable`（`:1190-1193`）に**別々に書かれている**。これを `app/services/dataset_fingerprint.py` に集約する。

```python
def dataset_fingerprint(schema_payload, schema_revision, df, fmt, options) -> str
```

さらに `commit_data_change` 内で**必ず** `updated["fingerprint"] = dataset_fingerprint(...)` を計算して保存する。呼び出し側で計算済みの値があっても信用しない（復元経路が計算を忘れる事故を構造的に潰す）。

#### 1.2.3 要約キャッシュキーの強化

`app/api/summaries.py:65-67` のキーに `dataRevision` と `maskRevision` を追加する。multi_response のキャッシュキー（`api/multi_response.py:250-251`）にも同様に `dataRevision` / `maskRevision` / `weightColumn` を追加する。

#### 1.2.4 既存データの移行

- 読み出しフォールバック（必須）: state ファイルが無いリビジョンは
  - schema: `_derive_dataset_schema(snapshot, source_schema=meta["schema"])`
  - codebook: 現行どおり `_sync_codebook(...)`
  - mask: `inputDataRevision < target_revision` のエントリのみ残す（近似）
  - 応答に `restoreWarnings: ["REVISION_STATE_BACKFILLED"]` を付ける
- 一括バックフィル（任意）: `backend/scripts/backfill_revision_state.py`（冪等・`--dry-run`）。上記フォールバックと同じ内容を書き出す。

**変更ファイル**: `app/storage/dataset_store.py`、新規 `app/services/dataset_fingerprint.py`、`app/api/datasets.py`、`app/api/summaries.py`、`app/api/multi_response.py`。

---

### 1.3 履歴カーソル（HIST-03 の土台）

**なぜ必要か**: 現状 Undo は「いまの操作の親へ戻す」処理をしたうえで、その undo 自体を**新しい操作として追記**し、`currentOperationId` をその undo 操作に付け替える（`datasets.py:1329-1334` + `dataset_store.py:334-338`）。次に Undo すると、カーソル（undo操作）の親＝**たった今取り消した操作**なので、同じリビジョンへもう一度戻る＝**2回目のUndoが効かない**（HIST-03）。redo 側も `undoneOperationId` を全走査する複雑なヒューリスティック（`:1405-1441`）になっている。

**設計**: 「監査ログ（append-only）」と「ナビゲーションカーソル」を分離する。

provenance ドキュメントに追加:
```jsonc
{
  "operations": [ ... ],          // 監査ログ。追記のみ。ナビゲーションには使わない
  "cursorOperationId": "op-...",  // 現在位置
  "redoStack": ["op-..."],        // Undo した操作（新しい順）
  "currentOperationId": "op-..."  // cursorOperationId の別名（応答互換のため維持）
}
```

- 通常のデータ変更: `parentOperationId = cursorOperationId` → 成功後に `cursorOperationId = 新op`、`redoStack = []`。
- 復元系（undo/redo/revert）: `commit_data_change(..., history_mode="navigate", cursor_operation_id=<対象op>)`。
  - `"append"`（既定）: カーソルを新opへ移す
  - `"navigate"`: 操作は**監査ログに追記するが、カーソルは対象opのまま**にする
- `undo`: 対象 = `ops[cursorOperationId].parentOperationId`。`redoStack` に現在のカーソルopを push。親が無ければ 409 `PROVENANCE_NOTHING_TO_UNDO`。
- `redo`: `redoStack.pop()` の op の `outputDataRevision` へ復元。空なら 409 `PROVENANCE_NOTHING_TO_REDO`。
- `revert`（任意ステップへジャンプ）: カーソルを対象opへ移し、`redoStack` は空にする（仕様として明記）。
- 応答に `cursorOperationId` / `canUndo` / `canRedo` を追加（`/datasets/{id}/provenance`, `/undo`, `/redo`, `/revert`）。
- 移行: 既存 provenance に `cursorOperationId` が無ければ `currentOperationId` をカーソルとみなし、`redoStack = []`。

**変更ファイル**: `app/storage/dataset_store.py`（`commit_data_change` のシグネチャ追加）、`app/api/datasets.py`（`_restore_revision` / `undo_dataset` / `redo_dataset` / `revert_dataset` / `_get_provenance`）、`fullstack/frontend/src/features/dataset/ProvenanceHistoryPanel.tsx`。

---

### 1.4 ウェイト契約（WEIGHT-04 の決定待ち）

現状: `AnalysisContext`（`app/domain/context.py`）に `weightColumn` はあるが**ウェイト種別が無い**。`api/summaries.py:205-215` の `CrosstabContext` は `AnalysisContext` の**重複定義**で、しかも `:297-299` で `AnalysisContext(**context.model_dump())` に詰め替えられるため、**`CrosstabContext` だけにフィールドを足すと黙って落ちる**。ここが WEIGHT-04 の実装場所の罠。

**土台として先に入れるもの（方式に依存しない部分）**

1. `CrosstabContext` は `AnalysisContext` を継承してセル固有フィールドだけ足す形に統合する（重複をやめる）。
2. `AnalysisContext` に追加:
   ```python
   weightType: Literal["survey", "frequency"] = "survey"
   ```
   - `frequency`（頻度重み）: 「同じ回答が w 人分」という意味なので、現行の加重度数のまま検定してよい。
   - `survey`（調査重み）: 設計重み。**現行の χ²/p は無効**（WEIGHT-04 の本体）。
3. 応答の `weightStatus` に `"applied_survey"` / `"applied_frequency"` を分けて出す（現状の `"applied"` は後方互換で残す）。

**WEIGHT-04 の選択肢（ユーザー決定待ち。決定後に1つ選ぶ）**

| 案 | 内容 | 変更点 | 受入条件 | リスク |
|---|---|---|---|---|
| **A** 有効N正規化＋近似の明示 | 重みを `n_eff = Σw · (n/Σw)` に正規化してから χ² を計算し、**倍率不変**にする。p値は「加重Pearson近似（設計効果未推定）」と明示。ASR は正規化後の重みで計算 | `crosstab.py:283` の `inference_matrix` を作る前に正規化。`WEIGHTED_INFERENCE_APPROXIMATION` 警告は維持 | 重みを2倍/0.5倍しても χ²・p・ASR・有意マークが**完全一致**する | 検定の名目上の自由度・p値は依然として近似。設計効果を無視している点は残る |
| **B** 調査重みでは検定を出さない | `weightType=="survey"` のとき χ²・p・Cramér's V・有意マークを **null**、集計（度数・％・ASR の記述）のみ表示 | `crosstab.py:294-322` を分岐。`statistics.inferenceMethod = "descriptive_only_survey_weight"`、`warnings` に `SURVEY_WEIGHT_NO_INFERENCE` | 調査重み時に p が出ないこと。頻度重み（`weightType=="frequency"`）では従来どおり | 機能が減る（ユーザーには不満が出る可能性） |
| **C** Rao-Scott 設計効果補正 | 設計効果 `deff`（ユーザー入力 or `DEFF` 列）から χ² を `χ²/deff`、df は同じで p を計算 | `AnalysisContext` に `designEffect: float \| None` を追加。`crosstab.py` に補正を追加 | `deff` を 1 にすると無補正と一致。`deff` を増やすと p が単調に増える | `deff` が無いデータでは使えない。入力UIが必要 |
| **D** デフォルト抑制＋明示オプトイン | `weightType=="survey"` は既定で B、リクエストに `allowApproximateInference: true` があるときのみ A を適用し「近似」バッジを出す | A+B の併用 | 明示しない限り p が出ない。明示時は倍率不変 | 実装量が最大 |

**本計画では §1.4 の 1〜3 と `weightType` の追加までを先行実装し、A〜D の選択後に該当分岐を入れる。** 決定待ちの間、`weightType` 既定は `"survey"` とし、**現行の挙動は変えない**（＝決定まで WEIGHT-04 の症状は残る。§6 に既知の未修正として明記）。

---

## 2. 個別修正

### 2.1 VERIFY-01 / A01 — 検証が群間差でなく全体平均と0を検定している

#### 現状（証拠）

`app/api/mining.py:253-276`。候補ごとに、対象設問の列をそのまま取り出して
```python
_, p_value = scipy_stats.ttest_1samp(vals, 0.0)   # :269
...
results.append({"candidateId": ..., "effectSize": round(mean, 4), ...})
```
を実行し、`verification_block["testUsed"] = "one_sample_mean"`（`:284`）と報告する。`effectSize` は**設問全体の平均**。

- 探索（classic）が返すのは「属性=高い群 と 低い群 の平均差」（`_describe_numeric` の `direction.highest_group / lowest_group / delta`）。
- 検証はその**どちらの群でもない**（設問全体）を 0 と比較している。
- アンケート設問の 1〜7 尺度で「平均が 0 か」を検定するのは**意味のない帰無仮説**であり、実質「平均≠0」で必ず有意になる。

#### 根本原因

検証が**候補のルール（どの群とどの群を比べるか）を持っていない**。IDしか渡ってこないので、評価時に対比を再構成できず、その辺にある列を0と比べている。

#### 修正方針

1. §1.1 の `estimand` を候補に持たせる（探索側が埋める）。
2. 新規 `app/algorithms/mining/verification_test.py` に `compute_estimand()` を作り、**探索と同じ対比**を評価データ上で再計算する。

```python
def compute_estimand(frame, candidate, weights=None, min_group_size=30) -> dict:
    """candidate.estimand の対比を frame 上で再計算する（探索と同一の定義）。"""
```
- classic_numeric（`mean_difference`）:
  - 属性列 `conditionLevel` / `referenceLevel` で2群に分ける（`__rowId__` を尊重、`missingPolicy` 準拠）
  - `scipy.stats.ttest_ind(a, b, equal_var=False)`（Welch）→ `testUsed = "welch_two_sample"`
  - `effect = mean(a) - mean(b)`、`ci95` は Welch の信頼区間、`cohensD`（プール標準偏差）も併記
  - `weights` があれば加重平均・加重分散で同一の形を計算（`testUsed = "weighted_welch_two_sample"`）
- classic_categorical（`proportion_difference`）:
  - 2×2表（`conditionLevel` 群 / 残り × `conditionCategory` / 残り）を作り、期待度数5未満があれば `fisher_exact`、無ければ `chi2_contingency(correction=False)` → `testUsed = "fisher_exact" | "chi2_2x2"`
  - `effect = p(条件付き) - p(非条件付き)`
- modern（`mean_difference`）: ルール一致行 vs スコープ内の補集合で同じ数値検定

3. **片側の群が `minGroupSize` 未満なら検定しない**。`{"testable": false, "reason": "INSUFFICIENT_GROUP_SIZE", "numeratorN": .., "denominatorN": ..}` を返し、BH 補正の対象から除外する（除外件数を `verification.mExcluded` に出す）。現状は `n < 5` で**黙ってスキップ**し、しかもそのまま「検証結果」として返していた（`:260-262`）。
4. 探索方向との一致を報告: `directionConsistent`（探索の `delta` の符号と評価での符号が一致するか）。`false` なら `replicationStatus: "reversed"`。
5. `verification_block` を差し替え:
   ```jsonc
   {"method":"holdout","estimand":"mean_difference","testUsed":"welch_two_sample",
    "alpha":0.05,"correction":"bh-fdr","mHypotheses":N,"mExcluded":M,
    "evaluationDataRevision":R,"candidateSetHash":"sha256:..."}
   ```
   `one_sample_mean` は**完全に削除**する（後方互換のための残置はしない。監査の受入条件が「testUsed が one_sample_mean でないこと」）。
6. `results[]`:
   ```jsonc
   {"candidateId":"...","estimand":{...},
    "effect":{"value":1.23,"ci95":[...],"cohensD":0.4,"type":"mean_difference"},
    "groupStats":[{"label":"20代","n":120,"mean":4.1,"sd":1.2},{"label":"60代","n":98,"mean":2.9,"sd":1.1}],
    "test":{"name":"welch_two_sample","statistic":..,"df":..,"pValue":..,"pAdjusted":..},
    "n":{"evaluation":218,"used":218},
    "directionConsistent":true,"replicationStatus":"replicated"|"reversed"|"not_testable"}
   ```

#### 変更ファイル

- 新規 `app/algorithms/mining/verification_test.py`（`compute_estimand`）
- `app/api/mining.py` `_verify_subgroups`（`:251-295`）
- `app/algorithms/mining/subgroup.py` `_describe_numeric` / `_test_categorical`（`estimand` を `direction` から埋める）
- 新規 `tests/unit/test_verification_estimand.py`、`tests/api/test_mining_verify_pinned.py`

#### テストと合格条件

- 合成データ（属性A/Bで設問の平均差が既知）で、検証の `effect.value` が**独立に計算した Welch の平均差と一致**する。
- `pValue` が `scipy.stats.ttest_ind(a, b, equal_var=False)` の再計算と一致し、`ttest_1samp(全体, 0)` とは**一致しない**。
- `testUsed` に `one_sample_mean` が現れない（全文検索で0件）。
- 片群 `minGroupSize` 未満の候補は `replicationStatus == "not_testable"` で、BH の `mHypotheses` に数えられない。
- 探索の `direction.delta` の符号を反転させたデータでは `directionConsistent == false` / `replicationStatus == "reversed"`。

---

### 2.2 VERIFY-02 / A02 — 候補固定と言いながら再探索している

#### 現状（証拠）

`app/api/mining.py:223-228`:
```python
if method != "cross_validation":
    sel_df = df.filter(pl.col("__rowId__").is_in(selection_ids))
    discovery = run_subgroup_mining(df=sel_df, ..., min_group_size=30,
                                    min_pct_diff=3.0, max_subgroup_levels=8, weights=req.weights)
```
直上のコメントは `# ... Never re-discover candidates here.`（`:221-222`）。ハードコードの `min_group_size=30 / min_pct_diff=3.0 / max_subgroup_levels=8` はクライアントの指定（`req.minGroupSize` など。フロントは送っている）を**無視**する。結果:
- 探索と違う設定で候補が作り直され、`candidateIds` に一致しないIDが混ざれば `:234` の「候補IDが見つかりません」で落ちる（＝ユーザーには「探索したのに検証できない」と見える）。
- 一致してしまった場合は**別物を検証している**のに成功したように見える。

#### 修正方針

1. `_verify_subgroups` から `run_subgroup_mining` の呼び出しを**完全に削除**する（交差検証ブロック `:184-199` も含む）。
2. 候補は §1.1 の候補ストアから `req.candidateSetHash` で読む。読めなければ 409。
3. クライアント送信の `minGroupSize` / `minPctDiff` / `maxSubgroupLevels` は**探索パラメータ**として扱い、検証では
   - `minGroupSize` のみ「評価時の最小群サイズ」（`testable` 判定）として使う
   - `minPctDiff` / `maxSubgroupLevels` は**無視**し、リクエストスキーマの description に非推奨と明記
4. 探索応答に `candidateSetHash` と `candidates[]`（`candidateId` + `displayLabel`）を返す。検証応答にも同じ `candidateSetHash` を返し、**探索時の値と一致することをテストで固定**する。
5. 交差検証（`method == "cross_validation"`）は、候補集合を fold 0 で固定し、各 fold の評価のみ実施する形に組み替える（VERIFY-03/A03 の解消も同時に達成できる。`stored_insights` を最後の fold で上書きしている `:196` を廃止）。

#### 変更ファイル

`app/api/mining.py` `_verify_subgroups`、`app/services/candidate_store.py`（新規）、`fullstack/frontend/src/features/mining/SubgroupMiningPage.tsx`（`runVerification` の送信内容）、`VerificationConfigModal.tsx`（文言）。

#### テストと合格条件

- 検証実行中に `run_subgroup_mining` が**呼ばれない**（`monkeypatch` で例外を投げる実装に差し替えて、検証が 200 で完了することを確認）。
- 探索→検証で `candidateSetHash` が一致する。
- 探索後にデータを変更（`dataRevision` 増加）してから検証すると、409/422 の**明示エラー**になる（黙って通らない）。
- UI文言「候補の再探索はしません」が事実になる（`VerificationConfigModal.tsx:47` の文言はそのまま維持できる）。

---

### 2.3 VERIFY-04 / A04 — 独立データの連番rowId衝突

#### 現状（証拠）

`app/api/mining.py:212-215`:
```python
evaluation_ids = eval_df["__rowId__"].to_list()
if set(all_ids) & set(evaluation_ids):
    raise BizError("VERIFICATION_SCOPE_OVERLAP", "独立データに同一rowIdが混入しています。", ...)
```
`dataset_store.assign_row_identity`（`:474-476`）は row ID 未指定のデータに `ROW-%06d` の**データセット内連番**を振る。別データセットでも 1 から始まるため、**30行以上あれば必ず衝突**し、独立検証が実質使えない。文字列一致を「同一回答者」と解釈しているのが誤り。

#### 修正方針

**同一性の単位を「rowId 文字列」から「データセット + 行」に変える。**

1. `VerificationConfig` に `independentDatasetId` は既にある（`:201-206`）。これを**必須**とし、評価側データセットを明示する。旧クライアントのように rowIds だけ送る形は 422 `VERIFICATION_CONFIG_INVALID`「独立検証には independentDatasetId が必要です」。
2. 判定を次のように置き換える:
   - `independentDatasetId == datasetId` → 422（従来どおり。同一データの使い回しは漏洩）
   - 別データセット → **rowId の文字列比較をしない**。代わりに
     - `evaluationScopeHash = scope_hash(sorted(evaluation_ids))` と `evaluationDatasetId` を検証ブロックに記録
     - 任意で `personKey`（リクエストで指定する個人識別列）が与えられた場合のみ、その値の集合の重複を**警告**として返す（`EVALUATION_KEY_OVERLAP`。ブロックはしない）
3. rowId の名前空間を応答に明示: `verification.rowIdNamespace = "dataset-scoped"`、`analysisDatasetId` / `evaluationDatasetId`。
4. 評価側の行を結果に出すときは `f"{evaluationDatasetId}:{rowId}"` の形にする（`results[].supportingRowIds` など。UIの「該当行を見る」から元データセットへ飛べるようにする）。
5. `check_row_disjoint`（`domain/verification.py:65-68`）は holdout / cross_validation の**同一データセット内**でのみ使う（独立検証では呼ばない）。

#### 変更ファイル

`app/api/mining.py:200-219`、`app/api/mining.py` の `VerificationConfig`、`app/domain/verification.py`、フロント `VerificationConfigModal.tsx`（独立データセットの選択を必須化）。

#### テストと合格条件

- 別々に作った2データセット（各100行、生成IDが両方 `ROW-000001` から始まる）で独立検証が **422 にならず 200 で完了**する。
- 同一データセットを独立データに指定 → 422（変わらず）。
- 応答の `evaluationDatasetId` が指定したデータセットIDと一致し、`evaluationScopeHash` が `scope_hash(eval_rowIds)` と一致する。

---

### 2.4 VERIFY-05 — modern 候補ハッシュの条件欠落

#### 現状（証拠）

- classic: `mining.py:151-154` — `condition` は属性名、`target` は設問名。**水準・タイプ・対比が入らない**。
- modern: `mining.py:401-402` — `str(item.get("condition", ""))`。modern の insight は `rule.conditions`（dictのリスト）を持つので、`condition` キーは**存在せず常に空文字**。
- `domain/verification.py:19-26` — 正規化も上記4項目のみ。
- さらに `mining.py:381-384` で modern の検証自体が 422 で拒否されているため、modern の `candidateSetHash` は**どのみち使えない**。

結果: 条件が異なる2つの候補集合が同じハッシュになる（衝突）／逆に、意味のないハッシュが UI に「候補N件（hash…）を固定しました」と表示される。

#### 修正方針

1. §1.1 の `candidate_set_hash` に置換（rule + estimand + revisions + scope + algorithm + parameters）。
2. classic 側（`:151-154`）を `build_pinned_candidates(...)` の戻り値に置換。
3. modern 側（`:401-402`）を `rule.conditions` の正規化JSONに置換（`item["rule"]["conditions"]` を `to_dict()` してソート）。
4. modern の `candidateSetHash` を探索応答に出す。検証は classic 検証APIに集約する（`inferenceMode == "verification"` は 422 のままにするが、メッセージを「modern候補は `/mining/subgroup` の `analysisMode=verification` に `candidateSetHash` を渡してください」に改善）。modern候補の検証有効化（`estimand = mean_difference`, ルール一致 vs 補集合）は本計画に含める。

#### テストと合格条件

- 1候補の条件を1つだけ変えた2つの候補集合でハッシュが**異なる**。
- 同じデータ・同じ設定・同じ `scopeHash` で探索を2回実行するとハッシュが**一致する**（決定的）。
- `minGroupSize` を変えると（= `parameters` が変わるので）ハッシュが変わる。※探索条件の違いは別の候補集合であるべきなので、これは意図した挙動。UIでは「探索条件を変えたら再探索」と案内する。
- modern の候補集合ハッシュに、条件文字列が**含まれている**（ハッシュ入力の正規化JSONをダンプして確認）。

---

### 2.5 WEIGHT-03 / B05 — MA集計が weightColumn を無視する（加重集計を実装）

#### 現状（証拠）

- `app/api/multi_response.py:37-43` `MultiResponseSummaryRequest` に `weightColumn` が**無い**。UIが送っても Pydantic が黙って捨てる。
- キャッシュキー（`:250-251`）にもウェイトが無い（将来フィールドを足しても重み違いの結果が衝突する）。
- `summarize_group`（`domain/multi_response.py:269-372`）は整数カウントのみ。`selectedN` / `pctRespondent` / `pctResponse` を無加重で返す。
- 比較API（`MultiResponseComparisonRequest:62-69`）にも無い。

#### 修正方針（決定事項どおり「回答者重みで加重集計を実装」）

1. **リクエスト契約**
   ```python
   class MultiResponseRequestBase(BaseModel):
       ...
       weightColumn: str | None = None
   class MultiResponseSummaryRequest(MultiResponseRequestBase): ...
   class MultiResponseComparisonRequest(MultiResponseRequestBase): ...
   ```
2. **`domain/multi_response.py`**: `summarize_group(..., weights: np.ndarray | None = None)` を追加し、カウントと**加重和を別々に**積む。
   - `selected_counts[item]`（無加重・整数。従来どおり）
   - `selected_weights[item]`（加重和）
   - `den_valid_weight = Σ_{valid} w_r`、`den_total_weight = Σ_r w_r × (その回答者の有効回答数)`
   - 出力:
     - `selectedN`（無加重。不変）
     - `selectedWeighted`（新規）
     - `pctRespondent` = `selected_weights / den_valid_weight × 100`（**加重比率に変更**）
     - `pctRespondentUnweighted`（新規）= `selected_counts / den_valid × 100`（従来の値）
     - `pctResponse` = `selected_weights / den_total_weight × 100`
   - 重みが無いとき（`weightColumn` 未指定）は `selectedWeighted == selectedN`、`pctRespondent == pctRespondentUnweighted`、`weightStatus = "not_requested"`。**既存フィールドの意味以外は形が変わらない**ので既存UIも壊れない。
3. **重み解決**: `resolve_weight_column` + `extract_weights`（`domain/survey_weight.py`。欠損コード適用済み・負値/NaN/Inf 拒否済み）を使う。不正な列・MA列・weight ロールでない列が指定された場合は `weight_unsupported_block` と同じ流儀で `weightStatus: "unsupported"` + `warnings` を返し、無加重で集計する（**落とさない**）。
   - 重み0の回答者は分母から除外し `weightZeroCount` に計上。
4. **キャッシュキー**: `(datasetId, rowIds, multiResponseGroupId, selectionHash, dataRevision, maskRevision, weightColumnId, weightsHash)`。`weightsHash` は解決後の重み配列のハッシュ（同名列でも値が違えば別）。
5. **応答**
   ```jsonc
   {"weightStatus":"applied","weightColumn":"QWEIGHT","weightColumnId":"col-..",
    "weightedN":1234.5,"weightMissingCount":12,"weightZeroCount":3,
    "items":[{"itemId":"..","label":"..","selectedN":100,"selectedWeighted":123.4,
              "pctRespondent":42.1,"pctRespondentUnweighted":40.0,"pctResponse":18.2}],
    "warnings":[{"code":"MA_WEIGHT_APPLIED","message":"回答者重みで加重集計しました（設計効果は考慮しません）。"}]}
   ```
   比率は記述統計なので設計効果の警告は不要。ただし「加重済み」であることは常に明示する。
6. **フロント**
   - `features/dataset/MultiResponseStatistics.tsx`: 加重時は `pctRespondent`（加重）と `pctRespondentUnweighted` を**併記**（加重バッジ + tooltip）。
   - `features/barchart/MultiResponseBarChart.tsx`: バーは `weightStatus=="applied"` なら加重値を採用、ツールチップに両方と `weightedN` を表示。
   - `WeightUnsupportedAlert` を MA 集計の直上にも配置（unsupported 時に表示）。
   - ウェイト列は既存の共有ストア（`app/store.ts` の weightColumn セレクタ）から供給する。新しいUIは作らない。

#### 変更ファイル

`app/api/multi_response.py`（リクエスト2種、`_summarize_multi_response`、キャッシュキー、比較API）、`app/domain/multi_response.py`、`app/api/datasets.py` は不要、フロント3ファイル。

#### テストと合格条件

- 全重み=1 → 加重と無加重が完全一致（`pctRespondent == pctRespondentUnweighted`）。
- 全重み×2 → `pctRespondent` は**不変**、`weightedN` と `selectedWeighted` が2倍。
- 重みに欠損がある列 → `weightMissingCount` に計上され、その行は分母から除外される（無加重の `den_valid` とも一致しないことを確認）。
- MA列を weightColumn に指定 → `weightStatus == "unsupported"` で 200（落ちない）。
- UIテスト（Vitest）: 加重時は加重バーと無加重値の併記が出る。

---

### 2.6 WEIGHT-04 / B04 — 補正ウェイトの倍率で p 値が激変する【未決】

#### 現状（証拠）

`app/algorithms/summaries/crosstab.py`:
```python
counts[i, j] += float(w or 0.0)                              # :207
...
inference_matrix = np.where(use_weights, counts, unweighted.astype(float))   # :283
chi2_stat, p_value, _, _ = stats.chi2_contingency(effective_matrix, correction=False)  # :311
```
重みを全部 2 倍すると χ² も 2 倍、p は小さくなる。Cramér's V は分母も同じ倍率なので不変、ASR は √k で増える（有意マーカーが増える）。つまり**同じデータなのに重みの単位だけで結論が変わる**。

#### 扱い

§1.4 のとおり**方針決定待ち**。決定後に A〜D のいずれかを実装する。決定まで本項目は着手しない（`weightType` の追加のみ先に入れる。既定 `"survey"` でも挙動は変えない）。

#### 決定後に必要になる変更（案ごとに共通）

- `crosstab.py`: 正規化または検定抑止の分岐。`statistics.inferenceMethod` を `weighted_pearson_approximation` / `descriptive_only_survey_weight` / `rao_scott_adjusted` から選ぶ。
- `warnings` の文言（「設計効果は推定しません」）は、選んだ案に応じて正確に書き直す。
- フロント `CrosstabView` の有意マーカー凡例に、重み使用時の注記を出す。
- テスト: **「重みを k 倍しても統計量・p値・有意マーク・ASR が変わらない」**（A/D 案）、または**「調査重みでは p とマークが出ない」**（B 案）を回帰条件にする。

---

### 2.7 IMPUTE-03 / E04 — 条件付き補完の説明変数分離とプレビュー＝適用

#### 現状（証拠）

1. プレビューAPIは**単一列**（`ImputePreviewRequest.column`、`api/datasets.py:1045-1049`）→ `preview_imputation(df, column=...)`（`core.py:187-204`）→ `impute_dataframe(df, columns=[column])`。
2. 適用APIは**複数列**（`ImputeRequest.columns`、`:1051-1055`）。
3. `tabdiff_impute` は `target_cols` だけで特徴行列を作る（`tabdiff.py:64-78`）。つまり**目的列が唯一の説明変数**。「他の設問の回答で条件付ける」ができない。
4. さらに `seed` と `num_steps` がプレビューと適用で同じでも、対象列の集合が違えば共分散行列が変わるので**結果が一致しない**。プレビューは「1列だけ補完した世界」、適用は「N列同時に補完した世界」。
5. カテゴリ列の補完（`tabdiff.py:239-282`）は最頻値/多項サンプルのみで、条件付けが一切ない。

#### 修正方針

**「計画（plan）」という明示的な単位を導入し、プレビューと適用が同じ plan を共有する。**

1. 新規 `app/algorithms/imputation/plan.py`
   ```python
   class ImputationPlan(BaseModel):
       datasetId: str
       dataRevision: int
       targetColumns: list[str]
       predictorColumns: list[str]
       excludedColumns: list[dict]   # [{columnId, reason}]（MA親, rowId, 重み, 非数値 等）
       strategy: str
       options: dict
       seed: int
       planHash: str

   def build_imputation_plan(df, codebook, target_columns, predictor_columns, strategy, options) -> ImputationPlan
   ```
   - `predictor_columns` 未指定時の既定 = 「`__rowId__` と目的列と MA親列と重み列を除いた全列」。
   - **目的列を説明変数に含めることは禁止**（`IMPUTATION_SELF_PREDICTOR` 422）。これが E04 の指摘そのもの。
   - 非数値の説明変数は `excludedColumns` に入れ、`PREDICTOR_CATEGORICAL_IGNORED` 警告を返す（tabdiff の条件付けは数値のみ）。
   - `planHash = sha256(canonical_json(datasetId, dataRevision, targets, predictors, strategy, options, seed))`。
2. `core.impute_dataframe(df, columns=None, strategy, options, predictors=None, plan=None)`。
3. `tabdiff_impute(df, columns, predictors=None, ...)`:
   - `feature_cols` = `predictors ∪ numeric_targets` を**データセットの列順**で並べる（決定性）。
   - 書き戻すのは `targets` のみ（`output_mask` を分離）。共分散推定・逆拡散・観測条件付け（`tabdiff.py:140-207` の `obs_idx` / `mis_idx`）は特徴行列全体で行う。
   - 説明変数に欠損がある行は、その行で観測されている座標だけで条件付けられる（既存ロジックで自然に成立）。
   - カテゴリ目的列は現行の最頻値/多項のままとし、`CATEGORICAL_CONDITIONAL_NOT_APPLIED` 警告を出す（条件付きカテゴリ補完は別バッチ）。
   - `diagnostics` に `predictorColumns` / `conditioningColumns` / `planHash` / `outputColumns` を追加。
4. **API**
   ```python
   class ImputationPlanRequest(BaseModel):
       columns: list[str]
       predictorColumns: list[str] | None = None
       strategy: str = "tabdiff"
       options: dict | None = None

   class ImputePreviewRequest(ImputationPlanRequest): pass

   class ImputeRequest(ImputationPlanRequest):
       inPlace: bool = True
       planHash: str          # プレビューの戻り値を必須化
   ```
   - `POST /impute/preview`: **選択した全列をまとめて**補完し、`perColumn[]` を返す。
     ```jsonc
     {"planHash":"...","datasetId":"...","dataRevision":3,
      "targetColumns":[...],"predictorColumns":[...],"excludedColumns":[...],
      "perColumn":[{"column":"..","beforeStats":{..},"afterStats":{..},"histogram":[..]}],
      "diagnostics":{..},"warnings":[...]}
     ```
   - `POST /impute`: `planHash` を再計算して照合。不一致 → 422 `IMPUTATION_PLAN_STALE`「プレビュー後にデータまたは設定が変わりました。もう一度プレビューしてください」。**これが「プレビューと適用が別物」を構造的に防ぐ**。
   - 単一列プレビューの旧応答形（`column/beforeStats/afterStats/histogram`）は `perColumn[0]` に加えて**トップレベルにも**残す（既存モーダルが壊れないように）。ただし新モーダルは `perColumn` を使う。
5. **フロント** `features/dataset/ImputationModal.tsx`:
   - プレビュー送信（`:122`）を `{columns: selectedCols, predictorColumns, strategy, options}` に変更（**適用と同じ列集合**）。
   - 「説明変数」セクションを追加（既定「自動（目的列以外の全列）」、詳細設定で個別選択）。
   - プレビュー結果の `planHash` を state に保持し、適用リクエスト（`:152-154`）に含める。`IMPUTATION_PLAN_STALE` を受けたら再プレビューを促す。
   - 列ごとのビフォーアフター表示は `perColumn` をタブ/アコーディオンで表示。

#### 変更ファイル

新規 `app/algorithms/imputation/plan.py`、`app/algorithms/imputation/core.py`、`app/algorithms/imputation/tabdiff.py`、`app/api/datasets.py:1045-1115`、`fullstack/frontend/src/features/dataset/ImputationModal.tsx`、型定義 `frontend/src/api/client.ts`。

#### テストと合格条件

- **同一 plan でプレビュー→適用すると、補完されたセルの値が完全一致する**（フィクスチャでハッシュ比較）。これが最重要の回帰条件。
- 目的列を `predictorColumns` に入れると 422 `IMPUTATION_SELF_PREDICTOR`。
- プレビュー後に行を追加（`dataRevision` 増加）→ 適用が 422 `IMPUTATION_PLAN_STALE`。
- 説明変数ありの補完で、補完値が説明変数と相関するデータ（例: `y = 2x + ノイズ`, y に欠損）では、説明変数なしの補完より**真値に近い**（RMSE 比較）。
- `predictorColumns` を明示指定したとき、`diagnostics.conditioningColumns` が指定どおりである。

---

### 2.8 IMPUTE-04 / E05 — 派生データセットに補完の記録が残らない

#### 現状（証拠）

`app/api/datasets.py:1128-1143`（非inPlace分岐）は `_finalize_dataset(... source_dataset_id=dataset_id)` を呼ぶだけ。`_finalize_dataset`（`:373-380`）は
- `seed_step` を `operation="import"` で作る（**補完の情報が無い**）
- `copiedMaskEntries` として**元データのマスク件数だけ**を記録する
- `mask_entries = list(source_mask.get("entries", []))` — **元データのマスクのみ**

したがって「今回どのセルをどう補完したか」が新データセットに**一切残らない**。監査の受入条件「新データの q・2行目が imputed として記録され、方法と元値nullを追跡できる」を満たさない。

#### 修正方針

1. `_mask_entries_for_impute`（`:70-99`）を2段に分ける:
   - `_imputed_cells(df_before, df_after, columns) -> list[{rowId, columnId}]`（操作IDに依存しない）
   - `_mask_entries(cells, strategy, operation_id, input_revision, mask_revision, source_dataset_id=None)`（エントリ生成）
   - inPlace 経路（`:1112-1115`）は従来どおり両方を使う。
2. `_finalize_dataset` に `derivation: dict | None = None` を追加:
   ```python
   derivation = {
       "operation": "impute",
       "params": {"columns": [...], "strategy": "tabdiff", "options": {...},
                  "inPlace": False, "sourceDatasetId": dataset_id,
                  "sourceOperationId": <元の現在op>, "sourceDataRevision": <元のrevision>,
                  "rawSemantics": "derived_creation"},
       "imputedCells": [{"rowId": "...", "columnId": "q"}, ...],   # 今回の補完
       "inheritedMaskEntries": [...],                              # 元データから継承
   }
   ```
   `_finalize_dataset` 内で:
   - `seed_step = _provenance_step(derivation["operation"], derivation["params"], ...)`
   - mask エントリ = `inheritedMaskEntries`（`inheritedFromDatasetId` を付与）+ `_mask_entries(imputedCells, strategy, seed_step["operationId"], input_revision=<新データの1>, mask_revision=1, source_dataset_id=...)`
   - `meta` に `sourceDatasetId` / `derivation: "impute"` を追加（UIから元データへ戻れるように）
3. **raw の意味**: 現行どおり派生データの `raw.parquet` は「派生作成時点の値（補完済み）」とする。これは監査が許容する条件付き（「rawの意味を明示し、元原本への導線を提供する」）ので、
   - provenance step の `params.rawSemantics = "derived_creation"` に明記
   - `GET /datasets/{id}` の応答に `sourceDatasetId` を出し、UI（データセット概要/履歴パネル）に「元データセットを開く」リンクを出す
   - 元データセット側は無変更（マスクもリビジョンも動かさない）
4. 派生データセットは 1 リビジョンしか持たないため Undo は提供しない。UIは「派生データセットのため Undo 不可（元データで操作してください）」と表示する（`canUndo=false`）。

#### 変更ファイル

`app/api/datasets.py`（`_mask_entries_for_impute` 分割、`_finalize_dataset`、`_impute_dataset`）、`app/storage/dataset_store.py`（マスクエントリの `inheritedFromDatasetId` は素通しで保存されるだけで変更不要）、`fullstack/frontend/src/features/dataset/ProvenanceHistoryPanel.tsx`。

#### テストと合格条件

- 欠損ありのデータで `inPlace=false` 補完 → 新データセットのマスクに**補完したセル数ぶんのエントリ**があり、`methodId == strategy`、`columnId == 対象列`、`createdByOperationId` が派生ステップのIDと一致する。
- 新データセットの provenance のステップが `operation == "impute"` で、`params.strategy` / `params.columns` / `params.sourceDatasetId` を持つ。
- 元データセットの `dataRevision` / `maskRevision` / マスク件数が**変化しない**。
- `GET /datasets/{新id}` に `sourceDatasetId` が入っている。

---

### 2.9 HIST-01〜04 / E07 — Undo が値しか戻さない

#### 現状（証拠）

`app/api/datasets.py:1307-1345` `_restore_revision`:

| 問題 | 該当行 | 症状 |
|---|---|---|
| H1: fingerprint 未再計算 | `:1333`（`dict(meta)` を渡す）+ `dataset_store.py:312-313`（`dataRevision` と `valuesFingerprint` のみ更新） | Undo 後のデータが操作前と同じ `fingerprint` になり、`api/summaries.py:65-67` のキャッシュキーが衝突 → **古い要約が返る** |
| H2: スキーマ未復元 | `:1333`（meta は現在のまま） | `meta.schema` / `columnCount` が操作後のまま。列を戻しても schema に無い／schema に有るのに parquet に無い列ができ、要約・分布が **500** |
| H3: マスク未復元 | `:1327-1328`（現在のマスクから「スナップショットに無い列」を除くだけ） | 補完の Undo 後も**補完マスクが残る**（列は存在するため除外されない） |
| H4: 履歴カーソル未分離 | `:1329-1334` + `dataset_store.py:334-338` | undo 操作が新しい現在操作になり、**2回目のUndoが同じ場所に戻る**（実質無効）。redo の分岐（`:1405-1454`）が複雑化 |
| H5: コードブック未復元 | `:1332` `_sync_codebook(dataset_id, snapshot, source_schema=meta["schema"])` | 列を戻してもラベル・欠損コード・カテゴリ順が戻らない（現在のコードブックから落とすだけ） |

#### 修正方針（§1.2 / §1.3 の土台を使う）

```python
def _restore_revision(dataset_id, target_revision, operation, params, expected_data, expected_schema):
    ...
    snapshot = store.read_snapshot(dataset_id, target_revision)
    state = store.read_revision_state(dataset_id, target_revision)          # 新規
    restored_codebook = store.read_revision_codebook(dataset_id, target_revision)  # 新規
    restored_mask_doc = store.read_revision_mask(dataset_id, target_revision)      # 新規
    warnings: list[str] = []

    if state is None:                      # 旧リビジョン（バックフィル前）
        warnings.append("REVISION_STATE_BACKFILLED")
        schema_payload = _derive_dataset_schema(snapshot, meta.get("schema", []))
        restored_codebook = _sync_codebook(dataset_id, snapshot, source_schema=meta.get("schema", []))
        restored_mask = [e for e in (store.load_mask(dataset_id) or {}).get("entries", [])
                         if e.get("columnId") in snapshot.columns
                         and int(e.get("inputDataRevision", 0)) < int(target_revision)]
        warnings.append("MASK_RESTORE_APPROXIMATED")
    else:
        schema_payload = state["schema"]
        restored_mask = list((restored_mask_doc or {}).get("entries", []))

    restored_meta = {**meta,
                     "schema": schema_payload,
                     "columnCount": snapshot.width - 1,
                     "rowCount": snapshot.height,
                     "schemaRevision": (restored_codebook or {}).get("schemaRevision", state["schemaRevision"] if state else meta["schemaRevision"])}
    # commit_data_change が fingerprint を必ず再計算する（§1.2.2）
    commit = store.commit_data_change(
        dataset_id, restored_meta, snapshot, codebook=restored_codebook,
        step=step, mask_entries=restored_mask, replace_mask=True,
        history_mode="navigate", cursor_operation_id=target_operation_id,
        bump_mask_revision=True)
```

- `bump_mask_revision=True` を追加し、**マスクを置換した復元では必ず `maskRevision` を +1** する（空に戻す場合も含む）。現行 `commit_data_change` は `mask_entries` が空だと `maskRevision` を増やさない（`dataset_store.py:328`）。
- `revert` で raw へ戻す場合は `restored_mask = []`（従来どおり）＋ `maskRevision` +1。
- undo/redo は §1.3 のカーソル方式に置換。`_restore_revision` に `target_operation_id` を渡す。
- 応答に `restoreWarnings` と `restoredSchemaRevision` を追加。

#### フロント

`features/dataset/ProvenanceHistoryPanel.tsx`:
- `canUndo` / `canRedo` でボタンを活性制御（現在位置に依存した不自然な有効/無効をやめる）。
- Undo/Redo 後に**スキーマ・コードブック・要約・マスクを再取得**する（`app/store.ts` の保持キャッシュも無効化）。要約は「指紋が戻る」ため、キャッシュキーに `dataRevision` を足すだけでは**取り違え**が起きうる → キャッシュキーに `dataRevision` を含める（§1.2.3）ことで必ず別エントリになる。
- 復元後に列が増減した場合に備えて、分布・クロス集計の選択列を検証し、無効な選択を落とす。

#### テストと合格条件（E07 の受入）

| # | 操作 | 期待 |
|---|---|---|
| 1 | 補完 → Undo | `dataRevision` が増え、`fingerprint` が**補完前の値と一致**。要約APIが補完前の統計を返す（古い値のキャッシュヒットが起きない） |
| 2 | 列削除 → Undo | 列が戻り、`meta.schema` の列数、codebook の `valueLabels` / `categoryOrder` / `missingCodes` も戻る |
| 3 | 補完 → Undo | マスクから補完エントリが消え、`maskRevision` が +1 |
| 4 | 3 → Redo | 補完マスクが**再付与**され、`maskRevision` がさらに +1 |
| 5 | Undo を2回 | 2段階前まで戻る（同じ状態に留まらない） |
| 6 | 任意の時点で要約・クロス集計・分布・MA集計 | すべて 200（500 を出さない）。`schema` と parquet の列が常に一致 |
| 7 | Undo → Redo → Undo を繰り返す | `operations` の監査ログ件数が単調増加し、`cursorOperationId` が期待どおり前後する |

---

## 3. 実施順序

| 段階 | 内容 | 依存 | 対象指摘 |
|---|---|---|---|
| **第0段階** | §1.2 リビジョン状態スナップショット＋fingerprint一元化＋キャッシュキー強化 / §1.3 履歴カーソル | なし | HIST の土台 |
| **第0段階b** | §1.1 候補固定（PinnedCandidate / 候補ストア / ハッシュ） | なし | VERIFY の土台 |
| **第1段階** | 検証APIの一時停止ゲート（`VERIFICATION_ENABLED=false` で 503 `VERIFICATION_TEMPORARILY_DISABLED`）。**土台完成までユーザーに誤った検証結果を出さない** | なし | VERIFY-01/02/04/05 |
| **第2段階** | VERIFY-01 → VERIFY-02 → VERIFY-05 → VERIFY-04 の順に実装し、第1段階のゲートを外す | 0b | VERIFY 系 |
| **第3段階** | HIST-01〜04（土台の上に復元処理を書き換え） | 0 | HIST 系 / E07 |
| **第4段階** | IMPUTE-03/E04（計画＋説明変数分離） → IMPUTE-04/E05（派生データのマスク・履歴） | なし（独立） | IMPUTE 系 |
| **第5段階** | WEIGHT-03/B05（加重MA集計） | なし | WEIGHT-03 |
| **第6段階** | WEIGHT-04/B04（**ユーザー方針待ち**）／UI文言・凡例・回帰スイート | 未決事項の解消 | WEIGHT-04 |

各段階は独立にPRを切る。第2段階と第3段階は同じ `datasets.py` / `mining.py` を触るため、**同時に作業しない**（競合回避）。

---

## 4. 回帰テスト一覧（新規・追加）

| テストファイル | 内容 |
|---|---|
| `backend/tests/unit/test_verification_estimand.py` | Welch/Fisher の独立再計算一致、`one_sample_mean` の非存在、群サイズ不足の扱い、方向一致判定 |
| `backend/tests/unit/test_mining_candidate.py` | ハッシュの決定性・条件差での非衝突・revision 変化での変化・modern 条件の含有 |
| `backend/tests/api/test_mining_verify_pinned.py` | 検証が再探索しない（`run_subgroup_mining` を例外化）、古いハッシュの拒否、独立データセットの rowId 衝突で落ちない |
| `backend/tests/unit/test_multi_response_weighted.py` | 重み倍率不変、全1一致、欠損除外、MA列の unsupported |
| `backend/tests/api/test_imputation_plan.py` | プレビュー＝適用のセル一致、self-predictor 422、plan stale 422、説明変数ありの RMSE 改善 |
| `backend/tests/api/test_derived_dataset_provenance.py` | 派生データのマスク件数・methodId・step params・元データ不変 |
| `backend/tests/api/test_provenance_undo_state.py` | §2.9 の受入表 1〜7 |
| `backend/tests/api/test_summary_cache_revision.py` | Undo 後に要約が古い値を返さないこと |
| `frontend/.../ImputationModal.test.tsx` | planHash の送信、stale 時の再プレビュー導線 |
| `frontend/.../MultiResponseStatistics.test.tsx` | 加重値と無加重値の併記 |

既存テストで影響を受けるもの（要更新）:
- `backend/tests/unit/test_review_bugs_b01_b12.py`（ウェイト・マスク関連。既に変更済みの可能性あり）
- `backend/tests/api/test_ma_transform_integrity.py`（MAの集計契約）
- マイニング系の e2e（`fullstack/e2e/`）で `analysisMode=verification` を使っているもの → 第1段階でゲートを入れると落ちるので、**ゲート導入と同時に更新**する。

---

## 5. 完了条件

1. 検証の `testUsed` から `one_sample_mean` が消え、探索と同じ対比（Welch / Fisher / 2x2 χ²）で再現される。
2. 検証時にマイニングが**一切再実行されない**（テストで証明）。
3. 独立データセット（別ID・連番rowId）で検証が通る。
4. 候補集合ハッシュが条件・対比・revision を含み、決定的で、衝突しない。
5. MA集計が `weightColumn` を尊重し、重みの倍率で比率が変わらない。
6. 補完のプレビューと適用が**同一セル値**を返し、説明変数が目的列と分離されている。
7. 派生データセットに、今回の補完セル・手法・元データへの参照が記録される。
8. Undo / Redo が値・スキーマ・コードブック・マスク・カーソルを一貫して復元し、どの時点でも全分析APIが 200 を返す。
9. WEIGHT-04/B04 は方針決定後に A〜D のいずれかを実装し、選んだ案の受入条件を満たす（**決定までは未修正であることを明示**）。

---

## 6. 補足：決定待ち・対象外の明示

- **WEIGHT-04/B04 は本計画の時点では修正しない**。§1.4 の土台（`weightType` の追加と `CrosstabContext` の統合）だけ先に入れ、既定 `"survey"` で**現行挙動を維持**する。したがって「重みの倍率で p 値が変わる」症状は**方針決定まで残る**。監査の受入条件を満たすのは決定後の第6段階。
- VERIFY-03/A03（交差検証が fold 0 のみ評価）は本計画の対象外だが、VERIFY-02 の改修で `_verify_subgroups` の交差検証ブロック（`mining.py:184-199`）を書き換えるため、**同時に解消するのが自然**。第2段階で併せて直すことを推奨（`stored_insights` を最後の fold で上書きする `:196` の削除）。
- 監査の「第1段階: 検証・感度分析を停止」に従い、**土台完成までは検証APIを機能フラグで停止**する。これは一時的な措置で、第2段階完了時に解除する。
