import { expect, it } from 'vitest'
import { kanoOption, praImpactOption } from '../src/features/pra/praCharts'
import { importanceBarsOption, rankingBarsOption, rankingScatterOption } from '../src/features/mining/rankingCharts'
import type { PraAttribute } from '../src/features/pra/PenaltyRewardPage'
import type { VariableRankItem } from '../src/features/mining/FeatureRankingPage'

const attributes: PraAttribute[] = [
  { name: 'first', label: 'Full first question', penalty: { coef: 2.5, se: 1, p: .1, ci: [.5, 4.5] },
    reward: { coef: -3, se: 1, p: .1, ci: [-5, -1] }, classification: 'performance', class_label: 'Performance',
    asymmetry: 0, asym_p: .1, n_dissatisfied: 2, dissatisfied_row_ids: ['r1', 'r2'], narrative: '' },
  { name: 'second', label: 'Second', penalty: { coef: -6, se: 1, p: .1, ci: [-8, -4] },
    reward: { coef: 5, se: 1, p: .1, ci: [3, 7] }, classification: 'basic', class_label: 'Basic',
    asymmetry: 0, asym_p: .1, n_dissatisfied: 1, dissatisfied_row_ids: ['r3'], narrative: '' },
]
it('retains signed PRA coefficient values without saturating bar lengths', () => {
  const option = praImpactOption(attributes, 'first') as any
  expect(option.series[0].data.map((point: any) => point.value)).toEqual([2.5, -6])
  expect(option.series[1].data.map((point: any) => point.value)).toEqual([-3, 5])
  expect(option.xAxis.min).toBeUndefined()
  expect(option.xAxis.max).toBeUndefined()
  expect(option.series[0].data[0].itemStyle.borderWidth).toBe(2)
})
it('retains both low and high coefficient signs without quadrant assumptions', () => {
  const option = kanoOption(attributes, 'second') as any
  const points = option.series.flatMap((series: any) => series.data)
  expect(points.find((point: any) => point.name === 'first').value).toEqual([2.5, -3])
  expect(points.find((point: any) => point.name === 'second').value).toEqual([-6, 5])
  expect(option.xAxis.min({ min: 2.5, max: 6 })).toBe(0)
  expect(option.xAxis.max({ min: -6, max: -2.5 })).toBe(0)
  expect(option.xAxis.name).toBe('低評価側係数 β_low')
  expect(option.yAxis.name).toBe('高評価側係数 β_high')
  expect(option.series[0].markLine.data).toEqual([{ xAxis: 0 }, { yAxis: 0 }])
  expect(option.yAxis.min({ min: 2, max: 6 })).toBe(0)
  expect(option.yAxis.max({ min: -6, max: -2 })).toBe(0)
  expect(points[0].description).toContain('既存モデルによる分類')
  expect(points[0].description).toContain('SE=1, p=0.1')
  expect(points.every((point: any) => /^#/.test(point.itemStyle.color))).toBe(true)
})
const rankings: VariableRankItem[] = [
  { variable: 'a', bordaScore: 10, overallRank: 1, meanRedundancy: .25, recommendationTier: 'high',
    scores: { relieff: { normalizedScore: .9, rawScore: 123, rank: 1 }, mutualInfo: null } },
  { variable: 'b', bordaScore: 2, overallRank: 2, meanRedundancy: .1, recommendationTier: 'medium',
    scores: { relieff: { normalizedScore: .1, rawScore: 4, rank: 2 }, mutualInfo: { normalizedScore: .5, rawScore: 3, rank: 1 } } },
]
it('keeps missing method scores missing and variable identity available for linked detail selection', () => {
  const option = rankingBarsOption(rankings, 'a', ['a']) as any
  expect(option.series[1].data[0].value).toBeNull()
  expect(option.series[0].data[0].name).toBe('a')
  expect(option.series[0].data[0].description).toContain('raw=123')
  const scatter = rankingScatterOption(rankings, 'b', ['a'], (_name, fallback) => fallback + .1, 1) as any
  expect(scatter.series[0].data[0].value).toEqual([10, .35])
  expect(scatter.series[0].data[1].symbolSize).toBe(20)
})

it('renders the native chart options through ECharts SVG without invalid geometry', async () => {
  const echarts = await import('echarts')
  for (const option of [kanoOption(attributes, null), praImpactOption(attributes, 'first'),
    rankingBarsOption(rankings, null, ['a']), rankingScatterOption(rankings, null, ['a'], (_name, fallback) => fallback, 1)]) {
    const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 900, height: 450 })
    try {
      chart.setOption({ animation: false, ...option })
      const svg = chart.renderToSVGString()
      expect(svg).toContain('<svg')
      expect(svg).toContain('<path')
      expect(svg).not.toContain('NaN')
      expect(svg).not.toContain('undefined')
    } finally { chart.dispose() }
  }
})


it('retains negative permutation importance and its received standard deviation', () => {
  const items = [{ featureName: 'a', importanceMean: -.3, importanceStd: .04, rank: 1 },
    { featureName: 'b', importanceMean: .5, importanceStd: .12, rank: 2 }]
  const option = importanceBarsOption(items, 'permutation') as any
  expect(option.series[0].data.map((item: any) => item.value)).toEqual([-.3, .5])
  expect(option.xAxis.min).toBeUndefined()
  expect(option.series[0].data[0].description).toContain('-0.300 ± 0.040')
  expect(option.series[0].data[0].label.position).toBe('left')
  expect(option.series[0].markLine.data).toEqual([{ xAxis: 0 }])
})
