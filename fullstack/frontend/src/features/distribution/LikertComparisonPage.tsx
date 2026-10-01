import { useAnalysisViewActive } from '../selection/analysisScope'
import EChart, { escapeHtml } from '../charts/EChart'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Empty, Radio, Segmented, Space, Spin, Typography } from 'antd'
import type { RootState } from '../../app/store'
import { selectionApplied, selectEffectiveRowIds, selectOrdinaryVariables } from '../../app/store'
import { getBrushOp } from '../selection/SelectionMenu'
import GraphPanel from '../common/GraphPanel'
import { api } from '../../api/client'
import { normalizeCode, useCodebook } from '../dataset/useCodebookColumn'
import { neutralIndex, sortLikertRows, toLikertRow, likertIntervals, validLikertOrder, type LikertMode, type LikertRow, type LikertSort } from './likertTransform'

interface LikertColumnPayload {
  denominators?: { total: number; target: number; valid: number; missing: number; notApplicable: number }
  distribution?: { code: string; label: string; count: number; percentageValid: number; isMissing?: boolean; isInvalid?: boolean }[]
  auxiliaryStats?: { mean?: number; meanNote?: string; top2Box?: { pct: number; n: number } | null }
  weighted?: { weightedN: number | null; distribution: { code: string; weightedCount: number; weightedPct: number | null }[] } | null
}

type Basis = 'unweighted' | 'weighted'

