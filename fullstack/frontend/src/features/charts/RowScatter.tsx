import { useGraphViewport } from '../common/GraphPanel'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import type { ECharts, EChartsOption } from 'echarts'
import { hovered, selectionApplied, type RootState } from '../../app/store'
import { getBrushOp } from '../selection/SelectionMenu'
import { useRowColorResolver } from '../../theme/useRowColor'
import EChart, { escapeHtml } from './EChart'

export interface RowPoint { rowId: string; x: number; y: number; tooltip?: string }
export interface RowScatterProps {
  points: RowPoint[]
  xName: string
  yName: string
  testId?: string
  height?: number | string
  option?: EChartsOption
  colorOf?: (rowId: string) => string
  clickOperation?: 'toggle' | 'menu'
  ariaLabel?: string
  onReady?: (chart: ECharts) => void
}
export function rowsInRange(points: RowPoint[], x: number[], y: number[]): string[] {
  return [...new Set(points.filter(p => p.x >= Math.min(...x) && p.x <= Math.max(...x) && p.y >= Math.min(...y) && p.y <= Math.max(...y)).map(p => p.rowId))]
}

export default function RowScatter({ points, xName, yName, testId, height = 420, option, colorOf, onReady, clickOperation = 'toggle', ariaLabel }: RowScatterProps) {
  const viewportKey=JSON.stringify(useGraphViewport())
  const dispatch = useDispatch()
  const { getColor, selectionColor } = useRowColorResolver()
  const selected = useSelector((s: RootState) => s.selection.selectedRowIds)
  const hover = useSelector((s: RootState) => s.selection.hoveredRowId)
  const [keyboardIndex, setKeyboardIndex] = useState(0)
  const latest = useRef(points); latest.current = points
  const chartRef = useRef<ECharts | null>(null)
  const start = useRef<{ x: number; y: number; clientX: number; clientY: number; point?: string; coordKey:string; pointerId:number } | null>(null)
  const clear = () => {
    start.current = null
    if (chartRef.current && !chartRef.current.isDisposed()) chartRef.current.setOption({ graphic: [{ id: 'row-selection', type: 'rect', invisible: true, silent: true, shape: { x: 0, y: 0, width: 0, height: 0 } }] })
  }
  const pointsKey = points.map(point => `${point.rowId}:${point.x}:${point.y}`).join('|')
  useEffect(clear, [pointsKey, viewportKey])
  const local = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(), chart = chartRef.current
    if (!chart || !rect.width || !rect.height) return null
    return { x: (event.clientX - rect.left) * chart.getWidth() / rect.width, y: (event.clientY - rect.top) * chart.getHeight() / rect.height, rect }
  }
  const nearest = (position: { x: number; y: number; rect: DOMRect }) => {
    const chart = chartRef.current
    if (!chart) return undefined
    let nearestPoint: RowPoint | undefined, distance = 64
    for (const point of latest.current) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
      const screen = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [point.x, point.y]) as number[]
      const d = ((screen[0] - position.x) * position.rect.width / chart.getWidth()) ** 2 + ((screen[1] - position.y) * position.rect.height / chart.getHeight()) ** 2
      if (d <= distance) { nearestPoint = point; distance = d }
    }
    return nearestPoint
  }
  const selectedSet = new Set(selected)
  const finite = useMemo(() => points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)), [points])
  const chartOption: EChartsOption = {
    grid: { left: 68, right: 35, top: 35, bottom: 60, containLabel: true },
    xAxis: { type: 'value', name: xName, nameLocation: 'middle', nameGap: 32, scale: true, axisLine: { onZero: true } },
    yAxis: { type: 'value', name: yName, nameLocation: 'middle', nameGap: 45, scale: true, axisLine: { onZero: true } },
    tooltip: { trigger: 'item', confine: true, formatter: (params: any) => escapeHtml(params.data.tooltip ?? `rowId: ${params.data.rowId}\n${xName}: ${params.data.value[0]}\n${yName}: ${params.data.value[1]}`).replace(/\n/g, '<br/>') },
    ...option,
    series: [{ id: 'respondent-rows', type: 'scatter',
      data: finite.map(point => ({ value: [point.x, point.y], rowId: point.rowId, tooltip: point.tooltip,
        symbolSize: selectedSet.has(point.rowId) || hover === point.rowId ? 11 : 7,
        itemStyle: { color: (colorOf ?? getColor)(point.rowId),
          borderColor: selectedSet.has(point.rowId) ? selectionColor : undefined, borderWidth: selectedSet.has(point.rowId) ? 1.5 : 0, opacity: selectedSet.has(point.rowId) || hover === point.rowId ? 1 : 0.65 } })),
    }, ...(Array.isArray(option?.series) ? option.series : option?.series ? [option.series] : [])],
  }
  const keyboardPoint = finite[Math.min(keyboardIndex, finite.length - 1)]
  return <div tabIndex={0} role="group" aria-label={`${xName} × ${yName}。矢印キーで行を移動、Enterで選択`}
    onPointerDown={event => {
      if (event.button !== 0 || start.current) return
      const position = local(event)
      if (!position) return
      start.current = { ...position, clientX: event.clientX, clientY: event.clientY, point: nearest(position)?.rowId, coordKey:viewportKey, pointerId:event.pointerId }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }} onPointerMove={event => {
      const position = local(event), origin = start.current
      if (!position) return
      if (!origin) { dispatch(hovered(nearest(position)?.rowId ?? null)); return }
      if (origin.point || origin.pointerId!==event.pointerId || origin.coordKey!==viewportKey) return
      chartRef.current?.setOption({ graphic: [{ id: 'row-selection', type: 'rect', invisible: false, silent: true, z: 100,
        shape: { x: Math.min(origin.x, position.x), y: Math.min(origin.y, position.y), width: Math.abs(position.x - origin.x), height: Math.abs(position.y - origin.y) },
        style: { fill: 'rgba(42,120,214,0.15)', stroke: '#2a78d6', lineWidth: 1.5 } }] })
    }} onPointerUp={event => {
      const position = local(event), origin = start.current, chart = chartRef.current
      if(origin?.pointerId!==event.pointerId)return
      clear()
      if(origin?.coordKey!==viewportKey)return
      if (!position || !origin || !chart) return
      if (Math.abs(event.clientX - origin.clientX) < 4 && Math.abs(event.clientY - origin.clientY) < 4) {
        const point = nearest(position)
        if (point) dispatch(selectionApplied({ rowIds: [point.rowId], operation: clickOperation === 'menu' ? getBrushOp() : 'toggle', label: `${testId ?? '散布図'} 行選択` }))
      } else if (!origin.point) {
        const a = chart.convertFromPixel({ gridIndex: 0 }, [origin.x, origin.y]) as number[]
        const b = chart.convertFromPixel({ gridIndex: 0 }, [position.x, position.y]) as number[]
        dispatch(selectionApplied({ rowIds: rowsInRange(latest.current, [a[0], b[0]], [a[1], b[1]]), operation: getBrushOp(), label: `${testId ?? '散布図'} 範囲選択` }))
      }
    }} onPointerCancel={clear} onLostPointerCapture={clear} onPointerLeave={() => { if (!start.current) dispatch(hovered(null)) }}
    onKeyDown={event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); setKeyboardIndex(i => Math.min(finite.length - 1, i + 1)) }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); setKeyboardIndex(i => Math.max(0, i - 1)) }
      else if ((event.key === 'Enter' || event.key === ' ') && keyboardPoint) { event.preventDefault(); dispatch(selectionApplied({ rowIds: [keyboardPoint.rowId], operation: 'toggle', label: `${testId ?? '散布図'} 行選択` })) }
    }} style={{ width: '100%', height }}>
    <EChart chartRef={chartRef} option={chartOption} height="100%" testId={testId} ariaLabel={ariaLabel ?? `${xName} × ${yName}`} onReady={onReady} />
    <span aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{keyboardPoint ? `rowId ${keyboardPoint.rowId}, ${xName} ${keyboardPoint.x}, ${yName} ${keyboardPoint.y}` : 'データなし'}</span>
  </div>
}
