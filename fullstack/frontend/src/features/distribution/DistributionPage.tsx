import { selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { l1Index, useL1ColorDomains } from '../../theme/useL1ColorDomain'
import L1Legend from '../common/L1Legend'
import { type ComponentProps, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { Alert, Card, Col, Dropdown, Pagination, Row, Segmented, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { BarChartOutlined, CheckCircleOutlined, SlidersOutlined, TableOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, hovered as hoverAction, selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { graphEngine } from '../../engine/graphClient'
import { vizTheme, l1Color, signedNoiseViz } from '../../theme/viz'
import { useBrushOp } from '../selection/SelectionMenu'
import GraphPanel from '../common/GraphPanel'
import { getSvgPoint } from '../../utils/svgCoordinates'
import { truncateText } from '../../utils/textUtils'
import { useRowColorResolver } from '../../theme/useRowColor'
import QQPlotView from '../qqplot/QQPlotView'
import EmptyStatePanel from '../common/EmptyStatePanel'
import { api, type MultiResponseSummary, type MultiResponseSummaryResponse, type MultiResponseWeight } from '../../api/client'
import { normalizeCode, useCodebook } from '../dataset/useCodebookColumn'
import QuestionCard from './QuestionCard'
import MultiResponseCard from './MultiResponseCard'

interface BoxStats {
  low: number
  q1: number
  median: number
  q3: number
  high: number
}

interface GroupRows {
  key: string
  code: string | null
  color: string
  stats: BoxStats | null
  rows: { id: string; v: number; index: number }[]
}

interface PanelData {
  column: string
  min: number
  max: number
  groups: GroupRows[]
}

/** Distribution lens — v1 layout: one box per category row, points jittered
 *  around their own box center. Horizontal = boxes stacked vertically per panel;
 *  Vertical = panels side by side along x (mirrors PCP vertical orientation).
 *  Range brush selects the value interval under the drag band. */
export default function DistributionPage() {
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const selection = useSelector((s: RootState) => s.selection)
  const pcp = useSelector((s: RootState) => s.pcp)
  const globalVars = useSelector(selectOrdinaryVariables)
  const entitySelection = useSelector(selectVariableEntities)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const svgRef = useRef<SVGSVGElement>(null)
  const [brushOp] = useBrushOp()
  const { columns: codebookColumns, getColumn, isLoading: isCodebookLoading, schemaRevision } = useCodebook()
  const weightColumnId = useSelector((s: RootState) => s.globalVariables.weightColumnId)
  const [viewMode, setViewMode] = useState<'cards' | 'boxplot' | 'qqplot'>('cards')
  const [rawDatasetIds, setRawDatasetIds] = useState<string[]>([])
  useEffect(() => {
    if (viewMode === 'boxplot' && selection.datasetId) setRawDatasetIds(ids => ids.includes(selection.datasetId!) ? ids : [...ids, selection.datasetId!])
  }, [viewMode, selection.datasetId])
  const data = useColumnarData(selection.datasetId && rawDatasetIds.includes(selection.datasetId) ? selection.datasetId : null)
  const [selectedCounts, setSelectedCounts] = useState<Record<string, Record<string, number>>>({})
  const [cardsRoleFilter, setCardsRoleFilter] = useState<'all' | 'question' | 'attribute'>('all')
  const [summaryData, setSummaryData] = useState<Record<string, any> | null>(null)
  const [weightMeta, setWeightMeta] = useState<Record<string, any> | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [loadingSummaries, setLoadingSummaries] = useState<boolean>(false)
  const [cardPage, setCardPage] = useState(1)
  const [maSummaries, setMaSummaries] = useState<MultiResponseSummary[]>([])
  const [maWeight, setMaWeight] = useState<MultiResponseWeight | null>(null)
  const [matching, setMatching] = useState(false)
  const [matchError, setMatchError] = useState<string | null>(null)
  const inputKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, effectiveRowIds])
  const currentInput = useRef(inputKey)
  currentInput.current = inputKey
  const matchGeneration = useRef(0)
  const summaryInput = useRef('')
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal')
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const dragRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

  const numericColumns = useMemo(() => {
    if (!data) return []
    const activeVarSet = new Set(globalVars.activeVariableIds)
    return data.schema
      .filter((c) => c.semanticType === 'numeric' && (!activeVarSet || activeVarSet.has(c.name)))
      .map((c) => c.name)
  }, [data, globalVars?.activeVariableIds])

  const categoricalColumns = useMemo(() => {
    if (!data) return []
    const activeVarSet = new Set(globalVars.activeVariableIds)
    return data.schema
      .filter((c) => c.semanticType !== 'numeric' && (!activeVarSet || activeVarSet.has(c.name)))
      .map((c) => c.name)
  }, [data, globalVars?.activeVariableIds])

  const cardColumns = useMemo(() => {
    return entitySelection.items.filter(item => entitySelection.selected.has(item.key))
      .flatMap(item => codebookColumns.filter(c => item.entity.kind === 'ma'
        ? c.multiResponseGroup === item.entity.groupId : c.columnId === item.entity.columnId))
      .filter((c) => {
        if (isCodebookLoading || cardsRoleFilter === 'all') return true
        const meta = getColumn(c.name)
        if (cardsRoleFilter === 'question' && meta?.role !== 'question') return false
        if (cardsRoleFilter === 'attribute' && meta?.role !== 'attribute') return false
        return true
      })
      .map((c) => c.name)
  }, [codebookColumns, entitySelection, cardsRoleFilter, getColumn, isCodebookLoading])

  const cardEntities = useMemo(() => {
    const seen = new Set<string>()
    return cardColumns.flatMap<{ kind: 'column' | 'ma'; id: string }>(name => {
      const groupId = getColumn(name)?.multiResponseGroup
      if (!groupId) return [{ kind: 'column' as const, id: name }]
      if (seen.has(groupId)) return []
      seen.add(groupId)
      return [{ kind: 'ma' as const, id: groupId }]
    })
  }, [cardColumns, getColumn])
  const visibleEntities = cardEntities.slice((Math.min(cardPage, Math.max(1, Math.ceil(cardEntities.length / 12))) - 1) * 12,
    Math.min(cardPage, Math.max(1, Math.ceil(cardEntities.length / 12))) * 12)
  const visibleKey = JSON.stringify(visibleEntities)
  useEffect(() => { setCardPage(1) }, [selection.datasetId, cardsRoleFilter])

  useEffect(() => {
    if (viewMode !== 'cards' || !selection.datasetId || isCodebookLoading || !codebookColumns.length) return
    let cancelled = false
    const entities = JSON.parse(visibleKey) as { kind: 'ma' | 'column'; id: string }[]
    const columns = entities.filter(e => e.kind === 'column').map(e => e.id)
    const groupIds = entities.filter(e => e.kind === 'ma').map(e => e.id)
    const key = JSON.stringify([inputKey, visibleKey])
    if (summaryInput.current !== key) {
      setSummaryData(null)
      setMaSummaries([])
      setMaWeight(null)
      setWeightMeta(null)
      summaryInput.current = key
    }
    setSummaryError(null)
    setLoadingSummaries(true)
    const weightName = codebookColumns.find((c) => c.columnId === weightColumnId)?.name
    const common = { datasetId: selection.datasetId, rowIds: effectiveRowIds, expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
      ...(weightName ? { weightColumn: weightName } : {}) }
    Promise.all([
      columns.length ? api.post<{ columns: Record<string, any>; selectedCountByCode?: Record<string, Record<string, number>> }>('/summaries', { ...common, columns, selectedRowIds: selection.selectedRowIds }) : Promise.resolve({ columns: {}, selectedCountByCode: {} }),
      groupIds.length ? api.post<MultiResponseSummaryResponse>('/summaries/multi-response', {
        ...common, groupIds, selectedRowIds: selection.selectedRowIds,
      }) : Promise.resolve({ groups: [] }),
    ]).then(([sa, ma]) => {
      if (!cancelled) {
        setSummaryData(sa.columns); setSelectedCounts(sa.selectedCountByCode ?? {}); setMaSummaries(ma.groups)
        setMaWeight(groupIds.length && 'weightStatus' in ma ? ma : null)
        const raw = sa as Record<string, any>
        setWeightMeta(raw.weightStatus ? {
          status: raw.weightStatus, columnName: raw.weightColumn,
          unweightedN: raw.unweightedN, weightedN: raw.weightedN,
          weightMissingCount: raw.weightMissingCount,
        } : null)
      }
    }).catch((error: { message?: string }) => {
      if (!cancelled) setSummaryError(error.message ?? '要約集計データの取得に失敗しました。')
    }).finally(() => { if (!cancelled) setLoadingSummaries(false) })
    return () => { cancelled = true }
  }, [viewMode, selection.datasetId, effectiveRowIds, schemaRevision, visibleKey, selection.selectedRowIds, isCodebookLoading, codebookColumns.length, weightColumnId])

  const selectMa = async (groupId: string, optionColumnIds: string[], predicate: string, status?: string, goToPcp?: boolean) => {
    const generation = ++matchGeneration.current
    const requestedInput = inputKey
    setMatching(true)
    setMatchError(null)
    try {
      const result = await api.post<{ rowIds: string[]; schemaRevision: number }>(`/datasets/${selection.datasetId}/matches`, {
        groupId, optionColumnIds, predicate, status, rowIds: effectiveRowIds, expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
      })
      if (generation !== matchGeneration.current || requestedInput !== currentInput.current || result.schemaRevision !== schemaRevision) return
      dispatch(selectionApplied({ rowIds: result.rowIds, operation: brushOp, label: `MA: ${groupId}` }))
      if (goToPcp) navigate('/pcp')
    } catch (error) {
      if (requestedInput === currentInput.current) setMatchError((error as { message?: string }).message ?? '回答者の選択に失敗しました。')
    } finally { if (generation === matchGeneration.current) setMatching(false) }
  }

  const handleSelectCategory = async (colName: string, code: string | number | null, label?: string) => {
    const column = getColumn(colName)
    if (!column) return
    const generation = ++matchGeneration.current
    const requestedInput = inputKey
    setMatching(true)
    setMatchError(null)
    try {
      const result = await api.post<{ rowIds: string[]; schemaRevision: number }>(`/datasets/${selection.datasetId}/column-matches`, {
        columnId: column.columnId, code: code === null ? null : normalizeCode(code), rowIds: effectiveRowIds, expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
      })
      if (generation !== matchGeneration.current || requestedInput !== currentInput.current || result.schemaRevision !== schemaRevision) return
      dispatch(selectionApplied({ rowIds: result.rowIds, operation: brushOp, label: `${column.label || colName} = ${label || code || '(欠損)'}` }))
    } catch (error) {
      if (requestedInput === currentInput.current) setMatchError((error as { message?: string }).message ?? '回答者の選択に失敗しました。')
    } finally { if (generation === matchGeneration.current) setMatching(false) }
  }

  const theme = useMemo(() => vizTheme(false), [])
  const { getColor } = useRowColorResolver(data)
  const domains = useL1ColorDomains(data)
  const domain = domains.find(d => d.key === pcp.colorBy)
  const groupBy = domain?.key ?? null

  /** Active row indexes via O(1) map lookups. */
  const activeIndexes = useMemo(() => {
    if (!data) return [] as number[]
    const out: number[] = []
    for (const id of effectiveRowIds) {
      const index = data.rowIndex.get(id)
      if (index !== undefined) out.push(index)
    }
    return out
  }, [data, effectiveRowIds])

  // Layout metrics in viewBox units. Horizontal: the title sits above each
  // panel's plot band (its own row), so it never overlaps points/boxes.
  // Vertical: minimum slot width keeps tick labels readable; beyond that the
  // frame scrolls horizontally instead of squeezing columns.
  const MIN_VERTICAL_SLOT = 150
  const width = orientation === 'horizontal'
    ? 900
    : Math.max(700, numericColumns.length * MIN_VERTICAL_SLOT + 120)
  const panelHeight = 128
  const PANEL_GAP = 28
  const height = orientation === 'horizontal'
    ? Math.max(220, 46 + numericColumns.length * (panelHeight + PANEL_GAP) + 16)
    : 470
  const plotLeft = 120
  const plotRight = width - 20

  /** Panels built once per data/selection change; box stats come from the
   *  engine (worker WASM) asynchronously and merge into the panels. */
  const [panelRows, setPanelRows] = useState<PanelData[]>([])
  const [loadingStats, setLoadingStats] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!data || !numericColumns.length || !activeIndexes.length) {
      setPanelRows([])
      setLoadingStats(false)
      return
    }
    const categories: (string | null)[] = domain ? [...domain.codes, null] : ['']
    const catRaw = groupBy ? data.columns[groupBy] ?? [] : null
    const next: PanelData[] = numericColumns.map((column: string) => {
      const arr = data.numeric[column]
      const rows: { id: string; v: number; index: number }[] = []
      let min = Infinity
      let max = -Infinity
      for (const index of activeIndexes) {
        const v = arr?.[index] ?? NaN
        if (!Number.isFinite(v)) continue
        rows.push({ id: data.rowIds[index], v, index })
        if (v < min) min = v
        if (v > max) max = v
      }
      const groups: GroupRows[] = categories.map((category, catIndex) => {
        const subset = groupBy
          ? rows.filter(({ index }) => { const slot = l1Index(domain, catRaw?.[index]); return category === null ? slot === null : slot === catIndex })
          : rows
        return {
          key: category ?? '(欠損)',
          code: category,
          color: groupBy && category !== null ? l1Color(theme, catIndex) : theme.contextLine,
          stats: null,
          rows: subset,
        }
      })
      return { column, min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max, groups }
    })
    setPanelRows(next)
    setLoadingStats(true)
    ;(async () => {
      try {
        const merged = next.map((panel) => ({
          ...panel,
          groups: panel.groups.map((group) => ({ ...group })),
        }))
        for (let pi = 0; pi < merged.length; pi += 1) {
          for (let gi = 0; gi < merged[pi].groups.length; gi += 1) {
            const group = merged[pi].groups[gi]
            if (!group.rows.length) continue
            const vals = new Float64Array(group.rows.length)
            for (let i = 0; i < group.rows.length; i += 1) vals[i] = group.rows[i].v
            const stats = await graphEngine.boxStats(vals)
            if (cancelled) return
            merged[pi].groups[gi].stats = stats ? { low: stats[0], q1: stats[1], median: stats[2], q3: stats[3], high: stats[4] } : null
          }
        }
        if (!cancelled) setPanelRows(merged)
      } finally {
        if (!cancelled) setLoadingStats(false)
      }
    })().catch(() => {
      if (!cancelled) setLoadingStats(false)
    })
    return () => { cancelled = true }
  }, [data, numericColumns.join('|'), activeIndexes, groupBy, theme, domain])

  // For vertical we need value→x and x→value helpers.
  const verticalSlots = numericColumns.length || 1
  const verticalSlotWidth = (plotRight - plotLeft) / verticalSlots

  /** Pointer position in viewBox units, accounting for native CTM inversion and aspect ratio letterboxing. */
  const eventPoint = (event: React.PointerEvent): { x: number; y: number } => {
    return getSvgPoint(svgRef.current, event, { width, height })
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (!svgRef.current) return
    const target = event.target as Element
    if (target.closest('circle, rect[data-selectable], rect.bar-hit')) {
      // Click on a selectable mark: let its own onClick handle it (audit #1).
      return
    }
    const pt = eventPoint(event)
    dragRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
    setDrag(dragRef.current)
    try { svgRef.current.setPointerCapture(event.pointerId) } catch { /* synthetic pointer */ }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current || !svgRef.current) return
    const pt = eventPoint(event)
    dragRef.current = { ...dragRef.current, x2: pt.x, y2: pt.y }
    setDrag(dragRef.current)
  }

  const onPointerUp = (_event: React.PointerEvent) => {
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!current || !data || !svgRef.current) return
    const rxLo = Math.min(current.x1, current.x2)
    const rxHi = Math.max(current.x1, current.x2)
    const ryLo = Math.min(current.y1, current.y2)
    const ryHi = Math.max(current.y1, current.y2)
    if (rxHi - rxLo < 5 && ryHi - ryLo < 5) return

    // Value interval covered by the rect on the VALUE axis of each panel.
    // Horizontal layout: value axis is X (rect's x extent); the rect selects
    // every panel whose row-band intersects the rect's y extent.
    // Vertical layout: value axis is Y; panels are columns along X.
    const hits = new Set<string>()
    for (const panel of panelRows) {
      let valueLo: number, valueHi: number, intersectsPanel: boolean
      if (orientation === 'horizontal') {
        valueLo = panel.min + ((rxLo - plotLeft) / (plotRight - plotLeft)) * (panel.max - panel.min)
        valueHi = panel.min + ((rxHi - plotLeft) / (plotRight - plotLeft)) * (panel.max - panel.min)
        const top = 46 + numericColumns.indexOf(panel.column) * (panelHeight + PANEL_GAP) + 18
        const bottom = top + panelHeight
        intersectsPanel = ryHi >= top && ryLo <= bottom
      } else {
        const slot = numericColumns.indexOf(panel.column)
        const left = plotLeft + slot * verticalSlotWidth
        const right = left + verticalSlotWidth
        intersectsPanel = rxHi >= left && rxLo <= right
        // Match renderVertical scaleY: v = min + ((innerBottom - y)/span)*(range).
        // Plot area y ∈ [34, height-46], clamped; y grows downward = value grows up.
        const innerTop = 34
        const innerBottom = height - 46
        const cLo = Math.min(innerBottom, Math.max(innerTop, ryLo))
        const cHi = Math.min(innerBottom, Math.max(innerTop, ryHi))
        valueLo = panel.min + ((innerBottom - cHi) / (innerBottom - innerTop)) * (panel.max - panel.min)
        valueHi = panel.min + ((innerBottom - cLo) / (innerBottom - innerTop)) * (panel.max - panel.min)
      }
      if (!intersectsPanel) continue
      const lo = Math.min(valueLo, valueHi)
      const hi = Math.max(valueLo, valueHi)
      // Vertical layout is a true 2D brush: x filters which category column
      // (box center ± spacing/2) each point sits in, y filters its value —
      // matching what the rect visually covers.
      const slot = numericColumns.indexOf(panel.column)
      const slotWidthV = (plotRight - plotLeft) / numericColumns.length
      const slotLeftV = plotLeft + slot * slotWidthV
      const nGroupsV = Math.max(1, panel.groups.length)
      const colSpacingV = (slotWidthV - 16) / nGroupsV
      const arr = data.numeric[panel.column]
      for (const index of activeIndexes) {
        const v = arr?.[index] ?? NaN
        if (!Number.isFinite(v) || v < lo || v > hi) continue
        if (orientation === 'vertical' && panel.groups.length > 1) {
          // find this row's group center and require it inside the rect x-range
          const gi = l1Index(domain, data.columns[groupKeyOf(panel)]?.[index]) ?? (domain?.codes.length ?? 0)
          if (gi >= 0) {
            const centerX = slotLeftV + 12 + gi * colSpacingV + colSpacingV / 2
            if (centerX < rxLo || centerX > rxHi) continue
          }
        }
        hits.add(data.rowIds[index])
      }
    }
    dispatch(selectionApplied({ rowIds: [...hits], operation: brushOp, label: '分布レンズ矩形選択' }))

  function groupKeyOf(_panel: PanelData): string {
    return groupBy ?? ''
  }
  }

  const selectedSet = new Set(selection.selectedRowIds)
  const hoveredId = selection.hoveredRowId

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

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  const renderHorizontal = () =>
    panelRows.map((panel, panelIndex) => {
      const innerLeft = plotLeft
      const innerRight = plotRight
      const scaleX = (value: number) =>
        innerLeft + ((value - panel.min) / (panel.max - panel.min || 1)) * (innerRight - innerLeft)
      // Title row above the plot band keeps the label clear of points and previous ticks.
      const panelTop = 46 + panelIndex * (panelHeight + PANEL_GAP) + 18
      const titleY = panelTop - 8
      const nGroups = panel.groups.length
      const rowSpacing = (panelHeight - 22) / Math.max(1, nGroups)
      return (
        <g key={panel.column}>
          <ColumnQuestionTooltip nameOrId={panel.column} svg><text x={innerLeft} y={titleY} fontSize={12} fontWeight={600} fill="#374151">{truncateText(panel.column, 24)}</text></ColumnQuestionTooltip>
          <line x1={innerLeft} y1={panelTop + panelHeight - 12} x2={innerRight} y2={panelTop + panelHeight - 12} stroke="#c3c2b7" strokeWidth={1} />
          {[panel.min, (panel.min + panel.max) / 2, panel.max].map((tick, ti) => (
            <g key={ti}>
              <line x1={scaleX(tick)} y1={panelTop + panelHeight - 12} x2={scaleX(tick)} y2={panelTop + panelHeight - 8} stroke="#c3c2b7" />
              <text x={scaleX(tick)} y={panelTop + panelHeight} textAnchor="middle" fontSize={10} fill="#6b7280">{Number(tick).toFixed(1)}</text>
            </g>
          ))}
          {panel.groups.map((group, gi) => {
            const centerY = panelTop + 12 + gi * rowSpacing + rowSpacing / 2
            const stats = group.stats
            return (
              <g key={JSON.stringify([panel.column, group.code])}>
                {group.key && (
                  <text x={112} y={centerY + 3} textAnchor="end" fontSize={10} fill="#52514e">
                    <title>{group.key}</title>
                    {truncateText(group.key.replace(/Iris-/, ''), 12)}
                  </text>
                )}
                {stats && (
                  <>
                    <line x1={scaleX(stats.low)} y1={centerY} x2={scaleX(stats.high)} y2={centerY} stroke={group.color} strokeWidth={1.2} opacity={0.75} />
                    <line x1={scaleX(stats.low)} y1={centerY - 5} x2={scaleX(stats.low)} y2={centerY + 5} stroke={group.color} />
                    <line x1={scaleX(stats.high)} y1={centerY - 5} x2={scaleX(stats.high)} y2={centerY + 5} stroke={group.color} />
                    <rect x={scaleX(stats.q1)} y={centerY - 7} width={Math.max(1, scaleX(stats.q3) - scaleX(stats.q1))} height={14} rx={2}
                      fill={group.color} opacity={0.18} stroke={group.color} strokeWidth={1.1} />
                    <line x1={scaleX(stats.median)} y1={centerY - 7} x2={scaleX(stats.median)} y2={centerY + 7} stroke={group.color} strokeWidth={2} />
                  </>
                )}
                {group.rows.map((row) => {
                  const isSelected = selectedSet.has(row.id)
                  const isHovered = hoveredId === row.id
                  return (
                    <circle data-selectable="true"
                      key={`${panel.column}-${row.id}`}
                      cx={scaleX(row.v)}
                      cy={centerY + signedNoiseViz(row.id, `${panel.column}-box`) * Math.min(10, rowSpacing * 0.35)}
                      r={isSelected ? 3.8 : isHovered ? 3.4 : 2.2}
                      fill={isSelected ? theme.selection : getColor(row.id)}
                      opacity={isSelected || isHovered ? 0.95 : 0.28}
                      stroke={isSelected ? theme.surface : getColor(row.id)}
                      strokeWidth={isSelected ? 1.4 : 0.3}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); dispatch(selectionApplied({ rowIds: [row.id], operation: 'toggle', label: '箱ひげ図から選択' })) }}
                      onMouseEnter={() => dispatch(hoverAction(row.id))}
                      onMouseLeave={() => dispatch(hoverAction(null))}
                    >
                      <title>{`${row.id}: ${row.v.toFixed(2)}`}</title>
                    </circle>
                  )
                })}
              </g>
            )
          })}
        </g>
      )
    })

  const renderVertical = () =>
    panelRows.map((panel) => {
      const slot = numericColumns.indexOf(panel.column)
      const slotWidth = (plotRight - plotLeft) / numericColumns.length
      const innerTop = 34
      const innerBottom = height - 46
      const scaleY = (value: number) =>
        innerBottom - ((value - panel.min) / (panel.max - panel.min || 1)) * (innerBottom - innerTop)
      const slotLeft = plotLeft + slot * slotWidth
      const nGroups = panel.groups.length
      const colSpacing = (slotWidth - 16) / Math.max(1, nGroups)
      const titleLength = Math.max(4, Math.floor((slotWidth - 16) / 10))
      return (
        <g key={panel.column}>
          <ColumnQuestionTooltip nameOrId={panel.column} svg><text x={slotLeft + slotWidth / 2} y={18} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151">
            {truncateText(panel.column, titleLength)}
          </text></ColumnQuestionTooltip>
          <line x1={slotLeft + 8} y1={innerTop} x2={slotLeft + 8} y2={innerBottom} stroke="#c3c2b7" strokeWidth={1} />
          <line x1={slotLeft + 8} y1={innerBottom} x2={slotLeft + slotWidth - 8} y2={innerBottom} stroke="#c3c2b7" strokeWidth={1} />
          {[panel.min, (panel.min + panel.max) / 2, panel.max].map((tick, ti) => (
            <g key={ti}>
              <line x1={slotLeft + 8} y1={scaleY(tick)} x2={slotLeft + 4} y2={scaleY(tick)} stroke="#c3c2b7" />
              <text x={slotLeft + 2} y={scaleY(tick) + 3} textAnchor="end" fontSize={10} fill="#6b7280">{Number(tick).toFixed(1)}</text>
            </g>
          ))}
          {panel.groups.map((group, gi) => {
            const centerX = slotLeft + 12 + gi * colSpacing + colSpacing / 2
            const stats = group.stats
            return (
              <g key={JSON.stringify([panel.column, group.code])}>
                {group.key && (
                  <text x={centerX} y={height - 30} textAnchor="middle" fontSize={9} fill="#52514e">
                    {group.key.replace(/Iris-/, '').slice(0, 6)}
                  </text>
                )}
                {stats && (
                  <>
                    <line x1={centerX} y1={scaleY(stats.low)} x2={centerX} y2={scaleY(stats.high)} stroke={group.color} strokeWidth={1.2} opacity={0.75} />
                    <line x1={centerX - 5} y1={scaleY(stats.low)} x2={centerX + 5} y2={scaleY(stats.low)} stroke={group.color} />
                    <line x1={centerX - 5} y1={scaleY(stats.high)} x2={centerX + 5} y2={scaleY(stats.high)} stroke={group.color} />
                    <rect x={centerX - 7} y={scaleY(stats.q3)} width={14} height={Math.max(1, scaleY(stats.q1) - scaleY(stats.q3))} rx={2}
                      fill={group.color} opacity={0.18} stroke={group.color} strokeWidth={1.1} />
                    <line x1={centerX - 7} y1={scaleY(stats.median)} x2={centerX + 7} y2={scaleY(stats.median)} stroke={group.color} strokeWidth={2} />
                  </>
                )}
                {group.rows.map((row) => {
                  const isSelected = selectedSet.has(row.id)
                  const isHovered = hoveredId === row.id
                  return (
                    <circle data-selectable="true"
                      key={`${panel.column}-${row.id}`}
                      cx={centerX + signedNoiseViz(row.id, `${panel.column}-boxv`) * Math.min(10, colSpacing * 0.35)}
                      cy={scaleY(row.v)}
                      r={isSelected ? 3.8 : isHovered ? 3.4 : 2.2}
                      fill={isSelected ? theme.selection : getColor(row.id)}
                      opacity={isSelected || isHovered ? 0.95 : 0.28}
                      stroke={isSelected ? theme.surface : getColor(row.id)}
                      strokeWidth={isSelected ? 1.4 : 0.3}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); dispatch(selectionApplied({ rowIds: [row.id], operation: 'toggle', label: '箱ひげ図から選択' })) }}
                      onMouseEnter={() => dispatch(hoverAction(row.id))}
                      onMouseLeave={() => dispatch(hoverAction(null))}
                    >
                      <title>{`${row.id}: ${row.v.toFixed(2)}`}</title>
                    </circle>
                  )
                })}
              </g>
            )
          })}
        </g>
      )
    })

  return (
    <div data-testid="distribution-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top Toolbar Card */}
        <Card size="small" style={{ background: '#fafafa' }}>
          <Row gutter={[12, 8]} align="middle" justify="space-between">
            <Col>
              <Space wrap align="center">
                <Segmented
                  data-testid="dist-view-mode"
                  size="small"
                  options={[
                    { label: '設問別分布カード', value: 'cards' },
                    { label: '箱ひげ図 (Box Plot)', value: 'boxplot' },
                    { label: '正規Q-Qプロット (QQ-Plot)', value: 'qqplot' },
                  ]}
                  value={viewMode}
                  onChange={(v) => setViewMode(v as 'cards' | 'boxplot' | 'qqplot')}
                />
                {viewMode === 'cards' && (
                  <Segmented
                    data-testid="cards-role-filter"
                    size="small"
                    options={[
                      { label: '全変数', value: 'all' },
                      { label: '設問のみ', value: 'question' },
                      { label: '属性のみ', value: 'attribute' },
                    ]}
                    value={cardsRoleFilter}
                    onChange={(v) => setCardsRoleFilter(v as 'all' | 'question' | 'attribute')}
                  />
                )}
                {viewMode === 'boxplot' && (
                    <Segmented
                      data-testid="dist-orientation"
                      size="small"
                      options={[
                        { label: '水平配置 (変数列が縦)', value: 'horizontal' },
                        { label: '垂直配置 (変数列が横)', value: 'vertical' },
                      ]}
                      value={orientation}
                      onChange={(v) => setOrientation(v as 'horizontal' | 'vertical')}
                    />
                )}
              </Space>
            </Col>
            <Col>
              <Space size={6}>
                <Tag color={groupBy ? 'blue' : 'default'} style={{ margin: 0 }}>
                  色分け: <ColumnQuestionTooltip nameOrId={groupBy ?? ''}>{groupBy ?? 'なし（単色）'}</ColumnQuestionTooltip>
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ドラッグで範囲選択 · クリックで選択toggle · 右クリックでメニュー
                </Typography.Text>
              </Space>
            </Col>
          </Row>
        </Card>

      {/* Summary KPI Cards */}
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="分析数値変数"
                value={viewMode === 'cards' ? cardColumns.filter(name => ['interval', 'ratio'].includes(getColumn(name)?.scaleType ?? '')).length : numericColumns.length}
                prefix={<BarChartOutlined />}
                suffix="軸"
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="カテゴリ変数"
                value={viewMode === 'cards' ? cardEntities.filter(e => e.kind === 'ma' || !['interval', 'ratio'].includes(getColumn(e.id)?.scaleType ?? '')).length : categoricalColumns.length}
                prefix={<TableOutlined />}
                suffix="列"
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="有効データ件数"
                value={effectiveRowIds.length}
                prefix={<CheckCircleOutlined />}
                suffix={`/ ${selection.allRowIds.length} 行`}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="PCP連動色分け"
                value={groupBy ? `${groupBy} (${domain?.codes.length ?? 0}水準)` : '単色表示'}
                formatter={() => <ColumnQuestionTooltip nameOrId={groupBy ?? ''}>{groupBy ? `${groupBy} (${domain?.codes.length ?? 0}水準)` : '単色表示'}</ColumnQuestionTooltip>}
                prefix={<SlidersOutlined />}
                valueStyle={{ fontSize: 14 }}
              />
            </Card>
          </Col>
        </Row>

      {viewMode === 'qqplot' ? (
        <QQPlotView />
      ) : viewMode === 'cards' ? (
        loadingSummaries && !summaryData ? (
          <div style={{ textAlign: 'center', padding: 48 }} data-testid="cards-loading">
            <Spin tip="設問分布データを集計中..."><div style={{ height: 80 }} /></Spin>
          </div>
        ) : summaryError ? (
          <Alert
            type="error"
            message="設問分布データの取得に失敗しました。"
            description={summaryError}
            showIcon
          />
        ) : cardEntities.length === 0 ? (
          <EmptyStatePanel message="表示可能な設問がありません。変数選択またはフィルタをご確認ください。" />
        ) : (
          <div data-testid="question-cards-container" style={{ padding: '4px 0' }}>
            {matchError && <Alert type="error" message={matchError} showIcon />}
            <Pagination size="small" current={Math.min(cardPage, Math.max(1, Math.ceil(cardEntities.length / 12)))}
              pageSize={12} total={cardEntities.length} showSizeChanger={false} onChange={setCardPage} style={{ marginBottom: 12 }} />
            <Row gutter={[16, 16]}>
              {visibleEntities.map((entity) => {
                if (entity.kind === 'ma') {
                  const summary = maSummaries.find(g => g.groupId === entity.id)
                  return summary ? <Col key={`ma:${entity.id}`} xs={24} lg={12}>
                    <MultiResponseCard summary={summary} loading={matching} weight={maWeight}
                      onSelect={(ids, predicate, status, goToPcp) => void selectMa(entity.id, ids, predicate, status, goToPcp)} />
                  </Col> : null
                }
                const colName = entity.id
                const colMeta = getColumn(colName)
                const colSum = summaryData?.[colName] || {}
                const selectedCountByCode = selectedCounts[colName] || {}
                const cardProps: ComponentProps<typeof QuestionCard> & { selectedCountByCode: Record<string, number> } = {
                  summary: {
                    columnId: colName,
                    semanticType: colMeta?.scaleType,
                    denominators: colSum.denominators,
                    distribution: colSum.distribution,
                    auxiliaryStats: colSum.auxiliaryStats,
                    min: colSum.min,
                    max: colSum.max,
                    mean: colSum.mean,
                    median: colSum.median,
                    weighted: colSum.weighted ?? null,
                    weight: weightMeta ? {
                      status: weightMeta.status, columnName: weightMeta.columnName,
                      unweightedN: weightMeta.unweightedN, weightedN: weightMeta.weightedN,
                      weightMissingCount: weightMeta.weightMissingCount,
                    } : null,
                  },
                  codebookColumn: colMeta,
                  selectedCountByCode,
                  onSelectCategory: (code, label) => handleSelectCategory(colName, code, label),
                }
                return (
                  <Col key={colName} xs={24} lg={12}>
                    <QuestionCard {...cardProps} />
                  </Col>
                )
              })}
            </Row>
          </div>
        )
      ) : numericColumns.length === 0 ? (
        <EmptyStatePanel message="分布プロットには1つ以上の数値変数が必要です。上部の変数セレクタから追加してください。" />
      ) : (
        <>
          {!domain && <Alert type="info" message="L1色分け列が未選択のため単色表示です。" />}
          <GraphPanel
            graphId="distribution/boxplot"
            title="分布・箱ひげ図"
            available={viewMode === 'boxplot' && numericColumns.length > 0}
            sizing="intrinsic"
            intrinsicSize={{ width, height }}
            controls={(
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <L1Legend />
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ドラッグで範囲選択 · クリックで選択toggle · 右クリックでメニュー
                </Typography.Text>
              </div>
            )}
          >
            <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
              <div
                data-testid="distribution-scroll"
                style={{
                  position: 'relative',
                  minHeight: 380,
                  overflow: 'visible',
                  outline: '1px solid #e5e7eb',
                  outlineOffset: -1,
                  borderRadius: 6,
                  background: '#fff',
                  userSelect: 'none',
                  boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.03)',
                }}
              >
      {loadingStats && (
                  <div
                    role="status"
                    aria-live="polite"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 30,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(255, 255, 255, 0.75)',
                      backdropFilter: 'blur(2px)',
                      gap: 12,
                    }}
                  >
                    <Spin size="large" tip="分布統計（BoxPlot）を計算中..." />
                  </div>
                )}
                <svg
                  ref={svgRef}
                  data-testid="distribution-svg"
                  viewBox={`0 0 ${width} ${height}`}
                  width={width}
                  height={height}
                  style={{ display: 'block', width, height, maxWidth: width, touchAction: 'none' }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                >
                  {orientation === 'horizontal' ? renderHorizontal() : renderVertical()}
                  {drag && (
                    <rect
                      x={Math.min(drag.x1, drag.x2)}
                      y={Math.min(drag.y1, drag.y2)}
                      width={Math.abs(drag.x2 - drag.x1)}
                      height={Math.abs(drag.y2 - drag.y1)}
                      fill="rgba(42,120,214,0.15)"
                      stroke="#2a78d6"
                      strokeWidth={1.5}
                      style={{ pointerEvents: 'none' }}
                    />
                  )}
                </svg>
              </div>
            </Dropdown>
          </GraphPanel>
        </>
      )}
    </div>
  )
}
