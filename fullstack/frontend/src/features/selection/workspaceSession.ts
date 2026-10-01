import { type AnalysisWorkspaceSnapshot, type RootState } from '../../app/store'
import { captureAnalysisRunContext } from './analysisScope'

/** Additive save fields keep existing session consumers intact; no inferred legacy migration. */
export function createAnalysisWorkspaceSnapshot(state: RootState): AnalysisWorkspaceSnapshot {
  if (!state.selection.datasetId) throw new Error('データセットがありません。')
  return captureAnalysisRunContext({ workspaceVersion: 1, datasetId: state.selection.datasetId,
    dataRevision: state.selection.dataRevision, schemaRevision: state.codebook.schemaRevision,
    activeRowIds: state.selection.activeRowIds, selectedRowIds: state.selection.selectedRowIds,
    groups: state.selection.groups, globalVariables: state.globalVariables,
    globalObservations: state.globalObservations })
}

/** Validate completely before a single restore dispatch; a missing record is never guessed. */
export function readAnalysisWorkspaceSnapshot(value: unknown, current: RootState): AnalysisWorkspaceSnapshot {
  const s = value as AnalysisWorkspaceSnapshot | null
  if (!s || s.workspaceVersion !== 1 || !s.globalObservations || !s.globalVariables)
    throw new Error('このセッションには共通分析対象の完全な記録がありません。現在の設定を保持しました。')
  if (s.datasetId !== current.selection.datasetId || s.dataRevision !== current.selection.dataRevision || s.schemaRevision !== current.codebook.schemaRevision)
    throw new Error('保存時のデータセットまたは世代と一致しません。現在の設定を保持しました。')
  const known = new Set(current.selection.allRowIds)
  const validRows = (rows: unknown): rows is string[] => Array.isArray(rows) && rows.every(id => typeof id === 'string' && known.has(id)) && new Set(rows).size === rows.length
  if (!validRows(s.activeRowIds) || !validRows(s.selectedRowIds) || !Array.isArray(s.groups)
    || s.groups.some(group => !validRows(group.rowIds)) || !s.globalObservations.sampling
    || !validRows(s.globalObservations.sampling.sampledRowIds)
    || !['all', 'active', 'selected', 'sampled'].includes(s.globalObservations.scopeMode))
    throw new Error('保存した対象行の記録が現在のデータと一致しません。')
  const active = new Set(s.activeRowIds)
  if (s.selectedRowIds.some(id => !active.has(id))) throw new Error('保存した選択行がActiveの範囲外です。')
  const sampling = s.globalObservations.sampling
  if (sampling.enabled && (sampling.datasetId && sampling.datasetId !== s.datasetId))
    throw new Error('標本が別のデータセットのものです。')
  if (sampling.enabled || sampling.sampledRowIds.length) {
    const rows = sampling.sampledRowIds
    const weights = sampling.sampledRowWeights
    if (sampling.method !== 'without_replacement' || !sampling.enabled || !rows.length
      || !Number.isSafeInteger(sampling.seed) || (sampling.seed ?? -1) < 0
      || !['all', 'active'].includes(sampling.sourceScope ?? '') || !sampling.sourceScopeHash || !sampling.sourceOrderHash
      || !Number.isInteger(sampling.sourceRowCount) || (sampling.sourceRowCount ?? 0) < rows.length
      || sampling.datasetId !== s.datasetId || !Number.isInteger(sampling.dataRevision) || !Number.isInteger(sampling.schemaRevision)
      || !weights || Object.keys(weights).length !== rows.length || rows.some(id => weights[id] !== 1))
      throw new Error('標本の抽出元・シード・世代・重みの完全な記録がありません。現在の設定を保持しました。')
  }
  if (s.globalObservations.scopeMode === 'sampled' && !sampling.enabled)
    throw new Error('標本が未作成です。現在の設定を保持しました。')
  const columns = new Set(current.codebook.columns.map(column => column.columnId))
  const groups = new Set(current.codebook.multiResponseGroups.map(group => group.groupId))
  if (s.globalVariables.datasetId !== s.datasetId || (s.globalVariables.activeEntities !== null &&
    (!Array.isArray(s.globalVariables.activeEntities) || s.globalVariables.activeEntities.some(entity =>
      entity.kind === 'column' ? !columns.has(entity.columnId) : entity.kind !== 'ma' || !groups.has(entity.groupId)))))
    throw new Error('保存した使用変数が現在のデータと一致しません。')
  return captureAnalysisRunContext(s)
}
