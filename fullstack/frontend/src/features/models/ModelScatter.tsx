import { CHART_MARKERS, pointDiameter, pointEmphasis } from '../charts/markerStyle'
import { useGraphViewport } from '../common/GraphPanel'
import { truncateText } from '../../utils/textUtils'
import { useContext, useEffect, useRef, useSyncExternalStore, type RefObject, type PointerEvent } from 'react'
import type { ECharts } from 'echarts'
import type { EChartsOption, SeriesOption } from 'echarts'
import EChart from '../charts/EChart'
import { ReactReduxContext } from 'react-redux'
import { hovered } from '../../app/store'

export interface ModelPoint {
  id: string; rowId?: string; x: number; y: number | null; title: string; label?: string; color?: string
  symbol?: string; selectionColor?: string; selected?: boolean; highlighted?: boolean; misclassified?: boolean
}
export function extent(values: number[]): [number, number] {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return [-1, 1]
  let lo = Infinity, hi = -Infinity
  for (const v of finite) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  const pad = lo === hi ? 1 : (hi - lo) * 0.1
  return [lo - pad, hi + pad]
}
/** Compact axis chrome only. Keep enough digits to distinguish a narrow
 * range around a large offset; plotted values and tooltip data stay exact. */
export function formatModelAxisValue(value: number, limits: readonly number[]): string {
  if (!Number.isFinite(value)) return ''
  if (value === 0) return '0'
  const span = Math.abs(limits[1] - limits[0])
  const magnitude = Math.max(Math.abs(limits[0]), Math.abs(limits[1]))
  const digits = span > 0 && magnitude > 0
    ? Math.min(14, Math.max(3, Math.ceil(Math.log10(magnitude / span)) + 3)) : 4
  const rounded = Number(value.toPrecision(digits))
  return Math.abs(rounded) >= 1e6 || Math.abs(rounded) < 1e-4 ? rounded.toExponential() : String(rounded)
}

