import { fitPointSeries, markerFitScale } from './markerStyle'
import { useGraphViewport } from '../common/GraphPanel'
import { useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type MutableRefObject, type RefObject } from 'react'
import * as echarts from 'echarts'
import Eventful from 'zrender/lib/core/Eventful.js'
import { downloadChartSvg, downloadChartPng } from './chartExport'
import GraphExportControl, { type GraphExportFormat } from './GraphExportControl'
import { layoutCategoryAxes } from './categoryAxisLayout'
import { ReactReduxContext } from 'react-redux'
import type { ECharts, EChartsOption } from 'echarts'

export interface EChartKeyboardItem {
  id: string
  label: string
  seriesIndex?: number
  dataIndex?: number
}
export interface EChartKeyboardNavigation {
  items: readonly EChartKeyboardItem[]
  onSelect?: (id: string) => void
  onHover?: (id: string | null) => void
}

export interface EChartProps {
  /** Accessible mark traversal. Callbacks share the pointer selection/hover path. */
  keyboardNavigation?: EChartKeyboardNavigation
  /** Ordinary scatter/line markers opt in; semantic/tree geometry is untouched. */
  fitPointMarkers?: boolean
  /** Invisible coarse-pointer radius for point charts without a nearest-point handler. */
  pointHitRadius?: number
  resetKey?: string | number
  exportPosition?: 'top-right' | 'top-left'
  exportFormats?: readonly GraphExportFormat[]
  exportFileName?: string
  exportTarget?: string
  renderer?: 'svg' | 'canvas'
  option: EChartsOption
  height?: number | string
  width?: number | string
  onEvents?: Record<string, (params: any, chart: ECharts) => void>
  onReady?: (chart: ECharts) => void
  chartRef?: MutableRefObject<ECharts | null>
  svgRef?: RefObject<SVGSVGElement>
  ariaLabel?: string
  testId?: string
  style?: CSSProperties
}

/** Single lifecycle owner for all non-PCP charts. Options and handlers may change
 * without recreating a chart; hidden keep-alive/focus panels resize on re-entry. */
