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
  pValue: number | null
  df?: number | null
  permutations?: number | null
  /** Benjamini–Hochberg adjusted p; null when the candidate was not testable. */
  pAdjusted: number | null
  significant: boolean
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
  replicationStatus: VerificationReplication
  warnings: { code: string; message: string }[]
}

export interface VerificationFold {
  fold: number
  nEvaluation: number
  testableCount: number
  effects: { candidateId: string; effect: number | null }[]
}

export interface VerificationInfo {
  method: string
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
  replicated: '再現',
  reversed: '方向反転',
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
