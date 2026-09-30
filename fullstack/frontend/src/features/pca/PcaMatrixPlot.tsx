import { useLayoutEffect, useMemo, useRef, type FC } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown } from 'antd'
import type { ECharts, EChartsOption } from 'echarts'
import type { RootState } from '../../app/store'
import { hovered, selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { useRowColorResolver } from '../../theme/useRowColor'
import GraphPanel, { useGraphPopupContainer, useGraphViewport } from '../common/GraphPanel'
import { getBrushOp } from '../selection/SelectionMenu'
import type { PcaResponse } from './types'
import EChart, { escapeHtml } from '../charts/EChart'

export const PcaMatrixPlot: FC<{ pcaData: PcaResponse | null }> = ({ pcaData }) => {
  return <div data-testid="pca-matrix-view" style={{ minHeight: 0 }}>
    <GraphPanel graphId="pca/matrix" title="PCA主成分散布図行列"
      available={Boolean(pcaData?.scores.length)} sizing="intrinsic" intrinsicSize={{ width: 640, height: 640 }}>
      <PcaMatrixChart pcaData={pcaData} />
    </GraphPanel>
  </div>
}

function PcaMatrixChart({ pcaData }: { pcaData: PcaResponse | null }) {
  const viewport = useGraphViewport()
  const viewportKey = `${viewport.logicalWidth}:${viewport.logicalHeight}:${viewport.scale}:${viewport.dpr}:${viewport.zoom}:${viewport.revision}`
  const graphPopupContainer = useGraphPopupContainer()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const { getColor, isSelected, selectionColor } = useRowColorResolver()
  const chartRef = useRef<ECharts | null>(null)
  const drag = useRef<{ x: number; y: number; clientX: number; clientY: number; index: number; viewportKey: string; target: HTMLDivElement; pointerId: number; point?: string } | null>(null)
  const clear = () => {
    const previous = drag.current
    drag.current = null
    if (previous?.target.hasPointerCapture?.(previous.pointerId)) previous.target.releasePointerCapture(previous.pointerId)
    if (chartRef.current && !chartRef.current.isDisposed()) chartRef.current.setOption({ graphic: [{ id: 'matrix-selection', type: 'rect', invisible: true, silent: true, shape: { x: 0, y: 0, width: 0, height: 0 } }] })
  }
  useLayoutEffect(clear, [pcaData, viewportKey])
  const k = Math.min(pcaData?.nComponents || pcaData?.eigenvalues.length || 4, 4)
  const compBounds = useMemo(() => Array.from({ length: k }, (_, c) => {
    const values = (pcaData?.scores ?? []).map(s => s.pc[c] ?? 0).filter(Number.isFinite)
    const { min, max } = values.reduce((bounds, value) => ({ min: Math.min(bounds.min, value), max: Math.max(bounds.max, value) }), { min: Infinity, max: -Infinity })
    const pad = Math.max((max - min) * .1, .5)
    return values.length ? { min: min - pad, max: max + pad } : { min: -1, max: 1 }
  }), [pcaData, k])
  const grid: any[] = [], xAxis: any[] = [], yAxis: any[] = [], series: any[] = []
  for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) {
    const index = r * k + c, bounds = compBounds[c]
    grid.push({ left: `${5 + c * 90 / k}%`, top: `${5 + r * 90 / k}%`, width: `${90 / k - 2}%`, height: `${90 / k - 2}%`, show: true, backgroundColor: r === c ? '#f5f5f5' : '#fafbfc' })
    xAxis.push({ gridIndex: index, type: 'value', min: bounds.min, max: bounds.max, show: r === k - 1, name: `PC${c + 1}`, axisLabel: { fontSize: 9 }, splitNumber: 2 })
    yAxis.push({ gridIndex: index, type: 'value', min: r === c ? 0 : compBounds[r].min, max: r === c ? undefined : compBounds[r].max, show: c === 0, name: r === c ? '度数' : `PC${r + 1}`, axisLabel: { fontSize: 9 }, splitNumber: 2 })
    if (r === c) {
      const bins = Array.from({ length: 15 }, () => [] as string[]), span = bounds.max - bounds.min
      for (const score of pcaData?.scores ?? []) {
        const value = score.pc[c] ?? 0
        if (!Number.isFinite(value)) continue
        const bin = Math.max(0, Math.min(14, Math.floor((value - bounds.min) / span * 15)))
        bins[bin].push(score.rowId || score.row_id || '')
      }
      series.push({ type: 'bar', xAxisIndex: index, yAxisIndex: index, name: `PC${c + 1} 度数`, barWidth: '90%',
        data: bins.map((ids, i) => ({ value: [bounds.min + (i + .5) * span / 15, ids.length], rowIds: ids,
          tooltip: `PC${c + 1}: ${bounds.min + i * span / 15} – ${bounds.min + (i + 1) * span / 15}\n度数: ${ids.length}`,
          itemStyle: { color: ids.some(isSelected) ? selectionColor : '#bae0ff' } })) })
    } else series.push({ type: 'scatter', xAxisIndex: index, yAxisIndex: index, name: `PC${c + 1} × PC${r + 1}`,
      data: (pcaData?.scores ?? []).filter(s => Number.isFinite(s.pc[c]) && Number.isFinite(s.pc[r])).map(s => { const id = s.rowId || s.row_id || ''; return {
        value: [s.pc[c], s.pc[r]], rowId: id, symbolSize: isSelected(id) ? 8 : 5,
        tooltip: `rowId: ${id}\nPC${c + 1}: ${s.pc[c]}\nPC${r + 1}: ${s.pc[r]}`,
        itemStyle: { color: getColor(id), borderColor: isSelected(id) ? selectionColor : undefined, borderWidth: isSelected(id) ? 2 : 0, opacity: isSelected(id) ? 1 : .65 },
      } }) })
  }
  const position = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(), chart = chartRef.current
    return chart && rect.width && rect.height ? { x: (event.clientX - rect.left) * chart.getWidth() / rect.width, y: (event.clientY - rect.top) * chart.getHeight() / rect.height, rect } : null
  }
  const nearest = (index: number, pos: { x: number; y: number; rect: DOMRect }) => {
    let result: string | undefined, distance = 64
    const chart = chartRef.current!
    for (const data of series[index]?.data ?? []) {
      if (!data.rowId) continue
      const screen = chart.convertToPixel({ gridIndex: index }, data.value) as unknown as number[]
      const d = ((screen[0] - pos.x) * pos.rect.width / chart.getWidth()) ** 2 + ((screen[1] - pos.y) * pos.rect.height / chart.getHeight()) ** 2
      if (d <= distance) { result = data.rowId; distance = d }
    }
    return result
  }
  const option: EChartsOption = { grid, xAxis, yAxis, series,
    tooltip: { trigger: 'item', confine: true, formatter: (p: any) => escapeHtml(p.data.tooltip ?? '').replace(/\n/g, '<br/>') },
  }
  const contextMenuItems = [
    { key: 'focus', label: 'Focus Selected', disabled: !selection.selectedRowIds.length, onClick: () => dispatch(focusSelected()) },
    { key: 'delete', label: 'Delete Selected', disabled: !selection.selectedRowIds.length, onClick: () => dispatch(deleteSelected()) },
    { key: 'clear', label: '選択解除', onClick: () => dispatch(selectionCleared()) },
    { key: 'reset', label: 'Reset to Base Data', onClick: () => dispatch(resetWorkingSet()) },
  ]
  return <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={graphPopupContainer}>
    <div style={{ width: 640, height: 640, userSelect: 'none', touchAction: 'none' }}
      onPointerDown={event => {
        if (event.button !== 0) return
        const pos = position(event), chart = chartRef.current
        if (!pos || !chart) return
        const index = grid.findIndex((_, i) => chart.containPixel({ gridIndex: i }, [pos.x, pos.y]))
        if (index < 0 || Math.floor(index / k) === index % k) return
        drag.current = { ...pos, clientX: event.clientX, clientY: event.clientY, index, viewportKey, target: event.currentTarget, pointerId: event.pointerId, point: nearest(index, pos) }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }} onPointerMove={event => {
        const pos = position(event), start = drag.current
        if (!pos || !start || start.viewportKey !== viewportKey || start.point) return
        chartRef.current?.setOption({ graphic: [{ id: 'matrix-selection', type: 'rect', invisible: false, silent: true, z: 100,
          shape: { x: Math.min(pos.x, start.x), y: Math.min(pos.y, start.y), width: Math.abs(pos.x - start.x), height: Math.abs(pos.y - start.y) },
          style: { fill: 'rgba(42,120,214,0.15)', stroke: '#2a78d6', lineWidth: 1.5 } }] })
      }} onPointerUp={event => {
        const pos = position(event), start = drag.current, chart = chartRef.current
        clear()
        if (!pos || !start || !chart || start.viewportKey !== viewportKey) return
        if (Math.abs(event.clientX - start.clientX) < 4 && Math.abs(event.clientY - start.clientY) < 4) {
          const row = nearest(start.index, pos)
          if (row) dispatch(selectionApplied({ rowIds: [row], operation: 'toggle', label: 'PCA行列行選択' }))
        } else if (!start.point) {
          const a = chart.convertFromPixel({ gridIndex: start.index }, [start.x, start.y]) as number[]
          const b = chart.convertFromPixel({ gridIndex: start.index }, [pos.x, pos.y]) as number[]
          const ids = series[start.index].data.filter((d: any) => d.value[0] >= Math.min(a[0], b[0]) && d.value[0] <= Math.max(a[0], b[0]) && d.value[1] >= Math.min(a[1], b[1]) && d.value[1] <= Math.max(a[1], b[1])).map((d: any) => d.rowId)
          dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: 'PCA行列範囲選択' }))
        }
      }} onPointerCancel={clear} onLostPointerCapture={clear}>

      <EChart chartRef={chartRef} option={option} testId="pca-matrix-canvas" height="100%" ariaLabel="PCA主成分散布図行列"
        onEvents={{
          click: params => { const ids = params.data?.rowIds; if (ids) dispatch(selectionApplied({ rowIds: ids, operation: params.data.rowId ? 'toggle' : getBrushOp(), label: 'PCA行列選択' })) },
          mouseover: params => { if (params.data?.rowId) dispatch(hovered(params.data.rowId)) },
          globalout: () => { dispatch(hovered(null)) },

        }} />
    </div></Dropdown>
}
