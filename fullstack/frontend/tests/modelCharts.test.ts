// @vitest-environment node
import { describe, it, expect } from 'vitest'
import * as echarts from 'echarts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { modelScatterOption, extent } from '../src/features/models/ModelScatter'
import { oddsForestOption, formatOdds } from '../src/features/models/OddsRatioForest'
const rows = [
  {name:'x', coefficient:43.9444915467, stdError:1, zValue:1, pValue:.02, oddsRatio:1.2157665459e19,
    ciLower:2486872.9622, ciUpper:5.9435617204e31, logOddsRatio:43.9444915467,
    logCiLower:Math.log(2486872.9622),logCiUpper:Math.log(5.9435617204e31)},
  {name:'range',coefficient:750,stdError:1,zValue:1,pValue:.001,oddsRatio:null,ciLower:null,ciUpper:null,
    logOddsRatio:750,logCiLower:730,logCiUpper:770,exponentiationStatus:{oddsRatio:'overflow',ciLower:'overflow',ciUpper:'overflow'}},
]
describe('ECharts model semantics', () => {
  it('retains stable ids and signs', () => {
    const option = modelScatterOption([{id:'row-stable-7',x:-2,y:3,title:'raw title',selected:true}], 'X','Y')
    const data = (option.series as any[])[0].data
    expect(data[0].id).toBe('row-stable-7');expect(data[0].value).toEqual([-2,3]);expect(data[0].symbolSize).toBe(14)
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
  it('uses uncapped log CI coordinates for extreme odds ratios', () => {
    const option = oddsForestOption(rows), data = (option.series as any[])[0].data
    expect(data[0][0]).toBeCloseTo(43.9444915467/Math.LN10);expect(data[0][3]).toBeGreaterThan(30)
    expect(data[1][0]).toBeCloseTo(750/Math.LN10);expect((option.xAxis as any).max).toBeGreaterThan(770/Math.LN10)
    expect(formatOdds(rows[0].oddsRatio)).toContain('e+19');expect(formatOdds(null,'overflow')).toBe('上限超過')
    expect(formatOdds(null,'underflow')).toContain('>0')
  })
  it('renders actual ECharts SVG', () => {
    mkdirSync('../../.temp/chart-qa', {recursive:true})
    for (const [name, option] of [
      ['model-scatter', modelScatterOption([{id:'a',x:-2,y:1,label:'A',title:'A'},{id:'b',x:3,y:-1,label:'B',title:'B',selected:true}], 'X','Y')],
      ['odds-forest', oddsForestOption(rows)],
    ] as const) {
      const chart = echarts.init(null, undefined, {renderer:'svg',ssr:true,width:700,height:400})
      chart.setOption(option);const svg = chart.renderToSVGString()
      expect(svg).toContain('<svg');expect(svg).not.toMatch(/(?:cx|cy|width|height)="NaN"/)
      writeFileSync(`../../.temp/chart-qa/${name}.svg`, svg);chart.dispose()
    }
  })
})
