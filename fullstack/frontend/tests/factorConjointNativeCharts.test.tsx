import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { Provider } from 'react-redux'
import { getInstanceByDom, init, type ECharts } from 'echarts'
import { mkdirSync, writeFileSync } from 'node:fs'
import ConjointFigure, { conjointExtent } from '../src/features/models/ConjointFigure'
import EfaScoreFigure from '../src/features/models/EfaScoreFigure'
import { efaScreeOption } from '../src/features/models/FactorAnalysisPage'
import { hovered, store } from '../src/app/store'

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(560)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  store.dispatch(hovered(null))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); store.dispatch(hovered(null)) })

function points(chart: ECharts): any[] {
  return (chart.getOption().series as any[]).find((series) => series.id === 'model-points').data
}
function trigger(chart: ECharts, name: string, payload: unknown): void {
  // Contract-level native event coverage; physical pointer QA is separate.
  ;(chart as ECharts & { trigger: (name: string, payload: unknown) => void }).trigger(name.toLowerCase(), payload)
}

describe('native Conjoint diagnostic scatter', () => {
  it('preserves signed coordinates and row IDs, omits missing residuals, and exports its generated SVG', () => {
    const svgRef = createRef<SVGSVGElement>(), toggle = vi.fn(), brush = vi.fn()
    const data = [
      { rowId: 'negative', x: -2, y: -4, title: 'negative residual' },
      { rowId: 'positive', x: 3, y: 2, title: '<raw> row title' },
      { rowId: 'missing-residual', x: 0, y: null, title: 'residual unavailable' },
      { rowId: 'nonfinite', x: NaN, y: 1, title: 'nonfinite' },
    ]
    const view = render(<ConjointFigure points={data} xLabel="予測評点" yLabel="残差"
      selected={new Set(['negative'])} highlighted={new Set(['positive'])}
      getColor={() => '#456789'} onToggle={toggle} onBrush={brush} svgRef={svgRef} testId="conjoint-native" />)
    const host = view.getByTestId('conjoint-native'), chart = getInstanceByDom(host)!
    expect(host).toHaveAttribute('data-chart-renderer', 'echarts')
    expect(points(chart).map((p) => [p.id, p.rowId, p.value])).toEqual([
      ['negative', 'negative', [-2, -4]], ['positive', 'positive', [3, 2]],
    ])
    expect(points(chart)[0].symbolSize).toBeGreaterThan(points(chart)[1].symbolSize)
    expect(points(chart)[0].itemStyle.color).toBe('#2a78d6')
    expect(points(chart)[1].itemStyle.color).toBe('#456789')
    expect(points(chart)[1].itemStyle.borderWidth).toBe(1.5)
    expect(svgRef.current?.tagName.toLowerCase()).toBe('svg')
    expect(chart.getDataURL({ type: 'svg' })).toContain('data:image/svg+xml')
    expect(host.querySelector('raw')).toBeNull()
    act(() => {
      trigger(chart, 'click', { seriesId: 'model-points', data: points(chart)[0] })
      trigger(chart, 'brushEnd', { areas: [{ coordRange: [[-3, 1], [-5, 2]] }] })
    })
    expect(toggle).toHaveBeenCalledWith('negative')
    expect(brush).toHaveBeenCalledWith({ x: [-3, 1], y: [-5, 2] })
    view.unmount()
    expect(svgRef.current).toBeNull()
    expect(chart.isDisposed()).toBe(true)
  })

  it('retains explicit ranking row order and refreshes central hover and row colors', () => {
    const svgRef = createRef<SVGSVGElement>()
    const data = [
      { rowId: 'rank-a', x: .2, y: 1, title: '第1位確率=0.2 行順=1（観測順位=3）' },
      { rowId: 'rank-b', x: .8, y: 2, title: '第1位確率=0.8 行順=2（観測順位=1）' },
    ]
    const draw = (color: string) => <Provider store={store}><ConjointFigure points={data}
      xLabel="第1位確率" yLabel="行順" selected={new Set()} highlighted={new Set()}
      getColor={() => color} onToggle={vi.fn()} svgRef={svgRef} testId="conjoint-ranking" /></Provider>
    const view = render(draw('#112233')), chart = getInstanceByDom(view.getByTestId('conjoint-ranking'))!
    expect(points(chart).map((p) => p.value)).toEqual([[.2, 1], [.8, 2]])
    expect((chart.getOption().yAxis as any[])[0].name).toBe('行順')
    act(() => { trigger(chart, 'mouseover', { data: points(chart)[1] }) })
    expect(store.getState().selection.hoveredRowId).toBe('rank-b')
    expect(points(chart)[1].itemStyle.borderWidth).toBe(1.5)
    act(() => { trigger(chart, 'mouseout', { data: points(chart)[1] }) })
    expect(store.getState().selection.hoveredRowId).toBeNull()
    view.rerender(draw('#abcdef'))
    expect(getInstanceByDom(view.getByTestId('conjoint-ranking'))).toBe(chart)
    expect(points(chart).every((p) => p.itemStyle.color === '#abcdef')).toBe(true)
  })

  it('keeps finite empty and constant extent fallbacks', () => {
    expect(conjointExtent([NaN, Infinity])).toEqual([0, 1])
    expect(conjointExtent([4, 4])).toEqual([3, 5])
    expect(conjointExtent([-4, 2])).toEqual([-4.3, 2.3])
  })
})