export default function LikertComparisonPage() {
  const dispatch = useDispatch()
  const viewActive = useAnalysisViewActive()
  const selection = useSelector((s: RootState) => s.selection)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const weightColumnId = useSelector((s: RootState) => s.globalVariables.weightColumnId)
  const { columns: definitions, schemaRevision } = useCodebook()
  const [sort, setSort] = useState<LikertSort>('top2-desc')
  const [mode, setMode] = useState<LikertMode>('stacked100')
  const columnsData = useColumnarData(selection.datasetId)
  useEffect(() => {
    const value = localStorage.getItem(`davis:likert-mode:${selection.datasetId}`)
    setMode(value === 'diverging' ? 'diverging' : 'stacked100')
  }, [selection.datasetId])
  const [basis, setBasis] = useState<Basis>('unweighted')
  const [payload, setPayload] = useState<Record<string, LikertColumnPayload> | null>(null)
  const [weightMeta, setWeightMeta] = useState<{ status: string; columnName?: string | null; unweightedN?: number | null; weightedN?: number | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matchError, setMatchError] = useState<string | null>(null)

  const globalVars = useSelector(selectOrdinaryVariables)
  const ordinalColumns = useMemo(
    () => definitions.filter((c) => c.role === 'question' && c.scaleType === 'ordinal' && !c.multiResponseGroup
      && globalVars.activeVariableIds.includes(c.name)),
    [definitions, globalVars.activeVariableIds],
  )
  const weightName = definitions.find((c) => c.columnId === weightColumnId)?.name
  const columnNames = useMemo(() => ordinalColumns.map((c) => c.name), [ordinalColumns])
  const orderKey = JSON.stringify(columnNames)
  const inputKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, effectiveRowIds, orderKey, weightName ?? null])
  const currentInput = useRef(inputKey)
  currentInput.current = inputKey
  const [resultKey, setResultKey] = useState<string | null>(null)

  useEffect(() => {
    if (!viewActive) return
    let cancelled = false
    setError(null)
    setMatchError(null)
    if (!selection.datasetId || !columnNames.length) {
      setLoading(false)
      setPayload(null)
      return
    }
    setLoading(true)
    void api.post<{ columns: Record<string, LikertColumnPayload>; weightStatus?: string; weightColumn?: string | null; unweightedN?: number; weightedN?: number | null }>(
      '/summaries',
      {
        datasetId: selection.datasetId, rowIds: effectiveRowIds, columns: columnNames,
        expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
        ...(weightName ? { weightMode: 'column', weightColumn: weightName } : { weightMode: 'none' }),
      },
    ).then((res) => {
      if (cancelled || currentInput.current !== inputKey) return
      setPayload(res.columns)
      setWeightMeta({ status: res.weightStatus ?? 'omitted', columnName: res.weightColumn ?? null,
        unweightedN: res.unweightedN ?? null, weightedN: res.weightedN ?? null })
      setResultKey(inputKey)
    }).catch((err: { message?: string }) => {
      if (cancelled || currentInput.current !== inputKey) return
      setError(err.message ?? 'Likert集計の取得に失敗しました。')
    }).finally(() => { if (!cancelled && currentInput.current === inputKey) setLoading(false) })
    return () => { cancelled = true }
  }, [viewActive, inputKey])

  const rows: LikertRow[] = useMemo(() => {
    if (!payload || resultKey !== inputKey) return []
    const items = ordinalColumns.map((col) => {
      const data = payload[col.name]
      if (!data) return null
      const order = validLikertOrder(col, data.distribution ?? [])
      const distByCode = new Map((data.distribution ?? []).map((d) => [String(d.code), d]))
      const useWeighted = basis === 'weighted' && data.weighted
      const weightedByCode = new Map((data.weighted?.distribution ?? []).map((d) => [String(d.code), d]))
      const categories = order.map((code) => {
        if (useWeighted) {
          const w = weightedByCode.get(code)
          return { code, label: distByCode.get(code)?.label ?? code, count: w?.weightedCount ?? 0, pct: w?.weightedPct ?? 0 }
        }
        const d = distByCode.get(code)
        return { code, label: d?.label ?? code, count: d?.count ?? 0, pct: d?.percentageValid ?? 0 }
      })
      const validN = data.denominators?.valid ?? 0
      return toLikertRow({
        columnId: col.name, title: col.label || col.name, categories, validN,
        top2Pct: data.auxiliaryStats?.top2Box?.pct ?? null,
        mean: data.auxiliaryStats?.mean ?? null,
      })
    }).filter((r): r is LikertRow => r !== null)
    return sortLikertRows(items, sort, columnNames)
  }, [payload, resultKey, inputKey, ordinalColumns, columnNames, sort, basis])

  const clickSegment = async (row: LikertRow, code: string) => {
    const column = definitions.find((c) => c.name === row.columnId)
    if (!column || !selection.datasetId) return
    setMatchError(null)
    try {
      const result = await api.post<{ rowIds: string[]; schemaRevision: number }>(
        `/datasets/${selection.datasetId}/column-matches`,
        { columnId: column.columnId, code: normalizeCode(code), rowIds: effectiveRowIds,
          expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision })
      if (currentInput.current !== inputKey || result.schemaRevision !== schemaRevision) return
      dispatch(selectionApplied({ rowIds: result.rowIds, operation: getBrushOp(), label: `Likert ${row.title} = ${code}` }))
    } catch (err) {
      if (currentInput.current === inputKey) setMatchError((err as { message?: string }).message ?? '回答者の選択に失敗しました。')
    }
  }

  const intervals = likertIntervals(rows, mode)
  const selectedByCategory = new Set<string>()
  if (columnsData) {
    const selectedIds = new Set(selection.selectedRowIds)
    columnsData.rowIds.forEach((id, i) => {
      if (!selectedIds.has(id)) return
      for (const row of rows) selectedByCategory.add(`${row.columnId}\0${normalizeCode(columnsData.columns[row.columnId]?.[i])}`)
    })
  }

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
  }, [Boolean(selection.datasetId)])

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  const controls = (
        <Space wrap>
          <Segmented
            size="small"
            aria-label="並べ替え"
            data-testid="likert-sort"
            options={[{ label: 'Top-2降順', value: 'top2-desc' }, { label: '平均降順', value: 'mean-desc' }, { label: '元順', value: 'original' }]}
            value={sort}
            onChange={(v) => setSort(v as LikertSort)}
          />
          <Radio.Group
            size="small"
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
            data-testid="likert-basis"
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="unweighted">非加重</Radio.Button>
            <Radio.Button value="weighted" disabled={!weightName}>加重</Radio.Button>
          </Radio.Group>
          <Segmented size="small" aria-label="Likert表示形式" data-testid="likert-mode" value={mode}
            options={[{ label: '100%積み上げ', value: 'stacked100' }, { label: '発散型', value: 'diverging' }]}
            onChange={value => { setMode(value as LikertMode); localStorage.setItem(`davis:likert-mode:${selection.datasetId}`, String(value)) }} />
        </Space>
  )

  return (
    <div data-testid="likert-page" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>

      {weightMeta && weightMeta.status !== 'omitted' && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="likert-weight-meta">
          表示基準: {basis === 'weighted' ? `加重（${weightMeta.columnName}）` : '非加重'}
          （非加重n={weightMeta.unweightedN ?? '—'} / 加重Σw={weightMeta.weightedN ?? '—'}）· 検定p値は加重しません
        </Typography.Text>
      )}
      {matchError && <Alert type="error" message={matchError} showIcon />}
      {error && <Alert type="error" message="集計エラー" description={error} showIcon />}
      <GraphPanel
        graphId="likert/comparison"
        title="Likert Comparison"
        available={rows.length > 0}
        sizing="intrinsic"
        controls={controls}
        intrinsicSize={{ width: 900, height: contentHeight }}
      >
        <div ref={contentRef}>
        {loading ? <div style={{ padding: 40, textAlign: 'center' }}><Spin tip="Likert集計を計算中..." /></div>
          : !rows.length ? <Empty description={ordinalColumns.length ? '表示可能な行がありません。' : '順序尺度の質問列がありません。'} />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <EChart height={Math.max(240, rows.length * 65 + 85)} testId="likert-echart" ariaLabel={`Likert ${mode === 'stacked100' ? '100%積み上げ' : '発散型'}・有効回答割合`}
                option={{
                  grid: { left: 190, right: 35, top: 25, bottom: 45, containLabel: true },
                  xAxis: { type: 'value', min: mode === 'diverging' ? -100 : 0, max: 100, name: '有効回答割合 (%)', nameLocation: 'middle', nameGap: 30,
                    axisLabel: { formatter: (v: number) => `${Math.abs(v)}%` } },
                  yAxis: { type: 'category', inverse: true, data: rows.map(row => row.title), axisLabel: { width: 170, overflow: 'truncate' } },
                  tooltip: { confine: true, formatter: (p: any) => { const mark = intervals[p.dataIndex]; return `${escapeHtml(rows[mark.rowIndex].title)}<br/>${escapeHtml(mark.label)} (${escapeHtml(mark.code)}): ${mark.count} / ${mark.pct.toFixed(2)}%<br/>有効n=${rows[mark.rowIndex].validN}` } },
                  series: [{ type: 'custom', data: intervals.map(mark => [mark.start, mark.end, mark.rowIndex]),
                    renderItem: (_params: any, api: any) => {
                      const mark = intervals[_params.dataIndex], start = api.coord([mark.start, mark.rowIndex]), end = api.coord([mark.end, mark.rowIndex])
                      return { type: 'rect', shape: { x: start[0], y: start[1] - 16, width: Math.max(0, end[0] - start[0]), height: 32 },
                        style: { fill: mark.color, stroke: selectedByCategory.has(`${mark.columnId}\0${mark.code}`) ? '#2a78d6' : '#fff', lineWidth: selectedByCategory.has(`${mark.columnId}\0${mark.code}`) ? 3 : 1 } }
                    } }],
                }} onEvents={{ click: params => { const mark = intervals[params.dataIndex]; if (mark) void clickSegment(rows[mark.rowIndex], mark.code) } }} />
              {rows.map((row) => (
                <Card key={row.columnId} size="small" title={`${row.title}（n=${row.validN}）`}>
                  <Space wrap>
                    {[...row.negative, ...(row.neutral ? [row.neutral] : []), ...row.positive].map(seg => <Button key={seg.code} size="small"
                      data-testid={`likert-seg-${row.columnId}-${seg.code}`} onClick={() => void clickSegment(row, seg.code)}
                      type={selectedByCategory.has(`${row.columnId}\0${seg.code}`) ? 'primary' : 'default'}>{seg.label}: {seg.count} ({seg.pct.toFixed(1)}%)</Button>)}
                    <span>Top-2: {row.top2Pct == null ? '—' : `${row.top2Pct.toFixed(1)}%`}</span>
                  </Space>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    {(() => {
                      const idx = neutralIndex(row.negative.length + (row.neutral ? 1 : 0) + row.positive.length)
                      return idx === null ? '偶数カテゴリのため中立なし' : `中立カテゴリは順序中央（位置${idx + 1}）`
                    })()}
                    {row.mean != null && <span> · 平均{row.mean.toFixed(2)}（等間隔得点として計算）</span>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </GraphPanel>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          セグメントをクリックすると該当回答者を中央Selectionへ送ります。* 中立の意味は原票で確認してください。
        </Typography.Text>
    </div>
  )
}
