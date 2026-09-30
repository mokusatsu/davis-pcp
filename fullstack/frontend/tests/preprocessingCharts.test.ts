import { expect, it } from 'vitest'
import { init } from 'echarts'
import { imputationHistogramOption } from '../src/features/dataset/preprocessingCharts'

it('retains separate observed, added, and received post-imputation counts on native bars', () => {
  const bins = [{ binLabel: 'Low', beforeCount: 3, imputedAdded: 2, afterCount: 5 },
    { binLabel: 'High', beforeCount: 0, imputedAdded: 1, afterCount: 1 }]
  const option = imputationHistogramOption(bins) as any
  expect(option.series.map((series: any) => series.type)).toEqual(['bar', 'bar'])
  expect(option.series[0].data).toEqual([3, 0])
  expect(option.series[1].data).toEqual([2, 1])
  expect(option.series[1].label.formatter({ dataIndex: 0 })).toBe('5件')
  expect(option.tooltip.formatter([{ dataIndex: 0 }])).toContain('観測値: 3\n補完追加: 2\n補完後: 5件')
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 560, height: 240 })
  try {
    chart.setOption({ ...option, animation: false })
    const svg = chart.renderToSVGString()
    expect(svg).toContain('<path')
    expect(svg).not.toContain('NaN')
  } finally { chart.dispose() }
})