export function modelScatterOption(points: ModelPoint[], xLabel: string, yLabel: string, oneDimensional = false,
  xExtent?: [number, number], yExtent?: [number, number], extraSeries: SeriesOption[] = [], note?: string): EChartsOption {
  const x = xExtent ?? extent(points.map(p => p.x))
  const y = oneDimensional ? [-1, 1] : yExtent ?? extent(points.map(p => p.y ?? 0))
  const finite = points.filter(p => Number.isFinite(p.x) && (oneDimensional || Number.isFinite(p.y)))
  return {
    animation: false, backgroundColor: '#fafafa',
    grid: { left: 64, right: 32, top: note ? 42 : 24, bottom: 54 },
    title: note ? { text: note, textStyle: { fontSize: 11, fontWeight: 'normal', color: '#666' }, left: 64 } : undefined,
    tooltip: { trigger: 'item', renderMode: 'richText', formatter: (p: any) => p.data?.title ?? p.name ?? '' },
    xAxis: { type: 'value', min: x[0], max: x[1], name: xLabel, nameLocation: 'middle', nameGap: 32, scale: true, axisLabel: { formatter: (value: number) => formatModelAxisValue(value, x) } },
    yAxis: { type: 'value', min: y[0], max: y[1], show: !oneDimensional, name: yLabel, nameLocation: 'middle', nameGap: 44, scale: true, axisLabel: { formatter: (value: number) => formatModelAxisValue(value, y) } },
    series: [...extraSeries, ...(finite.some(p => p.misclassified) ? [{ id: 'misclassification-rings', type: 'scatter' as const, silent: true, z: 4, emphasis: { scale: false },
      data: finite.flatMap((p,i) => p.misclassified ? [{value:[p.x,oneDimensional?((i%12)-5.5)/9:p.y],symbolSize:pointDiameter(p.selected, p.highlighted) + 2 * CHART_MARKERS.ringGap,
        itemStyle:{color:'transparent',borderColor:'#ff4d4f',borderWidth:1.5}}] : []) }] : []), { id: 'model-points', type: 'scatter', z: 5, labelLayout:{hideOverlap:true},
      data: finite.map((p, i) => ({
        id: p.id, rowId: p.rowId, name: p.label ?? '', title: p.title, value: [p.x, oneDimensional ? ((i % 12) - 5.5) / 9 : p.y],
        symbol: p.symbol ?? 'circle', symbolSize: pointDiameter(p.selected, p.highlighted),
        emphasis: pointEmphasis(p.selected, p.highlighted),
        itemStyle: { color: p.color ?? '#1890ff', opacity: p.selected ? 1 : 0.8,
          borderColor: p.selected ? p.selectionColor ?? '#2a78d6' : p.highlighted ? '#fa8c16' : '#fff',
          borderWidth: p.selected || p.highlighted ? 1.5 : 0.5 },
        label: { show: !!p.label, formatter: () => truncateText(p.label ?? '',16), position: p.x > x[0]+(x[1]-x[0])*.8 ? 'left' : 'right', fontSize: 11, color: '#333' },
      })),
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: '#ccc' },
        data: oneDimensional ? [{ xAxis: 0 }] : [{ xAxis: 0 }, { yAxis: 0 }] },
    }],
  }
}
export default function ModelScatter({ points, xLabel, yLabel, oneDimensional = false, xExtent, yExtent, extraSeries, note,
  svgRef, testId, height = 400, onToggle, onBrush, exportTarget }: {
  points: ModelPoint[]; xLabel: string; yLabel: string; oneDimensional?: boolean
  xExtent?: [number, number]; yExtent?: [number, number]; extraSeries?: SeriesOption[]; note?: string
  svgRef?: RefObject<SVGSVGElement>; testId: string; height?: number
  exportTarget?: string
  onToggle?: (id: string) => void; onBrush?: (bounds: { x: [number, number]; y: [number, number] | null }) => void
}) {
  const viewportKey=JSON.stringify(useGraphViewport())
  const redux=useContext(ReactReduxContext)
  const hoveredRow=useSyncExternalStore(redux?.store.subscribe ?? (()=>()=>{}),()=>redux?.store.getState().selection.hoveredRowId ?? null)
  const hoverRow=(id:string|null)=>redux?.store.dispatch(hovered(id))
  const chartRef = useRef<ECharts | null>(null)
  const start = useRef<{ x: number; y: number; clientX: number; clientY: number; pointerId: number; coordKey: string; hit?: string } | null>(null)
  const suppressClick = useRef(false)
  const local = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), chart = chartRef.current
    if (!chart || !r.width || !r.height) return null
    return { x: (e.clientX-r.left)*chart.getWidth()/r.width, y: (e.clientY-r.top)*chart.getHeight()/r.height }
  }
  const nearest = (p: {x:number;y:number}, box: DOMRect): string | undefined => {
    const chart=chartRef.current
    if(!chart)return undefined
    let hit: string | undefined, distance=CHART_MARKERS.nearestRadius ** 2 + .000001
    points.filter(q => Number.isFinite(q.x) && (oneDimensional || Number.isFinite(q.y))).forEach((q,i) => {
      const pos=chart.convertToPixel({gridIndex:0},[q.x,oneDimensional?((i%12)-5.5)/9:q.y]) as number[]
      const dx=(pos[0]-p.x)*box.width/chart.getWidth(),dy=(pos[1]-p.y)*box.height/chart.getHeight(),d=dx*dx+dy*dy
      if(d<distance){hit=q.id;distance=d}
    })
    return hit
  }
  const clear = () => {
    start.current = null
    chartRef.current?.setOption({ graphic: [{ id: 'model-selection', type: 'rect', invisible: true, silent: true, shape: {x:0,y:0,width:0,height:0} }] })
  }
  const dataKey = JSON.stringify([points.map(p => [p.id,p.x,p.y]),xLabel,yLabel,oneDimensional,xExtent,yExtent])
  useEffect(clear, [dataKey, viewportKey])
  const finitePoints = points.filter(p => Number.isFinite(p.x) && (oneDimensional || Number.isFinite(p.y)))
  const pointSeriesIndex = (extraSeries?.length ?? 0) + (finitePoints.some(p => p.misclassified) ? 1 : 0)
  return <div style={{height}} onPointerDown={e => {
    if (e.button !== 0 || (!onBrush && !onToggle) || start.current) return
    const p = local(e)
    if (!p) return
    start.current = {...p,clientX:e.clientX,clientY:e.clientY,pointerId:e.pointerId,coordKey:viewportKey,hit:nearest(p,e.currentTarget.getBoundingClientRect())};suppressClick.current = false
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }} onPointerMove={e => {
    const p = local(e), a = start.current
    if (!p || !a || !onBrush || a.hit || a.pointerId!==e.pointerId) return
    chartRef.current?.setOption({graphic:[{id:'model-selection',type:'rect',invisible:false,silent:true,z:100,
      shape:{x:Math.min(a.x,p.x),y:Math.min(a.y,p.y),width:Math.abs(p.x-a.x),height:Math.abs(p.y-a.y)},
      style:{fill:'rgba(42,120,214,.15)',stroke:'#2a78d6',lineWidth:1.5}}]})
  }} onPointerUp={e => {
    const a=start.current,p=local(e),chart=chartRef.current
    if(a?.pointerId!==e.pointerId)return
    clear()
    if (!a || !p || !chart || a.coordKey!==viewportKey) return
    if (Math.abs(e.clientX-a.clientX)<4 && Math.abs(e.clientY-a.clientY)<4) {
      const hit=nearest(p,e.currentTarget.getBoundingClientRect())
      suppressClick.current=true
      if (hit) onToggle?.(hit)
      return
    }
    suppressClick.current=true
    if(a.hit)return
    const lo=chart.convertFromPixel({gridIndex:0},[Math.min(a.x,p.x),Math.max(a.y,p.y)]) as number[]
    const hi=chart.convertFromPixel({gridIndex:0},[Math.max(a.x,p.x),Math.min(a.y,p.y)]) as number[]
    if (lo?.every(Number.isFinite) && hi?.every(Number.isFinite)) onBrush?.({x:[lo[0],hi[0]],y:oneDimensional?null:[lo[1],hi[1]]})
  }} onPointerCancel={e => { if(start.current?.pointerId===e.pointerId){suppressClick.current=true; clear()} }} onLostPointerCapture={e=>{if(start.current?.pointerId===e.pointerId)clear()}}>
  <EChart fitPointMarkers chartRef={chartRef} option={modelScatterOption(points.map(p=>({...p,highlighted:p.highlighted || !!p.rowId && p.rowId===hoveredRow})), xLabel, yLabel, oneDimensional, xExtent, yExtent, extraSeries, note)}
    height={height} svgRef={svgRef} testId={testId} ariaLabel={oneDimensional ? `${xLabel}（1次元）` : `${xLabel} / ${yLabel}`}
    exportFormats={['svg', 'png']} exportFileName={testId.replace(/-svg$/, '')} exportTarget={exportTarget}
    keyboardNavigation={{ items: finitePoints.map((point, dataIndex) => ({ id: point.id, label: `${point.title}${point.selected ? '、選択中' : ''}`,
      seriesIndex: pointSeriesIndex, dataIndex })), onSelect: onToggle,
      onHover: id => hoverRow(id === null ? null : finitePoints.find(point => point.id === id)?.rowId ?? null) }}
    onEvents={{ mouseover:p=>{if(p.data?.rowId)hoverRow(p.data.rowId)}, mouseout:p=>{if(p.data?.rowId)hoverRow(null)}, click: p => { if (suppressClick.current) { suppressClick.current=false; return }; if (p.seriesId === 'model-points' && p.data?.id) onToggle?.(p.data.id) },
      brushEnd: p => {
        const a = p.areas?.[0]
        if (!a?.coordRange) return
        const r = a.coordRange
        const x = oneDimensional ? r : r[0]
        const y = oneDimensional ? null : r[1]
        if (!Array.isArray(x) || !x.every(Number.isFinite)) return
        onBrush?.({ x: [Math.min(...x), Math.max(...x)], y: y ? [Math.min(...y), Math.max(...y)] : null })
      } }} />
  </div>
}
