import { useLayoutEffect, useRef, useState } from 'react'
import EChart, { escapeHtml } from './EChart'

export interface CategoryBarItem { id: string; label: string; value: number | null; detail?: string; selected?: boolean; color?: string }
export default function CategoryBars({ items, axisName, max, onSelect, testId, height }: {
  items: CategoryBarItem[]; axisName: string; max?: number; onSelect?: (id: string) => void; testId?: string; height?: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)
  useLayoutEffect(() => {
    const update = () => { if (host.current?.clientWidth) setWidth(host.current.clientWidth) }
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (host.current) observer?.observe(host.current)
    window.addEventListener('resize', update)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [])
  // Reserve labels once. containLabel plus a fixed left gutter used to leave
  // only ~30px for bars in the normal two-column robustness view.
  const left = Math.min(180, Math.round(width * .38))
  const right = Math.min(60, Math.round(width * .15))
  const plotWidth = width - left - right
  return <div ref={host} style={{ minWidth: 0 }}><EChart testId={testId} ariaLabel={axisName} height={height ?? Math.max(160, items.length * 32 + 70)}
    keyboardNavigation={{ items: items.map((item, dataIndex) => ({ id: item.id, seriesIndex: 0, dataIndex,
      label: `${item.label}: ${item.value == null ? '対象外・算出不可' : item.value}${item.selected ? '、選択中' : ''}${item.detail ? `。${item.detail}` : ''}` })), onSelect }} option={{
    grid: { left, right, top: 24, bottom: 42, outerBoundsMode: 'none' },
    xAxis: { type: 'value', name: axisName, min: 0, max, nameLocation: 'middle', nameGap: 28, splitNumber: plotWidth < 260 ? 3 : 5, axisLabel: { hideOverlap: true } },
    yAxis: { type: 'category', inverse: true, data: items.map(item => item.label), axisLabel: { width: Math.max(24, left - 16), overflow: 'truncate' } },
    tooltip: { confine: true, formatter: (params: any) => { const item = items[params.dataIndex]; return `${escapeHtml(item.label)}<br/>${item.value == null ? '対象外・算出不可' : item.value}<br/>${escapeHtml(item.detail ?? '').replace(/\n/g, '<br/>')}` } },
    series: [{ type: 'bar', data: items.map(item => ({ value: item.value, itemStyle: { color: item.selected ? '#2a78d6' : item.color ?? '#91caff', borderColor: item.selected ? '#174e91' : 'transparent', borderWidth: item.selected ? 2 : 0 },
      label: { show: true, position: 'right', formatter: item.value == null ? '—' : `${Number(item.value.toFixed(2))}` } })) }],
  }} onEvents={{ click: params => { if (items[params.dataIndex]) onSelect?.(items[params.dataIndex].id) } }} /></div>
}
