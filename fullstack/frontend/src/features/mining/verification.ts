/**
 * Contract for pinned-candidate verification.
 *
 * Exploration pins the candidates it found and returns a `candidateSetHash`;
 * verification loads that set and re-tests each candidate's *own* contrast
 * (mean difference, proportion difference or Kendall τ difference) on the
 * evaluation partition. Nothing is re-discovered, so a candidate the server
 * could not pin is simply absent from `results`.
 *
 * Not every pinned candidate can be tested — the evaluation split may leave a
 * group below the minimum size, or a column may be missing. Those come back
 * with `testable: false` and a `reason` instead of an estimate, so `test` and
 * `effect` are nullable and reading them unconditionally is a bug.
 */

export interface VerificationGroupStat {
  label: string
  n: number
  mean?: number | null
  sd?: number | null
  /** Proportion candidates report a percentage where the mean would go. */
  pct?: number | null
}

export interface VerificationEffect {
  estimate: number | null
  ci95: [number, number] | null
  meanA?: number | null
  meanB?: number | null
  nA?: number | null
  nB?: number | null
  varA?: number | null
  varB?: number | null
  cohensD?: number | null
  /** Proportion candidates: the two cell proportions being contrasted. */
  pRow?: number | null
  pOther?: number | null
  contingency?: number[][]
  groupStats?: VerificationGroupStat[]
  weighted?: boolean
  [key: string]: unknown
}

export interface VerificationTest {
  name: string | null
  statistic: number | null
  pValue?: number | null
  df?: number | null
  permutations?: number | null
  /** Suppressed for posthoc stability and unavailable independent inference. */
  pAdjusted?: number | null
  significant?: boolean | null
}

export type VerificationReplication = 'replicated' | 'reversed' | 'not_comparable' | 'not_testable'

export interface VerificationResultItem {
  candidateId: string
  estimand: Record<string, unknown>
  testable: boolean
  /** The machine-readable reason the candidate could not be tested. */
  reason: string | null
  detail?: Record<string, unknown>
  effect: VerificationEffect | null
  test: VerificationTest | null
  n: { evaluation: number; used: number }
  /** Whether the evaluation split reproduced the exploration's direction. */
  directionConsistent: boolean | null
  replicationStatus?: VerificationReplication | null
  warnings: { code: string; message: string }[]
}

export interface VerificationFold {
  fold: number
  nEvaluation: number
  testableCount: number
  effects: {
    candidateId: string
    effect: number | null
    testable?: boolean
    n?: { evaluation: number; used: number }
    reason?: string | null
  }[]
}

export interface VerificationInfo {
  method: string
  /** Holdout/CV reuse exploration data; they do not provide independent inference. */
  stabilityMode?: 'posthoc_stability' | null
  /** One entry per test actually used across the family, not a single name. */
  testUsed: string[]
  estimand: string
  alpha: number
  correction: string
  mHypotheses: number
  mExcluded: number
  excludedCandidateIds: string[]
  seed: number
  nSelection: number
  nEvaluation: number
  selectionScopeHash: string
  evaluationScopeHash: string
  analysisDatasetId: string
  evaluationDatasetId: string
  rowIdNamespace: string
  candidateSetHash: string
  pinnedCandidateIds: string[]
  pinnedCandidateCount: number
  explorationScopeHash: string
  explorationDataRevision: number
  minGroupSize: number
  note?: string
  folds?: VerificationFold[]
}

export interface PinnedCandidateSummary {
  candidateId: string
  displayLabel: string
  estimand: Record<string, unknown>
}

export const REPLICATION_LABEL: Record<VerificationReplication, string> = {
  replicated: '探索と方向一致',
  reversed: '探索と方向反転',
  not_comparable: '比較不可',
  not_testable: '検定不可',
}

export const REPLICATION_COLOR: Record<VerificationReplication, string> = {
  replicated: 'green',
  reversed: 'red',
  not_comparable: 'orange',
  not_testable: 'default',
}

export const METHOD_LABEL: Record<string, string> = {
  holdout: 'ホールドアウト分割',
  cross_validation: '交差検証',
  independent: '独立データ',
}

/** The server explains an untestable candidate in `warnings`; fall back to the code. */
export function untestableReason(item: VerificationResultItem): string {
  const message = item.warnings?.[0]?.message
  if (message) return message
  return item.reason ? `${item.reason}（検定できません）` : '検定できません。'
}

/** Verification findings live under `test`; exploration deliberately has none. */
export function verificationFor(
  results: VerificationResultItem[] | null | undefined,
  candidateId: string,
): VerificationResultItem | null {
  return results?.find((item) => item.candidateId === candidateId) ?? null
}

/** Use the completed response, never the current settings or truthiness of null. */
export function isPosthocStability(info: VerificationInfo | null | undefined): boolean {
  return info?.stabilityMode === 'posthoc_stability'
    || info?.method === 'holdout' || info?.method === 'cross_validation'
}

export function isIndependentInference(info: VerificationInfo | null | undefined): boolean {
  return info?.method === 'independent' && !isPosthocStability(info)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isPValue(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

/** An estimate can exist even when inference cannot be calculated. */
export function hasAdjustedInference(info: VerificationInfo | null | undefined, item: VerificationResultItem): boolean {
  return isIndependentInference(info) && item.testable
    && isPValue(item.test?.pValue) && isPValue(item.test?.pAdjusted)
}

export function verificationIntervalLabel(info: VerificationInfo | null | undefined): string {
  const level = isFiniteNumber(info?.alpha) && info.alpha > 0 && info.alpha < 1
    ? `${Number(((1 - info.alpha) * 100).toFixed(6))}% CI` : '区間推定'
  return `差の${level}${isIndependentInference(info) ? '' : '（参考）'}`
}

export function verificationListSummary(info: VerificationInfo | null, item: VerificationResultItem | null): string {
  if (!item) return '評価対象外'
  if (!item.testable) return `評価できません（${item.reason ?? '理由不明'}）`
  if (hasAdjustedInference(info, item)) {
    const direction = item.replicationStatus ? REPLICATION_LABEL[item.replicationStatus] : null
    return `p=${item.test!.pValue} adj=${item.test!.pAdjusted}${direction ? `（${direction}）` : ''}`
  }
  const estimate = isFiniteNumber(item.effect?.estimate) ? item.effect.estimate.toFixed(4) : '算出不可'
  return `${isPosthocStability(info) ? '安定性確認' : '参考評価'}: 点推定 ${estimate}／評価 ${item.n.used}行`
}
