import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { getInstanceByDom, init, setPlatformAPI, type ECharts } from 'echarts'
import { DEFAULT_TEXT_WIDTH_MAP, platformApi } from 'zrender/lib/core/platform.js'
import { store } from '../src/app/store'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import { BiplotView } from '../src/features/pca/BiplotView'
import { rankingBarsOption } from '../src/features/mining/rankingCharts'
import { perturbationAxisLabel } from '../src/features/robustness/RobustnessPage'
import CategoryBars from '../src/features/charts/CategoryBars'
const measureText = platformApi.measureText
beforeEach(() => {
  // Font-aware widths are essential here: fixed7px metrics incorrectly make
  // every12px multiline label7px high and cannot validate real chart layouts.
  setPlatformAPI({ measureText: (text, font) => {
    const size = Number(/([\d.]+)px/.exec(font ?? '')?.[1] ?? 12)
    return { width: [...String(text)].reduce((sum, char) => sum + ((DEFAULT_TEXT_WIDTH_MAP as Record<string,number>)[char] ?? 1) * size, 0) }
  } })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); setPlatformAPI({ measureText }) })
function assertTextInside(chart: ECharts, text: string) {
  const label = chart.getZr().storage.getDisplayList().find((item: any) => item.type === 'tspan' && item.style.text === text)!
  expect(label, text).toBeDefined()
  const bounds = label.getBoundingRect().clone()
  if (label.transform) bounds.applyTransform(label.transform)
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(chart.getWidth())
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(chart.getHeight())
}
it('keeps the PCA component axis title inside normal and expanded SVG edges', () => {
  const pcaData = { nComponents: 2, eigenvalues: [2, 1], explainedVarianceRatio: [.66, .34], columns: [], loadings: {}, scores: [{ rowId: 'r1', pc: [-1, -1] }, { rowId: 'r2', pc: [1, 1] }] } as any
  const view = render(<Provider store={store}><GraphExpansionProvider><BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} /></GraphExpansionProvider></Provider>)
  const chart = getInstanceByDom(view.getByTestId('pca-biplot-canvas'))!
  for (const width of [720, 1120]) { chart.resize({ width, height: 480 }); assertTextInside(chart, 'PC1') }
})
it('biplot renders compact fractional bounds without rounding scores, vector coordinates or tooltips', () => {
  const minX = -0.87263637429, maxX = 0.854589727251
  const minY = -0.77263637429, maxY = 0.728483948572
  const scores = [
    { rowId: 'left', pc: [-2, minY, minX] },
    { rowId: 'exact', pc: [0, 0.4784238321249003, 0.12727962370642537] },
    { rowId: 'right', pc: [2, maxY, maxX] },
  ]
  const loading = [0.25, -0.728483948572, 0.77263637429]
  const fractionalData = { nComponents: 3, eigenvalues: [2, 1, 0.1],
    explainedVarianceRatio: [0.65, 0.32, 0.03], scores, columns: ['feature'], loadings: { feature: loading } } as any
  const view = render(<Provider store={store}><GraphExpansionProvider>
    <BiplotView pcaData={fractionalData} selectedX={2} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
  </GraphExpansionProvider></Provider>)
  const chartDom = view.getByTestId('pca-biplot-canvas')
  const chart = getInstanceByDom(chartDom)!
  const option = chart.getOption() as any
  // Both ranges use the existing 0.5 padding; only their displayed labels change.
  expect(option.xAxis[0]).toMatchObject({ name: 'PC3', min: minX - 0.5, max: maxX + 0.5 })
  expect(option.yAxis[0]).toMatchObject({ name: 'PC2', min: minY - 0.5, max: maxY + 0.5 })
  const labels = Array.from(chartDom.querySelectorAll('svg text'), label => label.textContent)
  expect(labels).not.toContain(String(maxX + 0.5))
  expect(labels).not.toContain(String(maxY + 0.5))
  expect(labels).toEqual(expect.arrayContaining(['1', '1.35', '1.23', 'PC3', 'PC2']))
  expect(option.xAxis[0].axisLabel.hideOverlap).toBe(true)
  expect(option.yAxis[0].axisLabel.hideOverlap).toBe(true)
  expect(option.xAxis[0].axisLabel.formatter(maxX + 0.5)).toBe('1.35')
  expect(option.yAxis[0].axisLabel.formatter(maxY + 0.5)).toBe('1.23')
  const rows = option.series.find((series: any) => series.id === 'respondent-rows').data
  expect(rows.map((row: any) => ({ rowId: row.rowId, value: row.value })))
    .toEqual(scores.map(score => ({ rowId: score.rowId, value: [score.pc[2], score.pc[1]] })))
  expect(option.tooltip[0].formatter({ data: rows[1] }))
    .toBe(`rowId: exact<br/>PC3: ${scores[1].pc[2]}<br/>PC2: ${scores[1].pc[1]}`)
  const vector = option.series.find((series: any) => series.name === 'feature').markLine
  const scale = Math.min(((maxX + 0.5) - (minX - 0.5)) / 2, ((maxY + 0.5) - (minY - 0.5)) / 2) * 0.75
  expect(vector.data[0].map((endpoint: any) => endpoint.coord)).toEqual([[0, 0], [loading[2] * scale, loading[1] * scale]])
  expect(vector.tooltip.formatter()).toBe(`feature: (${loading[2]}, ${loading[1]})`)
})
it('keeps the complete normalized-score title within the ranking export', () => {
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 560, height: 350 })
  try {
    chart.setOption({ animation: false, ...rankingBarsOption([{ variable: 'Q1', bordaScore: 2, overallRank: 1, meanRedundancy: .2, recommendationTier: 'high', scores: { relieff: { normalizedScore: .8, rawScore: 2, rank: 1 } } }] as any, null, []) })
    for (const width of [560, 1120]) { chart.resize({ width, height: 350 }); assertTextInside(chart, 'Normalized score') }
  } finally { chart.dispose() }
})
it('keeps bootstrap lower and upper bounds distinct while retaining full scenario details', () => {
  const scenarios = [
    { strategy: 'bootstrap_ci_lower', label: 'ブートストラップ 95%CI 下限' },
    { strategy: 'bootstrap_ci_upper', label: 'ブートストラップ 95%CI 上限' },
    { strategy: 'outlier_removal', label: '外れ値除外 5%' },
  ]
  expect(scenarios.map(perturbationAxisLabel)).toEqual(['95%CI 下限', '95%CI 上限', '外れ値除外 5%'])
  const view = render(<CategoryBars testId="bounds" axisName="推定値ドリフト (%)" items={scenarios.map((p,i) => ({ id: String(i), label: perturbationAxisLabel(p), detail: p.label, value: i + 1 }))} />)
  const chart = getInstanceByDom(view.getByTestId('bounds'))!
  assertTextInside(chart, '95%CI 下限'); assertTextInside(chart, '95%CI 上限')
  const formatter = (chart.getOption().tooltip as any)[0].formatter
  expect(formatter({ dataIndex: 0 })).toContain(scenarios[0].label)
  expect(formatter({ dataIndex: 1 })).toContain(scenarios[1].label)
})
