import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { getInstanceByDom, init } from 'echarts'
import EChart from '../src/features/charts/EChart'
import EChartSurface, { geometryToGraphic } from '../src/features/charts/EChartSurface'
import { getSvgPoint } from '../src/utils/svgCoordinates'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('renders statistical primitives with real SVG SSR, retaining distances, paths, rotations and opacity', () => {
  const graphics = geometryToGraphic(<g fill="#123456" fillOpacity={.4} transform="translate(10, 20)">
    <rect x={10} y={10} width={100} height={25} /><circle cx={90} cy={50} r={5} /><line x1={0} y1={100} x2={120} y2={200} stroke="#f00" />
    <path d="M 1 2 L 15 8 L 15 20 Z" /><text x={20} y={30} transform="rotate(-90 20 30)">Label</text>
  </g>)
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 500, height: 300 })
  chart.setOption({ animation: false, graphic: graphics })
  const svg = chart.renderToSVGString()
  expect(svg).toContain('Label')
  expect(svg).toContain('#123456')
  expect(svg).not.toMatch(/NaN|Infinity/)
  expect(graphics[0].children[0].shape.width).toBe(100)
  expect(graphics[0].children[0].style.fillOpacity).toBe(.4)
  expect(graphics[0].children[4].rotation).toBeCloseTo(Math.PI / 2)
  chart.dispose()
})
it('keeps lifecycle, custom events, exports and external SVG reference on refresh and disposes on unmount', () => {
  const ref = createRef<SVGSVGElement>(), ready = vi.fn(), clicked = vi.fn()
  const option = { xAxis: {}, yAxis: {}, series: [{ type: 'scatter' as const, data: [[1, 2]] }], toolbox: { feature: { restore: {} } } }
  const view = render(<EChart option={option} svgRef={ref} onReady={ready} onEvents={{ click: clicked }} testId="host" />)
  const chart = getInstanceByDom(view.getByTestId('host'))!
  expect(ref.current?.tagName.toLowerCase()).toBe('svg')
  expect(ready).toHaveBeenCalledTimes(1)
  expect(view.getByRole('button', { name: '統計グラフ：SVGを保存' })).toBeVisible()
  expect((chart.getOption().toolbox as any)[0].feature).toHaveProperty('restore')
  view.rerender(<EChart option={{ ...option, series: [{ type: 'scatter', data: [[2, 3]] }] }} svgRef={ref} onReady={ready} testId="host" />)
  expect(getInstanceByDom(view.getByTestId('host'))).toBe(chart)
  expect(ready).toHaveBeenCalledTimes(1)
  expect(chart.getDataURL({ type: 'svg' })).toContain('data:image/svg+xml')
  view.unmount()
  expect(chart.isDisposed()).toBe(true)
  expect(ref.current).toBeNull()
})
it('preserves graphics mark clicks, native pointer guards, tooltips and logical brush coordinates', () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const select = vi.fn(), pointer = vi.fn(), cancelled = vi.fn(), context = vi.fn(), svg = createRef<SVGSVGElement>()
  const view = render(<EChartSurface ref={svg} width={600} height={400} viewBox="0 0 600 400" data-testid="surface"
    onPointerDown={pointer} onLostPointerCapture={cancelled} onContextMenu={context}>
    <circle cx={200} cy={100} r={12} onClick={select}><title>{'<unsafe> stable rowId r17'}</title></circle>
    <text x={40} y={40}>Plain text</text>
  </EChartSurface>)
  const host = view.getByTestId('surface'), chartDom = host.querySelector('[data-chart-renderer="echarts"]') as HTMLElement
  const chart = getInstanceByDom(chartDom)!
  act(() => { chart.resize({ width: 600, height: 400 }) })
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 } as DOMRect)
  const target = chart.getZr().findHover(200, 100).target as any
  expect(target?.onclick).toBeTypeOf('function')
  fireEvent.pointerDown(host, { clientX: 200, clientY: 100, button: 0 })
  expect(pointer).not.toHaveBeenCalled()
  fireEvent.mouseMove(chartDom.firstElementChild!, { clientX: 200, clientY: 100 })
  fireEvent.mouseDown(chartDom.firstElementChild!, { clientX: 200, clientY: 100, button: 0 })
  fireEvent.mouseUp(chartDom.firstElementChild!, { clientX: 200, clientY: 100, button: 0 })
  fireEvent.click(chartDom.firstElementChild!, { clientX: 200, clientY: 100 })
  expect(select).toHaveBeenCalledTimes(1)
  fireEvent.mouseMove(chartDom.firstElementChild!, { clientX: 200, clientY: 100 })
  expect(view.getByRole('tooltip')).toHaveTextContent('<unsafe> stable rowId r17')
  expect(view.container.querySelector('unsafe')).toBeNull()
  fireEvent.pointerDown(host, { clientX: 40, clientY: 200, button: 0 })
  expect(pointer).toHaveBeenCalledTimes(1)
  fireEvent.lostPointerCapture(host)
  expect(cancelled).toHaveBeenCalledTimes(1)
  fireEvent.contextMenu(host)
  expect(context).toHaveBeenCalledTimes(1)
  svg.current!.getBoundingClientRect = () => ({ left: 50, top: 60, width: 300, height: 200 } as DOMRect)
  expect(getSvgPoint(svg.current, { clientX: 150, clientY: 110 })).toEqual({ x: 200, y: 100 })
})
it('retains nested tspan values and variable names, and split native titles without HTML interpretation', () => {
  const graphics = geometryToGraphic(<>
    <text>2件<tspan> (1件選択 / 50%)</tspan><tspan> [25.0%]</tspan></text>
    <text><tspan>X</tspan> × <tspan>Y</tspan></text>
    <text><title>{'同じ表示'} ({2})</title>Label</text>
  </>)
  expect(graphics[0].style.text).toBe('2件 (1件選択 / 50%) [25.0%]')
  expect(graphics[1].style.text).toBe('X × Y')
  expect(graphics[2].info.title).toBe('同じ表示 (2)')
  expect(graphics[2].style.text).toBe('Label')
})
it('exposes raw mark identity and selection to keyboard users', () => {
  const select = vi.fn()
  const view = render(<EChartSurface width={300} height={200} data-testid="keyboard-surface">
    <circle cx={90} cy={60} r={4} onClick={select}><title>rowId: stable-r17</title></circle>
  </EChartSurface>)
  const surface = view.getByTestId('keyboard-surface')
  fireEvent.focus(surface)
  expect(view.getByRole('tooltip')).toHaveTextContent('stable-r17')
  fireEvent.keyDown(surface, { key: 'Enter' })
  expect(select).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(surface, { key: 'Escape' })
  expect(view.queryByRole('tooltip')).toBeNull()
})
it('preserves native legend choices when only chart styles/selection refresh', () => {
  const option = { legend: {}, xAxis: {}, yAxis: {}, series: [{ type: 'scatter' as const, name: 'Group A', data: [[1, 2]] }] }
  const view = render(<EChart option={option} testId="legend" />)
  const chart = getInstanceByDom(view.getByTestId('legend'))!
  act(() => { chart.dispatchAction({ type: 'legendUnSelect', name: 'Group A' }) })
  view.rerender(<EChart option={{ ...option, series: [{ ...option.series[0], itemStyle: { color: '#f00' } }] }} testId="legend" />)
  expect((chart.getOption().legend as any)[0].selected['Group A']).toBe(false)
})
it('preserves zoom for the same view and resets interaction state and old series on dataset change', () => {
  const option = { legend: {}, dataZoom: [{ type: 'inside' as const, start: 0, end: 100 }], xAxis: {}, yAxis: {}, series: [{ id: 'same', type: 'scatter' as const, name: 'Group A', data: [[1, 2], [2, 4]] }] }
  const view = render(<EChart option={option} testId="zoom" resetKey="dataset-a" />)
  const chart = getInstanceByDom(view.getByTestId('zoom'))!
  act(() => { chart.dispatchAction({ type: 'dataZoom', start: 10, end: 70 }); chart.dispatchAction({ type: 'legendUnSelect', name: 'Group A' }) })
  view.rerender(<EChart option={{ ...option, series: [{ ...option.series[0], itemStyle: { color: '#0f0' } }] }} testId="zoom" resetKey="dataset-a" />)
  expect((chart.getOption().dataZoom as any)[0].start).toBe(10)
  expect((chart.getOption().legend as any)[0].selected['Group A']).toBe(false)
  view.rerender(<EChart option={{ ...option, series: [] }} testId="zoom" resetKey="dataset-b" />)
  expect((chart.getOption().dataZoom as any)[0].start).toBe(0)
  expect(chart.getOption().series).toHaveLength(0)
})
it('preserves native tree roam while keeping controlled collapse and resetting new topology', () => {
  const option = { series: [{ type: 'tree' as const, roam: true, data: [{ id: 'root', name: 'root', children: [{ id: 'leaf', name: 'leaf' }] }] }] }
  const view = render(<EChart option={option} testId="tree" resetKey="a" />)
  const chart = getInstanceByDom(view.getByTestId('tree'))!
  act(() => { chart.setOption({ series: [{ zoom: 1.7, center: [100, 120] }] }) })
  view.rerender(<EChart option={{ series: [{ ...option.series[0], data: [{ ...option.series[0].data[0], collapsed: true }] }] }} testId="tree" resetKey="a" />)
  expect((chart.getOption().series as any)[0].zoom).toBe(1.7)
  expect((chart.getOption().series as any)[0].data[0].collapsed).toBe(true)
  view.rerender(<EChart option={{ series: [{ ...option.series[0], data: [{ id: 'new-root', name: 'new tree' }] }] }} testId="tree" resetKey="a" />)
  expect((chart.getOption().series as any)[0].zoom).toBe(1)
})
