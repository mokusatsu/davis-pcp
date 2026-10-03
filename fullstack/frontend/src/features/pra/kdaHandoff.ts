import { captureAnalysisRunContext, createScopeSnapshot, type AnalysisScopeSnapshot } from '../selection/analysisScope'

/** An executed KDA result, never the subsequently edited controls. PRA asks a
 * different question (low/high asymmetry); it does not verify Shapley importance. */
export interface KdaPraHandoff {
  version: 1
  kind: 'kda-to-pra'
  sourceRunId: string
  datasetId: string
  dataRevision: number
  schemaRevision: number
  outcome: string
  drivers: string[]
  /** Requested execution rows, before listwise missing-value exclusion.
   * sourceConclusion.nValid records how many of these rows KDA fitted. */
  scopeSnapshot: AnalysisScopeSnapshot
  sourceConclusion: {
    kind: 'shapley-importance'
    method: string
    rSquared: number
    nValid: number
    drivers: Array<{ name: string; importancePct: number; direction: number }>
  }
}

export function captureKdaPraHandoff(handoff: KdaPraHandoff): KdaPraHandoff {
  return captureAnalysisRunContext(handoff)
}

/** History state may be restored or supplied by another route. Reject an
 * incomplete/unsupported contract instead of silently falling back to defaults. */
export function readKdaPraHandoff(value: unknown): KdaPraHandoff | null {
  if (!value || typeof value !== 'object') return null
  const h = value as KdaPraHandoff
  const strings = (xs: unknown): xs is string[] => Array.isArray(xs) && xs.every(x => typeof x === 'string' && x.length > 0)
  if (h.version !== 1 || h.kind !== 'kda-to-pra' || !h.sourceRunId || typeof h.sourceRunId !== 'string'
    || !h.datasetId || typeof h.datasetId !== 'string' || !Number.isInteger(h.dataRevision) || !Number.isInteger(h.schemaRevision)
    || typeof h.outcome !== 'string' || !h.outcome || !strings(h.drivers) || !h.drivers.length
    || new Set(h.drivers).size !== h.drivers.length || h.drivers.includes(h.outcome)
    || !h.scopeSnapshot || !['all', 'active', 'selected', 'sampled'].includes(h.scopeSnapshot.scope)
    || !strings(h.scopeSnapshot.rowIds) || !h.scopeSnapshot.rowIds.length
    || h.sourceConclusion?.kind !== 'shapley-importance' || typeof h.sourceConclusion.method !== 'string'
    || !Number.isFinite(h.sourceConclusion.rSquared) || !Number.isInteger(h.sourceConclusion.nValid)
    || !Array.isArray(h.sourceConclusion.drivers)
    || h.sourceConclusion.drivers.length !== h.drivers.length
    || h.sourceConclusion.drivers.some(d => !d || !h.drivers.includes(d.name) || !Number.isFinite(d.importancePct) || !Number.isFinite(d.direction))) return null
  // Reconstruct the authoritative scope key/count/context rather than trusting
  // history's display metadata. The exact rows and sampling provenance survive.
  const scopeSnapshot = createScopeSnapshot(h.scopeSnapshot.scope, h.scopeSnapshot.rowIds, h.datasetId,
    h.dataRevision, h.schemaRevision, h.scopeSnapshot.sampling)
  return captureKdaPraHandoff({ ...h, scopeSnapshot })
}

export function kdaHandoffError(handoff: KdaPraHandoff, current: {
  datasetId: string | null; dataRevision: number; schemaRevision: number; rowIds: string[]
}): string | null {
  if (handoff.datasetId !== current.datasetId || handoff.dataRevision !== current.dataRevision || handoff.schemaRevision !== current.schemaRevision) {
    return 'KDA実行時のデータセット・データ世代と一致しません。元のKDAを再実行して送り直すか、引継ぎを解除してください。'
  }
  const availableRows = new Set(current.rowIds)
  if (handoff.scopeSnapshot.rowIds.some(id => !availableRows.has(id))) {
    return 'KDA実行時の対象行を現在のデータで利用できません。元のKDAを再実行して送り直すか、引継ぎを解除してください。'
  }
  return null
}
