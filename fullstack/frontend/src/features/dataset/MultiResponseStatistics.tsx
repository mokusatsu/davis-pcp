import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { Alert, Col, Pagination, Row, Spin } from 'antd'
import { api, type MultiResponseSummaryResponse } from '../../api/client'
import { selectVariableEntities, selectionApplied, type RootState } from '../../app/store'
import { useCodebook } from './useCodebookColumn'
import MultiResponseCard from '../distribution/MultiResponseCard'
import { getBrushOp } from '../selection/SelectionMenu'

export default function MultiResponseStatistics({ rowIds }: { rowIds: string[] }) {
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const selection = useSelector((s: RootState) => s.selection)
  const entities = useSelector(selectVariableEntities)
  const { schemaRevision, isLoading } = useCodebook()
  const groups = entities.items.flatMap(item => item.entity.kind === 'ma' && entities.selected.has(item.key) ? [item.entity.groupId] : [])
  const [page, setPage] = useState(1)
  const currentPage = Math.min(page, Math.max(1, Math.ceil(groups.length / 12)))
  const groupIds = groups.slice((currentPage - 1) * 12, currentPage * 12)
  const key = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, rowIds, groupIds])
  const currentKey = useRef(key)
  currentKey.current = key
  const [result, setResult] = useState<{ key: string; value: MultiResponseSummaryResponse } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [matching, setMatching] = useState(false)
  const matchVersion = useRef(0)
  useEffect(() => {
    setMatching(false)
    return () => { matchVersion.current++ }
  }, [key])
  useEffect(() => { setPage(1) }, [selection.datasetId])
  useEffect(() => {
    if (!selection.datasetId || !groupIds.length || isLoading) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void api.post<MultiResponseSummaryResponse>('/summaries/multi-response', {
      datasetId: selection.datasetId, groupIds, rowIds, selectedRowIds: selection.selectedRowIds,
      expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
    }).then(value => { if (!cancelled) setResult({ key, value }) })
      .catch(error => { if (!cancelled) setError(error.message || 'MA集計に失敗しました。') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [key, selection.selectedRowIds, isLoading])

  const select = async (groupId: string, optionColumnIds: string[], predicate: string, status?: string, goToPcp?: boolean) => {
    const version = ++matchVersion.current
    const operation = getBrushOp()
    setMatching(true)
    setError(null)
    try {
      const matched = await api.post<{ rowIds: string[] }>(`/datasets/${selection.datasetId}/matches`, {
        groupId, optionColumnIds, predicate, status, rowIds,
        expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
      })
      if (version !== matchVersion.current || currentKey.current !== key) return
      dispatch(selectionApplied({ rowIds: matched.rowIds, operation, label: `MA: ${groupId}` }))
      if (goToPcp) navigate('/pcp')
    } catch (error) {
      if (version === matchVersion.current && currentKey.current === key) setError(error instanceof Error ? error.message : '回答者の選択に失敗しました。')
    } finally { if (version === matchVersion.current) setMatching(false) }
  }
  if (!groups.length) return null
  return <section aria-label="複数回答の記述統計">
    {error && <Alert type="error" showIcon message={error} />}
    {loading && <Spin />}
    <Row gutter={[16, 16]}>{result?.key === key && result.value.groups.map(summary => <Col key={summary.groupId} xs={24} lg={12}>
      <MultiResponseCard summary={summary} loading={matching}
        onSelect={(ids, predicate, status, goToPcp) => void select(summary.groupId, ids, predicate, status, goToPcp)} />
    </Col>)}</Row>
    {groups.length > 12 && <Pagination current={currentPage} pageSize={12} total={groups.length} showSizeChanger={false} onChange={setPage} />}
  </section>
}
