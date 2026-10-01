import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { getInstanceByDom, init } from 'echarts'
import { CHART_MARKERS, pointDiameter, pointRadius, pointEmphasis, markerFitScale, fitPointSeries } from '../src/features/charts/markerStyle'
import { geometryToGraphic } from '../src/features/charts/EChartSurface'
import ModelScatter, { modelScatterOption } from '../src/features/models/ModelScatter'
import EChart from '../src/features/charts/EChart'
import * as graphPanel from '../src/features/common/GraphPanel'
import { chartSvgAtScale } from '../src/features/charts/chartExport'
import { efaScreeOption } from '../src/features/models/FactorAnalysisPage'
import { tourOption } from '../src/features/tgt/TgtCanvas'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('uses one point policy for models, tour and scree series without changing coordinates or symbols', () => {
  expect([pointDiameter(), pointDiameter(false, true), pointDiameter(true, true)]).toEqual([6, 8, 9])
  const option = modelScatterOption([
    { id: 'ordinary', x: 1, y: -2, title: 'ordinary', symbol: 'diamond' },
    { id: 'hovered', x: 2, y: 3, title: 'hovered', highlighted: true },
    { id: 'selected', x: 4, y: 5, title: 'selected', selected: true, misclassified: true },
  ], 'X', 'Y') as any
  const data = option.series.find((s: any) => s.id === 'model-points').data
  expect(data.map((p: any) => p.symbolSize)).toEqual([6, 8, 9])
  expect(data.map((p: any) => p.emphasis.scale)).toEqual([8 / 6, false, false])
  expect(data[0].value).toEqual([1, -2]); expect(data[0].symbol).toBe('diamond')
  expect(data[2].itemStyle.borderWidth).toBe(1.5)
  expect(option.series[0].data[0].symbolSize).toBe(9 + 2 * CHART_MARKERS.ringGap)
  const tour = tourOption([false, true].map((selected, i) => ({ rowId: String(i), x: i, y: -i, color: '#123456', selected, trails: [] })), 640, 480, '#2a78d6') as any
  expect(tour.series.find((s: any) => s.id === 'tour-points').data.map((p: any) => p.symbolSize)).toEqual([6, 9])
  expect((efaScreeOption([3, 2, 1], [2, 1, .5], 2).series as any[]).map(s => s.symbolSize)).toEqual([6, 6])
})

for (const scale of [.5, 1, 2]) it(`keeps ordinary markers CSS-sized at inner scale ${scale}, with independent group-owned hit targets`, () => {
  const select = vi.fn()
  const all = geometryToGraphic(<>
    <g onClick={select}><circle data-chart-marker="point" cx={100} cy={80} r={pointRadius()} fill="#123456"><title>row a</title></circle></g>
    <circle cx={150} cy={80} r={30} fill="none" />
    <circle data-chart-marker="ring" cx={100} cy={80} r={pointRadius() + CHART_MARKERS.ringGap} />
  </>, undefined, {}, CHART_MARKERS.hitRadius, { x: scale, y: scale })
  const [visible, hit] = all[0].children[0].children
  expect(visible.shape.r * scale).toBe(pointRadius())
  expect(visible.shape.cx).toBe(100)
  expect(visible.style.lineWidth * scale).toBe(1)
  expect(hit.shape.r * scale).toBe(CHART_MARKERS.hitRadius)
  expect(hit.style.fill).toBe('rgba(0,0,0,0)')
  expect(all[0].onclick).toBeTypeOf('function')
  expect(all[1].shape.r).toBe(30) // Reference geometry remains data-/layout-sized.
  expect(all[2].shape.r * scale).toBe(pointRadius() + CHART_MARKERS.ringGap)
})

