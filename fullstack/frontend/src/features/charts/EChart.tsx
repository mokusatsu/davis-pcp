import { useGraphViewport } from '../common/GraphPanel'
import { useContext, useEffect, useRef, useSyncExternalStore, type CSSProperties, type MouseEvent, type MutableRefObject, type RefObject } from 'react'
import * as echarts from 'echarts'
import Eventful from 'zrender/lib/core/Eventful.js'
import { ReactReduxContext } from 'react-redux'
import type { ECharts, EChartsOption } from 'echarts'

export interface EChartProps {
  resetKey?: string | number
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
  chartRef, svgRef, resetKey, renderer = 'svg', ariaLabel = '統計グラフ', testId, style }: EChartProps) {
  const graphViewport=useGraphViewport()
  const viewportKey=JSON.stringify(graphViewport)
  // SVG is resolution independent. ECharts Canvas fixes DPR at init, so renew
  // only its painter when the display density changes; React/analysis stay alive.
  const effectiveDpr=renderer==='canvas' ? Math.max(.5,(graphViewport.dpr || (typeof window!=='undefined' ? window.devicePixelRatio : 1) || 1)*graphViewport.scale) : 1
  const redux = useContext(ReactReduxContext)
  const datasetId = useSyncExternalStore(redux?.store.subscribe ?? (() => () => {}), () => redux?.store.getState().selection?.datasetId)
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<ECharts | null>(null)
  const events = useRef(onEvents)
  const ready = useRef(onReady)
  const readyCalled = useRef(false)
  const legendKey = useRef<string | null>(null)
  events.current = onEvents
  ready.current = onReady
  const eventNames = Object.keys(onEvents ?? {}).sort().join('|')

  useEffect(() => {
    const element = container.current
    if (!element) return
    const chart = echarts.init(element, undefined, { renderer, devicePixelRatio: effectiveDpr })
    instance.current = chart
    if (chartRef) chartRef.current = chart
    const syncSvg = () => {
      if (svgRef) (svgRef as MutableRefObject<SVGSVGElement | null>).current = element.querySelector('svg')
    }
    chart.on('finished', syncSvg)
    const resize = () => {
      if (!chart.isDisposed() && element.clientWidth > 0 && element.clientHeight > 0) {
        chart.resize({ animation: { duration: 0 } })
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
      chart.dispose()
    }
  }, [chartRef, svgRef, renderer, effectiveDpr])

  useEffect(() => {
    const chart=instance.current, element=container.current
    if(chart && !chart.isDisposed() && element && element.clientWidth>0 && element.clientHeight>0)
      chart.resize({animation:{duration:0}})
  },[viewportKey])

  useEffect(() => {
    const chart = instance.current
    if (!chart) return
    const nextSeries = Array.isArray(option.series) ? option.series : option.series ? [option.series] : []
    const topology = (nodes: any[]): any => nodes.map(node => [node.id, node.name, node.value, topology(node.children ?? [])])
    const key = JSON.stringify([resetKey ?? datasetId, nextSeries.map(series => [series.id, series.name, series.type,
      series.type === 'tree' ? topology((series as any).data ?? []) : undefined])])
    const previous = chart.getOption()
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
    chart.setOption({
      animation: false,
      aria: { enabled: true, label: { description: ariaLabel } },
      ...option,
      ...(legend ? { legend } : {}),
      ...(dataZoom ? { dataZoom } : {}),
      ...(series ? { series } : {}),
      toolbox: option.toolbox === undefined || !Array.isArray(option.toolbox) ? { right: 8, ...option.toolbox, feature: { saveAsImage: { type: renderer === 'canvas' ? 'png' : 'svg', title: renderer === 'canvas' ? 'PNGを保存' : 'SVGを保存', name: ariaLabel }, ...(option.toolbox as any)?.feature } } : option.toolbox,
    }, { notMerge: true, lazyUpdate: false })
    if (svgRef) (svgRef as MutableRefObject<SVGSVGElement | null>).current = container.current?.querySelector('svg') ?? null
    if (!readyCalled.current) { readyCalled.current = true; ready.current?.(chart) }
  }, [option, ariaLabel, chartRef, svgRef, renderer, effectiveDpr, resetKey, datasetId])

  useEffect(() => {
    const chart = instance.current
    if (!chart) return
    const handlers = eventNames.split('|').filter(Boolean).map(name => {
      const handler = (params: unknown) => events.current?.[name]?.(params, chart)
      chart.on(name, handler)
      return { name, handler }
    })
    return () => { if (!chart.isDisposed()) handlers.forEach(({ name, handler }) => chart.off(name, handler)) }
  }, [eventNames, chartRef, svgRef, renderer, effectiveDpr])

  const retainNativeControl = (event: MouseEvent<HTMLDivElement>) => {
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

  return <div ref={container} data-testid={testId} data-chart-renderer="echarts" role="img" aria-label={ariaLabel}
    onPointerDown={retainNativeControl} onMouseDown={retainNativeControl}
    style={{ width, height, minWidth: 0, minHeight: 100, userSelect: 'none', touchAction: 'none', ...style }} />
}

/** ECharts HTML tooltips accept markup: all labels from datasets must be escaped. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}
