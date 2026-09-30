import EChart, { escapeHtml } from './EChart'

export interface CategoryBarItem { id: string; label: string; value: number | null; detail?: string; selected?: boolean; color?: string }
export default function CategoryBars({ items, axisName, max, onSelect, testId, height }: {
  items: CategoryBarItem[]; axisName: string; max?: number; onSelect?: (id: string) => void; testId?: string; height?: number
}) {
  return <EChart testId={testId} ariaLabel={axisName} height={height ?? Math.max(160, items.length * 32 + 70)} option={{
    grid: { left: 180, right: 60, top: 24, bottom: 42, containLabel: true },
    xAxis: { type: 'value', name: axisName, min: 0, max, nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'category', inverse: true, data: items.map(item => item.label), axisLabel: { width: 160, overflow: 'truncate' } },
    tooltip: { confine: true, formatter: (params: any) => { const item = items[params.dataIndex]; return `${escapeHtml(item.label)}<br/>${item.value == null ? '算出不可（分母0）' : item.value}<br/>${escapeHtml(item.detail ?? '').replace(/\n/g, '<br/>')}` } },
    series: [{ type: 'bar', data: items.map(item => ({ value: item.value, itemStyle: { color: item.selected ? '#2a78d6' : item.color ?? '#91caff', borderColor: item.selected ? '#174e91' : 'transparent', borderWidth: item.selected ? 2 : 0 },
      label: { show: true, position: 'right', formatter: item.value == null ? '—' : `${Number(item.value.toFixed(2))}` } })) }],
  }} onEvents={{ click: params => { if (items[params.dataIndex]) onSelect?.(items[params.dataIndex].id) } }} />
}