it('keeps stretched geometry visually circular and 24px hit padding after outer Fit shrinking', () => {
  const outer = .5, sx = 2, sy = .5
  const all = geometryToGraphic(<circle data-chart-marker="point" cx={100} cy={80} r={pointRadius()} onClick={() => {}} />,
    undefined, {}, CHART_MARKERS.hitRadius / outer, { x: sx, y: sy })
  const [visible, hit] = all[0].children
  expect(visible.type).toBe('ellipse')
  expect(visible.shape.rx * sx).toBe(pointRadius())
  expect(visible.shape.ry * sy).toBe(pointRadius())
  expect(hit.shape.rx * sx * outer).toBe(CHART_MARKERS.hitRadius)
  expect(hit.shape.ry * sy * outer).toBe(CHART_MARKERS.hitRadius)
})

it('renders native point and hover diameters without ECharts adding a second multiplier', () => {
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 600, height: 400 })
  try {
    chart.setOption(modelScatterOption([{ id: 'base', x: 0, y: 0, title: 'base' }, { id: 'selected', x: 1, y: 1, title: 'selected', selected: true }], 'X', 'Y'))
    const data = (chart as any).getModel().getSeriesByIndex(0).getData()
    for (const [index, selected] of [false, true].entries()) {
      const symbol = data.getItemGraphicEl(index).getSymbolPath()
      expect(symbol.scaleX * 2).toBe(pointDiameter(selected))
      expect(symbol.states.emphasis.scaleX * 2).toBe(selected ? 9 : 8)
    }
  } finally { chart.dispose() }
})

it('keeps tiny native points clickable through invisible padding and refreshes options when hit settings change', () => {
  const click = vi.fn(), option = { animation: false, xAxis: { min: -1, max: 1 }, yAxis: { min: -1, max: 1 },
    series: [{ type: 'scatter' as const, symbolSize: pointDiameter(), emphasis: pointEmphasis(), data: [[0, 0]] }] }
  const view = render(<EChart pointHitRadius={12} option={option} onEvents={{ click }} testId="point-hit" />)
  const assertHit = () => {
    const chart = getInstanceByDom(view.getByTestId('point-hit'))!
    chart.resize({ width: 600, height: 400 })
    chart.getZr().flush()
    const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [0, 0]) as number[]
    expect(chart.getZr().findHover(x + 8, y).target).toBeTruthy()
    expect((chart.getOption().series as any[])[0].data).toEqual([[0, 0]])
    ;(chart as any).trigger('click', { data: [0, 0] })
  }
  assertHit()
  view.rerender(<EChart pointHitRadius={16} option={option} onEvents={{ click }} testId="point-hit" />)
  assertHit()
  expect(click).toHaveBeenCalledTimes(2)
})

it.each([null, 1.25, 2])('keeps actual native point glyphs at CSS policy sizes under Fit and zoom %s', zoom => {
  const fit = 2.113, viewport = { scale: fit * (zoom ?? 1), zoom, logicalWidth: 600, logicalHeight: 400, dpr: 2, revision: 0 }
  vi.spyOn(graphPanel, 'useGraphViewport').mockReturnValue(viewport)
  const option = modelScatterOption([{ id: 'base', x: 0, y: 0, title: 'base' },
    { id: 'selected', x: 1, y: 1, title: 'selected', selected: true, misclassified: true }], 'X', 'Y')
  const view = render(<EChart fitPointMarkers option={option} testId="fit-glyphs" />)
  const chart = getInstanceByDom(view.getByTestId('fit-glyphs'))!
  chart.resize({ width: 600, height: 400 }); chart.getZr().flush()
  const model = (chart as any).getModel(), data = model.getSeriesByIndex(1).getData()
  for (const [index, selected] of [false, true].entries()) {
    const symbol = data.getItemGraphicEl(index).getSymbolPath()
    expect(symbol.scaleX * 2 * viewport.scale).toBeCloseTo(pointDiameter(selected) * (zoom ?? 1))
    expect(symbol.states.emphasis.scaleX * 2 * viewport.scale).toBeCloseTo((selected ? 9 : 8) * (zoom ?? 1))
  }
  expect((chart.getOption().series as any[])[0].data[0].symbolSize * viewport.scale).toBeCloseTo(15 * (zoom ?? 1))
  const exported = new DOMParser().parseFromString(chartSvgAtScale(chart, viewport.scale), 'image/svg+xml').documentElement
  expect(Number(exported.getAttribute('width'))).toBeCloseTo(600 * viewport.scale)
  expect(exported.getAttribute('viewBox')).toBe('0 0 600 400')
})

