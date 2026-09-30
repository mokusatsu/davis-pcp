import { describe, expect, it } from 'vitest'
import { init } from 'echarts'
import { famdRelationOption } from '../src/features/models/FamdFigure'

const relations = [
  { variableId: 'X', kind: 'numeric', relationStrength: [0.86, 0.04], contributions: [0.4, 0.1] },
  { variableId: 'Group', kind: 'categorical', relationStrength: [0.75, 0.6], contributions: [0.3, 0.2] },
]

describe('FAMD variable-relation layout', () => {
  for (const width of [560, 1120]) it(`keeps the real SVG legend above the plotting grid at width ${width}`, () => {
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width, height: 300 })
    try {
      chart.setOption(famdRelationOption(relations, [1, 2], new Map([['X','X'],['Group','Group']])))
      chart.getZr().flush()
      const text = chart.getZr().storage.getDisplayList(true).filter((el: any) => typeof el.style?.text === 'string')
      const legends = text.filter((el: any) => /^第[12]軸$/.test(el.style.text))
      expect(legends).toHaveLength(2)
      for (const label of legends) {
        const bounds = label.getBoundingRect().clone()
        bounds.applyTransform(label.transform)
        expect(bounds.y).toBeGreaterThanOrEqual(0)
        expect(bounds.y + bounds.height).toBeLessThan(40)
      }
      const xTick = text.find((el: any) => el.style.text === '0.2')!
      expect(xTick).toBeTruthy()
      const tickBounds = xTick.getBoundingRect().clone()
      tickBounds.applyTransform(xTick.transform)
      expect(tickBounds.y).toBeGreaterThan(260)
      expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity|<image/)
    } finally { chart.dispose() }
  })
})

// ECharts 6 can shrink one grid dimension to fit axis text, even in a square host.
// The circle must retain equal pixel scales without depending on that auto-fit.
describe('FAMD correlation-circle scale', () => {
  it('opts out of asymmetric auto-shrink with symmetric room for axis labels', async () => {
    const { render, cleanup } = await import('@testing-library/react')
    const { CorrelationCircle } = await import('../src/features/models/FamdFigure')
    const { getInstanceByDom } = await import('echarts')
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 420 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 420 })
    try {
      const view = render(<CorrelationCircle testId="circle-equal-scales" points={[{id:'X',label:'X',title:'X',x:.8,y:.4}]} />)
      const chart = getInstanceByDom(view.getByTestId('circle-equal-scales'))!
      const origin = chart.convertToPixel({gridIndex:0},[0,0]) as number[]
      const x = chart.convertToPixel({gridIndex:0},[1,0]) as number[]
      const y = chart.convertToPixel({gridIndex:0},[0,1]) as number[]
      expect(Math.abs(x[0]-origin[0])).toBeCloseTo(Math.abs(y[1]-origin[1]),10)
      expect((chart.getOption() as any).grid[0].outerBoundsMode).toBe('none')
    } finally {
      cleanup()
      if(width) Object.defineProperty(HTMLElement.prototype,'clientWidth',width); else delete (HTMLElement.prototype as any).clientWidth
      if(height) Object.defineProperty(HTMLElement.prototype,'clientHeight',height); else delete (HTMLElement.prototype as any).clientHeight
    }
  })
})
