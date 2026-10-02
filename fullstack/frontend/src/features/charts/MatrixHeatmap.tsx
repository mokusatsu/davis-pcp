import EChart, { escapeHtml } from './EChart'

export default function MatrixHeatmap({ labels, matrix, counts, bound, selected, onSelect, testId, title, height = 440, decimals = 2 }: {
  labels: string[]; matrix: (number | null)[][]; counts?: number[][]; bound?: number;
  selected?: [number, number] | null; onSelect?: (row: number, col: number) => void; testId?: string; title: string; height?: number | string; decimals?: number
}) {
  const values = matrix.flat().filter((value): value is number => value !== null && Number.isFinite(value))
  const extent = bound ?? Math.max(...values.map(Math.abs), 1e-12)
  const cells = matrix.flatMap((row, r) => row.map((value, c) => ({ value: [c, r, value ?? 0], raw: value, row: r, col: c,
    itemStyle: { borderWidth: selected?.[0] === r && selected?.[1] === c ? 3 : 1, borderColor: selected?.[0] === r && selected?.[1] === c ? '#1677ff' : '#e5e7eb' } })))
  const validCells = cells.filter(cell => cell.raw != null && Number.isFinite(cell.raw))
  const missingCells = cells.filter(cell => cell.raw == null || !Number.isFinite(cell.raw))
  const seriesIndices = [0, 0]
  const keyboardItems = cells.map(cell => {
    const valid = cell.raw != null && Number.isFinite(cell.raw), seriesIndex = valid ? 0 : 1
    return { id: `${cell.row}:${cell.col}`, seriesIndex, dataIndex: seriesIndices[seriesIndex]++,
      label: `${labels[cell.row]} × ${labels[cell.col]}: ${valid ? cell.raw : '計算不可'}${counts ? `、n=${counts[cell.row]?.[cell.col] ?? '—'}` : ''}${selected?.[0] === cell.row && selected?.[1] === cell.col ? '、選択中' : ''}` }
  })
  // The y-label gutter above the first row stays clear of every top-axis label.
  // Keep export here rather than covering a staggered label at the upper right.
  return <EChart exportPosition="top-left" testId={testId} height={height} ariaLabel={title}
    keyboardNavigation={{ items: keyboardItems, onSelect: onSelect ? id => {
      const [row, col] = id.split(':').map(Number); onSelect(row, col)
    } : undefined }} option={{
    // The shared category layout converts these outer gutters into bounded
    // multiline label space once, without double-reserving containLabel margins.
    grid: { left: 12, right: 24, top: 12, bottom: 44, containLabel: true },
    xAxis: { type: 'category', data: labels, position: 'top', splitArea: { show: true }, axisLabel: { width: 110, overflow: 'truncate' } },
    yAxis: { type: 'category', data: labels, inverse: true, splitArea: { show: true }, axisLabel: { width: 130, overflow: 'truncate' } },
    visualMap: [{ min: -extent, max: extent, seriesIndex: 0, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: ['#2166ac', '#ffffff', '#b2182b'] } }, { show: false, min: 0, max: 1, seriesIndex: 1, inRange: { color: ['#eeeeee', '#eeeeee'] } }],
    tooltip: { confine: true, formatter: (p: any) => `${escapeHtml(labels[p.data.row])} × ${escapeHtml(labels[p.data.col])}<br/>${p.data.raw == null ? '計算不可' : p.data.raw}${counts ? `<br/>n=${counts[p.data.row]?.[p.data.col] ?? '—'}` : ''}` },
    series: [
      { type: 'heatmap', data: validCells, label: { show: true, formatter: (p: any) => Number(p.data.raw).toFixed(decimals) } },
      { type: 'heatmap', data: missingCells, itemStyle: { color: '#eeeeee' }, label: { show: true, formatter: '—' } },
    ],
  }} onEvents={{ click: params => { if (params.data) onSelect?.(params.data.row, params.data.col) } }} />
}
