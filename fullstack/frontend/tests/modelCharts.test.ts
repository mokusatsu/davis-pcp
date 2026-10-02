// @vitest-environment node
import { describe, it, expect } from 'vitest'
import * as echarts from 'echarts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { modelScatterOption, extent, formatModelAxisValue } from '../src/features/models/ModelScatter'
import { oddsForestOption, formatOdds } from '../src/features/models/OddsRatioForest'
import { formatLogisticEstimate, type CoefficientItem } from '../src/features/models/LogisticRegressionPage'
const rows: CoefficientItem[] = [
  {name:'x', coefficient:43.9444915467, stdError:1, zValue:1, pValue:.02, oddsRatio:1.2157665459e19,
    ciLower:2486872.9622, ciUpper:5.9435617204e31, logOddsRatio:43.9444915467,
    logCiLower:Math.log(2486872.9622),logCiUpper:Math.log(5.9435617204e31), inferenceStatus:'available', inferenceReason:null},
  {name:'range',coefficient:750,stdError:1,zValue:1,pValue:.001,oddsRatio:null,ciLower:null,ciUpper:null,
    logOddsRatio:750,logCiLower:730,logCiUpper:770,inferenceStatus:'available',inferenceReason:null,
    exponentiationStatus:{oddsRatio:'overflow',ciLower:'overflow',ciUpper:'overflow'}},
]
const unavailableRow: CoefficientItem = { name: 'collinear', coefficient: 1, stdError: null, zValue: null,
  pValue: null, oddsRatio: Math.E, ciLower: null, ciUpper: null, logOddsRatio: 1, logCiLower: null, logCiUpper: null,
  inferenceStatus: 'unavailable', inferenceReason: 'SINGULAR_INFORMATION',
  exponentiationStatus: { oddsRatio: 'finite', ciLower: 'unavailable', ciUpper: 'unavailable' } }
