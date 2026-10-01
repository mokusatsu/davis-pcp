import { useAnalysisViewActive } from '../selection/analysisScope'
import CategoryBars from '../charts/CategoryBars'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Pagination, Radio, Space, Spin, Tooltip, Typography } from 'antd'
import Select from '../common/ColumnSelect'
import { useDispatch, useSelector } from 'react-redux'
import { api, type MultiResponseSummary, type MultiResponseSummaryResponse, type MultiResponseWeight } from '../../api/client'
import { selectEffectiveRowIds, selectVariableEntities, selectionApplied, type RootState } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import { getBrushOp } from '../selection/SelectionMenu'
import GraphPanel from '../common/GraphPanel'
import WeightUnsupportedAlert from '../common/WeightUnsupportedAlert'

interface Comparison extends MultiResponseWeight {
  attributeMissingExcluded: number
  strata: { code: string; label: string; summary: MultiResponseSummary }[]
}

const formatWeight = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 })

const weightNote = (weight: Comparison | null, summary: MultiResponseSummary): string | null => {
  if (weight?.weightStatus !== 'applied') return null
  return [
    `回答者重み ${weight.weightColumn ?? ''} で加重集計`,
    `加重N ${formatWeight(weight.weightedN ?? 0)}`,
    `有効回答者の重み合計 ${formatWeight(summary.weightedValidN ?? 0)}`,
    '設計効果は考慮しません',
  ].join(' / ')
}

