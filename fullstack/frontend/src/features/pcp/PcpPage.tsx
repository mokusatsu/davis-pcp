import { selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import MaAxisPicker from './MaAxisPicker'
import { Select as AntSelect } from 'antd'
import ColumnQuestionTooltip, { ColumnQuestionText } from '../common/ColumnQuestionTooltip'
import Table from '../common/ColumnTable'
import Select from '../common/ColumnSelect'
import { l1Index, useDatasetL1ColorDomains } from '../../theme/useL1ColorDomain'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSelector, useDispatch } from 'react-redux'
import {
  Alert, Button, Dropdown, InputNumber, Segmented, Slider, Space, Spin,
  Switch, Tag, Typography,
} from 'antd'
import { DownOutlined } from '@ant-design/icons'
import { ArrowLeftOutlined, ArrowRightOutlined, ArrowUpOutlined, ArrowDownOutlined, CaretUpOutlined, CaretLeftOutlined } from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, hovered as hoverAction, pcpStateChanged, l2ColorToggled } from '../../app/store'
import type { PcpAxis } from './usePcpPipeline'
import { useCodebook } from '../dataset/useCodebookColumn'
import { normalizedRect, type Rect } from './brush'
import { graphEngine } from '../../engine/graphClient'
import { renderPcp, type PcpRenderSpec } from '../../engine/pcpRenderer'
import { useActiveRows, usePcpGeometry, usePcpSimplification, buildAxes } from './usePcpPipeline'
import { useColumnarData } from './useDatasetColumns'
import { api } from '../../api/client'
import { vizTheme, l1Palette } from '../../theme/viz'
import GraphPanel, { useGraphPopupContainer } from '../common/GraphPanel'
import PcpPlotViewport from './PcpPlotViewport'
import { getSvgPoint } from '../../utils/svgCoordinates'
import EmptyStatePanel from '../common/EmptyStatePanel'

/** Palette tokens as a plain array for the packed-slot color resolver. */
function buildPalette(theme: ReturnType<typeof vizTheme>): string[] {
  return [...l1Palette(theme)]
}

/** Paint the spec on an OffscreenCanvas inside the shared graph worker.
 *  Falls back to main-thread painting when Workers are unavailable.
 *  The offscreen canvas is NOT transferred — it stays owned by this thread so
 *  the previous frame remains visible until the new paint completes (no blank
 *  flash between renders). */
async function paintOnWorker(offscreen: OffscreenCanvas, spec: PcpRenderSpec): Promise<void> {
  const w = ensurePaintWorker()
  if (!w) throw new Error('paint worker unavailable')
  const id = ++paintRequestId
  return new Promise((resolve, reject) => {
    const entry = paintPending.get(id)
    void entry
    paintPending.set(id, { resolve, reject })
    w.postMessage({ id, op: 'renderPcp', canvas: offscreen, spec })
  })
}

let paintWorker: Worker | null = null
let paintRequestBroken = false
let paintRequestId = 0
const paintPending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>()

function ensurePaintWorker(): Worker | null {
  if (paintWorker) return paintWorker
  if (paintRequestBroken) return null
  try {
    paintWorker = new Worker(new URL('../../engine/graph.worker.ts', import.meta.url), { type: 'module' })
    paintWorker.onmessage = (event: MessageEvent) => {
      const data = event.data as { id: number; ok: boolean; error?: string }
      const entry = paintPending.get(data.id)
      if (entry) {
        paintPending.delete(data.id)
        if (data.ok) entry.resolve()
        else entry.reject(new Error(data.error ?? 'worker paint failed'))
      }
    }
    paintWorker.onerror = () => {
      paintRequestBroken = true
      paintWorker = null
      for (const [, entry] of paintPending) entry.reject(new Error('paint worker crashed'))
      paintPending.clear()
    }
    // The OffscreenCanvas transfers away after first use; keep one canvas per
    // request instead — a fresh worker per page mount is acceptable here since
    // the module-level singleton below persists across renders.
    return paintWorker
  } catch {
    paintRequestBroken = true
    return null
  }
}

export interface OrderingDiagnostics {
  method: string
  evidenceClass: string
  outputColumnIds: string[]
  candidateOrders: string[][]
  candidateScores: (number | null)[]
  iterationTrace: { step: number; selected?: string; rule?: string; loading?: number[] }[]
}


