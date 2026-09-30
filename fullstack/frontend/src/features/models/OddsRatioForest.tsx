import EChart from '../charts/EChart'
import { useQuestionText } from '../common/ColumnQuestionTooltip'
import { truncateText } from '../../utils/textUtils'
import type { EChartsOption } from 'echarts'
import type { CoefficientItem } from './LogisticRegressionPage'

export function formatOdds(value: number | null, status?: string): string {
  if (value == null) return status === 'overflow' ? '上限超過' : status === 'underflow' ? '下限未満 (>0)' : '未定義'
  if (!Number.isFinite(value)) return '未定義'
  return value !== 0 && (Math.abs(value) >= 1e4 || Math.abs(value) < 0.001) ? value.toExponential(3) : value.toPrecision(4)
}
export function oddsForestOption(items: CoefficientItem[], labels: Readonly<Record<string, string>> = {}): EChartsOption {
  const values = items.flatMap(r => [r.logOddsRatio, r.logCiLower, r.logCiUpper]).filter(Number.isFinite).map(v => v / Math.LN10)
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values)
  const pad = Math.max(0.1, (hi - lo) * 0.08)
  return { animation: false, backgroundColor: '#fafafa', grid: { left: 130, right: 40, top: 30, bottom: 60 },
    tooltip: { renderMode: 'richText', formatter: (p: any) => {
      const r = items[p.dataIndex]
      return r ? `${labels[r.name] ?? r.name}\nOR=${formatOdds(r.oddsRatio, r.exponentiationStatus?.oddsRatio)} [${formatOdds(r.ciLower, r.exponentiationStatus?.ciLower)}, ${formatOdds(r.ciUpper, r.exponentiationStatus?.ciUpper)}]\np=${r.pValue}` : ''
    } },
    xAxis: { type: 'value', min: lo - pad, max: hi + pad, name: 'オッズ比（対数目盛）', nameLocation: 'middle', nameGap: 35,
      axisLabel: { showMinLabel: false, showMaxLabel: false, hideOverlap: true, formatter: (v: number) => Math.abs(v) < 1e-10 ? '1' : `10^${Number(v.toPrecision(3))}` } },
    yAxis: { type: 'category', inverse: true, data: items.map(r => r.name), axisLabel: { formatter: (name: string) => truncateText(name, 16) } },
    series: [{ type: 'custom', data: items.map((r, i) => [r.logOddsRatio / Math.LN10, i, r.logCiLower / Math.LN10, r.logCiUpper / Math.LN10]),
      renderItem: (_params: any, api: any) => {
        const mid = api.coord([api.value(0), api.value(1)]), low = api.coord([api.value(2), api.value(1)]), high = api.coord([api.value(3), api.value(1)])
        const row = items[Number(api.value(1))], color = row.pValue < .05 ? '#1890ff' : '#888'
        const children: any[] = []
        if (low.every(Number.isFinite) && high.every(Number.isFinite)) {
          children.push({ type: 'line', shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] }, style: { stroke: color, lineWidth: 2 } })
          for (const p of [low, high]) children.push({ type: 'line', shape: { x1: p[0], y1: p[1]-5, x2: p[0], y2: p[1]+5 }, style: { stroke: color } })
        }
        if (mid.every(Number.isFinite)) children.push({ type: 'circle', shape: { cx: mid[0], cy: mid[1], r: 5 }, style: { fill: color } })
        return { type: 'group', children }
      } }, { type: 'scatter', data: [], markLine: { symbol: 'none', silent: true, data: [{ xAxis: 0 }], label: { formatter: 'OR = 1', position: 'start' } } }],
  }
}
export default function OddsRatioForest({ items }: { items: CoefficientItem[] }) {
  const questionText = useQuestionText()
  const labels = Object.fromEntries(items.map(item => [item.name, questionText(item.name)]))
  return <EChart testId="logistic-forest-chart" height={Math.max(280, items.length * 38 + 100)} ariaLabel="オッズ比と95%信頼区間" option={oddsForestOption(items, labels)} />
}
