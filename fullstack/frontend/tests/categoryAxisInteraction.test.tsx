import { act, cleanup, render } from '@testing-library/react'
import { getInstanceByDom } from 'echarts'
import { afterEach, expect, it, vi } from 'vitest'
import EChart from '../src/features/charts/EChart'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('reflows labels on external resize without replacing the chart, source values or legend state', () => {
  let width = 440
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(350)
  const names = ['A very long variable name that needs to wrap over several lines', '別の長い変数名とその設問文'.repeat(4)]
  const formatter = vi.fn((p: any) => `series value=${p.data.value}`)
  const onClick = vi.fn()
  const option = { grid: { left: 150, top: 20, right: 40, bottom: 40 },
    legend: { data: ['signed values'] }, tooltip: { formatter },
    xAxis: { type: 'value' as const }, yAxis: { type: 'category' as const, data: names },
    series: [{ type: 'bar' as const, name: 'signed values', data: [-2.75, 1.625] }] }
  const view = render(<EChart option={option} testId="label-resize" onEvents={{ click: onClick }} />)
  const chart = getInstanceByDom(view.getByTestId('label-resize'))!
  act(() => { chart.dispatchAction({ type: 'legendUnSelect', name: 'signed values' }) })
  for (width of [320, 960, 440, 320, 960, 440]) {
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(getInstanceByDom(view.getByTestId('label-resize'))).toBe(chart)
    const current = chart.getOption() as any
    expect(current.series[0].data).toEqual([-2.75, 1.625])
    expect(current.tooltip[0].extraCssText).toContain('white-space: normal')
    expect(current.tooltip[0].confine).toBe(true)
    expect(current.tooltip[0].enterable).toBe(true)
    expect(current.yAxis[0].tooltip.enterable).toBe(true)
    expect(current.yAxis[0].data).toEqual(names)
    expect(current.yAxis[0].axisLabel.formatter(names[0], 0).split('\n').length).toBeGreaterThan(1)
    expect(current.legend[0].selected['signed values']).toBe(false)
    expect(current.grid[0].left).toBeLessThanOrEqual(width * .42 + 16)
    expect(current.yAxis[0].tooltip.formatter({ value: names[1] })).toBe(names[1])
  }
  act(() => {
    ;(chart as any).trigger('click', { componentType: 'yAxis', componentIndex: 0, dataIndex: 0, value: names[0] })
  })
  expect(onClick).not.toHaveBeenCalled()
  expect(formatter).not.toHaveBeenCalled()
  act(() => { (chart as any).trigger('click', { componentType: 'series', dataIndex: 0, data: -2.75 }) })
  expect(onClick).toHaveBeenCalledOnce()
})

it('retains category-axis click selection when a chart explicitly opted into it', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
  const click = vi.fn()
  const view = render(<EChart testId="interactive-category" option={{
    xAxis: { type: 'value' }, yAxis: { type: 'category', triggerEvent: true, data: ['code-1'] },
    series: [{ type: 'bar', data: [1] }],
  }} onEvents={{ click }} />)
  const chart = getInstanceByDom(view.getByTestId('interactive-category'))!
  act(() => { (chart as any).trigger('click', { componentType: 'yAxis', value: 'code-1' }) })
  expect(click).toHaveBeenCalledOnce()
})
