import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import { Typography } from 'antd'
import { selectEffectiveRowIds, type RootState, type SamplingConfig } from '../../app/store'

export type ObservationScope = 'all' | 'active' | 'selected' | 'sampled'
export interface ScopeContextRows {
  scope: ObservationScope
  rowIds?: string[]
  activeRowIds?: string[]
  selectedRowIds?: string[]
  sampledRowIds?: string[]
}
export interface AnalysisScopeSnapshot {
  scope: ObservationScope
  rowIds: string[]
  scopeKey: string
  label: string
  count: number
  contextRows: ScopeContextRows
  sampling?: SamplingConfig
}
const LABELS: Record<ObservationScope, string> = {
  all: '全体 (All)', active: '作業中の行 (Active)', selected: '選択中の行 (Selected)', sampled: '標本 (Sampled)',
}

/** Copies the resolved rows once. Highlight changes never mutate a submitted context. */
export function createScopeSnapshot(scope: ObservationScope, rows: string[], datasetId: string | null,
  dataRevision: number, schemaRevision: number, sampling?: SamplingConfig): AnalysisScopeSnapshot {
  const rowIds = [...new Set(rows)]
  const contextRows: ScopeContextRows = scope === 'all' ? { scope }
    : scope === 'active' ? { scope, activeRowIds: [...rowIds] }
      : scope === 'selected' ? { scope, selectedRowIds: [...rowIds] }
        : { scope, sampledRowIds: [...rowIds] }
  // Membership order is irrelevant for input equality. Preserve original row order in payloads.
  const scopeKey = JSON.stringify([datasetId, dataRevision, schemaRevision, scope, [...rowIds].sort(),
    scope === 'sampled' && sampling ? [sampling.sampleId, sampling.seed, sampling.sourceScopeHash, sampling.sourceOrderHash] : null])
  return { scope, rowIds, scopeKey, contextRows, label: LABELS[scope], count: rowIds.length,
    ...(scope === 'sampled' && sampling ? { sampling: captureAnalysisRunContext(sampling) } : {}) }
}

export function useAnalysisScope(): AnalysisScopeSnapshot {
  const scope = useSelector((s: RootState) => s.globalObservations?.scopeMode ?? 'active')
  const rows = useSelector(selectEffectiveRowIds)
  const sampling = useSelector((s: RootState) => scope === 'sampled' ? s.globalObservations.sampling : undefined)
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  return useMemo(() => createScopeSnapshot(scope, rows, datasetId, dataRevision, schemaRevision, sampling),
    [scope, rows, datasetId, dataRevision, schemaRevision, sampling])
}

/** Analysis contexts are JSON DTOs; copy nested algorithm/weight fields too. */
export function captureAnalysisRunContext<T>(context: T): T {
  return typeof structuredClone === 'function' ? structuredClone(context) : JSON.parse(JSON.stringify(context)) as T
}

export function AnalysisScopeSummary({ snapshot, label = '共通対象' }: { snapshot?: AnalysisScopeSnapshot | null; label?: string }) {
  const current = useAnalysisScope()
  const activeRows = useSelector((s: RootState) => s.selection.activeRowIds)
  const outsideActive = useMemo(() => {
    const active = new Set(activeRows)
    return current.rowIds.reduce((count, id) => count + (active.has(id) ? 0 : 1), 0)
  }, [current.rowIds, activeRows])
  return <Typography.Text type="secondary" data-testid="analysis-scope-summary">
    {label}: {current.label} {current.count}行（上部で変更）
    {outsideActive > 0 && <> / Active外{outsideActive}行は表示のみ。選択操作には全復帰してください</>}
    {snapshot && <> / この結果: {snapshot.label} {snapshot.count}行
      {snapshot.sampling && <> / seed {snapshot.sampling.seed ?? '未記録'}・抽出元{snapshot.sampling.sourceRowCount ?? '未記録'}行</>}
      {snapshot.scopeKey !== current.scopeKey && '・現在の対象と異なります。再実行すると更新されます'}
    </>}
  </Typography.Text>
}

/** Run identity ignores brush/scope changes; only a newer run or dataset revision supersedes it. */
export function useScopedRun(inputKey = '') {
  const scope = useAnalysisScope()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const identity = JSON.stringify([datasetId, dataRevision, schemaRevision])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const sequence = useRef(0)
  const [submitted, setSubmitted] = useState<{ scope: AnalysisScopeSnapshot; inputKey: string } | null>(null)
  useEffect(() => { sequence.current++; setSubmitted(null) }, [identity])
  useEffect(() => () => { sequence.current++ }, [])
  const begin = (overrideScope?: AnalysisScopeSnapshot) => {
    const version = ++sequence.current
    const capturedScope = captureAnalysisRunContext(overrideScope ?? scope)
    const isCurrent = () => version === sequence.current && identity === currentIdentity.current
    return { scope: capturedScope, isCurrent, commit: () => {
      if (isCurrent()) setSubmitted({ scope: capturedScope, inputKey })
    } }
  }
  return { scope, snapshot: submitted?.scope ?? null, begin, identity,
    dirty: submitted !== null && (submitted.scope.scopeKey !== scope.scopeKey || submitted.inputKey !== inputKey) }
}

/** Standalone views are active by default; KeepAlive provides activity for its cached tabs. */
export const AnalysisViewActivityContext = createContext(true)
export function useAnalysisViewActive(_path?: string) {
  return useContext(AnalysisViewActivityContext)
}