describe('ECharts model semantics', () => {
  it('retains stable ids and signs', () => {
    const option = modelScatterOption([{id:'row-stable-7',x:-2,y:3,title:'raw title',selected:true}], 'X','Y')
    const data = (option.series as any[])[0].data
    expect(data[0].id).toBe('row-stable-7');expect(data[0].value).toEqual([-2,3]);expect(data[0].symbolSize).toBe(9)
  })
  it('keeps one-dimensional jitter out of axis interpretation', () => {
    const option = modelScatterOption([{id:'a',x:2,y:null,title:'a'}], '第1軸','',true)
    expect((option.yAxis as any).show).toBe(false);expect((option.series as any[])[0].data[0].value[0]).toBe(2)
  })
  it('aligns misclassification rings after dropping nonfinite points', () => {
    const option = modelScatterOption([{id:'bad',x:NaN,y:null,title:'bad'}, {id:'good',x:2,y:null,title:'good',misclassified:true}], 'X','',true)
    const series = option.series as any[]
    expect(series.find(s => s.id === 'misclassification-rings').data[0].value)
      .toEqual(series.find(s => s.id === 'model-points').data[0].value)
  })
  it('handles empty and constant extents', () => {
    expect(extent([])).toEqual([-1,1]);expect(extent([4,4])).toEqual([3,5]);expect(extent([NaN,4])).toEqual([3,5])
  })
  it('formats compact model axes without rounding plotted coordinates or raw tooltips', () => {
    const x = 0.728483948572, y = -0.77263637429
    const option = modelScatterOption([{ id: 'exact', x, y, title: `${x} / ${y}` }], '第1軸', '第2軸', false, [-1, 1], [-1, 1]) as any
    expect(option.xAxis.axisLabel.formatter(x)).toBe('0.728')
    expect(option.yAxis.axisLabel.formatter(y)).toBe('-0.773')
    expect(option.series[0].data[0].value).toEqual([x, y])
    expect(option.tooltip.formatter({ data: option.series[0].data[0] })).toBe(`${x} / ${y}`)
    expect(formatModelAxisValue(100000.001, [100000, 100000.01])).toBe('100000.001')
    expect(formatModelAxisValue(100000.002, [100000, 100000.01])).toBe('100000.002')
    expect(formatModelAxisValue(0.000000123456, [0, 0.000001])).toBe('1.23e-7')
    expect(formatModelAxisValue(123456789, [0, 200000000])).toBe('1.23e+8')
    expect(formatModelAxisValue(-0, [-1, 1])).toBe('0')
  })
  it('uses uncapped log CI coordinates for extreme odds ratios', () => {
    const option = oddsForestOption(rows), data = (option.series as any[])[0].data
    expect(data[0][0]).toBeCloseTo(43.9444915467/Math.LN10);expect(data[0][3]).toBeGreaterThan(30)
    expect(data[1][0]).toBeCloseTo(750/Math.LN10);expect((option.xAxis as any).max).toBeGreaterThan(770/Math.LN10)
    expect(formatOdds(rows[0].oddsRatio)).toContain('e+19');expect(formatOdds(null,'overflow')).toBe('上限超過')
    expect(formatOdds(null,'underflow')).toContain('>0')
  })
  it('preserves tiny finite coefficient and standard-error values', () => {
    expect(formatLogisticEstimate(1e-155)).toBe('1.000e-155')
    expect(formatLogisticEstimate(-1e-155)).toBe('-1.000e-155')
    expect(formatLogisticEstimate(1e155)).toBe('1.000e+155')
    expect(formatLogisticEstimate(0)).toBe('0.0000')
    expect(formatLogisticEstimate(null)).toBe('利用不可')
    expect(formatOdds(null, 'unavailable')).toBe('利用不可')
  })
  it('omits unavailable intervals before coordinate conversion and does not mark null p-values significant', () => {
    const option = oddsForestOption([unavailableRow, rows[0]]) as any
    const series = option.series[0]
    expect(series.data[0]).toEqual([1 / Math.LN10, 0, null, null])
    const render = (index: number) => series.renderItem({}, {
      value: (dim: number) => series.data[index][dim],
      coord: (point: number[]) => { expect(point.every(value => value != null && Number.isFinite(value))).toBe(true); return point },
    })
    const unavailable = render(0).children
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]).toMatchObject({ type: 'circle', style: { fill: '#888' } })
    const available = render(1).children
    expect(available.filter((child: any) => child.type === 'line')).toHaveLength(3)
    expect(available.at(-1)).toMatchObject({ type: 'circle', style: { fill: '#1890ff' } })
    const tooltip = option.tooltip.formatter({ dataIndex: 0 })
    expect(tooltip).toContain('OR=2.718')
    expect(tooltip).toContain('95% CI=利用不可')
    expect(tooltip).toContain('p=利用不可')
    expect(tooltip).toContain('SINGULAR_INFORMATION')
    expect(tooltip).not.toContain('p=null')
    expect(tooltip).not.toContain('p=0')
  })
  it('renders actual ECharts SVG', () => {
    mkdirSync('../../.temp/chart-qa', {recursive:true})
    for (const [name, option] of [
      ['model-scatter', modelScatterOption([{id:'a',x:-2,y:1,label:'A',title:'A'},{id:'b',x:3,y:-1,label:'B',title:'B',selected:true}], 'X','Y')],
      ['odds-forest', oddsForestOption(rows)],
      ['odds-forest-unavailable', oddsForestOption([unavailableRow, rows[0]])],
      ['odds-forest-empty', oddsForestOption([])],
    ] as const) {
      const chart = echarts.init(null, undefined, {renderer:'svg',ssr:true,width:700,height:400})
      chart.setOption(option);const svg = chart.renderToSVGString()
      expect(svg).toContain('<svg');expect(svg).not.toMatch(/(?:cx|cy|width|height)="NaN"/)
      if (name === 'odds-forest-unavailable') {
        const marks = (chart as any).getModel().getSeriesByIndex(0).getData().getItemGraphicEl(0).children()
        expect(marks).toHaveLength(1)
        expect(marks[0].type).toBe('circle')
        expect(marks[0].style.fill).toBe('#888')
      }
      writeFileSync(`../../.temp/chart-qa/${name}.svg`, svg);chart.dispose()
    }
  })
})
