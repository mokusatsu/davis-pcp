import { useGraphViewport } from '../common/GraphPanel'
import { pointRadius, markerFitScale } from '../charts/markerStyle'
import EChart from '../charts/EChart'
import { useQuestionText } from '../common/ColumnQuestionTooltip'
import type { EChartsOption } from 'echarts'
import type { CoefficientItem } from './LogisticRegressionPage'

export function formatOdds(value: number | null, status?: string): string {
  if (value == null) return status === 'overflow' ? '上限超過' : status === 'underflow' ? '下限未満 (>0)' : status === 'unavailable' ? '利用不可' : '未定義'
  if (!Number.isFinite(value)) return '未定義'
  return value !== 0 && (Math.abs(value) >= 1e4 || Math.abs(value) < 0.001) ? value.toExponential(3) : value.toPrecision(4)
}
export function inferenceUnavailableReason(item: CoefficientItem): string {
  return item.inferenceReason === 'SINGULAR_INFORMATION' ? '情報行列のランク不足（係数を一意に識別できません / SINGULAR_INFORMATION）'
    : item.inferenceReason ?? '推論に必要な情報がありません'
}
function hasOddsInterval(item: CoefficientItem): item is CoefficientItem & { logCiLower: number; logCiUpper: number } {
  return item.inferenceStatus === 'available' && item.logCiLower != null && item.logCiUpper != null
    && Number.isFinite(item.logCiLower) && Number.isFinite(item.logCiUpper)
}
export function formatOddsInterval(item: CoefficientItem): string {
  return hasOddsInterval(item)
    ? `[${formatOdds(item.ciLower, item.exponentiationStatus?.ciLower)}, ${formatOdds(item.ciUpper, item.exponentiationStatus?.ciUpper)}]`
    : '利用不可'
}
export function oddsForestOption(items: CoefficientItem[], labels: Readonly<Record<string, string>> = {}, fitScale = 1): EChartsOption {
  const values = items.flatMap(r => hasOddsInterval(r) ? [r.logOddsRatio, r.logCiLower, r.logCiUpper] : [r.logOddsRatio])
    .filter(Number.isFinite).map(v => v / Math.LN10)
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values)
  const pad = Math.max(0.1, (hi - lo) * 0.08)
  return { animation: false, backgroundColor: '#fafafa', grid: { left: 130, right: 40, top: 30, bottom: 60 },
    tooltip: { renderMode: 'richText', formatter: (p: any) => {
      const r = items[p.dataIndex]
      if (!r) return ''
      const pValue = r.inferenceStatus === 'available' && r.pValue != null && Number.isFinite(r.pValue) ? r.pValue : '利用不可'
      return `${labels[r.name] ?? r.name}\nOR=${formatOdds(r.oddsRatio, r.exponentiationStatus?.oddsRatio)}\n95% CI=${formatOddsInterval(r)}\np=${pValue}`
        + (r.inferenceStatus === 'unavailable' ? `\n理由: ${inferenceUnavailableReason(r)}` : '')
    } },
    xAxis: { type: 'value', min: lo - pad, max: hi + pad, name: 'オッズ比（対数目盛）', nameLocation: 'middle', nameGap: 35,
      axisLabel: { showMinLabel: false, showMaxLabel: false, hideOverlap: true, formatter: (v: number) => Math.abs(v) < 1e-10 ? '1' : `10^${Number(v.toPrecision(3))}` } },
    yAxis: { type: 'category', inverse: true, data: items.map(r => r.name), axisLabel: { width: 140 } },
    series: [{ type: 'custom', data: items.map((r, i) => [r.logOddsRatio / Math.LN10, i,
      hasOddsInterval(r) ? r.logCiLower / Math.LN10 : null, hasOddsInterval(r) ? r.logCiUpper / Math.LN10 : null]),
      renderItem: (_params: any, api: any) => {
        const mid = api.coord([api.value(0), api.value(1)])
        const row = items[Number(api.value(1))]
        const color = row.inferenceStatus === 'available' && row.pValue != null && Number.isFinite(row.pValue) && row.pValue < .05 ? '#1890ff' : '#888'
        const children: any[] = []
        // Check source availability before arithmetic/coord: null would become zero (OR=1).
        if (hasOddsInterval(row)) {
          const low = api.coord([api.value(2), api.value(1)]), high = api.coord([api.value(3), api.value(1)])
          if (low.every(Number.isFinite) && high.every(Number.isFinite)) {
            children.push({ type: 'line', shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] }, style: { stroke: color, lineWidth: 2 } })
            for (const p of [low, high]) children.push({ type: 'line', shape: { x1: p[0], y1: p[1]-5, x2: p[0], y2: p[1]+5 }, style: { stroke: color } })
          }
        }
        if (mid.every(Number.isFinite)) children.push({ type: 'circle', shape: { cx: mid[0], cy: mid[1], r: pointRadius() / fitScale }, style: { fill: color } })
        return { type: 'group', children }
      } }, { type: 'scatter', data: [], markLine: { symbol: 'none', silent: true, data: [{ xAxis: 0 }], label: { formatter: 'OR = 1', position: 'start' } } }],
  }
}
export default function OddsRatioForest({ items }: { items: CoefficientItem[] }) {
  const fitScale = markerFitScale(useGraphViewport())
  const questionText = useQuestionText()
  const labels = Object.fromEntries(items.map(item => [item.name, questionText(item.name)]))
  const unavailable = items.filter(item => !hasOddsInterval(item))
  return <>
    <EChart testId="logistic-forest-chart" height={Math.max(280, items.length * 38 + 100)} ariaLabel="オッズ比と利用可能な95%信頼区間" option={oddsForestOption(items, labels, fitScale)} />
    {unavailable.length > 0 && <p style={{ fontSize: 12, color: '#666' }}>
      95%信頼区間は利用不可: {unavailable.map(item => `${item.name}（理由: ${inferenceUnavailableReason(item)}）`).join('、')}。
      点はORの推定値です。利用不可の推論による有意性の色分けは行いません。
    </p>}
  </>
}