describe('native factor-score scatter', () => {
  it('omits null/NaN scores without synthesizing positions and retains same-factor brush bounds', () => {
    const svgRef = createRef<SVGSVGElement>(), brush = vi.fn(), toggle = vi.fn()
    const view = render(<EfaScoreFigure points={[
      { rowId: 'score-a', x: -3, y: -3, title: 'score-a F1=-3' },
      { rowId: 'score-b', x: 5, y: 5, title: 'score-b F1=5' },
      { rowId: 'missing-x', x: null, y: 1, title: 'missing' },
      { rowId: 'missing-y', x: 1, y: null, title: 'missing' },
      { rowId: 'invalid-y', x: 1, y: Infinity, title: 'invalid' },
      { rowId: 'invalid-x', x: NaN, y: 1, title: 'invalid' },
    ]} xLabel="F1" yLabel="F1" selected={new Set(['score-b'])} hovered="score-a"
      getColor={() => '#765432'} onToggle={toggle} onBrush={brush} svgRef={svgRef} testId="efa-native" />)
    const chart = getInstanceByDom(view.getByTestId('efa-native'))!
    expect(points(chart).map((p) => [p.rowId, p.value])).toEqual([['score-a', [-3, -3]], ['score-b', [5, 5]]])
    expect(points(chart)[0].itemStyle.color).toBe('#765432')
    expect(points(chart)[0].itemStyle.borderWidth).toBe(1.5)
    expect(points(chart)[1].itemStyle.color).toBe('#2a78d6')
    expect((chart.getOption().yAxis as any[])[0].show).toBe(true)
    act(() => {
      trigger(chart, 'click', { seriesId: 'model-points', data: points(chart)[0] })
      trigger(chart, 'brushEnd', { areas: [{ coordRange: [[-4, 4], [-2, 7]] }] })
    })
    expect(toggle).toHaveBeenCalledWith('score-a')
    // The page retains its existing same-factor intersection logic.
    expect(brush).toHaveBeenCalledWith({ x: [-4, 4], y: [-2, 7] })
    expect(svgRef.current).not.toBeNull()
  })

  it('handles empty and all-missing datasets without marks or non-finite axes', () => {
    const svgRef = createRef<SVGSVGElement>()
    const view = render(<EfaScoreFigure points={[{ rowId: 'missing', x: null, y: null, title: 'missing' }]}
      xLabel="F1" yLabel="F2" selected={new Set()} hovered={null} onToggle={vi.fn()} svgRef={svgRef} testId="efa-empty" />)
    const chart = getInstanceByDom(view.getByTestId('efa-empty'))!
    expect(points(chart)).toEqual([])
    expect((chart.getOption().xAxis as any[])[0]).toMatchObject({ min: 0, max: 1 })
    expect((chart.getOption().yAxis as any[])[0]).toMatchObject({ min: 0, max: 1 })
  })
})

describe('native EFA parallel-analysis scree', () => {
  it('keeps observed and reference ranks aligned and missing values as gaps', () => {
    const option = efaScreeOption([3, 2, -1], [2.5, null, 1, .5], 2)
    expect((option.xAxis as any).data).toEqual(['1', '2', '3', '4'])
    const series = option.series as any[]
    expect(series.map((s) => s.type)).toEqual(['line', 'line'])
    expect(series[0].data).toEqual([3, 2, -1, null])
    expect(series[1].data).toEqual([2.5, null, 1, .5])
    expect(series.every((s) => s.connectNulls === false)).toBe(true)
    expect(series[1].lineStyle.type).toBe('dashed')
    expect((option.title as any).text).toContain('候補 2')
  })

  it('renders actual ECharts SVG for sparse, negative and unavailable parallel-analysis data', () => {
    mkdirSync('../../.temp/chart-qa', { recursive: true })
    for (const [name, observed, reference] of [
      ['efa-scree-sparse', [4, 2, -1], [3, null, 1]],
      ['efa-scree-missing', [NaN, null], [null, Infinity]],
      ['efa-scree-empty', [], []],
    ] as const) {
      const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 560, height: 220 })
      chart.setOption(efaScreeOption([...observed], [...reference], null))
      const svg = chart.renderToSVGString()
      expect(svg).toContain('<svg')
      expect(svg).not.toMatch(/NaN|Infinity/)
      expect(svg).toContain('観測')
      expect(svg).toContain('参照分位')
      if (name === 'efa-scree-sparse') {
        expect((chart.convertToPixel({ gridIndex: 0 }, ['3', -1]) as number[]).every(Number.isFinite)).toBe(true)
      }
      writeFileSync(`../../.temp/chart-qa/${name}.svg`, svg)
      chart.dispose()
    }
  })
})
