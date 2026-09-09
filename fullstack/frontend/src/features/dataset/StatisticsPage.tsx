import { selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import { useQuestionText } from '../common/ColumnQuestionTooltip'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { l1Index, useL1ColorDomains } from '../../theme/useL1ColorDomain'
import L1Legend from '../common/L1Legend'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Card, Col, Dropdown, Empty, Row, Segmented, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { BarChartOutlined, CheckCircleOutlined, FilterOutlined, TableOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, statsScopeSet, selectEffectiveRowIds } from '../../app/store'
import { useRowColorResolver } from '../../theme/useRowColor'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { graphEngine } from '../../engine/graphClient'
import { vizTheme, l1Color, signedNoiseViz } from '../../theme/viz'
import { getBrushOp } from '../selection/SelectionMenu'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { getSvgPoint } from '../../utils/svgCoordinates'
import { normalizeCode, useCodebook } from './useCodebookColumn'
import { QuestionCard } from '../distribution/QuestionCard'
import MultiResponseStatistics from './MultiResponseStatistics'

interface StatsRow {
  key: string
  column: string
  type: string
  count: number
  missing: number
  mean?: string
  std?: string
  min?: string
  q1?: string
  median?: string
  q3?: string
  max?: string
  mode?: string
  unique?: string
}

/** Descriptive statistics page: per-axis summary table + histogram per axis. */
export default function StatisticsPage() {
  const questionText = useQuestionText()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const pcpColorBy = useSelector((s: RootState) => s.pcp.colorBy)
  const globalVars = useSelector(selectOrdinaryVariables)
  const entities = useSelector(selectVariableEntities)
  const maCount = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key)).length
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const data = useColumnarData(selection.datasetId, [...globalVars.activeVariableIds, ...(pcpColorBy ? [pcpColorBy] : [])])
  const { getColumn, formatValueLabel, getOrderedCategories } = useCodebook()
  const { focused, isTargetActive } = useFocusMode()
  const theme = vizTheme(false)
  const { getColor } = useRowColorResolver()

  const contextMenuItems = [
    {
      key: 'focus',
      label: 'Focus Selected (選択行のみに絞り込み)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: 'Delete Selected (選択行を一時除外)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: 'Clear Selection (選択解除)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      key: 'reset',
      label: 'Reset to Base Data (全データ復帰)',
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]
  // Range brush over a histogram (AGENTS.md R3): drag horizontally to select
  // the value interval under the band. dragRef mirrors state for fresh reads.
  const [histDrag, setHistDrag] = useState<{ column: string; x1: number; x2: number } | null>(null)
  /** Last bin clicked per column (column → bin index) for exact self-highlight. */
  const [clickedBin, setClickedBin] = useState<{ column: string; bin: number } | null>(null)
  const histDragRef = useRef<{ column: string; x1: number; x2: number } | null>(null)
  const histSvgRefs = useRef(new Map<string, SVGSVGElement>())

  const statsScope = useSelector((s: RootState) => s.selection.statsScope)
  /** Scope-filtered row indexes (active or selected), shared by stats + histograms. */
  const scopedIndexes = useMemo(() => {
    if (!data) return []
    const scopeSet = statsScope === 'selected' ? new Set(selection.selectedRowIds) : null
    const effectiveSet = new Set(effectiveRowIds)
    const out: number[] = []
    for (let i = 0; i < data.rowIds.length; i += 1) {
      if (scopeSet ? scopeSet.has(data.rowIds[i]) : effectiveSet.has(data.rowIds[i])) out.push(i)
    }
    return out
  }, [data, statsScope, selection.selectedRowIds, effectiveRowIds])

  const targetSchema = useMemo(() => {
    if (!data) return []
    const activeVarSet = new Set(globalVars.activeVariableIds)
    return activeVarSet ? data.schema.filter((c) => activeVarSet.has(c.name)) : data.schema
  }, [data, globalVars?.activeVariableIds])

  const columnValues = useMemo(() => Object.fromEntries(targetSchema.map(column => {
    const spec = getColumn(column.name)
    const missing = new Set(spec?.missingCodes ?? [])
    const numeric = spec ? ['interval', 'ratio'].includes(spec.scaleType) : column.semanticType === 'numeric'
    const values = (data?.columns[column.name] ?? []).map(raw => {
      const code = normalizeCode(raw)
      return code === null || missing.has(code) || (numeric && (code.trim() === '' || !Number.isFinite(Number(code)))) ? null : code
    })
    return [column.name, { numeric, values, numbers: numeric ? Float64Array.from(values, v => v === null ? NaN : Number(v)) : new Float64Array(0) }]
  })), [data, targetSchema, getColumn])

  const [stats, setStats] = useState<StatsRow[]>([])
  const [loadingStats, setLoadingStats] = useState(false)
  useEffect(() => {
    if (!data || !scopedIndexes.length) { setStats([]); setLoadingStats(false); return }
    let cancelled = false
    setLoadingStats(true)
    ;(async () => {
      try {
        const f = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(3))
        const rows: StatsRow[] = []
        for (const column of targetSchema) {
          const spec = getColumn(column.name)
          const scaleNames: Record<string, string> = { nominal: '名義尺度', ordinal: '順序尺度', interval: '間隔尺度', ratio: '比例尺度', text: 'テキスト', id: '識別子' }
          const type = spec ? scaleNames[spec.scaleType] : (column.semanticType === 'numeric' ? '数値' : 'カテゴリ')
          if (columnValues[column.name].numeric) {
            const arr = columnValues[column.name].numbers
            const scoped = new Float64Array(scopedIndexes.length)
            for (let i = 0; i < scopedIndexes.length; i += 1) scoped[i] = arr[scopedIndexes[i]]
            // unique over finite values (host-side; hashing is cheap vs sorting)
            const unique = new Set<number>()
            let missing = 0
            for (let i = 0; i < scoped.length; i += 1) {
              const v = scoped[i]
              if (Number.isFinite(v)) unique.add(v)
              else missing += 1
            }
            const d = await graphEngine.describeNumeric(scoped)
            if (cancelled) return
            rows.push({
              key: column.name,
              column: column.name,
              type,
              count: d ? d[0] : 0,
              missing: d ? d[1] : missing,
              mean: d ? f(d[2]) : '—',
              std: d ? f(d[3]) : '—',
              min: d ? f(d[4]) : '—',
              q1: d ? f(d[5]) : '—',
              median: d ? f(d[6]) : '—',
              q3: d ? f(d[7]) : '—',
              max: d ? f(d[8]) : '—',
              unique: String(unique.size),
            })
          } else {
            const values = columnValues[column.name].values
            const strings = scopedIndexes.map((i) => values[i]).filter((v): v is string => v !== null && v !== undefined)
            const counts = new Map<string, number>()
            for (const v of strings) counts.set(v, (counts.get(v) ?? 0) + 1)
            const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
            rows.push({
              key: column.name,
              column: column.name,
              type,
              count: strings.length,
              missing: scopedIndexes.length - strings.length,
              mode: top ? `${formatValueLabel(column.name, top[0])} (${top[1]})` : '—',
              unique: String(counts.size),
            })
          }
        }
        if (!cancelled) setStats(rows)
      } finally {
        if (!cancelled) setLoadingStats(false)
      }
    })().catch(() => {
      if (!cancelled) setLoadingStats(false)
    })
    return () => { cancelled = true }
  }, [data, scopedIndexes, targetSchema, columnValues, getColumn, formatValueLabel])

  const numericColumns = useMemo(
    () => targetSchema.filter((c) => columnValues[c.name].numeric).map((c) => c.name),
    [targetSchema, columnValues],
  )

  const selectedSet = new Set(selection.selectedRowIds)
  const domains = useL1ColorDomains(data)
  const domain = domains.find(d => d.key === pcpColorBy)
  const categoriesOf = domain ? [...domain.codes, null] : null

  // Histogram layout.
  const binsCount = 20
  const histWidth = 560
  const histHeight = 300

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="statistics-page" style={{ display: 'flex', flexDirection: 'column', gap: 12, height: focused ? '100%' : undefined, flex: focused ? 1 : 'none', minHeight: focused ? 0 : undefined }}>
      {/* Top Toolbar Card */}
      {!focused && (
        <Card size="small" style={{ background: '#fafafa' }}>
          <Row gutter={[12, 8]} align="middle" justify="space-between">
            <Col>
              <Space wrap align="center">
                <Segmented
                  data-testid="stats-scope"
                  size="small"
                  options={[{ label: '有効データ全体', value: 'active' }, { label: '選択行のみ', value: 'selected' }]}
                  value={statsScope}
                  onChange={(v) => dispatch(statsScopeSet(v as 'active' | 'selected'))}
                />
              </Space>
            </Col>
            <Col>
              <Space size={6}>
                <Tag color={statsScope === 'selected' ? 'blue' : 'default'} style={{ margin: 0 }}>
                  {statsScope === 'selected'
                    ? `選択中 ${selection.selectedRowIds.length} 行を集計`
                    : `有効データ ${selection.activeRowIds.length} 行を集計`}
                </Tag>
                {pcpColorBy && (
                  <Tag color="purple" style={{ margin: 0 }}>
                    色分け: <ColumnQuestionTooltip nameOrId={pcpColorBy!}>{pcpColorBy}</ColumnQuestionTooltip>
                  </Tag>
                )}
              </Space>
            </Col>
          </Row>
        </Card>
      )}

      {/* Summary KPI Cards */}
      {!focused && (
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="集計対象の変数"
                value={targetSchema.length + maCount}
                prefix={<TableOutlined />}
                suffix={`項目 (通常 ${targetSchema.length}・MA ${maCount})`}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="集計対象データ"
                value={scopedIndexes.length}
                prefix={<CheckCircleOutlined />}
                suffix={`/ ${data?.rowIds.length ?? 0} 行`}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="集計スコープ"
                value={statsScope === 'selected' ? '選択行のみ' : '有効データ全体'}
                prefix={<FilterOutlined />}
                valueStyle={{ fontSize: 15 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="可視化ヒストグラム"
                value={numericColumns.length}
                prefix={<BarChartOutlined />}
                suffix="グラフ"
              />
            </Card>
          </Col>
        </Row>
      )}

      <L1Legend />
      {!focused && <MultiResponseStatistics rowIds={statsScope === 'selected' ? selection.selectedRowIds : effectiveRowIds} />}
      {loadingStats && (
        <Card size="small" style={{ textAlign: 'center', padding: '30px 20px', background: '#fafafa', borderRadius: 8 }}>
          <Spin size="large" tip="記述統計量を集計中..." />
        </Card>
      )}

      {statsScope === 'selected' && !selection.selectedRowIds.length ? (
        <Empty
          data-testid="stats-empty-selected"
          style={{ marginTop: 40 }}
          description="行が選択されていません。PCPや各グラフ、またはテーブルで行を選択してください。"
        />
      ) : (
        <>
          {!focused && (
            <Card
              size="small"
              title={<span style={{ fontSize: 13, fontWeight: 600 }}>記述統計量サマリー（{statsScope === 'selected' ? '選択行' : '有効データ'}）</span>}
              style={{ boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.03)' }}
            >
              <Table<StatsRow>
                size="small"
                pagination={false}
                loading={loadingStats}
                dataSource={stats}
                columns={[
                  { title: '列', dataIndex: 'column', key: 'column', fixed: 'left' },
                  { title: '型', dataIndex: 'type', key: 'type', width: 70 },
                  { title: 'count', dataIndex: 'count', key: 'count', width: 70 },
                  { title: 'missing', dataIndex: 'missing', key: 'missing', width: 70 },
                  { title: 'mean', dataIndex: 'mean', key: 'mean', width: 80, render: (v) => v ?? '—' },
                  { title: 'std', dataIndex: 'std', key: 'std', width: 80, render: (v) => v ?? '—' },
                  { title: 'min', dataIndex: 'min', key: 'min', width: 80, render: (v) => v ?? '—' },
                  { title: 'q1', dataIndex: 'q1', key: 'q1', width: 80, render: (v) => v ?? '—' },
                  { title: 'median', dataIndex: 'median', key: 'median', width: 80, render: (v) => v ?? '—' },
                  { title: 'q3', dataIndex: 'q3', key: 'q3', width: 80, render: (v) => v ?? '—' },
                  { title: 'max', dataIndex: 'max', key: 'max', width: 80, render: (v) => v ?? '—' },
                  { title: '最頻値', dataIndex: 'mode', key: 'mode', render: (v) => v ?? '—' },
                  { title: 'unique', dataIndex: 'unique', key: 'unique', width: 70 },
                ]}
                scroll={{ x: 'max-content' }}
              />
            </Card>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {targetSchema.filter(c => {
              const spec = getColumn(c.name)
              return spec ? ['nominal', 'ordinal'].includes(spec.scaleType) : !columnValues[c.name].numeric
            }).map(column => {
              const values = columnValues[column.name].values
              const counts = new Map<string, number>()
              const selectedCounts: Record<string, number> = Object.create(null)
              for (const index of scopedIndexes) {
                const code = values[index]
                if (code === null || code === undefined) continue
                counts.set(code, (counts.get(code) ?? 0) + 1)
                if (selectedSet.has(data!.rowIds[index])) selectedCounts[code] = (selectedCounts[code] ?? 0) + 1
              }
              const valid = [...counts.values()].reduce((a, b) => a + b, 0)
              return <div key={column.name} style={{ flex: '1 1 420px', minWidth: 0, maxWidth: '100%' }}>
                <QuestionCard codebookColumn={getColumn(column.name)} summary={{
                  columnId: column.name,
                  denominators: { total: scopedIndexes.length, target: scopedIndexes.length, valid, missing: scopedIndexes.length - valid, notApplicable: 0 },
                  distribution: getOrderedCategories(column.name, [...counts.keys()]).map(code => ({ code, label: formatValueLabel(column.name, code), count: counts.get(code) ?? 0, percentageValid: valid ? (counts.get(code) ?? 0) / valid * 100 : 0, percentageTotal: scopedIndexes.length ? (counts.get(code) ?? 0) / scopedIndexes.length * 100 : 0 })),
                }} selectedCountByCode={selectedCounts} onSelectCategory={(code) => {
                  const ids = scopedIndexes.filter(i => values[i] === normalizeCode(code)).map(i => data!.rowIds[i])
                  dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: `カテゴリ選択（${column.name}）` }))
                }} />
              </div>
            })}
          </div>
          {(() => {
            const activeSingleColumn = numericColumns.find((col) => isTargetActive(`histogram-${col}`))
            const renderHistCard = (column: string, isSingleFocused: boolean) => {
              const rows = scopedIndexes
                .map((index) => ({ id: data!.rowIds[index], index, v: columnValues[column].numbers[index] ?? NaN }))
                .filter(({ v }) => Number.isFinite(v))
              if (!rows.length) return null
              const min = Math.min(...rows.map((r) => r.v))
              const max = Math.max(...rows.map((r) => r.v))
              const binEdges = Array.from({ length: binsCount + 1 }, (_, i) => min + ((max - min) / binsCount) * i)
              const groupBins = categoriesOf
                ? categoriesOf.map(() => new Array(binsCount).fill(0))
                : [new Array(binsCount).fill(0)]
              for (const row of rows) {
                let bin = Math.floor(((row.v - min) / (max - min || 1)) * binsCount)
                bin = Math.min(binsCount - 1, bin)
                if (categoriesOf && pcpColorBy && data!.columns[pcpColorBy]) {
                  const ci = l1Index(domain, data!.columns[pcpColorBy][row.index]) ?? domain!.codes.length
                  if (ci >= 0) groupBins[ci][bin] += 1
                } else {
                  groupBins[0][bin] += 1
                }
              }
              const maxCount = Math.max(...groupBins.flat(), 1)
              const barW = (histWidth - 30) / binsCount
              const selectedRows = rows.filter(({ id }) => selectedSet.has(id))
              const selectedBinFlags = new Array<boolean>(binsCount).fill(false)
              for (const { v } of selectedRows) {
                let bin = Math.floor(((v - min) / (max - min || 1)) * binsCount)
                bin = Math.min(binsCount - 1, Math.max(0, bin))
                selectedBinFlags[bin] = true
              }
              const isBinHighlighted = (bi: number) =>
                (clickedBin?.column === column && clickedBin?.bin === bi)
                || selectedBinFlags[bi]
              const selectBinRange = (bin: number) => {
                const lo = binEdges[bin]
                const hi = binEdges[bin + 1]
                const ids = rows
                  .filter(({ v }) => bin === binsCount - 1 ? v >= lo && v <= hi : v >= lo && v < hi)
                  .map(({ id }) => id)
                dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: `ヒストグラム選択（${column}）` }))
                setClickedBin({ column, bin })
              }
              const histOnPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
                if (event.button !== 0) return
                const target = event.target as Element
                if (target.closest('circle, rect[data-selectable], g[data-selectable]')) {
                  return
                }
                const svg = event.currentTarget
                const pt = getSvgPoint(svg, event, { width: histWidth, height: histHeight })
                histDragRef.current = { column, x1: pt.x, x2: pt.x }
                setHistDrag(histDragRef.current)
                try { svg.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
              }
              const histOnPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
                if (!histDragRef.current || histDragRef.current.column !== column) return
                const svg = histSvgRefs.current.get(column)
                if (!svg) return
                const pt = getSvgPoint(svg, event, { width: histWidth, height: histHeight })
                histDragRef.current = { ...histDragRef.current, x2: pt.x }
                setHistDrag(histDragRef.current)
              }
              const histOnPointerUp = () => {
                const cur = histDragRef.current
                histDragRef.current = null
                setHistDrag(null)
                if (!cur || cur.column !== column || Math.abs(cur.x2 - cur.x1) < 4) return
                const xLoPx = Math.min(cur.x1, cur.x2)
                const xHiPx = Math.max(cur.x1, cur.x2)
                const plotL = 22
                const plotR = histWidth - 8
                const vLo = min + ((xLoPx - plotL) / (plotR - plotL)) * (max - min)
                const vHi = min + ((xHiPx - plotL) / (plotR - plotL)) * (max - min)
                const ids = rows.filter(({ v }) => v >= Math.min(vLo, vHi) && v <= Math.max(vLo, vHi)).map(({ id }) => id)
                dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: `ヒストグラム範囲選択（${column}）` }))
              }
              const activeHistDrag = histDrag?.column === column ? histDrag : null

              return (
                <div
                  key={column}
                  style={{
                    userSelect: 'none',
                    flex: isSingleFocused ? '1 1 100%' : '0 0 auto',
                    maxWidth: isSingleFocused ? '1000px' : histWidth,
                    margin: isSingleFocused ? '0 auto' : undefined,
                    width: '100%',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: '#f8fafc', border: '1px solid #e5e7eb', borderBottom: 'none', borderRadius: '6px 6px 0 0' }}>
                    <Typography.Text strong style={{ fontSize: 13, color: '#334155' }}><ColumnQuestionTooltip nameOrId={column}>{column}</ColumnQuestionTooltip></Typography.Text>
                    {!isSingleFocused && <FocusEnterButton targetId={`histogram-${column}`} title={`${column} ヒストグラム`} />}
                  </div>
                  <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
                  <div>
                  <svg
                    ref={(el) => { if (el) histSvgRefs.current.set(column, el) }}
                    data-testid={`histogram-${column}`}
                    viewBox={`0 0 ${histWidth} ${histHeight}`}
                    width={histWidth}
                    height={histHeight}
                    style={{
                      width: '100%',
                      height: 'auto',
                      display: 'block',
                      border: '1px solid #e5e7eb',
                      borderTop: 'none',
                      borderRadius: 0,
                      background: '#fff',
                      touchAction: 'none',
                    }}
                    onPointerDown={histOnPointerDown}
                    onPointerMove={histOnPointerMove}
                    onPointerUp={histOnPointerUp}
                  >
                    <ColumnQuestionTooltip nameOrId={column} svg><text x={histWidth / 2} y={16} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151">{column}</text></ColumnQuestionTooltip>
                    {groupBins.map((bins, gi) =>
                      bins.map((count, bi) => {
                        if (!count) return null
                        const h = (count / maxCount) * (histHeight - 44)
                        const x = 22 + bi * barW
                        const color = domain && gi < domain.codes.length ? l1Color(theme, gi) : theme.contextLine
                        const isSelectedBin = isBinHighlighted(bi)
                        return (
                          <rect
                            key={`${gi}-${bi}`}
                            data-selectable="true"
                            x={x}
                            y={histHeight - 26 - h}
                            width={Math.max(1, barW - 2)}
                            height={h}
                            fill={color}
                            opacity={isSelectedBin ? 0.95 : 0.55}
                            style={{ cursor: 'pointer' }}
                            onClick={() => selectBinRange(bi)}
                          >
                            <title>{`${questionText(column)} [${binEdges[bi].toFixed(2)}–${binEdges[bi + 1].toFixed(2)}): ${count}`}</title>
                          </rect>
                        )
                      }))}
                    {activeHistDrag && (
                      <rect
                        x={Math.min(activeHistDrag.x1, activeHistDrag.x2)}
                        y={10}
                        width={Math.abs(activeHistDrag.x2 - activeHistDrag.x1)}
                        height={histHeight - 36}
                        fill="rgba(42,120,214,0.15)"
                        stroke="#2a78d6"
                        strokeWidth={1.5}
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                    <line x1={20} y1={histHeight - 26} x2={histWidth - 8} y2={histHeight - 26} stroke="#c3c2b7" />
                    {[min, (min + max) / 2, max].map((tick, ti) => (
                      <text key={ti} x={22 + ((tick - min) / (max - min || 1)) * (histWidth - 38)} y={histHeight - 10}
                        textAnchor="middle" fontSize={10} fill="#6b7280">{Number(tick).toFixed(1)}</text>
                    ))}
                  </svg>
                  {/* jittered strip under the histogram */}
                  <svg
                    viewBox={`0 0 ${histWidth} 40`}
                    width={histWidth}
                    height={40}
                    style={{
                      width: '100%',
                      height: 'auto',
                      display: 'block',
                      background: '#fff',
                      border: '1px solid #e5e7eb',
                      borderTop: 'none',
                      borderRadius: '0 0 6px 6px',
                    }}
                  >
                    {rows.map(({ id, v }) => {
                      const isSelected = selectedSet.has(id)
                      const color = isSelected
                        ? theme.selection
                        : getColor(id)
                      const cx = 22 + ((v - min) / (max - min || 1)) * (histWidth - 38)
                      const cy = 20 + signedNoiseViz(id, `${column}-strip`) * 12
                      return (
                        <g key={id} data-selectable="true"
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); dispatch(selectionApplied({ rowIds: [id], operation: getBrushOp(), label: 'ヒストグラム点クリック' })) }}>
                          <circle cx={cx} cy={cy} r={11} fill="transparent" />
                          <circle cx={cx} cy={cy}
                            r={isSelected ? 3.8 : 2.2}
                            fill={color} opacity={isSelected ? 0.95 : 0.45}
                            stroke={isSelected ? '#fff' : 'none'} strokeWidth={isSelected ? 1.5 : 0}>
                            <title>{`${id}: ${v.toFixed(3)} — クリックで選択`}</title>
                          </circle>
                        </g>
                      )
                    })}
                  </svg>
                  </div>
                  </Dropdown>
                </div>
              )
            }

            if (activeSingleColumn) {
              return (
                <FocusTarget id={`histogram-${activeSingleColumn}`} title={`${activeSingleColumn} ヒストグラム`}>
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 12 }}>
                    {renderHistCard(activeSingleColumn, true)}
                  </div>
                </FocusTarget>
              )
            }

            return (
              <Card
                size="small"
                title={<span style={{ fontSize: 13, fontWeight: 600 }}>各変数のヒストグラム分布（棒クリック＝値域選択 · 下段stripは選択値域を強調）</span>}
                style={{
                  boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.03)',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                  {numericColumns.map((col) => renderHistCard(col, false))}
                </div>
              </Card>
            )
          })()}
        </>
      )}
    </div>
  )
}
