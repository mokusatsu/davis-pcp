import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { getInstanceByDom } from 'echarts'
import CategoryBars from '../src/features/charts/CategoryBars'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps a usable plot and distinct CI labels at narrow, normal and expanded widths', () => {
  let width = 320
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
  const onSelect = vi.fn()
  const items = [
    { id: 'outlier', label: '数値的外れ度下位5%除去', value: 284.93, detail: 'Full scenario description', selected: true },
    { id: 'lower', label: '95%CI 下限', value: 1077.41 },
    { id: 'upper', label: '95%CI 上限', value: 1455.12 },
  ]
  const view = render(<CategoryBars testId="responsive-bars" axisName="推定値ドリフト (%)" items={items} onSelect={onSelect} />)
  const chart = getInstanceByDom(view.getByTestId('responsive-bars'))!
  for (width of [320, 420, 560, 1120]) {
    act(() => { window.dispatchEvent(new Event('resize')) })
    const model = (chart as any).getModel()
    const rect = model.getComponent('grid').coordinateSystem.getRect()
    expect(rect.width).toBeGreaterThanOrEqual(width * .45)
    const labels = chart.getZr().storage.getDisplayList().filter((e: any) => e.type === 'tspan' && !e.ignore)
    expect(labels.some((e: any) => e.style.text === '95%CI 下限')).toBe(true)
    expect(labels.some((e: any) => e.style.text === '95%CI 上限')).toBe(true)
    const ticks = labels.filter((e: any) => /^\d[\d,]*$/.test(e.style.text)).map(e => {
      const bounds = e.getBoundingRect().clone(); if (e.transform) bounds.applyTransform(e.transform); return bounds
    }).filter(b => b.y >= rect.y + rect.height).sort((a,b) => a.x - b.x)
    expect(ticks.length).toBeGreaterThan(1)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].x).toBeGreaterThanOrEqual(ticks[i-1].x + ticks[i-1].width)
    const data = model.getSeriesByIndex(0).getData()
    expect(items.map((_, i) => data.get('x', i))).toEqual(items.map(item => item.value))
    expect(data.getItemGraphicEl(0).style.fill).toBe('#2a78d6')
  }
  expect((chart.getOption().tooltip as any)[0].formatter({ dataIndex: 0 })).toContain('Full scenario description')
  act(() => { (chart as any).trigger('click', { dataIndex: 2 }) })
  expect(onSelect).toHaveBeenCalledWith('upper')
})
