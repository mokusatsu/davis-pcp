import { useQuestionText } from '../common/ColumnQuestionTooltip'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Card, Col, Dropdown, Row, Segmented, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { CheckCircleOutlined, DotChartOutlined, SwapOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, hovered as hoverAction, selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { graphEngine } from '../../engine/graphClient'
import { vizTheme } from '../../theme/viz'
import { getBrushOp, useBrushOp } from '../selection/SelectionMenu'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { getSvgPoint } from '../../utils/svgCoordinates'
import { truncateText } from '../../utils/textUtils'
import { useRowColorResolver } from '../../theme/useRowColor'
import EmptyStatePanel from '../common/EmptyStatePanel'

interface FacetPoint { x: number; y: number; id: string }

/** Facet scatter matrix + correlation heatmap; cell click = variable-pair focus. */
export default function RelationshipsPage() {
  const questionText = useQuestionText()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const { focused, isTargetActive } = useFocusMode()
  const data = useColumnarData(selection.datasetId)
  const [corr, setCorr] = useState<{ columns: string[]; matrix: Float64Array } | null>(null)
  const [focusPair, setFocusPair] = useState<[string, string] | null>(null)
  // Pair plot sizing: 'fit' scales the whole matrix to the container; 'iris'
  // keeps the Iris-standard cell size (5 columns) and scrolls for more.
  const [pairSizeMode, setPairSizeMode] = useState<'fit' | 'iris'>('fit')

  // Reset focusPair when datasetId changes.
  useEffect(() => {
    setFocusPair(null)
  }, [selection.datasetId])

  const globalVars = useSelector((s: RootState) => s.globalVariables)
  const activeVarIds = globalVars?.activeVariableIds

  // Filter numeric columns: semanticType === 'numeric' AND in activeVariableIds (if activeVariableIds is non-empty)
  const numericColumns = useMemo(() => {
    if (!data) return []
    return data.schema
      .filter((c) => c.semanticType === 'numeric' && (!activeVarIds || activeVarIds.length === 0 || activeVarIds.includes(c.name)))
      .map((c) => c.name)
      .filter((name) => {
        const arr = data.numeric[name]
        if (!arr) return false
        for (let i = 0; i < arr.length; i += 1) {
          if (Number.isFinite(arr[i])) return true
        }
        return false
      })
  }, [data, activeVarIds])

  // If focusPair refers to columns no longer in numericColumns, clear it
  useEffect(() => {
    if (!focusPair) {
      if (numericColumns.length >= 2) {
        setFocusPair([numericColumns[0], numericColumns[1]])
      }
      return
    }
    if (!numericColumns.includes(focusPair[0]) || !numericColumns.includes(focusPair[1])) {
      setFocusPair(numericColumns.length >= 2 ? [numericColumns[0], numericColumns[1]] : null)
    }
  }, [numericColumns, focusPair])

  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  // Scope-filtered active row indexes (O(active), no per-row object building).
  const activeIndexes = useMemo(() => {
    if (!data) return [] as number[]
    const out: number[] = []
    for (const id of effectiveRowIds) {
      const index = data.rowIndex.get(id)
      if (index !== undefined) out.push(index)
    }
    return out
  }, [data, effectiveRowIds])

  const [loadingCorr, setLoadingCorr] = useState(false)

  // Correlation heatmap via the WASM engine (worker): columnar k×n input.
  useEffect(() => {
    let cancelled = false
    if (!data || !numericColumns.length || !activeIndexes.length) {
      setCorr(null)
      setLoadingCorr(false)
      return
    }
    setLoadingCorr(true)
    ;(async () => {
      try {
        const k = numericColumns.length
        const values = new Float64Array(activeIndexes.length * k)
        for (let r = 0; r < activeIndexes.length; r += 1) {
          const src = activeIndexes[r]
          for (let c = 0; c < k; c += 1) {
            values[r * k + c] = data.numeric[numericColumns[c]]?.[src] ?? NaN
          }
        }
        const matrix = await graphEngine.correlationMatrix(values, activeIndexes.length, k)
        if (!cancelled) setCorr({ columns: [...numericColumns], matrix })
      } catch {
        if (!cancelled) setCorr(null)
      } finally {
        if (!cancelled) setLoadingCorr(false)
      }
    })().catch(() => {
      if (!cancelled) {
        setCorr(null)
        setLoadingCorr(false)
      }
    })
    return () => { cancelled = true }
  }, [data, numericColumns.join('|'), activeIndexes])

  const currentCorrValue = useMemo(() => {
    if (!corr || !focusPair) return null
    const i = corr.columns.indexOf(focusPair[0])
    const j = corr.columns.indexOf(focusPair[1])
    if (i < 0 || j < 0) return null
    const v = (corr.matrix as Float64Array)[i * corr.columns.length + j]
    return Number.isFinite(v) ? v : null
  }, [corr, focusPair])

  const facetPoints = useMemo<FacetPoint[]>(() => {
    if (!data || !focusPair) return []
    const [cx, cy] = focusPair
    const xVals = data.numeric[cx]
    const yVals = data.numeric[cy]
    const points: FacetPoint[] = []
    for (const index of activeIndexes) {
      const x = xVals?.[index] ?? NaN
      const y = yVals?.[index] ?? NaN
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      points.push({ x, y, id: data.rowIds[index] })
    }
    return points
  }, [data, focusPair, activeIndexes])


  const theme = vizTheme(false)
  // Facet plot fills the container width as a square: measured via ResizeObserver.
  const facetFrameRef = useRef<HTMLDivElement>(null)
  const [facetContainerWidth, setFacetContainerWidth] = useState(480)
  useEffect(() => {
    const frame = facetFrameRef.current
    if (!frame) return
    const observer = new ResizeObserver(() => setFacetContainerWidth(Math.max(240, frame.clientWidth)))
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])
  const size = facetContainerWidth
  // Heatmap cells never shrink below MIN_CELL px: with more columns the
  // matrix grows and scrolls horizontally instead of becoming unreadable.
  const MIN_CELL = 46
  const labelMargin = 110
  const cellCount = corr?.columns.length ?? 1
  const heatSize = Math.max(530, labelMargin + cellCount * MIN_CELL)
  const cellSize = (heatSize - labelMargin) / Math.max(1, cellCount)
  const selectedSet = new Set(selection.selectedRowIds)

  const facetXRange = focusPair && data
    ? (() => {
      const vals = facetPoints.map((p) => p.x)
      return { min: Math.min(...vals), max: Math.max(...vals) }
    })()
    : null
  const facetYRange = focusPair && data
    ? (() => {
      const vals = facetPoints.map((p) => p.y)
      return { min: Math.min(...vals), max: Math.max(...vals) }
    })()
    : null

  const shortName = (name: string, maxLen: number = 8) => truncateText(name.replace(/_cm$/, '').replace(/_/g, ' '), maxLen)

  /** Pair plot: scatter matrix over numeric columns; diagonal = histogram.
   *  'fit': whole matrix scales down to fit (cells shrink for many columns).
   *  'iris': Iris-standard cell size kept constant — the matrix grows and
   *  the container scrolls horizontally instead of shrinking cells. */
  const IRIS_PAIR_COLUMNS = 5
  const pairCell = pairSizeMode === 'iris'
    ? Math.round((640 - 110) / IRIS_PAIR_COLUMNS)
    : Math.max(60, Math.round(780 / Math.max(1, numericColumns.length)))
  const pairLabel = 70
  const pairSize = pairLabel + numericColumns.length * pairCell
  const pairMaxWidth = pairSizeMode === 'iris' ? undefined : pairSize
  const selectedPairSet = new Set(selection.selectedRowIds)
  /** Per numeric column: active+finite row indexes and value range. */
  const pairPoints = useMemo(() => {
    if (!data) return new Map<string, { indexes: number[]; ids: string[]; min: number; max: number }>()
    const out = new Map<string, { indexes: number[]; ids: string[]; min: number; max: number }>()
    for (const col of numericColumns) {
      const arr = data.numeric[col]
      const indexes: number[] = []
      const ids: string[] = []
      let min = Infinity
      let max = -Infinity
      for (const index of activeIndexes) {
        const v = arr?.[index] ?? NaN
        if (!Number.isFinite(v)) continue
        indexes.push(index)
        ids.push(data.rowIds[index])
        if (v < min) min = v
        if (v > max) max = v
      }
      out.set(col, { indexes, ids, min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max })
    }
    return out
  }, [data, numericColumns, activeIndexes])
  const pairRange = useMemo(() => {
    const entries: [string, { min: number; max: number }][] = []
    pairPoints.forEach((v, col) => entries.push([col, { min: v.min, max: v.max }]))
    return Object.fromEntries(entries)
  }, [pairPoints])
  const { getColor } = useRowColorResolver()
  const pairColorOf = useMemo(() => (id: string) => getColor(id), [getColor])

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

  /** Rect brush on the pair plot (PCP-parity): drag over any cell selects the
   *  rows whose (x,y) fall inside the rect in that cell's value space.
   *  dragRef mirrors state so rapid pointer events never read stale values. */
  const pairSvgRef = useRef<SVGSVGElement>(null)
  const [pairDrag, setPairDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const pairDragRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [brushOpOp] = useBrushOp() as ['add' | 'replace' | 'subtract' | 'toggle', (v: never) => void]

  const pairEventPoint = (event: React.PointerEvent): { x: number; y: number } => {
    return getSvgPoint(pairSvgRef.current, event, { width: pairSize, height: pairSize })
  }

  const onPairPointerDown = (event: React.PointerEvent) => {
    if (!pairSvgRef.current || event.button !== 0) return
    const target = event.target as Element
    if (target.closest('circle, rect[data-selectable], rect.bar-hit')) {
      // Click on a selectable mark: let its own onClick handle it (audit #1).
      return
    }
    const pt = pairEventPoint(event)
    // ignore drags starting on labels margin
    if (pt.x < pairLabel || pt.y < pairLabel) return
    pairDragRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
    setPairDrag(pairDragRef.current)
    try { pairSvgRef.current.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
  }

  const onPairPointerMove = (event: React.PointerEvent) => {
    if (!pairDragRef.current || !pairSvgRef.current) return
    const pt = pairEventPoint(event)
    pairDragRef.current = { ...pairDragRef.current, x2: pt.x, y2: pt.y }
    setPairDrag(pairDragRef.current)
  }

  const onPairPointerUp = async (_event: React.PointerEvent) => {
    const cur = pairDragRef.current
    pairDragRef.current = null
    setPairDrag(null)
    if (!cur || !data) return
    if (Math.abs(cur.x2 - cur.x1) < 5 && Math.abs(cur.y2 - cur.y1) < 5) return
    const rxLo = Math.min(cur.x1, cur.x2), rxHi = Math.max(cur.x1, cur.x2)
    const ryLo = Math.min(cur.y1, cur.y2), ryHi = Math.max(cur.y1, cur.y2)
    const ixLo = Math.floor((rxLo - pairLabel) / pairCell)
    const ixHi = Math.floor((rxHi - pairLabel) / pairCell)
    const iyLo = Math.floor((ryLo - pairLabel) / pairCell)
    const iyHi = Math.floor((ryHi - pairLabel) / pairCell)
    const hits = new Set<string>()
    for (const iy of range(iyLo, iyHi)) {
      for (const ix of range(ixLo, ixHi)) {
        if (iy < 0 || iy >= numericColumns.length || ix < 0 || ix >= numericColumns.length) continue
        const colX = numericColumns[ix], colY = numericColumns[iy]
        if (colX === colY) continue // diagonal has no per-row points
        const px = pairPoints.get(colX)
        const py = pairPoints.get(colY)
        if (!px || !py || !px.indexes.length) continue
        const xr = pairRange[colX], yr = pairRange[colY]
        const cellX0 = pairLabel + ix * pairCell + 4
        const cellX1 = pairLabel + ix * pairCell + pairCell - 6
        const cellY0 = pairLabel + iy * pairCell + 4
        const cellY1 = pairLabel + iy * pairCell + pairCell - 4
        if (cellX1 <= cellX0 || cellY1 <= cellY0) continue
        const vxLo = xr.min + ((Math.max(rxLo, cellX0) - cellX0) / (cellX1 - cellX0)) * (xr.max - xr.min)
        const vxHi = xr.min + ((Math.min(rxHi, cellX1) - cellX0) / (cellX1 - cellX0)) * (xr.max - xr.min)
        const vyHi = yr.min + ((cellY1 - Math.max(ryLo, cellY0)) / (cellY1 - cellY0)) * (yr.max - yr.min)
        const vyLo = yr.min + ((cellY1 - Math.min(ryHi, cellY1)) / (cellY1 - cellY0)) * (yr.max - yr.min)
        // Rows where BOTH columns are finite, aligned as [row][xv,yv].
        const xCol = data.numeric[colX]
        const yCol = data.numeric[colY]
        const validIds: string[] = []
        const validVals: number[] = []
        for (let r = 0; r < px.ids.length; r += 1) {
          const id = px.ids[r]
          const rowIdx = px.indexes[r]
          const xv = xCol?.[rowIdx] ?? NaN
          const yv = yCol?.[rowIdx] ?? NaN
          if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue
          validIds.push(id)
          validVals.push(xv, yv)
        }
        const m = validIds.length
        if (!m) continue
        const vals = Float64Array.from(validVals)
        const both = new Uint8Array(m).fill(1)
        const hitIndices = await graphEngine.scatterHit(vals, m,
          { x1: Math.min(vxLo, vxHi), y1: Math.min(vyLo, vyHi), x2: Math.max(vxLo, vxHi), y2: Math.max(vyLo, vyHi) },
          both)
        for (const idx of hitIndices) {
          if (idx >= 0 && idx < m) hits.add(validIds[idx])
        }
      }
    }
    dispatch(selectionApplied({ rowIds: [...hits], operation: brushOpOp, label: 'ペアプロット矩形選択' }))
  }

  function range(a: number, b: number): number[] {
    const out: number[] = []
    for (let i = a; i <= b; i++) out.push(i)
    return out
  }

  /** Rect brush on the facet plot (AGENTS.md R3). */
  const facetSvgRef = useRef<SVGSVGElement>(null)
  const [facetDrag, setFacetDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const facetDragRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

  const onFacetPointerDown = (event: React.PointerEvent) => {
    if (!facetSvgRef.current || event.button !== 0) return
    if ((event.target as Element).closest('circle')) return // let point clicks through
    const pt = getSvgPoint(facetSvgRef.current, event, { width: size, height: size })
    facetDragRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
    setFacetDrag(facetDragRef.current)
    try { facetSvgRef.current.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
  }

  const onFacetPointerMove = (event: React.PointerEvent) => {
    if (!facetDragRef.current || !facetSvgRef.current) return
    const pt = getSvgPoint(facetSvgRef.current, event, { width: size, height: size })
    facetDragRef.current = {
      ...facetDragRef.current,
      x2: pt.x,
      y2: pt.y,
    }
    setFacetDrag(facetDragRef.current)
  }

  const onFacetPointerUp = async (_event: React.PointerEvent) => {
    const cur = facetDragRef.current
    facetDragRef.current = null
    setFacetDrag(null)
    if (!cur || !data || !focusPair || !facetXRange || !facetYRange) return
    if (Math.abs(cur.x2 - cur.x1) < 5 && Math.abs(cur.y2 - cur.y1) < 5) return
    const pxLo = Math.min(cur.x1, cur.x2), pxHi = Math.max(cur.x1, cur.x2)
    const pyLo = Math.min(cur.y1, cur.y2), pyHi = Math.max(cur.y1, cur.y2)
    // plot margins used by the render: x from 30 to size-20, y inverted with margin 30
    const vxLo = facetXRange.min + ((pxLo - 30) / (size - 50)) * (facetXRange.max - facetXRange.min)
    const vxHi = facetXRange.min + ((pxHi - 30) / (size - 50)) * (facetXRange.max - facetXRange.min)
    const vyHi = facetYRange.min + ((size - 30 - pyLo) / (size - 50)) * (facetYRange.max - facetYRange.min)
    const vyLo = facetYRange.min + ((size - 30 - pyHi) / (size - 50)) * (facetYRange.max - facetYRange.min)
    const nRows = facetPoints.length
    if (!nRows) return
    const values = new Float64Array(nRows * 2)
    for (let i = 0; i < nRows; i += 1) {
      values[i * 2] = facetPoints[i].x
      values[i * 2 + 1] = facetPoints[i].y
    }
    const active = new Uint8Array(nRows).fill(1)
    const hitIdxs = await graphEngine.scatterHit(values, nRows,
      { x1: Math.min(vxLo, vxHi), y1: Math.min(vyLo, vyHi), x2: Math.max(vxLo, vxHi), y2: Math.max(vyLo, vyHi) },
      active)
    dispatch(selectionApplied({ rowIds: hitIdxs.map((i) => facetPoints[i].id), operation: getBrushOp(), label: 'ファセット矩形選択' }))
  }

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  if (numericColumns.length < 2) {
    return (
      <div data-testid="relationships-page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Space wrap>
          <FocusEnterButton />
        </Space>
        <EmptyStatePanel
          message="散布図行列には2つ以上の数値変数が必要です。"
          description={
            numericColumns.length === 1
              ? `現在の有効な数値列は1列（${numericColumns[0]}）のみです。上部の変数セレクタから数値変数を追加してください。`
              : '上部の変数セレクタから数値変数を2つ以上選択してください。'
          }
          minVariables={2}
        />
      </div>
    )
  }

  return (
    <div
      data-testid="relationships-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : 'none',
        minHeight: focused ? 0 : undefined,
      }}
    >
      {/* Top Toolbar Card */}
      {!focused && (
        <Card size="small" style={{ background: '#fafafa' }}>
          <Row gutter={[12, 8]} align="middle" justify="space-between">
            <Col>
              <Space wrap align="center">
                <Segmented
                  data-testid="pair-size-mode"
                  size="small"
                  options={[{ label: '全体表示 (Fit)', value: 'fit' }, { label: 'Iris基準サイズ', value: 'iris' }]}
                  value={pairSizeMode}
                  onChange={(v) => setPairSizeMode(v as 'fit' | 'iris')}
                />
                {focusPair && (
                  <Space size={4}>
                    <Typography.Text style={{ fontSize: 12 }}>焦点ペア:</Typography.Text>
                    <Select
                      size="small"
                      style={{ width: 120 }}
                      value={focusPair[0]}
                      onChange={(x) => setFocusPair([x, focusPair[1]])}
                      options={numericColumns.map((c) => ({ label: c, value: c }))}
                    />
                    <SwapOutlined style={{ color: '#888' }} />
                    <Select
                      size="small"
                      style={{ width: 120 }}
                      value={focusPair[1]}
                      onChange={(y) => setFocusPair([focusPair[0], y])}
                      options={numericColumns.map((c) => ({ label: c, value: c }))}
                    />
                  </Space>
                )}
              </Space>
            </Col>
            <Col>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                ドラッグ=矩形範囲選択 · 点クリック=toggle · ヒートマップセルクリック=ペア焦点
              </Typography.Text>
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
                title="分析数値変数"
                value={numericColumns.length}
                prefix={<DotChartOutlined />}
                suffix="軸"
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="焦点ペア"
                value={focusPair ? `${focusPair[0]} × ${focusPair[1]}` : '未選択'}
                prefix={<SwapOutlined />}
                valueStyle={{ fontSize: 14 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>ペア相関係数 r</div>
              {currentCorrValue !== null ? (
                <Space align="baseline">
                  <span style={{ fontSize: 20, fontWeight: 600, color: currentCorrValue >= 0 ? '#1677ff' : '#cf1322' }}>
                    {currentCorrValue.toFixed(3)}
                  </span>
                  <Tag color={Math.abs(currentCorrValue) > 0.7 ? 'red' : Math.abs(currentCorrValue) > 0.4 ? 'orange' : 'default'}>
                    {Math.abs(currentCorrValue) > 0.7 ? '強相関' : Math.abs(currentCorrValue) > 0.4 ? '中相関' : '弱・無相関'}
                  </Tag>
                </Space>
              ) : (
                <span style={{ fontSize: 18, color: '#8c8c8c' }}>—</span>
              )}
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="分析対象行"
                value={activeIndexes.length}
                prefix={<CheckCircleOutlined />}
                suffix={`/ ${data?.rowIds.length ?? 0} 行`}
              />
            </Card>
          </Col>
        </Row>
      )}

      {(!focused || isTargetActive('pair-plot')) && (
      <div style={{ display: 'flex', flexDirection: 'column', flex: isTargetActive('pair-plot') ? 1 : 'none', flexShrink: 0, height: isTargetActive('pair-plot') ? '100%' : undefined, minHeight: isTargetActive('pair-plot') ? 0 : undefined }}>
        {!focused && (
          <Space wrap style={{ marginBottom: 6 }} align="center">
            <Typography.Title level={5} style={{ margin: 0 }}>対散布図行列（ペアプロット）</Typography.Title>
            <FocusEnterButton targetId="pair-plot" title="ペアプロット（散布図行列）" />
          </Space>
        )}
        <FocusTarget id="pair-plot" title="ペアプロット（散布図行列）">
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={() => document.body}>
        <div
          data-testid="pair-plot-scroll"
          style={{
            position: 'relative',
            flex: isTargetActive('pair-plot') ? 1 : 'none',
            height: isTargetActive('pair-plot') ? '100%' : undefined,
            minHeight: isTargetActive('pair-plot') ? undefined : 420,
            overflowX: isTargetActive('pair-plot') ? 'visible' : 'auto',
            overflowY: 'visible',
            border: isTargetActive('pair-plot') ? 'none' : '1px solid #e5e7eb',
            borderRadius: isTargetActive('pair-plot') ? 0 : 6,
            background: '#fff',
            width: pairSizeMode === 'iris' ? '100%' : undefined,
            userSelect: 'none',
            boxShadow: isTargetActive('pair-plot') ? 'none' : '0 1px 2px 0 rgba(0, 0, 0, 0.03)',
          }}
        >
        {loadingCorr && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'absolute', inset: 0, zIndex: 30,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(255, 255, 255, 0.75)', backdropFilter: 'blur(2px)',
              gap: 12,
            }}
          >
            <Spin size="large" tip="相関行列および散布図データを計算中..." />
          </div>
        )}
        <svg
          ref={pairSvgRef}
          data-testid="pair-plot"
          width={pairSize} height={pairSize} viewBox={`0 0 ${pairSize} ${pairSize}`}
          style={{ width: '100%', maxWidth: isTargetActive('pair-plot') ? 'min(100%, calc(100vh - 100px))' : (pairSizeMode === 'iris' ? 'none' : pairMaxWidth), minWidth: pairSizeMode === 'iris' ? Math.min(pairSize, 900) : undefined, height: isTargetActive('pair-plot') ? '100%' : 'auto', aspectRatio: isTargetActive('pair-plot') ? '1 / 1' : undefined, margin: isTargetActive('pair-plot') ? '0 auto' : undefined, display: 'block', background: '#fff', touchAction: 'none' }}
          onPointerDown={onPairPointerDown}
          onPointerUp={onPairPointerUp}
          onPointerMove={onPairPointerMove}
        >
          {numericColumns.map((colY, iy) =>
            numericColumns.map((colX, ix) => {
              const x0 = pairLabel + ix * pairCell
              const y0 = pairLabel + iy * pairCell
              if (colX === colY) {
                // Diagonal histogram (12 bins). Bar click selects the bin's
                // value range (half-open [lo, hi), last bin closed).
                const columnRows = pairPoints.get(colY)!
                const min = columnRows.min, max = columnRows.max
                const arr = data!.numeric[colY]
                const bins = new Array<number>(12).fill(0)
                for (const index of columnRows.indexes) {
                  const v = arr?.[index] ?? NaN
                  if (!Number.isFinite(v)) continue
                  bins[Math.min(11, Math.floor(((v - min) / (max - min || 1)) * 12))] += 1
                }
                const maxCount = Math.max(...bins, 1)
                const edges = Array.from({ length: 13 }, (_, i) => min + ((max - min) / 12) * i)
                const selectBin = (bi: number) => {
                  const lo = edges[bi], hi = edges[bi + 1]
                  const ids = columnRows.ids.filter((_, r) => {
                    const v = arr?.[columnRows.indexes[r]] ?? NaN
                    return bi === 11 ? v >= lo && v <= hi : v >= lo && v < hi
                  })
                  dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: `ペアプロット対角ヒスト選択（${colY}）` }))
                }
                return (
                  <g key={`diag-${colY}`} transform={`translate(${x0}, ${y0})`}>
                    <rect width={pairCell - 2} height={pairCell - 2} fill="#fafafa" stroke="#e1e0d9" />
                    {bins.map((count, bi) => {
                      if (!count) return null
                      const barH = (count / maxCount) * (pairCell - 16)
                      return (
                        <rect
                          key={bi}
                          data-selectable="true"
                          x={(bi / 12) * (pairCell - 6) + 3}
                          y={pairCell - 4 - barH}
                          width={(pairCell - 6) / 12 - 1.5}
                          height={barH}
                          fill="#2a78d6"
                          opacity={0.7}
                          style={{ cursor: 'pointer' }}
                          onClick={() => selectBin(bi)}
                        />
                      )
                    })}
                  </g>
                )
              }
              const xr = pairRange[colX]
              const yr = pairRange[colY]
              if (!xr || !yr) return null
              const xCol = data!.numeric[colX]
              const yCol = data!.numeric[colY]
              const xRows = pairPoints.get(colX)!
              const yById = new Map<string, number>()
              for (let r = 0; r < pairPoints.get(colY)!.ids.length; r += 1) {
                yById.set(pairPoints.get(colY)!.ids[r], pairPoints.get(colY)!.indexes[r])
              }
              const dots: JSX.Element[] = []
              for (let r = 0; r < xRows.ids.length; r += 1) {
                const id = xRows.ids[r]
                const yIdx = yById.get(id)
                if (yIdx === undefined) continue
                const v = xCol?.[xRows.indexes[r]] ?? NaN
                const yv = yCol?.[yIdx] ?? NaN
                if (!Number.isFinite(v) || !Number.isFinite(yv)) continue
                const dotPx = ((v - xr.min) / (xr.max - xr.min || 1)) * (pairCell - 8) + 4
                const py = pairCell - 4 - ((yv - yr.min) / (yr.max - yr.min || 1)) * (pairCell - 8)
                const isSelected = selectedPairSet.has(id)
                dots.push(
                  <circle key={id} data-selectable="true" cx={dotPx} cy={py} r={isSelected ? 3.5 : 2.0}
                    fill={isSelected ? '#2a78d6' : pairColorOf(id)}
                    opacity={isSelected ? 0.95 : 0.4}
                    stroke={isSelected ? '#fff' : 'none'} strokeWidth={isSelected ? 1.5 : 0}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => dispatch(hoverAction(id))}
                    onMouseLeave={() => dispatch(hoverAction(null))}
                    onClick={(e) => { e.stopPropagation(); dispatch(selectionApplied({ rowIds: [id], operation: 'toggle', label: 'ペアプロット点クリック' })) }}>
                    <title>{`${id}: ${questionText(colX)}=${Number(v).toFixed(2)}, ${questionText(colY)}=${Number(yv).toFixed(2)}`}</title>
                  </circle>,
                )
              }
              return (
                <g key={`${colX}-${colY}`} transform={`translate(${x0}, ${y0})`}>
                  <rect width={pairCell - 2} height={pairCell - 2} fill="#fff" stroke="#e5e7eb" />
                  {dots}
                </g>
              )
            }))}
          {/* axis labels */}
          {numericColumns.map((col, i) => (
            <g key={`lbl-${col}`}>
              <ColumnQuestionTooltip nameOrId={col} svg><text x={pairLabel + i * pairCell + pairCell / 2} y={14} textAnchor="middle" fontSize={11} fontWeight={600} fill="#52514e">

                {shortName(col, 8)}
              </text></ColumnQuestionTooltip>
              <ColumnQuestionTooltip nameOrId={col} svg><text x={12} y={pairLabel + i * pairCell + pairCell / 2} fontSize={11} fontWeight={600} fill="#52514e">

                {shortName(col, 8)}
              </text></ColumnQuestionTooltip>
            </g>
          ))}
          {/* drag rect on TOP of everything so it stays visible while brushing */}
          {pairDrag && (
            <rect
              x={Math.min(pairDrag.x1, pairDrag.x2)}
              y={Math.min(pairDrag.y1, pairDrag.y2)}
              width={Math.abs(pairDrag.x2 - pairDrag.x1)}
              height={Math.abs(pairDrag.y2 - pairDrag.y1)}
              fill="rgba(42,120,214,0.15)"
              stroke="#2a78d6"
              strokeWidth={1.5}
              style={{ pointerEvents: 'none' }}
            />
          )}
        </svg>
        </div>
        </Dropdown>
        </FocusTarget>
      </div>
      )}
      {(!focused || isTargetActive('heatmap') || isTargetActive('facet-plot')) && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'stretch', flex: focused ? 1 : 'none', flexShrink: 0, height: focused ? '100%' : undefined, minHeight: 0, width: '100%' }}>
      {(!focused || isTargetActive('heatmap')) && (
      <div style={{ flex: isTargetActive('heatmap') ? 1 : 'none', flexShrink: 0, width: '100%', height: isTargetActive('heatmap') ? '100%' : undefined, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!focused && (
          <Space wrap align="center" style={{ marginBottom: 4 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>相関ヒートマップ（セルクリック＝変数ペア焦点）</Typography.Title>
            <FocusEnterButton targetId="heatmap" title="相関ヒートマップ" />
          </Space>
        )}
        <FocusTarget id="heatmap" title="相関ヒートマップ">
        <div
          data-testid="heatmap-scroll"
          style={{
            position: 'relative',
            flex: isTargetActive('heatmap') ? 1 : 'none',
            height: isTargetActive('heatmap') ? '100%' : undefined,
            minHeight: isTargetActive('heatmap') ? undefined : 320,
            overflowX: isTargetActive('heatmap') ? 'visible' : 'auto',
            overflowY: isTargetActive('heatmap') ? 'visible' : 'auto',
            border: isTargetActive('heatmap') ? 'none' : '1px solid #e5e7eb',
            borderRadius: isTargetActive('heatmap') ? 0 : 6,
            background: '#fff',
          }}
        >
        {loadingCorr && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'absolute', inset: 0, zIndex: 30,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(255, 255, 255, 0.75)', backdropFilter: 'blur(2px)',
              gap: 12,
            }}
          >
            <Spin size="large" tip="相関ヒートマップを計算中..." />
          </div>
        )}
        <svg
          data-testid="correlation-heatmap"
          width={heatSize + labelMargin}
          height={heatSize + labelMargin}
          viewBox={`0 0 ${heatSize + labelMargin} ${heatSize + labelMargin}`}
          style={{
            display: 'block',
            width: isTargetActive('heatmap') ? '100%' : undefined,
            minWidth: isTargetActive('heatmap') ? undefined : heatSize + labelMargin,
            maxWidth: isTargetActive('heatmap') ? 'min(100%, calc(100vh - 100px))' : '100%',
            maxHeight: isTargetActive('heatmap') ? '100%' : undefined,
            height: isTargetActive('heatmap') ? '100%' : 'auto',
            aspectRatio: isTargetActive('heatmap') ? '1 / 1' : undefined,
            margin: isTargetActive('heatmap') ? '0 auto' : undefined,
          }}
        >
          {corr?.columns.map((colI, i) =>
            corr.columns.map((colJ, j) => {
              const rawVal = (corr.matrix as Float64Array)[i * corr.columns.length + j]
              const isFinite = Number.isFinite(rawVal)
              const val = isFinite ? rawVal : 0
              const isFocus = focusPair && focusPair[0] === colI && focusPair[1] === colJ
              return (
                <g
                  key={`cell-${colI}-${colJ}`}
                  style={{ cursor: isFinite ? 'pointer' : 'default' }}
                  onClick={() => isFinite && setFocusPair([colI, colJ])}
                >
                  <rect
                    x={labelMargin + j * cellSize}
                    y={labelMargin + i * cellSize}
                    width={cellSize}
                    height={cellSize}
                    fill={isFinite ? (val >= 0 ? `rgba(42,120,214,${Math.abs(val)})` : `rgba(227,73,72,${Math.abs(val)})`) : '#f5f5f4'}
                    stroke={isFocus ? '#1677ff' : '#ffffff'}
                    strokeWidth={isFocus ? 2.5 : 1}
                  />
                  {isFinite && (
                    <text
                      x={labelMargin + j * cellSize + cellSize / 2}
                      y={labelMargin + i * cellSize + cellSize / 2 + 4}
                      textAnchor="middle"
                      fontSize={11}
                      fill={Math.abs(val) > 0.45 ? '#ffffff' : '#1c1917'}
                    >
                      {val.toFixed(2)}
                    </text>
                  )}
                </g>
              )
            })
          )}
          {corr?.columns.map((col, j) => (
            <ColumnQuestionTooltip nameOrId={col} svg key={`col-${col}`}><text
              key={`col-${col}`}
              x={labelMargin + j * cellSize + cellSize / 2}
              y={labelMargin - 8}
              textAnchor="start"
              fontSize={12}
              fontWeight={600}
              fill="#374151"
              transform={`rotate(-45 ${labelMargin + j * cellSize + cellSize / 2} ${labelMargin - 8})`}
            >

              {shortName(col, 12)}
            </text></ColumnQuestionTooltip>
          ))}
          {corr?.columns.map((col, i) => (
            <ColumnQuestionTooltip nameOrId={col} svg key={`row-${col}`}><text
              key={`row-${col}`}
              x={labelMargin - 8}
              y={labelMargin + i * cellSize + cellSize / 2 + 4}
              textAnchor="end"
              fontSize={12}
              fontWeight={600}
              fill="#374151"
            >

              {shortName(col, 12)}
            </text></ColumnQuestionTooltip>
          ))}
        </svg>
        </div>
        </FocusTarget>
        <Typography.Text type="secondary">青=正の相関、赤=負の相関。セルをクリックするとファセットプロットが更新されます。</Typography.Text>
      </div>
      )}
      {(!focused || isTargetActive('facet-plot')) && (
      <div style={{ flex: isTargetActive('facet-plot') ? 1 : 'none', flexShrink: 0, width: '100%', height: isTargetActive('facet-plot') ? '100%' : undefined, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!focused && (
          <Space wrap align="center" style={{ marginBottom: 4 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>ファセットプロット</Typography.Title>
            <FocusEnterButton targetId="facet-plot" title="ファセットプロット" />
          </Space>
        )}
        <div ref={facetFrameRef}>
        <Space style={{ marginBottom: 4 }}>
          <Select
            data-testid="facet-x"
            placeholder="X軸"
            style={{ width: 160 }}
            value={focusPair?.[0]}
            onChange={(v) => setFocusPair((prev) => [v, prev?.[1] ?? v])}
            options={numericColumns.map((c) => ({ value: c, label: c }))}
          />
          <Select
            data-testid="facet-y"
            placeholder="Y軸"
            style={{ width: 160 }}
            value={focusPair?.[1]}
            onChange={(v) => setFocusPair((prev) => [prev?.[0] ?? v, v])}
            options={numericColumns.map((c) => ({ value: c, label: c }))}
          />
        </Space>
        </div>
        <FocusTarget id="facet-plot" title="ファセットプロット">
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={() => document.body}>
        <svg
          ref={facetSvgRef}
          data-testid="facet-plot" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
          style={{ width: '100%', maxWidth: isTargetActive('facet-plot') ? 'min(100%, calc(100vh - 120px))' : Math.min(size, 680), margin: isTargetActive('facet-plot') ? '0 auto' : undefined, aspectRatio: '1 / 1', height: isTargetActive('facet-plot') ? '100%' : 'auto', display: 'block', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, touchAction: 'none', userSelect: 'none' }}
          onPointerDown={onFacetPointerDown}
          onPointerMove={onFacetPointerMove}
          onPointerUp={onFacetPointerUp}
        >
          {facetDrag && (
            <rect
              x={Math.min(facetDrag.x1, facetDrag.x2)}
              y={Math.min(facetDrag.y1, facetDrag.y2)}
              width={Math.abs(facetDrag.x2 - facetDrag.x1)}
              height={Math.abs(facetDrag.y2 - facetDrag.y1)}
              fill="rgba(42,120,214,0.15)"
              stroke="#2a78d6"
              strokeWidth={1.5}
              style={{ pointerEvents: 'none' }}
            />
          )}
          {facetXRange && facetYRange && facetPoints.map((point) => {
            const plotPadding = 48
            const plotWidth = size - plotPadding - 24
            const px = plotPadding + ((point.x - facetXRange.min) / (facetXRange.max - facetXRange.min || 1)) * plotWidth
            const py = size - plotPadding - ((point.y - facetYRange.min) / (facetYRange.max - facetYRange.min || 1)) * plotWidth
            const isSelected = selectedSet.has(point.id)
            const dotRadius = isSelected ? 5.0 : 3.5
            return (
              <circle
                key={point.id}
                data-selectable="true"
                cx={px}
                cy={py}
                r={dotRadius}
                fill={isSelected ? theme.selection : pairColorOf(point.id)}
                opacity={isSelected ? 0.95 : 0.45}
                stroke={isSelected ? '#fff' : 'none'}
                strokeWidth={isSelected ? 1.5 : 0}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => dispatch(hoverAction(point.id))}
                onMouseLeave={() => dispatch(hoverAction(null))}
                onClick={(e) => { e.stopPropagation(); dispatch(selectionApplied({ rowIds: [point.id], operation: 'toggle', label: 'ファセット点クリック' })) }}
              >
                <title>{`${point.id}: ${questionText(focusPair?.[0] ?? '')}=${point.x.toFixed(2)}, ${questionText(focusPair?.[1] ?? '')}=${point.y.toFixed(2)}`}</title>
              </circle>
            )
          })}
          {focusPair && facetXRange && facetYRange && (() => {
            const plotPadding = 48
            const plotWidth = size - plotPadding - 24
            const labelFontSize = 12
            const tickFontSize = 10
            const xMin = facetXRange.min.toFixed(1)
            const xMid = ((facetXRange.min + facetXRange.max) / 2).toFixed(1)
            const xMax = facetXRange.max.toFixed(1)
            const yMin = facetYRange.min.toFixed(1)
            const yMid = ((facetYRange.min + facetYRange.max) / 2).toFixed(1)
            const yMax = facetYRange.max.toFixed(1)
            return (
              <g className="facet-axes">
                {/* Axis lines */}
                <line x1={plotPadding} y1={size - plotPadding} x2={plotPadding + plotWidth} y2={size - plotPadding} stroke="#d9d9d9" strokeWidth={1.5} />
                <line x1={plotPadding} y1={size - plotPadding} x2={plotPadding} y2={size - plotPadding - plotWidth} stroke="#d9d9d9" strokeWidth={1.5} />

                {/* X axis ticks & numbers */}
                <text x={plotPadding + 2} y={size - plotPadding + tickFontSize + 4} textAnchor="start" fontSize={tickFontSize} fill="#6b7280">{xMin}</text>
                <text x={plotPadding + plotWidth / 2} y={size - plotPadding + tickFontSize + 4} textAnchor="middle" fontSize={tickFontSize} fill="#6b7280">{xMid}</text>
                <text x={plotPadding + plotWidth} y={size - plotPadding + tickFontSize + 4} textAnchor="end" fontSize={tickFontSize} fill="#6b7280">{xMax}</text>

                {/* Y axis ticks & numbers */}
                <text x={plotPadding - 8} y={size - plotPadding - 2} textAnchor="end" fontSize={tickFontSize} fill="#6b7280">{yMin}</text>
                <text x={plotPadding - 8} y={size - plotPadding - plotWidth / 2 + 3} textAnchor="end" fontSize={tickFontSize} fill="#6b7280">{yMid}</text>
                <text x={plotPadding - 8} y={size - plotPadding - plotWidth + 8} textAnchor="end" fontSize={tickFontSize} fill="#6b7280">{yMax}</text>

                {/* Axis titles */}
                <ColumnQuestionTooltip nameOrId={focusPair[0]} svg><text x={plotPadding + plotWidth / 2} y={size - 6} textAnchor="middle" fontSize={labelFontSize} fontWeight={600} fill="#374151">

                  {truncateText(focusPair[0], 20)}
                </text></ColumnQuestionTooltip>
                <ColumnQuestionTooltip nameOrId={focusPair[1]} svg><text x={14} y={size - plotPadding - plotWidth / 2} fontSize={labelFontSize} fontWeight={600} fill="#374151" textAnchor="middle" transform={`rotate(-90 14 ${size - plotPadding - plotWidth / 2})`}>

                  {truncateText(focusPair[1], 20)}
                </text></ColumnQuestionTooltip>
              </g>
            )
          })()}
        </svg>
        </Dropdown>
        </FocusTarget>
        <Typography.Text type="secondary">点クリックで選択toggle（全ビュー連動）</Typography.Text>
      </div>
      )}
      </div>
      )}
    </div>
  )
}