export default function MultiResponseBarChart() {
  const dispatch = useDispatch()
  const viewActive = useAnalysisViewActive()
  const selection = useSelector((s: RootState) => s.selection)
  const entities = useSelector(selectVariableEntities)
  const rowIds = useSelector(selectEffectiveRowIds)
  const { columns, schemaRevision, isLoading } = useCodebook()
  const weightColumnId = useSelector((s: RootState) => s.globalVariables.weightColumnId)
  const weightName = columns.find(column => column.columnId === weightColumnId)?.name
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key))
  const maGroups = useSelector((s: RootState) => s.codebook.datasetId === s.selection.datasetId ? s.codebook.multiResponseGroups : [])
  const [groupKey, setGroupKey] = useState('')
  const group = groups.find(item => item.key === groupKey) ?? groups[0]
  const groupId = group?.entity.kind === 'ma' ? group.entity.groupId : ''
  const groupOptions = groups.map(item => {
    const id = item.entity.kind === 'ma' ? item.entity.groupId : ''
    const detail = maGroups?.find(g => g.groupId === id)
    const members = columns.filter(col => col.multiResponseGroup === id)
    const memberCount = detail?.optionOrder?.length || members.length
    const memberLabels = members
      .map(col => col.multiResponseOptionLabel?.trim() || col.label?.trim() || col.name)
      .filter(label => label)
    // 設問文は所属列のラベルから復元する。同一設問の選択肢は「共通の設問文＋【選択肢名】」
    // 形式のため、最長共通接頭辞が設問文に相当する。
    const prefixOf = (a: string, b: string) => {
      let i = 0
      while (i < a.length && i < b.length && a[i] === b[i]) i++
      return a.slice(0, i)
    }
    const questionStem = memberLabels.length
      ? memberLabels.reduce((prefix, label) => prefixOf(prefix, label)).replace(/【[^】]*$/, '').trim()
      : ''
    const questionText = item.label !== id
      ? `${item.label}（${memberCount}件）`
      : questionStem ? `${questionStem}（${memberCount}件）` : memberLabels.length ? `選択肢: ${memberLabels.join(' / ')}` : undefined
    return { value: item.key, label: item.label, questionName: id, questionText }
  })
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
  const key = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, rowIds, groupId, attribute?.columnId, weightName ?? null])
  const currentKey = useRef(key)
  currentKey.current = key
  const version = useRef(0)
  useEffect(() => { setPage(1); setStrataPage(1); setMatching(false); return () => { version.current++ } }, [key])
  useEffect(() => {
    if (!viewActive) return
    if (!groupId || !selection.datasetId || isLoading) return
    let cancelled = false
    setLoading(true)
    setError('')
    const body = { datasetId: selection.datasetId, rowIds, selectedRowIds: selection.selectedRowIds,
      ...(weightName ? { weightColumn: weightName } : {}),
      expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision }
    const request = attribute
      ? api.post<Comparison>('/summaries/multi-response/comparison', { ...body, groupId, attributeColumnId: attribute.columnId })
      : api.post<MultiResponseSummaryResponse>('/summaries/multi-response', { ...body, groupIds: [groupId] })
        .then(value => ({ ...value, attributeMissingExcluded: 0,
          strata: value.groups.map(summary => ({ code: '', label: '全体', summary })) }))
    void request.then(value => { if (!cancelled) setResult({ key, value }) })
      .catch(error => { if (!cancelled) { setResult(null); setError(error.message || 'MA集計に失敗しました。') } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [viewActive, key, selection.selectedRowIds, isLoading, retry])

  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(300)
  useLayoutEffect(() => {
    const node = contentRef.current
    if (!node) return
    const measure = () => { if (node.offsetHeight > 0) setContentHeight(node.offsetHeight) }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    measure()
    return () => observer?.disconnect()
  }, [Boolean(groups.length)])

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
  // Bars follow the weighted totals once a survey weight applies, so the
  // scale has to come from the same quantity the bars are drawn from.
  const weighted = value?.weightStatus === 'applied'
  const barValue = (item: MultiResponseSummary['items'][number]) =>
    weighted ? item.selectedWeighted ?? 0 : item.selectedN
  const maxValue = value?.strata.reduce((maximum, stratum) =>
    stratum.summary.items.reduce((maximum, item) => Math.max(maximum, barValue(item)), maximum), 1) ?? 1
  const maControls = (
    <Space wrap style={{ marginBottom: 12 }}>
      <span>対象設問:</span><Select size="small" aria-label="MA対象設問" style={{ width: 220 }} value={group?.key}
        options={groupOptions} onChange={setGroupKey} />
      <span>比較属性:</span><Select size="small" aria-label="MA比較属性" allowClear placeholder="なし（全体）" style={{ width: 180 }}
        value={attribute?.columnId} options={attributes.map(col => ({ value: col.columnId }))}
        onChange={value => setAttributeId(value || '')} />
      <Radio.Group size="small" optionType="button" buttonStyle="solid" value={mode} onChange={event => setMode(event.target.value)}
        options={[{ label: '人数', value: 'count' }, { label: '選択率 (%)', value: 'percent' }]} />
    </Space>
  )
  return (
  <GraphPanel
    graphId="barchart/ma"
    title="複数回答の棒グラフ"
    available={Boolean(group)}
    sizing="intrinsic"
    intrinsicSize={{ width: 680, height: contentHeight }}
    normalWidth="viewport"
    controls={maControls}
  >
  <Card ref={contentRef} size="small" data-testid="ma-barchart">
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => setRetry(value => value + 1)}>再試行</Button>} />}
    {loading && <Spin />}
    <WeightUnsupportedAlert weightColumnName={value?.weightStatus === 'unsupported' ? value?.weightColumn : null} />
    {value && <Typography.Paragraph type="secondary">
      {weighted
        ? `回答者重み ${value.weightColumn ?? ''} を適用し、各群の有効回答者の重み合計を分母に集計します（設計効果は考慮しません）。加重N ${formatWeight(value.weightedN ?? 0)}${(value.weightMissingCount ?? 0) > 0 ? `・重み欠損 ${value.weightMissingCount}人` : ''}${(value.weightZeroCount ?? 0) > 0 ? `・重み0 ${value.weightZeroCount}人` : ''}。`
        : '各群の有効回答者を分母に集計します。'}比較属性の欠損除外: {value.attributeMissingExcluded}人
    </Typography.Paragraph>}
    {value && !options.length && <Empty description="集計対象がありません" />}
    {value && value.strata.length > 10 && <Space style={{ marginBottom: 12 }}><span>比較カテゴリ</span>
      <Pagination size="small" current={currentStrataPage} pageSize={10} total={value.strata.length} showSizeChanger={false} onChange={setStrataPage} />
    </Space>}
    <CategoryBars axisName={mode === 'percent' ? '選択率 (%)' : weighted ? '加重人数 (Σw)' : '人数'}
      max={mode === 'percent' ? 100 : maxValue} testId="ma-grouped-chart"
      items={visible.flatMap(option => visibleStrata.map(stratum => {
        const item = stratum.summary.items.find(item => item.columnId === option.columnId)!
        return { id: JSON.stringify([item.columnId, stratum.code]), label: `${option.label || option.name} / ${stratum.label}`,
          value: mode === 'percent' ? item.pctRespondent : barValue(item), selected: item.selectedInSelection > 0,
          detail: `非加重: ${item.selectedN}人 / 有効: ${stratum.summary.denominators.valid}人 / 選択中: ${item.selectedInSelection}人` }
      }))} onSelect={id => { if (!matching && !loading) { const [columnId, code] = JSON.parse(id); void select(columnId, code) } }} />
    {visible.map(option => <div key={option.columnId} style={{ marginBottom: 16 }}>
      <Typography.Text strong>{option.name} {option.label}</Typography.Text>
      {visibleStrata.map(stratum => {
        const item = stratum.summary.items.find(item => item.columnId === option.columnId)!
        return <div key={stratum.code} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 4, minWidth: 0 }}>
          <Tooltip mouseEnterDelay={0.2} title={weightNote(value, stratum.summary)}>
            <span style={{ flex: '0 1 180px', minWidth: 0, overflowWrap: 'anywhere' }}>
              {stratum.label}（有効{stratum.summary.denominators.valid}人{weighted ? `／加重N ${formatWeight(stratum.summary.weightedValidN ?? 0)}` : ''}）
            </span>
          </Tooltip>
          <button type="button" disabled={matching || loading || !item.selectedN} aria-label={`${option.name} ${stratum.label}の回答者を選択`}
            onClick={() => void select(item.columnId, stratum.code)} style={{ flex: '1 1 120px', minWidth: 0, border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }}>
            回答者を選択
          </button>
          <span style={{ flex: '1 1 220px', minWidth: 0, overflowWrap: 'anywhere' }}>{weighted ? `加重${formatWeight(item.selectedWeighted ?? 0)} / ` : ''}{item.selectedN}人 / {item.pctRespondent == null ? '—（分母0）' : `${item.pctRespondent.toFixed(1)}%`}{weighted && item.pctRespondentUnweighted != null ? `（非加重 ${item.pctRespondentUnweighted.toFixed(1)}%）` : ''} ・ 選択中{item.selectedInSelection}人</span>
        </div>
      })}
    </div>)}
    {options.length > 20 && <Pagination size="small" current={currentPage} pageSize={20} total={options.length} showSizeChanger={false} onChange={setPage} />}
  </Card>
  </GraphPanel>
  )
}