export default function PcpPage() {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const pcp = useSelector((s: RootState) => s.pcp)
  const { columns: codebookColumns, formatValueLabel } = useCodebook()
  const globalVars = useSelector(selectOrdinaryVariables)
  const globalEntities = useSelector(selectVariableEntities)
  const maGroups = globalEntities.items.filter(item => item.entity.kind === 'ma' && globalEntities.selected.has(item.key))
    .map(item => ({ groupId: item.name, label: item.label }))
  const availableMaAxes = (pcp.maAxes ?? []).filter(axis => maGroups.some(group => group.groupId === axis.groupId)
    && (axis.kind === 'maCount' || codebookColumns.some(column => column.columnId === axis.columnId && column.multiResponseGroup === axis.groupId)))
  const eligibleAxisKeys = [...globalVars.activeVariableIds, ...availableMaAxes.map(axis => axis.key)]
  const ordinaryNames = useMemo(() => codebookColumns.filter(column => !column.multiResponseGroup).map(column => column.name), [codebookColumns])
  const initializedDataset = useRef<string | null>(null)
  const datasetKey = `${selection.datasetId}:${selection.dataRevision}`
  const requestedAxes = initializedDataset.current === datasetKey ? pcp.visibleColumns : ordinaryNames.slice(0, 10)
  const requestedColumns = [...new Set([...requestedAxes.filter(name => ordinaryNames.includes(name) && globalVars.activeVariableIds.includes(name)),
    ...(pcp.colorBy && codebookColumns.some(column => column.name === pcp.colorBy) ? [pcp.colorBy] : [])])]
  const data = useColumnarData(selection.datasetId, requestedColumns, availableMaAxes.filter(axis => requestedAxes.includes(axis.key)))
  const theme = vizTheme(false)
  /** OffscreenCanvas mirror of the visible canvas — painted in the worker. */
  const offscreenRef = useRef<OffscreenCanvas | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<SVGSVGElement>(null)
  const brushRectRef = useRef<SVGRectElement>(null)
  const frameNodeRef = useRef<HTMLDivElement | null>(null)
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 })
  // F004-01: GraphPanel 子から受け取る実 viewport 情報（scale/dpr/revision）。
  const [viewScaleState, setViewScaleState] = useState(1)
  const [viewDprState, setViewDprState] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))
  const [viewRevisionState, setViewRevisionState] = useState(0)
  const onViewportSize = useCallback((v: { width: number; height: number; scale: number; dpr: number; revision: number }) => {
    setFrameSize(prev => (prev.width !== v.width || prev.height !== v.height ? { width: v.width, height: v.height } : prev))
    setViewScaleState(v.scale > 0 ? v.scale : 1)
    setViewDprState(v.dpr > 0 ? v.dpr : 1)
    setViewRevisionState(v.revision)
  }, [])
  // F004-01: PcpPage 自体は GraphPanel の親であり、ここで useGraphViewport を
  // 呼んでも GraphPanel 上の既定値しか返さない。実 viewport 情報は描画子の
  // PcpPlotViewport が GraphPanel の子として受け取り、frameSize に反映する。
  const graphPopupContainer = useGraphPopupContainer('pcp/main')
  const brushState = useRef<{ start: { x: number; y: number }; pointerId: number } | null>(null)
  const [diagnostics, setDiagnostics] = useState<OrderingDiagnostics | null>(null)
  const [orderError, setOrderError] = useState<{ message: string; suggestedActions: string[] } | null>(null)
  const [orderingLoading, setOrderingLoading] = useState(false)
  const [firstFrameRendered, setFirstFrameRendered] = useState(false)
  const [tooltip, setTooltip] = useState<{ id: string; x: number; y: number } | null>(null)
  const [imputedCells, setImputedCells] = useState<Map<string, Set<string>>>(new Map())
  useEffect(() => {
    if (!selection.datasetId) {
      setImputedCells(new Map())
      return
    }
    let current = true
    api.get<{ entries: { rowId: string; columnId: string }[] }>(
      `/datasets/${selection.datasetId}/imputation-mask?expectedDataRevision=${selection.dataRevision}`,
    ).then((mask) => {
      if (!current) return
      const map = new Map<string, Set<string>>()
      for (const entry of mask.entries) {
        let set = map.get(entry.rowId)
        if (!set) {
          set = new Set<string>()
          map.set(entry.rowId, set)
        }
        set.add(entry.columnId)
      }
      setImputedCells(map)
    }).catch(() => { if (current) setImputedCells(new Map()) })
    return () => { current = false }
  }, [selection.datasetId, selection.dataRevision])

  // Build axis metadata from schema (O(cols) via precomputed min/max/cats).
  const axes = useMemo<PcpAxis[]>(() => (data ? buildAxes(data, codebookColumns).map(axis => {
    const ma = availableMaAxes.find(item => item.key === axis.key)
    if (!ma) return axis
    const column = codebookColumns.find(column => column.columnId === ma.columnId)
    return ma.kind === 'maCount'
      ? { ...axis, missingAsGap: true, label: `${maGroups.find(group => group.groupId === ma.groupId)?.label || ma.groupId}・選択数` }
      : { ...axis, label: column?.multiResponseOptionLabel || column?.label || column?.name || axis.key,
        type: 'categorical' as const, missingAsGap: true, min: 0, max: 1, categories: ['0', '1'], valueLabels: { '0': '非選択', '1': '選択' } }
  }) : []), [data, codebookColumns, pcp.maAxes, globalEntities])
  const l1Candidates = useDatasetL1ColorDomains(selection.datasetId) ?? []
  const l1Domain = l1Candidates.find(d => d.key === pcp.colorBy)

  // Dataset switch: drop the previous geometry immediately so axis controls
  // never render positions from a different dataset (audit #3).
  useEffect(() => {
    offscreenRef.current = null
    setFirstFrameRendered(false)
    if (frameNodeRef.current) {
      frameNodeRef.current.scrollLeft = 0
      frameNodeRef.current.scrollTop = 0
    }
  }, [selection.datasetId])

  // Initialize only ordinary axes. Additional axes are chosen explicitly in the page control.
  useEffect(() => {
    if (!codebookColumns.length || initializedDataset.current === datasetKey) return
    initializedDataset.current = datasetKey
    dispatch(pcpStateChanged({
      order: ordinaryNames,
      visibleColumns: ordinaryNames.slice(0, 10),
      maAxes: [],
      reversed: Object.fromEntries(ordinaryNames.map(name => [name, false])),
    }))
  }, [ordinaryNames, codebookColumns.length, dispatch, datasetKey])

  const orderedVisibleAxes = useMemo(() => {
    const activeVarIds = eligibleAxisKeys
    return pcp.order
      .filter((key) => activeVarIds.includes(key) && pcp.visibleColumns.includes(key))
      .map((key) => axes.find((a) => a.key === key))
      .filter((a): a is PcpAxis => Boolean(a))
  }, [pcp.order, pcp.visibleColumns, globalVars?.activeVariableIds, axes])

  const activeRowIndexes = useActiveRows(data)

  // K-Medoids draw simplification: >500 rows draw cluster representatives
  // (medoids ∪ selected rows) instead of every active row. Runs BEFORE the
  // geometry call so color slots / selection flags / hit tests all see the
  // reduced row set and stay consistent by construction.
  const simplification = usePcpSimplification({ source: data, orderedVisibleAxes, activeRowIndexes })
  const drawRowIndexes = simplification?.drawRowIndexes ?? activeRowIndexes

  // Minimum pixel width/height per axis: below this, labels/ticks collide and the
  // plot becomes unreadable, so the frame scrolls instead.
  const MIN_AXIS_WIDTH = 90
  const MIN_AXIS_HEIGHT = 48

  const isVertical = pcp.orientation === 'vertical'

  const virtualWidth = useMemo(() => {
    if (!orderedVisibleAxes.length) return 0
    if (isVertical) return Math.max(frameSize.width, 1)
    return Math.max(frameSize.width, orderedVisibleAxes.length * MIN_AXIS_WIDTH)
  }, [orderedVisibleAxes, frameSize.width, isVertical])

  const virtualHeight = useMemo(() => {
    if (!orderedVisibleAxes.length) return 0
    if (!isVertical) return Math.max(frameSize.height, 1)
    return Math.max(frameSize.height, orderedVisibleAxes.length * MIN_AXIS_HEIGHT)
  }, [orderedVisibleAxes, frameSize.height, isVertical])

  const geometry = usePcpGeometry({
    source: data,
    // Geometry must span the FULL virtual span — not just the visible frame —
    // or axis spacing collapses and the canvas coordinate space diverges
    // from the scrollable area (student_performance: 33 axes drew at 12.8px
    // pitch inside a 2970px scroll area in horizontal mode, or squashed into
    // 14px in vertical mode).
    width: virtualWidth,
    height: virtualHeight,
    orderedVisibleAxes,
    activeRowIndexes: drawRowIndexes,
  })

  /** Handlers must always see the latest geometry even when a stale event
   *  closure survives a React bailout — closures over `geometry` went stale
   *  (hover/brush dead after remount), so input paths read through this ref. */
  const geometryRef = useRef<ReturnType<typeof usePcpGeometry>>(null)
  useEffect(() => {
    geometryRef.current = geometry
  }, [geometry])

  /** Same stale-closure guard for the simplification result (hit expansion). */
  const simplificationRef = useRef<ReturnType<typeof usePcpSimplification>>(null)
  useEffect(() => {
    simplificationRef.current = simplification
  }, [simplification])

  /** Geometry rows are keyed by position; keep id↔row maps for hit tests/hover. */
  const rowIndexByGeometryRow = useMemo(
    () => (geometry ? geometry.rowIds : []),
    [geometry],
  )
  void rowIndexByGeometryRow

  /** Per-geometry-row packed color slots (L1 slot | L2 group), context gray sentinel. */
  const rowColorSlots = useMemo(() => {
    if (!geometry) return null
    const slots = new Uint16Array(geometry.nRows)
    const l2GroupOfId = new Map<string, number>()
    if (selection.l2ColorEnabled) {
      selection.groups.forEach((group, index) => {
        group.rowIds.forEach((id) => { if (!l2GroupOfId.has(id)) l2GroupOfId.set(id, index) })
      })
    }
    const colorKey = pcp.colorBy
    if (colorKey && data) {
      const values = data.columns[colorKey] ?? []
      for (let r = 0; r < geometry.nRows; r += 1) {
        const id = geometry.rowIds[r]
        const index = data.rowIndex.get(id)
        if (index === undefined) continue
        const l1Slot = l1Index(l1Domain, values[index]) ?? 0xff
        const l2Group = l2GroupOfId.get(id)
        slots[r] = ((l2Group !== undefined && selection.l2ColorEnabled) ? (1 << 15) | ((l2Group & 0x7f) << 8) : 0) | (l1Slot & 0xff)
      }
    } else {
      for (let r = 0; r < geometry.nRows; r += 1) {
        const id = geometry.rowIds[r]
        const l2Group = l2GroupOfId.get(id)
        slots[r] = ((l2Group !== undefined && selection.l2ColorEnabled) ? (1 << 15) | ((l2Group & 0x7f) << 8) : 0) | (0xff & 0xff)
      }
    }
    return slots
  }, [geometry, selection.groups, selection.l2ColorEnabled, pcp.colorBy, data, l1Domain])

  const selectedFlags = useMemo(() => {
    if (!geometry) return null
    const flags = new Uint8Array(geometry.nRows)
    const selectedSet = new Set(selection.selectedRowIds)
    geometry.rowIds.forEach((id, r) => { flags[r] = selectedSet.has(id) ? 1 : 0 })
    return flags
  }, [geometry, selection.selectedRowIds])

  const hoveredGeometryRow = useMemo(() => {
    if (!geometry || !selection.hoveredRowId) return -1
    return geometry.rowIds.indexOf(selection.hoveredRowId)
  }, [geometry, selection.hoveredRowId])

  /** True while data is present but the first frame has not been painted yet —
   *  drives the "描画準備中" indicator in place of a blank plot. */
  const preparingFirstFrame = Boolean(data && orderedVisibleAxes.length && (!geometry || !rowColorSlots || !selectedFlags))
  const isPlotLoading = Boolean(data && orderedVisibleAxes.length && (preparingFirstFrame || orderingLoading || !firstFrameRendered))

  /**
   * Render pipeline: geometry (WASM in worker) → paint spec → worker paints on
   * OffscreenCanvas; main thread only transfers the canvas and input events.
   * Falls back to painting locally when OffscreenCanvas/Worker unavailable.
   * While one paint is in flight, newer requests REPLACE the queued one (only
   * the latest state is painted when the worker frees up) so rapid pointer
   * movement can't pile up a lagging update queue.
   */
  const renderBusyRef = useRef(false)
  const pendingRenderRef = useRef(false)
  /** Always-current renderPlot reference — the pending follow-up must run the
   *  LATEST closure (fresh frameSize/geometry), not the one that was busy. */
  const renderPlotRef = useRef<() => void>(() => {})
  const renderPlot = useCallback(async () => {
    renderPlotRef.current = () => { void renderPlot() }
    if (renderBusyRef.current) {
      pendingRenderRef.current = true
      return
    }
    renderBusyRef.current = true
    try {
      await doRenderPlot()
    } finally {
      renderBusyRef.current = false
      // A request arrived while painting: run exactly ONE follow-up through
      // the latest closure so it picks up the newest frameSize/geometry.
      if (pendingRenderRef.current) {
        pendingRenderRef.current = false
        renderPlotRef.current()
      }
    }
    async function doRenderPlot() {
    const canvas = canvasRef.current
    if (!canvas || !geometry || !rowColorSlots || !selectedFlags) return
    // The canvas is FRAME-SIZED and shows the scrolled window of the plot:
    // browsers silently disable canvases wider than ~32k px (kaggle's 369
    // axes × 90px × dpr2 = 66k px painted nothing), so the full virtual span
    // can never be one bitmap. Geometry stays in virtual coords; the renderer
    // translates by -viewportX so lines land in viewport-local positions.
    const width = Math.max(1, frameSize.width)
    const height = Math.max(1, frameSize.height)
    // F005-01: 有効DPR = rawDpr × 表示scale。バッファ寸法・renderer変換は
    // すべてこの値で統一する（rendererはspec.dprだけで変換するため）。
    // 寸法変更だけで分析 API は再実行しない。
    const viewScale = viewScaleState > 0 ? viewScaleState : 1
    const rawDpr = viewDprState > 0 ? viewDprState : Math.max(1, window.devicePixelRatio || 1)
    const dpr = rawDpr * viewScale
    const deviceW = Math.round(width * dpr)
    const deviceH = Math.round(height * dpr)
    // Resize (and only resize) clears the visible canvas; same-size repaints
    // keep the previous frame until the new one is ready.
    if (canvas.width !== deviceW || canvas.height !== deviceH) {
      canvas.width = deviceW
      canvas.height = deviceH
      offscreenRef.current = null
    }
    // R035-01: Canvas は共通 surface の scale 変換内に置かれるため、
    // 共通 viewport のスクロール量（CSS px）を論理座標へ換算して渡す。
    // surface scale=s で表示されるため、論理上のスクロールは scroll/s となる。
    // SVG 側は virtual 寸法のまま DOM スクロールする方式と原点を一致させる。
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const surfaceScale = (() => {
      const surface = canvas.closest('[data-testid^="graph-surface-"]') as HTMLElement | null
      const s = surface ? Number(surface.getAttribute('data-graph-scale')) : NaN
      return Number.isFinite(s) && s > 0 ? s : 1
    })()
    const rawLeft = frameNodeRef.current?.scrollLeft ?? 0
    const rawTop = frameNodeRef.current?.scrollTop ?? 0
    const scrollLeft = rawLeft / surfaceScale
    const scrollTop = rawTop / surfaceScale

    const axesSpec = orderedVisibleAxes.map((a) => ({
      key: a.key,
      label: a.label,
      isCategorical: a.type === 'categorical',
      min: a.min,
      max: a.max,
      categories: a.categories,
      valueLabels: a.valueLabels,
    }))
    const geometryRowIndexById = new Map<string, number>()
    geometry.rowIds.forEach((id, index) => { geometryRowIndexById.set(id, index) })
    const columnNameById = new Map(codebookColumns.map((c) => [c.columnId, c.name]))
    const axisIndexByKey = new Map(orderedVisibleAxes.map((a, index) => [a.key, index]))
    const imputedAxes = new Map<number, Set<number>>()
    for (const [rowId, columnIds] of imputedCells) {
      const row = geometryRowIndexById.get(rowId)
      if (row === undefined) continue
      for (const columnId of columnIds) {
        const axis = axisIndexByKey.get(columnId)
          ?? axisIndexByKey.get(columnNameById.get(columnId) ?? '')
        if (axis === undefined) continue
        let set = imputedAxes.get(row)
        if (!set) {
          set = new Set<number>()
          imputedAxes.set(row, set)
        }
        set.add(axis)
      }
    }
    const spec: PcpRenderSpec = {
      width,
      height,
      dpr,
      orientation: pcp.orientation,
      points: geometry.points,
      nRows: geometry.nRows,
      nAxes: geometry.nAxes,
      axisPos: geometry.axisPos,
      bounds: geometry.bounds,
      imputedAxes: imputedAxes.size > 0 ? imputedAxes : undefined,
      axes: axesSpec,
      reversed: Object.fromEntries(orderedVisibleAxes.map(a => [a.key, Boolean(a.isReversed) !== Boolean(pcp.reversed[a.key])])),
      style: {
        showContext: pcp.showContext,
        lineOpacity: pcp.lineOpacity,
        lineWidth: pcp.lineWidth,
        selectedLineWidthBoost: 1.3,
      },
      rowColorSlots,
      categoricalPalette: buildPalette(theme),
      selectedFlags,
      hoveredRow: hoveredGeometryRow,
      // Density controls: cap context rows so huge datasets (kaggle 921×369)
      // stay responsive; off-viewport segments are skipped losslessly.
      // Selected/hovered rows are never decimated.
      maxContextRows: 4000,
      viewportX: scrollLeft,
      viewportY: scrollTop,
      clusterSizes: simplification?.clusterSizes ?? null,
    }

    let offscreen = offscreenRef.current
    const canOffscreen = typeof OffscreenCanvas !== 'undefined' && graphEngine.kind !== undefined
    if (canOffscreen) {
      try {
        if (!offscreen || offscreen.width !== deviceW || offscreen.height !== deviceH) {
          offscreen = new OffscreenCanvas(deviceW, deviceH)
          offscreenRef.current = offscreen
        } else {
          // Reuse the same buffer: the worker clears it before painting.
        }
        await paintOnWorker(offscreen, spec)
        // Blit only AFTER the fresh frame is complete — the visible canvas
        // keeps showing the previous frame until this moment (no blank).
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(offscreen as unknown as CanvasImageSource, 0, 0)
        setFirstFrameRendered(true)
        return
      } catch {
        // Worker paint failed — fall back to a synchronous local repaint below.
      }
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    renderPcp(ctx, spec)
    setFirstFrameRendered(true)
    }
  }, [geometry, rowColorSlots, selectedFlags, hoveredGeometryRow, orderedVisibleAxes, pcp.orientation, pcp.reversed, pcp.showContext, pcp.lineOpacity, pcp.lineWidth, frameSize, simplification, theme, viewScaleState, viewDprState, viewRevisionState])

  useEffect(() => { void renderPlot() }, [renderPlot])

  const [measureNode, setMeasureNode] = useState<HTMLDivElement | null>(null)
  // 共通 viewport を frame とみなす。plot-frame 自体はスクロールしないため、
  // frameSize・スクロールオフセットは共通 viewport から取得する。
  // 従来の frame 計測は GraphPanel 外の単体利用時のみ残す。
  useEffect(() => {
    const frame = measureNode
    if (!frame) return
    const viewportEl = frame.closest('[data-testid^="graph-viewport-"]') as HTMLElement | null
    if (viewportEl) {
      frameNodeRef.current = viewportEl as unknown as HTMLDivElement
      const measureViewport = () => {
        const width = Math.max(1, viewportEl.clientWidth)
        const height = Math.max(1, viewportEl.clientHeight)
        setFrameSize(prev => (prev.width !== width || prev.height !== height ? { width, height } : prev))
        return width > 1
      }
      if (!measureViewport()) {
        const raf = requestAnimationFrame(function tick() {
          if (!measureViewport()) requestAnimationFrame(tick)
        })
        return () => cancelAnimationFrame(raf)
      }
      const observer = new ResizeObserver(measureViewport)
      observer.observe(viewportEl)
      return () => observer.disconnect()
    }
    // GraphPanel 外のフォールバック（従来の frame 計測）
    const measure = () => {
      const width = Math.max(1, frame.clientWidth)
      const height = Math.max(1, frame.clientHeight)
      setFrameSize(prev => (prev.width !== width || prev.height !== height ? { width, height } : prev))
      return width > 1
    }
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    let raf = 0
    let tries = 0
    const tick = () => {
      tries += 1
      if (measure() || tries >= 120) return
      raf = requestAnimationFrame(tick)
    }
    if (!measure()) raf = requestAnimationFrame(tick)
    const interval = setInterval(measure, 500)
    const recheck = () => { measure() }
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('resize', recheck)
    window.addEventListener('focus', recheck)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('resize', recheck)
      window.removeEventListener('focus', recheck)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureNode, selection.datasetId])

  /** 共通 viewport のスクロールで再描画する。plot-frame 自体はスクロールしない。 */
  useEffect(() => {
    const frame = measureNode
    if (!frame) return
    const scroller = (frame.closest('[data-testid^="graph-viewport-"]') as HTMLDivElement | null) ?? frame
    frameNodeRef.current = scroller
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        renderPlotRef.current()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [measureNode])

  const eventPoint = (event: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const overlay = overlayRef.current
    const g = geometryRef.current
    if (!overlay || !g) return { x: NaN, y: NaN }
    return getSvgPoint(overlay, event, { width: Math.max(virtualWidth, 1), height: Math.max(virtualHeight, 1) })
  }

  const applySelectionIds = useCallback((ids: string[], operation: typeof pcp.brushOperation, label: string) => {
    dispatch(selectionApplied({ rowIds: ids, operation, label }))
  }, [dispatch])

  /** Hover via engine nearest-row (worker). Falls back silently to no-op.
   *  Optimizations for huge datasets:
   *  - in-flight RPC coalescing: a newer pointermove supersedes the pending
   *    query (only the latest point is answered);
   *  - points outside the plot band are rejected locally (no RPC at all);
   *  - the active mask is cached per-geometry instead of rebuilt per event. */
  const hoverSeqRef = useRef(0)
  const activeMaskRef = useRef<{ nRows: number; mask: Uint8Array } | null>(null)
  const updateHover = useCallback(async (point: { x: number; y: number }) => {
    const g = geometryRef.current
    if (!g) return
    // Outside the plot band → no line can be within threshold; skip the RPC.
    const { bounds } = g
    const pad = 8
    if (point.x < bounds.left - pad || point.x > bounds.right + pad
      || point.y < bounds.top - pad || point.y > bounds.bottom + pad) {
      hoverSeqRef.current += 1
      if (selection.hoveredRowId !== null) dispatch(hoverAction(null))
      setTooltip(null)
      return
    }
    const seq = ++hoverSeqRef.current
    let mask = activeMaskRef.current
    if (!mask || mask.nRows !== g.nRows) {
      const m = new Uint8Array(g.nRows).fill(1)
      activeMaskRef.current = { nRows: g.nRows, mask: m }
      mask = activeMaskRef.current!
    }
    const nearestIndex = await graphEngine.nearest(
      g.points, g.nRows, g.nAxes,
      point.x, point.y, 7, mask.mask,
    )
    // A newer pointermove superseded this query — drop the stale answer.
    if (seq !== hoverSeqRef.current) return
    const id = nearestIndex >= 0 ? g.rowIds[nearestIndex] : null
    if (id !== selection.hoveredRowId) dispatch(hoverAction(id))
    setTooltip(id ? { id, x: lastClientPoint.current.x, y: lastClientPoint.current.y } : null)
  }, [selection.hoveredRowId, dispatch])

  const lastClientPoint = useRef({ x: 0, y: 0 })

  // F005-02: 座標系が変わった進行中ドラッグは選択確定せず取消する。
  // 倍率だけでなく画面リサイズ・DPR変更も対象とするため、viewport の
  // 座標系世代（data-coord-gen：寸法・DPR・zoom）を開始時に記録し、
  // up 時点で異なっていれば dispatch せず矩形・capture を掃除する。
  const dragToken = useRef<{ gen: string | null } | null>(null)
  const coordGenOf = (el: Element): string | null => {
    try {
      return el.closest('[data-testid^="graph-host-"]')
        ?.querySelector('[data-testid^="graph-viewport-"]')?.getAttribute('data-coord-gen')
        ?? null
    } catch { return null }
  }
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const point = eventPoint(event)
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    brushState.current = { start: point, pointerId: event.pointerId }
    dragToken.current = { gen: coordGenOf(event.currentTarget as Element) }
    try { overlayRef.current?.setPointerCapture(event.pointerId) } catch { /* synthetic pointer */ }
    brushRectRef.current?.setAttribute('visibility', 'visible')
    brushRectRef.current?.setAttribute('x', String(point.x))
    brushRectRef.current?.setAttribute('y', String(point.y))
    brushRectRef.current?.setAttribute('width', '0')
    brushRectRef.current?.setAttribute('height', '0')
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!geometryRef.current) return
    const point = eventPoint(event)
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    lastClientPoint.current = { x: event.clientX, y: event.clientY }
    if (brushState.current) {
      const rect = normalizedRect(brushState.current.start, point)
      brushRectRef.current?.setAttribute('x', String(rect.x1))
      brushRectRef.current?.setAttribute('y', String(rect.y1))
      brushRectRef.current?.setAttribute('width', String(rect.x2 - rect.x1))
      brushRectRef.current?.setAttribute('height', String(rect.y2 - rect.y1))
      return
    }
    void updateHover(point)
  }

  const cancelBrush = (pointerId?: number) => {
    brushState.current = null
    dragToken.current = null
    brushRectRef.current?.setAttribute('visibility', 'hidden')
    if (pointerId !== undefined) {
      try { overlayRef.current?.releasePointerCapture(pointerId) } catch { /* already released */ }
    }
  }

  // F005-02: Escape単独でも進行中ドラッグを取消す。拡大ダイアログの
  // 二段階Escape（1回目は子popup、2回目は拡大終了）とは独立に、
  // ここではブラシ矩形とcaptureの掃除だけを行い、選択dispatchしない。
  // brushStateはrefのため再レンダーを起こさず、keydown到達時に判定する。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && brushState.current) {
        cancelBrush(brushState.current.pointerId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onPointerUp = async (event: React.PointerEvent) => {
    if (!brushState.current || !geometryRef.current) return
    // F005-02: 座標系世代が変わった進行中ドラッグは確定せず取消し、dispatch しない。
    // 倍率変更・画面リサイズ・DPR変更・Escape相当のいずれもここで取消す。
    try {
      const nowGen = coordGenOf(event.currentTarget as Element)
      if (dragToken.current && dragToken.current.gen !== nowGen) {
        cancelBrush(brushState.current.pointerId)
        return
      }
    } catch { /* 照合失敗時は従来通り確定する */ }
    const g = geometryRef.current
    const current = eventPoint(event)
    const rect = normalizedRect(brushState.current.start, current)
    const distance = Math.hypot(current.x - brushState.current.start.x, current.y - brushState.current.start.y)
    const pointerId = brushState.current.pointerId
    brushRectRef.current?.setAttribute('visibility', 'hidden')
    try { overlayRef.current?.releasePointerCapture(pointerId) } catch { /* already released */ }
    brushState.current = null
    dragToken.current = null

    // Under draw simplification a drawn line represents a whole cluster:
    // expand every hit to the full member set so selections retroactively
    // cover the source rows (other views operate on real rows, not medoids).
    const members = simplificationRef.current?.membersOfDrawnRow
    const expand = (hitRows: number[]): string[] => {
      if (!members) return hitRows.map((i) => g.rowIds[i])
      const ids: string[] = []
      for (const i of hitRows) ids.push(...(members[i] ?? []).map((src) => data?.rowIds[src] ?? ''))
      return ids.filter(Boolean)
    }

    if (distance < 4) {
      // Point-click toggle via engine nearest-row.
      const active = new Uint8Array(g.nRows).fill(1)
      const nearestIndex = await graphEngine.nearest(
        g.points, g.nRows, g.nAxes,
        current.x, current.y, 8, active,
      )
      if (nearestIndex >= 0) {
        applySelectionIds(
          expand([nearestIndex]),
          pcp.brushOperation === 'add' ? 'toggle' : pcp.brushOperation,
          '線をクリック選択',
        )
      }
      return
    }
    // Worker-based exact hit-test over the polyline buffer.
    const active = new Uint8Array(g.nRows).fill(1)
    const hits = await graphEngine.polylineHit(
      g.points, g.nRows, g.nAxes,
      rect as Rect, pcp.hitMode, active,
    )
    const modeLabel = pcp.hitMode === 'legacyVertex' ? 'DAVIS頂点ブラシ' : '線分交差ブラシ'
    applySelectionIds(expand(hits), pcp.brushOperation, modeLabel)
  }

  const runOrdering = async (mode: string) => {
    if (!selection.datasetId) return
    dispatch(pcpStateChanged({ orderMode: mode }))
    if (mode === 'manual' || mode === 'database') {
      setDiagnostics(null)
      setOrderError(null)
      if (mode === 'database') {
        const inputOrder = axes.map((a) => a.key)
        dispatch(pcpStateChanged({ order: inputOrder }))
      }
      return
    }
    setOrderingLoading(true)
    try {
      const result = await api.post<OrderingDiagnostics & { outputColumnIds: string[] }>('/orderings', {
        datasetId: selection.datasetId,
        mode,
      })
      setDiagnostics({ ...result })
      setOrderError(null)
      dispatch(pcpStateChanged({
        order: [
          ...result.outputColumnIds,
          ...pcp.order.filter((k) => !result.outputColumnIds.includes(k)),
        ],
      }))
    } catch (error) {
      const err = error as { message: string; suggestedActions?: string[] }
      setOrderError({ message: err.message, suggestedActions: err.suggestedActions ?? [] })
    } finally {
      setOrderingLoading(false)
    }
  }

  const moveAxis = (key: string, targetIndex: number) => {
    const visible = pcp.order.filter((k) => pcp.visibleColumns.includes(k))
    const from = visible.indexOf(key)
    if (from < 0) return
    const target = Math.min(Math.max(targetIndex, 0), visible.length - 1)
    if (from === target) return
    visible.splice(from, 1)
    visible.splice(target, 0, key)
    const hidden = pcp.order.filter((k) => !pcp.visibleColumns.includes(k))
    dispatch(pcpStateChanged({ order: [...visible, ...hidden], orderMode: 'manual' }))
  }

  const reverseAxis = (key: string) =>
    dispatch(pcpStateChanged({ reversed: { ...pcp.reversed, [key]: !pcp.reversed[key] } }))

  const tooltipContent = useMemo(() => {
    if (!tooltip || !data) return null
    const index = data.rowIndex.get(tooltip.id)
    if (index === undefined) return null
    // Under simplification the hovered line represents a whole cluster —
    // say so instead of presenting the medoid as a lone row.
    const members = simplificationRef.current?.membersOfDrawnRow
    const geometryRows = geometryRef.current?.rowIds ?? []
    const geomIndex = geometryRows.indexOf(tooltip.id)
    const memberCount = members && geomIndex >= 0 ? (members[geomIndex]?.length ?? 1) : 1
    return (
      <div>
        <strong>{tooltip.id}</strong>
        {memberCount > 1 && (
          <div style={{ color: '#888' }}>代表行: {memberCount}行のクラスタ</div>
        )}
        {data.schema.slice(0, 6).map((c) => (
          <div key={c.columnId}><ColumnQuestionText nameOrId={c.name} />: {formatValueLabel(c.name, data.columns[c.name]?.[index])} ({String(data.columns[c.name]?.[index] ?? '')})</div>
        ))}
      </div>
    )
  }, [tooltip, data, formatValueLabel])

  const orderMenu = (
    <div style={{ padding: 12, width: 260, background: '#fff', borderRadius: 8, boxShadow: '0 3px 12px rgba(0,0,0,.15)', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
      <div>
        <Typography.Text strong style={{ fontSize: 12 }}>軸順</Typography.Text>
        <AntSelect
          data-testid="order-mode"
          size="small"
          value={pcp.orderMode}
          style={{ width: '100%', marginTop: 4 }}
          onChange={runOrdering}
          options={[
            { value: 'database', label: 'NoOrder（入力順）' },
            { value: 'componentJar', label: 'Component／JAR初版互換' },
            { value: 'componentPaper', label: 'Component／原論文解釈' },
            { value: 'permute', label: 'PermuteOrder' },
            { value: 'correlation', label: '相関セリエーション' },
            { value: 'manual', label: 'Manual Order' },
          ]}
        />
        <Space size="small" style={{ marginTop: 6 }}>
          <Segmented
            size="small"
            data-testid="orientation"
            options={[{ label: '水平', value: 'horizontal' }, { label: '垂直', value: 'vertical' }]}
            value={pcp.orientation}
            onChange={(value) => dispatch(pcpStateChanged({ orientation: value as 'horizontal' | 'vertical' }))}
          />
        </Space>
      </div>
    </div>
  )

  const renderSettingsMenu = (
    <div style={{ padding: 12, width: 280, background: '#fff', borderRadius: 8, boxShadow: '0 3px 12px rgba(0,0,0,.15)', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
      {imputedCells.size > 0 && (
        <Typography.Text type="secondary" aria-label="補完マーカーの説明">
          ◆紫マーカー・点線＝補完値（{imputedCells.size}行に補完あり）
        </Typography.Text>
      )}
      {selection.groups.length > 0 && (
        <div>
          <label>
            <Switch
              size="small"
              data-testid="l2-color-toggle"
              checked={selection.l2ColorEnabled}
              onChange={(checked) => dispatch(l2ColorToggled(checked))}
            />{' '}
            L2色分け：解析グループ（{selection.groups[0].source?.startsWith('clustering') ? 'クラスタ' : 'グループ'} {selection.groups.length}件）
          </label>
        </div>
      )}
      <div>
        <Typography.Text style={{ fontSize: 12 }}>文脈線の不透明度 {Math.round(pcp.lineOpacity * 100)}%</Typography.Text>
        <Slider data-testid="line-opacity" min={4} max={70} value={Math.round(pcp.lineOpacity * 100)} style={{ margin: '0' }}
          onChange={(v) => dispatch(pcpStateChanged({ lineOpacity: v / 100 }))} />
        <Typography.Text style={{ fontSize: 12 }}>線幅 {pcp.lineWidth.toFixed(1)} px</Typography.Text>
        <Slider data-testid="line-width" min={5} max={30} value={Math.round(pcp.lineWidth * 10)} style={{ margin: '0' }}
          onChange={(v) => dispatch(pcpStateChanged({ lineWidth: v / 10 }))} />
      </div>
      <Space size="middle" wrap>
        <label><Switch size="small" data-testid="show-context" checked={pcp.showContext} onChange={(c) => dispatch(pcpStateChanged({ showContext: c }))} /> 選択外を表示</label>
        <label><Switch size="small" data-testid="high-quality" checked={pcp.highQuality} onChange={(c) => dispatch(pcpStateChanged({ highQuality: c }))} /> 高品質</label>
      </Space>
      <div>
        <Typography.Text style={{ fontSize: 12 }}>描画簡略化</Typography.Text>
        <AntSelect
          data-testid="simplify-mode"
          size="small"
          style={{ width: '100%', marginTop: 4 }}
          value={pcp.simplifyMode}
          onChange={(value) => dispatch(pcpStateChanged({ simplifyMode: value }))}
          options={[
            { value: 'kmedoids', label: 'K-Medoids（300サンプル）' },
            { value: 'off', label: 'OFF' },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          500行超で適用／代表行（メドイド）のみ描画。ブラシ・ホバーは代表行にのみ反応します。
        </Typography.Text>
        {simplification && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {simplification.medoidCount}本の代表線で描画中（{activeRowIndexes.length}行をクラスタリング）
          </Typography.Text>
        )}
      </div>
      <div>
        <label><Switch size="small" data-testid="jitter-enabled" checked={pcp.jitterEnabled} onChange={(c) => dispatch(pcpStateChanged({ jitterEnabled: c }))} /> Jittering</label>
        {pcp.jitterEnabled && (
          <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 4 }}>
            <AntSelect
              data-testid="jitter-mode"
              size="small"
              style={{ width: '100%' }}
              value={pcp.jitterMode}
              onChange={(value) => dispatch(pcpStateChanged({ jitterMode: value }))}
              options={[
                { value: 'pixel', label: '決定的pixel jitter' },
                { value: 'legacyRaw', label: '初版raw ±0.1' },
              ]}
            />
            <InputNumber data-testid="jitter-amount" size="small" min={0} max={16} disabled={pcp.jitterMode === 'legacyRaw'} value={pcp.jitterAmount} onChange={(v) => dispatch(pcpStateChanged({ jitterAmount: Number(v) ?? 0 }))} addonAfter="px" style={{ width: '100%' }} />
            <InputNumber data-testid="jitter-seed" size="small" min={0} max={2147483647} value={pcp.jitterSeed} onChange={(v) => dispatch(pcpStateChanged({ jitterSeed: Number(v) ?? 0 }))} addonBefore="seed" style={{ width: '100%' }} />
          </Space>
        )}
      </div>
    </div>
  )

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

  if (!selection.datasetId) {
    return <Alert type="info" showIcon message="データセットを読み込んでください。" description="上部のImportからCSV等を取り込むか、Irisサンプルを選択してください。" />
  }

  const axisChooser = <Space wrap><Select mode="multiple" aria-label="PCPの表示軸" placeholder="表示軸を選択"
    style={{ minWidth: 240, maxWidth: 480 }} maxTagCount={2} allowClear optionFilterProp="label"
    value={pcp.visibleColumns.filter(name => eligibleAxisKeys.includes(name))}
    options={[...ordinaryNames.filter(name => globalVars.activeVariableIds.includes(name)).map(name => ({ value: name, label: `${name}: ${codebookColumns.find(column => column.name === name)?.label || name}` })),
      ...availableMaAxes.map(axis => ({ value: axis.key, label: axes.find(item => item.key === axis.key)?.label || (axis.kind === 'maCount' ? `${axis.groupId}・選択数` : codebookColumns.find(column => column.columnId === axis.columnId)?.multiResponseOptionLabel || codebookColumns.find(column => column.columnId === axis.columnId)?.label || axis.columnId) }))]}
    onChange={names => dispatch(pcpStateChanged({ visibleColumns: names }))} />
    <MaAxisPicker groups={maGroups} columns={codebookColumns} onAdd={added => dispatch(pcpStateChanged({
      maAxes: [...new Map([...(pcp.maAxes ?? []), ...added].map(axis => [axis.key, axis])).values()],
      visibleColumns: [...new Set([...pcp.visibleColumns, ...added.map(axis => axis.key)])],
      order: [...new Set([...pcp.order, ...added.map(axis => axis.key)])],
    }))} /></Space>

  if (orderedVisibleAxes.length < 2) {
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
      {axisChooser}
      <EmptyStatePanel
        message="平行座標プロットには2つ以上の表示軸が必要です。共通変数とこのページの表示軸を選択してください。"
        minVariables={2}
      />
      </Space>
    )
  }

  return (
    <div data-testid="pcp-page" style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', flex: 1, minHeight: 400 }}>
      <Space size="small" wrap>
        {axisChooser}
        <Dropdown popupRender={() => orderMenu} trigger={['click']} disabled={orderingLoading} getPopupContainer={() => document.body}>
          <Button data-testid="axis-order-menu" loading={orderingLoading}>軸順 <DownOutlined /></Button>
        </Dropdown>
        <Dropdown popupRender={() => renderSettingsMenu} trigger={['click']} getPopupContainer={() => document.body}>
          <Button data-testid="axis-settings">描画設定 <DownOutlined /></Button>
        </Dropdown>
        {selection.selectedRowIds.length > 0 && (
          <Typography.Text type="secondary">選択 {selection.selectedRowIds.length}行</Typography.Text>
        )}
        {diagnostics && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {diagnostics.evidenceClass}
          </Typography.Text>
        )}
      </Space>

        {orderError && (
          <Alert
            type="warning"
            showIcon
            closable
            message={orderError.message}
            description={<ul>{orderError.suggestedActions.map((action) => <li key={action}>{action}</li>)}</ul>}
            onClose={() => setOrderError(null)}
          />
        )}

        <GraphPanel
          graphId="pcp/main"
          title="平行座標プロット (PCP)"
          available={orderedVisibleAxes.length >= 2}
          sizing="responsive"
        >
        <PcpPlotViewport onSize={onViewportSize} />
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={graphPopupContainer}>
        <div ref={setMeasureNode} data-testid="plot-frame" style={{ flex: 1, minHeight: 320, height: '100%', outline: '1px solid #e5e7eb', outlineOffset: -1, borderRadius: 6, background: '#ffffff', overflow: 'visible', userSelect: 'none' }}>
          <div data-testid="plot-canvas-area" style={{ position: 'relative', width: isPlotLoading ? '100%' : (isVertical ? '100%' : Math.max(virtualWidth, 1)), height: isPlotLoading ? '100%' : (isVertical ? Math.max(virtualHeight, 1) : '100%'), minWidth: '100%', minHeight: '100%', overflow: 'visible' }}>
          {orderingLoading && (
            <div
              role="status"
              aria-live="polite"
              style={{
                position: 'absolute', inset: 0, zIndex: 30,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255, 255, 255, 0.8)', backdropFilter: 'blur(2px)',
                gap: 12,
              }}
            >
              <Spin size="large" tip="軸順を最適化中..."><div style={{ height: 80 }} /></Spin>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                相関セリエーション / 最適順序を計算しています
              </Typography.Text>
            </div>
          )}
          {(preparingFirstFrame || !firstFrameRendered) && !orderingLoading && (
            <div
              data-testid="pcp-preparing"
              role="status"
              aria-live="polite"
              style={{
                position: 'absolute', inset: 0, zIndex: 20,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 10, color: theme.inkMuted, pointerEvents: 'none',
                background: 'rgba(255, 255, 255, 0.6)',
              }}
            >
              <Spin size="large" tip="平行座標プロットを描画準備中…"><div style={{ height: 80 }} /></Spin>
            </div>
          )}
          <canvas ref={canvasRef} data-testid="pcp-canvas" role="img" aria-label="Parallel coordinates plot"
            style={{ position: 'sticky', left: 0, top: 0, display: 'block' }} />
          <svg
            ref={overlayRef}
            data-testid="plot-overlay"
            viewBox={`0 0 ${Math.max(virtualWidth, 1)} ${Math.max(virtualHeight, 1)}`}
            width={Math.max(virtualWidth, 1)}
            height={Math.max(virtualHeight, 1)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={(e) => cancelBrush(e.pointerId)}
            onLostPointerCapture={(e) => { if (brushState.current?.pointerId === e.pointerId) cancelBrush(e.pointerId) }}
            onPointerLeave={() => { dispatch(hoverAction(null)); setTooltip(null) }}
            onDoubleClick={() => dispatch(selectionCleared())}
          >
            {geometry && orderedVisibleAxes.map((axis, index) => {
              const horizontal = pcp.orientation === 'horizontal'
              const anchor = geometry.axisPos[index]
              const hit = <rect x={horizontal ? -130 : geometry.bounds.left - 130}
                  y={horizontal ? -10 : anchor - 10}
                  transform={horizontal ? `translate(${anchor}, ${geometry.bounds.bottom + 8}) rotate(-45)` : undefined}
                  width={130} height={22} fill="transparent" aria-label={axis.label} />
              return availableMaAxes.some(item => item.key === axis.key)
                ? <g key={axis.key}><title>{axis.label}</title>{hit}</g>
                : <ColumnQuestionTooltip key={axis.key} nameOrId={axis.key} svg>{hit}</ColumnQuestionTooltip>
            })}
            {geometry && orderedVisibleAxes.flatMap((axis, index) => (axis.categories ?? []).map((code, i) => {
              let t = (axis.categories?.length ?? 0) <= 1 ? 0.5 : i / (axis.categories!.length - 1)
              if (Boolean(axis.isReversed) !== Boolean(pcp.reversed[axis.key])) t = 1 - t
              const horizontal = pcp.orientation === 'horizontal'
              const x = horizontal ? geometry.axisPos[index] - 95 : geometry.bounds.left + t * (geometry.bounds.right - geometry.bounds.left) - 40
              const y = horizontal ? geometry.bounds.bottom - t * (geometry.bounds.bottom - geometry.bounds.top) - 8 : geometry.axisPos[index] - 20
              const label = axis.valueLabels?.[code] ?? code
              return <rect key={`${axis.key}-${code}`} data-testid={`pcp-tick-${axis.key}-${code}`} data-code={code} data-label={label}
                x={x} y={y} width={88} height={16} fill="transparent" aria-label={`${axis.label}: ${label} (${code})`}
                onPointerDown={e => e.stopPropagation()}><title>{`${axis.label}: ${label} (${code})`}</title></rect>
            }))}
            <rect ref={brushRectRef} fill="rgba(42,120,214,0.15)" strokeWidth={1.5} style={{ pointerEvents: 'none' }} stroke="#2a78d6" visibility="hidden" />
          </svg>
          {/* v1-style on-axis controls: move/reverse buttons near each axis.
              Horizontal: controls sit in a row ABOVE the plot. Vertical: axes
              stack along y, controls sit to the RIGHT of each axis line,
              aligned in a column along the right side of the plot. */}
          {!isPlotLoading && geometry && orderedVisibleAxes.map((axis, index) => {
            const visibleIndex = index
            const vertical = pcp.orientation === 'vertical'
            const left = vertical
              ? geometry.bounds.right + 8
              : (geometry.axisPos[index] ?? 0)
            const top = vertical
              ? (geometry.axisPos[index] ?? 0)
              : 8
            // 色分けアイコン付きの列は操作部を2列（アイコン行＋ボタン行）にし、
            // 横幅をボタン3個分に抑えて隣の軸操作と重ならないようにする。
            const isColored = pcp.colorBy === axis.key
            return (
              <div key={axis.key}>
                <div
                  className="axis-control"
                  data-testid={`axis-control-${axis.key}`}
                  style={{
                    position: 'absolute', left, top,
                    transform: vertical ? 'translateY(-50%)' : 'translateX(-50%)',
                    display: 'flex', flexDirection: 'column',
                    gap: 2, alignItems: 'center',
                    background: 'rgba(255,255,255,0.92)', border: '1px solid #d9d9d9', borderRadius: 6,
                    padding: '2px 4px', zIndex: 10,
                    maxWidth: 76,
                  }}
                >
                {isColored && (
                  <span title={`この軸（${axis.label}）で色分け中`} style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%', overflow: 'hidden' }}>
                    {theme.categorical.slice(1, 5).map((c) => (
                      <span key={c} style={{ width: 5, height: 12, background: c, marginRight: 1, borderRadius: 1, flexShrink: 0 }} />
                    ))}
                  </span>
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {vertical ? (
                  <>
                    <Button size="small" type="text" style={{ padding: '0 4px', minWidth: 20, height: 20 }}
                      icon={<ArrowUpOutlined />} disabled={visibleIndex === 0}
                      aria-label={`${axis.label}を前へ移動`} onClick={() => moveAxis(axis.key, visibleIndex - 1)} />
                    <Button size="small" type="text" style={{ padding: '0 4px', minWidth: 20, height: 20 }}
                      icon={<CaretLeftOutlined />} aria-label={`${axis.label}を反転`}
                      onClick={() => reverseAxis(axis.key)} />
                    <Button size="small" type="text" style={{ padding: '0 4px', minWidth: 20, height: 20 }}
                      icon={<ArrowDownOutlined />} disabled={visibleIndex === orderedVisibleAxes.length - 1}
                      aria-label={`${axis.label}を次へ移動`} onClick={() => moveAxis(axis.key, visibleIndex + 1)} />
                  </>
                ) : (
                  <>
                    <Button size="small" type="text" style={{ padding: '0 4px', minWidth: 20, height: 20 }}
                      icon={<ArrowLeftOutlined />} disabled={visibleIndex === 0}
                      aria-label={`${axis.label}を前へ移動`} onClick={() => moveAxis(axis.key, visibleIndex - 1)} />
                    <Button size="small" type="text" style={{ padding: '0 4px', minWidth: 20, height: 20 }}
                      icon={<CaretUpOutlined />} aria-label={`${axis.label}を反転`}
                      onClick={() => reverseAxis(axis.key)} />
                    <Button size="small" type="text" style={{ padding: '0 4px', minWidth: 20, height: 20 }}
                      icon={<ArrowRightOutlined />} disabled={visibleIndex === orderedVisibleAxes.length - 1}
                      aria-label={`${axis.label}を次へ移動`} onClick={() => moveAxis(axis.key, visibleIndex + 1)} />
                  </>
                )}
                </span>
              </div>
            </div>
          )
        })}
          {tooltip && createPortal(
            <div data-testid="pcp-hover-tooltip" role="tooltip" style={{ position: 'fixed', left: tooltip.x + 14, top: tooltip.y + 14, zIndex: 100, background: '#fff', border: '1px solid #d9d9d9', borderRadius: 4, padding: '6px 10px', fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,.15)', pointerEvents: 'none' }}>
              {tooltipContent}
            </div>,
            graphPopupContainer(),
          )}
          </div>
        </div>
        </Dropdown>
        </GraphPanel>

        {diagnostics && (
          <div data-testid="ordering-diagnostics">
            <Table
              size="small"
              pagination={false}
              dataSource={diagnostics.iterationTrace.map((item) => ({ ...item, key: item.step }))}
              columns={[
                { title: 'Step', dataIndex: 'step', key: 'step', width: 60 },
                { title: '選択軸', dataIndex: 'selected', key: 'selected' },
                { title: '規則', dataIndex: 'rule', key: 'rule' },
                {
                  title: 'loading',
                  dataIndex: 'loading',
                  key: 'loading',
                  render: (v?: number[]) => (v?.length ? v.map((x) => x.toFixed(4)).join(', ') : '—'),
                },
              ]}
            />
            <Typography.Text type="secondary">
              候補: {diagnostics.candidateOrders.length ? diagnostics.candidateOrders.map((order, i) => `(${order.join('→')}: ${diagnostics.candidateScores[i]})`).join(' ') : 'なし'}
            </Typography.Text>
            <Tag color="blue" style={{ marginLeft: 8 }}>{diagnostics.evidenceClass}</Tag>
          </div>
        )}
    </div>
  )
}