export default function EChart({ option, height = 360, width = '100%', onEvents, onReady,
  chartRef, svgRef, resetKey, renderer = 'svg', ariaLabel = '統計グラフ', testId, style, exportPosition = 'top-right',
  exportFormats = ['svg'], exportFileName, exportTarget, pointHitRadius, fitPointMarkers = false, keyboardNavigation }: EChartProps) {
  const keyboardEnabled = Boolean(keyboardNavigation?.items.length)
  const graphViewport=useGraphViewport()
  const viewportKey=JSON.stringify(graphViewport)
  const fitScale = fitPointMarkers ? markerFitScale(graphViewport) : 1
  // SVG is resolution independent. ECharts Canvas fixes DPR at init, so renew
  // only its painter when the display density changes; React/analysis stay alive.
  const effectivePointerSize = pointHitRadius ? 2 * pointHitRadius / Math.max(graphViewport.scale, .01) : undefined
  const effectiveDpr=renderer==='canvas' ? Math.max(.5,(graphViewport.dpr || (typeof window!=='undefined' ? window.devicePixelRatio : 1) || 1)*graphViewport.scale) : 1
  const redux = useContext(ReactReduxContext)
  const datasetId = useSyncExternalStore(redux?.store.subscribe ?? (() => () => {}), () => redux?.store.getState().selection?.datasetId)
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<ECharts | null>(null)
  // DPR / pointer-tolerance changes replace the painter, not user legend/zoom choices.
  const previousInstanceOption = useRef<ReturnType<ECharts['getOption']> | undefined>()
  const events = useRef(onEvents)
  const ready = useRef(onReady)
  const readyCalled = useRef(false)
  const legendKey = useRef<string | null>(null)
  events.current = onEvents
  ready.current = onReady
  const eventNames = Object.keys(onEvents ?? {}).sort().join('|')
  const rawOption = useRef(option)
  rawOption.current = option
  const labelViewport = useRef('')
  const relayoutCategories = (chart: ECharts) => {
    const key = `${chart.getWidth()}x${chart.getHeight()}`
    if (labelViewport.current === key) return
    labelViewport.current = key
    const source = rawOption.current
    const laidOut = layoutCategoryAxes(source, chart.getWidth(), chart.getHeight())
    if (laidOut !== source) chart.setOption({ grid: laidOut.grid, xAxis: laidOut.xAxis, yAxis: laidOut.yAxis }, { lazyUpdate: false })
  }

  useEffect(() => {
    const element = container.current
    if (!element) return
    const chart = echarts.init(element, undefined, { renderer, devicePixelRatio: effectiveDpr,
      ...(effectivePointerSize ? { useCoarsePointer: true, pointerSize: effectivePointerSize } : {}) })
    instance.current = chart
    if (chartRef) chartRef.current = chart
    const syncSvg = () => {
      if (svgRef) (svgRef as MutableRefObject<SVGSVGElement | null>).current = element.querySelector('svg')
    }
    chart.on('finished', syncSvg)
    const resize = () => {
      if (!chart.isDisposed() && element.clientWidth > 0 && element.clientHeight > 0) {
        chart.resize({ animation: { duration: 0 } })
        relayoutCategories(chart)
        syncSvg()
      }
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    observer?.observe(element)
    window.addEventListener('resize', resize)
    // A keep-alive page can become visible without a viewport resize.
    const visibility = () => { if (!document.hidden) resize() }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', visibility)
      chart.off('finished', syncSvg)
      if (chartRef?.current === chart) chartRef.current = null
      if (svgRef) (svgRef as MutableRefObject<SVGSVGElement | null>).current = null
      instance.current = null
      readyCalled.current = false
      previousInstanceOption.current = chart.getOption()
      chart.dispose()
    }
  }, [chartRef, svgRef, renderer, effectiveDpr, effectivePointerSize])

  useEffect(() => {
    const chart=instance.current, element=container.current
    if(chart && !chart.isDisposed() && element && element.clientWidth>0 && element.clientHeight>0) {
      chart.resize({animation:{duration:0}})
      relayoutCategories(chart)
    }
  },[viewportKey])

  useEffect(() => {
    const chart = instance.current
    if (!chart) return
    const nextSeries = Array.isArray(option.series) ? option.series : option.series ? [option.series] : []
    const topology = (nodes: any[]): any => nodes.map(node => [node.id, node.name, node.value, topology(node.children ?? [])])
    const key = JSON.stringify([resetKey ?? datasetId, nextSeries.map(series => [series.id, series.name, series.type,
      series.type === 'tree' ? topology((series as any).data ?? []) : undefined])])
    const previous = chart.getOption() ?? previousInstanceOption.current
    let legend = option.legend
    if (legend && legendKey.current === key) {
      const oldLegends = Array.isArray(previous?.legend) ? previous.legend : []
      const nextLegends = Array.isArray(legend) ? legend : [legend]
      legend = nextLegends.map((entry, index) => ({ ...entry, selected: { ...(oldLegends[index] as any)?.selected, ...entry.selected } }))
    }
    let dataZoom = option.dataZoom
    let series = option.series
    if (legendKey.current === key) {
      if (dataZoom) {
        const zooms = Array.isArray(dataZoom) ? dataZoom : [dataZoom]
        dataZoom = zooms.map((zoom, index) => {
          const old = (previous?.dataZoom as any[])?.[index]
          return old ? { ...zoom, start: old.start, end: old.end, startValue: old.startValue, endValue: old.endValue } : zoom
        })
      }
      series = nextSeries.map((item, index) => {
        const old = (previous?.series as any[])?.[index]
        return item.type === 'tree' && item.roam && old?.type === 'tree' ? { ...item, zoom: old.zoom, center: old.center } : item
      })
    }
    legendKey.current = key
    const tooltips = option.tooltip ? (Array.isArray(option.tooltip) ? option.tooltip : [option.tooltip]).map(tooltip => ({
      ...tooltip,
      // Full labels remain readable without growing the graph's scroll extent.
      // Preserve the caller's enterable setting; ordinary mark tooltips must not
      // intercept the next cell/point click. Full-label axis tips opt in separately.
      ...(tooltip.renderMode !== 'richText' ? { confine: true,
        className: [tooltip.className, 'davis-chart-tooltip'].filter(Boolean).join(' '), extraCssText:
        `${tooltip.extraCssText ?? ''}; max-width: min(420px, 80vw); max-height: 50vh; white-space: normal; overflow-wrap: anywhere; overflow: auto` } : {}),
    })) : undefined
    const laidOut = layoutCategoryAxes(option, chart.getWidth(), chart.getHeight())
    labelViewport.current = `${chart.getWidth()}x${chart.getHeight()}`
    chart.setOption({
      animation: false,
      ...laidOut,
      // The focusable mark navigator owns its accessible role and instructions.
      // ECharts' generated ARIA otherwise overwrites that element with role=img.
      aria: keyboardEnabled ? { ...laidOut.aria, enabled: false }
        : { enabled: true, label: { description: ariaLabel }, ...laidOut.aria },
      ...(tooltips ? { tooltip: tooltips } : {}),
      ...(legend ? { legend } : {}),
      ...(dataZoom ? { dataZoom } : {}),
      ...(series ? { series: fitPointSeries(series, fitScale) } : {}),
      // Export is a stable DOM control: a native toolbox target is recreated
      // on setOption (including every Grand Tour frame), losing in-flight clicks.
      toolbox: option.toolbox,
    }, { notMerge: true, lazyUpdate: false })
    if (svgRef) (svgRef as MutableRefObject<SVGSVGElement | null>).current = container.current?.querySelector('svg') ?? null
    if (!readyCalled.current) { readyCalled.current = true; ready.current?.(chart) }
  }, [option, ariaLabel, chartRef, svgRef, renderer, effectiveDpr, effectivePointerSize, fitScale, resetKey, datasetId, keyboardEnabled])

  useEffect(() => {
    const chart = instance.current
    if (!chart) return
    const handlers = eventNames.split('|').filter(Boolean).map(name => {
      const handler = (params: any) => {
        // Label tooltips must not masquerade as series marks in selection handlers.
        // Preserve explicitly interactive axes (the BarChart's category selector).
        if (params?.componentType === 'xAxis' || params?.componentType === 'yAxis') {
          const source = rawOption.current[params.componentType as 'xAxis' | 'yAxis']
          const axes = Array.isArray(source) ? source : [source]
          if (!axes[params.componentIndex ?? 0]?.triggerEvent) return
        }
        events.current?.[name]?.(params, chart)
      }
      chart.on(name, handler)
      return { name, handler }
    })
    return () => { if (!chart.isDisposed()) handlers.forEach(({ name, handler }) => chart.off(name, handler)) }
  }, [eventNames, chartRef, svgRef, renderer, effectiveDpr, effectivePointerSize])

  const [keyboardId, setKeyboardId] = useState<string | null>(null)
  const keyboard = useRef(keyboardNavigation); keyboard.current = keyboardNavigation
  const activeKeyboardItem = useRef<EChartKeyboardItem | null>(null)
  const keyboardScope = `${resetKey ?? datasetId ?? ''}`
  const previousKeyboardScope = useRef(keyboardScope)
  const leaveKeyboard = () => {
    const previous = activeKeyboardItem.current
    activeKeyboardItem.current = null
    const chart = instance.current
    if (previous && chart && !chart.isDisposed()) {
      if (previous.seriesIndex !== undefined && previous.dataIndex !== undefined)
        chart.dispatchAction({ type: 'downplay', seriesIndex: previous.seriesIndex, dataIndex: previous.dataIndex })
      chart.dispatchAction({ type: 'hideTip' })
    }
    if (previous) keyboard.current?.onHover?.(null)
  }
  const enterKeyboard = (item: EChartKeyboardItem | undefined) => {
    leaveKeyboard()
    activeKeyboardItem.current = item ?? null
    setKeyboardId(item?.id ?? null)
    if (!item) return
    const chart = instance.current
    if (chart && !chart.isDisposed() && item.seriesIndex !== undefined && item.dataIndex !== undefined) {
      chart.dispatchAction({ type: 'highlight', seriesIndex: item.seriesIndex, dataIndex: item.dataIndex })
      chart.dispatchAction({ type: 'showTip', seriesIndex: item.seriesIndex, dataIndex: item.dataIndex })
    }
    keyboard.current?.onHover?.(item.id)
  }
  const keyboardItemsKey = JSON.stringify(keyboardNavigation?.items.map(item => [item.id, item.seriesIndex, item.dataIndex]))
  useEffect(() => {
    const current = keyboard.current?.items.find(item => item.id === activeKeyboardItem.current?.id)
    if (previousKeyboardScope.current !== keyboardScope || (activeKeyboardItem.current && !current)) {
      leaveKeyboard(); setKeyboardId(null)
    } else if (current) activeKeyboardItem.current = current
    previousKeyboardScope.current = keyboardScope
  }, [keyboardItemsKey, keyboardScope])
  useEffect(() => () => leaveKeyboard(), [])
  const keyboardItem = keyboardNavigation?.items.find(item => item.id === keyboardId)

  const retainNativeControl = (event: MouseEvent<HTMLDivElement>) => {
    // Long full-text tooltips can be scrolled without starting a chart brush.
    if (event.target instanceof Element && event.target.closest('.davis-chart-tooltip')) {
      event.stopPropagation(); return
    }
    const chart = instance.current, element = container.current
    if (!chart || chart.isDisposed() || !element) return
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    let target: echarts.ElementEvent['target'] | undefined = chart.getZr().findHover(
      (event.clientX - rect.left) * chart.getWidth() / rect.width,
      (event.clientY - rect.top) * chart.getHeight() / rect.height,
    )?.target
    // Toolbox/legend controls own their click. An outer selection wrapper must
    // not capture their pointer: that retargets pointerup/click outside zrender
    // and silently prevents export. Keep ordinary plot hits/brushes bubbling.
    while (target) {
      // Element.isSilent() tests drawing/hit-test visibility, while the Eventful
      // method inspects handlers registered with .on('click', ...) by ECharts.
      if (typeof target.onclick === 'function' || !Eventful.prototype.isSilent.call(target, 'click')) {
        event.stopPropagation(); return
      }
      target = target.parent
    }
  }

  return <div data-chart-host="echarts" style={{ width, height, minWidth: 0, minHeight: 100, position: 'relative', ...style }}>
    <div ref={container} data-testid={testId} data-chart-renderer="echarts" role={keyboardEnabled ? 'group' : 'img'}
      tabIndex={keyboardEnabled ? 0 : undefined}
      aria-label={keyboardEnabled ? `${ariaLabel}。矢印キーでマークを移動${keyboardNavigation?.onSelect ? '、EnterまたはSpaceで選択' : ''}、Escapeで詳細を閉じる` : ariaLabel}
      onFocus={event => { if (event.target === event.currentTarget) enterKeyboard(keyboardItem ?? keyboard.current?.items[0]) }}
      onBlur={() => { leaveKeyboard(); setKeyboardId(null) }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
        const navigation = keyboard.current, items = navigation?.items
        if (!items?.length) return
        const index = Math.max(0, items.findIndex(item => item.id === keyboardId))
        if (event.key.startsWith('Arrow')) {
          event.preventDefault()
          const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
          enterKeyboard(items[(index + direction + items.length) % items.length])
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault(); enterKeyboard(items[event.key === 'Home' ? 0 : items.length - 1])
        } else if ((event.key === 'Enter' || event.key === ' ') && navigation?.onSelect) {
          event.preventDefault(); navigation.onSelect(items[index].id)
        } else if (event.key === 'Escape') { leaveKeyboard(); setKeyboardId(null) }
      }}
      onPointerDown={retainNativeControl} onMouseDown={retainNativeControl}
      style={{ width: '100%', height: '100%', minWidth: 0, userSelect: 'none', touchAction: 'none' }} />
    {keyboardNavigation && <span aria-live="polite" style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{keyboardItem?.label ?? ''}</span>}
    <div data-chart-export-controls onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      style={{ position: 'absolute', top: 4, ...(exportPosition === 'top-left' ? { left: 8 } : { right: 8 }), zIndex: 2, display: 'flex', gap: 4, maxWidth: 'calc(100% - 16px)' }}>
      {exportFormats.map(format => <GraphExportControl key={format} format={format} graphLabel={ariaLabel} target={exportTarget}
        exportKey={resetKey ?? datasetId} statusStyle={{ position: 'absolute', top: 28, ...(exportPosition === 'top-left' ? { left: 0 } : { right: 0 }), background: '#fff', padding: 4, width: 240, zIndex: 3 }}
        onExport={() => {
          const chart = instance.current
          if (!chart || chart.isDisposed()) throw new Error('グラフを利用できません')
          return format === 'png'
            ? downloadChartPng(chart, exportFileName ?? ariaLabel, graphViewport.scale)
            : downloadChartSvg(chart, exportFileName ?? ariaLabel, graphViewport.scale)
        }} />)}
    </div>
  </div>
}

/** ECharts HTML tooltips accept markup: all labels from datasets must be escaped. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}
