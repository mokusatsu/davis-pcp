import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Pagination, Progress, Radio, Select, Space, Spin, Typography } from 'antd'
import { useDispatch, useSelector } from 'react-redux'
import { api, type MultiResponseSummary, type MultiResponseSummaryResponse } from '../../api/client'
import { selectEffectiveRowIds, selectVariableEntities, selectionApplied, type RootState } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import { getBrushOp } from '../selection/SelectionMenu'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'

interface Comparison {
  attributeMissingExcluded: number
  strata: { code: string; label: string; summary: MultiResponseSummary }[]
}

export default function MultiResponseBarChart() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const entities = useSelector(selectVariableEntities)
  const rowIds = useSelector(selectEffectiveRowIds)
  const { columns, schemaRevision, isLoading } = useCodebook()
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key))
  const [groupKey, setGroupKey] = useState('')
  const group = groups.find(item => item.key === groupKey) ?? groups[0]
  const groupId = group?.entity.kind === 'ma' ? group.entity.groupId : ''
  const attributes = columns.filter(col => col.role === 'attribute' && !col.multiResponseGroup && !['id', 'text'].includes(col.scaleType))
  const [attributeId, setAttributeId] = useState('')
  const attribute = attributes.find(col => col.columnId === attributeId)
  const [mode, setMode] = useState<'count' | 'percent'>('count')
  const [page, setPage] = useState(1)
  const [strataPage, setStrataPage] = useState(1)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{ key: string; value: Comparison } | null>(null)
  const [loading, setLoading] = useState(false)
  const [matching, setMatching] = useState(false)
  const [error, setError] = useState('')
  const key = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, rowIds, groupId, attribute?.columnId])
  const currentKey = useRef(key)
  currentKey.current = key
  const version = useRef(0)
  useEffect(() => { setPage(1); setStrataPage(1); setMatching(false); return () => { version.current++ } }, [key])
  useEffect(() => {
    if (!groupId || !selection.datasetId || isLoading) return
    let cancelled = false
    setLoading(true)
    setError('')
    const body = { datasetId: selection.datasetId, rowIds, selectedRowIds: selection.selectedRowIds,
      expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision }
    const request = attribute
      ? api.post<Comparison>('/summaries/multi-response/comparison', { ...body, groupId, attributeColumnId: attribute.columnId })
      : api.post<MultiResponseSummaryResponse>('/summaries/multi-response', { ...body, groupIds: [groupId] })
        .then(value => ({ attributeMissingExcluded: 0, strata: value.groups.map(summary => ({ code: '', label: '全体', summary })) }))
    void request.then(value => { if (!cancelled) setResult({ key, value }) })
      .catch(error => { if (!cancelled) { setResult(null); setError(error.message || 'MA集計に失敗しました。') } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [key, selection.selectedRowIds, isLoading, retry])

  const select = async (columnId: string, code: string) => {
    const requestVersion = ++version.current
    const operation = getBrushOp()
    setMatching(true)
    setError('')
    try {
      const result = await api.post<{ rowIds: string[] }>(`/datasets/${selection.datasetId}/matches`, {
        groupId, optionColumnIds: [columnId], predicate: 'any', rowIds,
        attributeFilter: attribute ? { columnId: attribute.columnId, code } : undefined,
        expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
      })
      if (currentKey.current === key && version.current === requestVersion)
        dispatch(selectionApplied({ rowIds: result.rowIds, operation, label: `MA: ${groupId}` }))
    } catch (error) {
      if (currentKey.current === key && version.current === requestVersion) setError(error instanceof Error ? error.message : '選択に失敗しました。')
    } finally { if (version.current === requestVersion) setMatching(false) }
  }
  if (!groups.length) return null
  const value = result?.key === key ? result.value : null
  const options = value?.strata[0]?.summary.items ?? []
  const currentPage = Math.min(page, Math.max(1, Math.ceil(options.length / 20)))
  const visible = options.slice((currentPage - 1) * 20, currentPage * 20)
  const currentStrataPage = Math.min(strataPage, Math.max(1, Math.ceil((value?.strata.length ?? 0) / 10)))
  const visibleStrata = value?.strata.slice((currentStrataPage - 1) * 10, currentStrataPage * 10) ?? []
  const maxCount = value?.strata.reduce((maximum, stratum) => stratum.summary.items.reduce((maximum, item) => Math.max(maximum, item.selectedN), maximum), 1) ?? 1
  return <FocusTarget id="ma-barchart" title="複数回答の棒グラフ"><Card size="small" title="複数回答の棒グラフ" data-testid="ma-barchart"
    extra={!focused && <FocusEnterButton targetId="ma-barchart" title="複数回答の棒グラフ" />}>
    <Space wrap style={{ marginBottom: 12 }}>
      <span>対象設問:</span><Select size="small" aria-label="MA対象設問" style={{ width: 220 }} value={group?.key}
        options={groups.map(item => ({ value: item.key, label: item.label }))} onChange={setGroupKey} />
      <span>比較属性:</span><Select size="small" aria-label="MA比較属性" allowClear placeholder="なし（全体）" style={{ width: 180 }}
        value={attribute?.columnId} options={attributes.map(col => ({ value: col.columnId, label: `${col.name} — ${col.label || col.name}` }))}
        onChange={value => setAttributeId(value || '')} />
      <Radio.Group size="small" optionType="button" buttonStyle="solid" value={mode} onChange={event => setMode(event.target.value)}
        options={[{ label: '人数', value: 'count' }, { label: '選択率 (%)', value: 'percent' }]} />
    </Space>
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => setRetry(value => value + 1)}>再試行</Button>} />}
    {loading && <Spin />}
    {value && <Typography.Paragraph type="secondary">各群の有効回答者を分母に集計します。比較属性の欠損除外: {value.attributeMissingExcluded}人</Typography.Paragraph>}
    {value && !options.length && <Empty description="集計対象がありません" />}
    {value && value.strata.length > 10 && <Space style={{ marginBottom: 12 }}><span>比較カテゴリ</span>
      <Pagination size="small" current={currentStrataPage} pageSize={10} total={value.strata.length} showSizeChanger={false} onChange={setStrataPage} />
    </Space>}
    {visible.map(option => <div key={option.columnId} style={{ marginBottom: 16 }}>
      <Typography.Text strong>{option.name} {option.label}</Typography.Text>
      {visibleStrata.map(stratum => {
        const item = stratum.summary.items.find(item => item.columnId === option.columnId)!
        return <div key={stratum.code} style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
          <span style={{ width: 130, flexShrink: 0 }}>{stratum.label}（有効{stratum.summary.denominators.valid}人）</span>
          <button type="button" disabled={matching || loading || !item.selectedN} aria-label={`${option.name} ${stratum.label}の回答者を選択`}
            onClick={() => void select(item.columnId, stratum.code)} style={{ flex: 1, border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }}>
            <Progress percent={mode === 'percent' ? item.pctRespondent ?? 0 : item.selectedN / maxCount * 100} showInfo={false}
              strokeColor="#cbd5e1" success={{ percent: mode === 'percent' ? item.selectedInSelection / Math.max(1, stratum.summary.denominators.valid) * 100 : item.selectedInSelection / maxCount * 100, strokeColor: '#1677ff' }} />
          </button>
          <span style={{ width: 205 }}>{item.selectedN}人 / {item.pctRespondent == null ? '—（分母0）' : `${item.pctRespondent.toFixed(1)}%`} ・ 選択中{item.selectedInSelection}人</span>
        </div>
      })}
    </div>)}
    {options.length > 20 && <Pagination size="small" current={currentPage} pageSize={20} total={options.length} showSizeChanger={false} onChange={setPage} />}
  </Card></FocusTarget>
}