it('preserves encoded size ratios, semantic tree nodes, coordinates and input options', () => {
  const series = [{ type: 'scatter', symbolSize: (value: number[]) => value[2], data: [{ value: [1, 2], symbolSize: [6, 8] }] },
    { type: 'tree', symbolSize: [84, 38], data: [{ name: 'tree' }] }]
  const next = fitPointSeries(series, 2)
  expect(next[0].symbolSize([0, 0, 20])).toBe(10)
  expect(next[0].data[0].symbolSize).toEqual([3, 4])
  expect(next[0].data[0].value).toEqual([1, 2])
  expect(next[1]).toBe(series[1])
  expect(series[0].data[0].symbolSize).toEqual([6, 8])
})

it.each([null, 1.25])('compensates custom marker Fit separately from its screen-sized hit target at zoom %s', zoom => {
  const inner = .5, viewport = { scale: .5 * (zoom ?? 1), zoom }, fit = markerFitScale(viewport)
  const graphics = geometryToGraphic(<circle data-chart-marker="point" cx={100} cy={80} r={pointRadius()} onClick={() => {}} />,
    undefined, {}, CHART_MARKERS.hitRadius / viewport.scale, { x: inner, y: inner }, fit)
  const [visible, hit] = graphics[0].children
  expect(visible.shape.r * inner * viewport.scale * 2).toBeCloseTo(6 * (zoom ?? 1))
  expect(hit.shape.r * inner * viewport.scale * 2).toBeCloseTo(24)
})

it.each([.5, 2])('keeps native hit tolerance and legend state through Fit scale %s', scale => {
  const viewport = { scale: 1, zoom: null, logicalWidth: 600, logicalHeight: 400, dpr: 1, revision: 0 }
  vi.spyOn(graphPanel, 'useGraphViewport').mockImplementation(() => viewport)
  const option = { animation: false, legend: {}, xAxis: {}, yAxis: {}, series: [
    { type: 'scatter' as const, name: 'visible', symbolSize: 6, data: [[0, 0]] },
    { type: 'scatter' as const, name: 'hidden', symbolSize: 6, data: [[1, 1]] },
  ] }
  const content = () => <EChart fitPointMarkers pointHitRadius={12} option={option} testId="fit-hit" />
  const view = render(content())
  const original = getInstanceByDom(view.getByTestId('fit-hit'))!
  act(() => original.dispatchAction({ type: 'legendUnSelect', name: 'hidden' }))
  viewport.scale = scale
  view.rerender(content())
  const chart = getInstanceByDom(view.getByTestId('fit-hit'))!
  chart.resize({ width: 600, height: 400 }); chart.getZr().flush()
  expect((chart.getOption().legend as any[])[0].selected.hidden).toBe(false)
  const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [0, 0]) as number[]
  expect(chart.getZr().findHover(x + 8 / viewport.scale, y).target).toBeTruthy()
})

it.each([.5, 1, 2])('allows a click-only model to select a tiny point within 8 screen pixels at scale %s', scale => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const toggle = vi.fn(), view = render(<ModelScatter points={[{ id: 'a', x: 0, y: 0, title: 'a' }]}
    xLabel="X" yLabel="Y" onToggle={toggle} testId="click-only" />)
  const element = view.getByTestId('click-only'), chart = getInstanceByDom(element)!
  chart.resize({ width: 600, height: 400 })
  const host = element.closest('[data-chart-host]')!.parentElement!
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600 * scale, height: 400 * scale } as DOMRect)
  const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [0, 0]) as number[]
  for (const distance of [7, 9]) {
    fireEvent.pointerDown(host, { clientX: x * scale + distance, clientY: y * scale, button: 0 })
    fireEvent.pointerUp(host, { clientX: x * scale + distance, clientY: y * scale, button: 0 })
  }
  expect(toggle).toHaveBeenCalledTimes(1)
  expect(toggle).toHaveBeenCalledWith('a')
})
