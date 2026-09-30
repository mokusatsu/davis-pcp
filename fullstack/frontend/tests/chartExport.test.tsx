import { cleanup, render } from '@testing-library/react'
import { getInstanceByDom, type ECharts } from 'echarts'
import { afterEach, expect, it, vi } from 'vitest'
import EChart from '../src/features/charts/EChart'
import { chartSvg, downloadBlob, downloadChartSvg } from '../src/features/charts/chartExport'
import { tourOption } from '../src/features/tgt/TgtCanvas'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml')
it('downloads a connected, same-origin SVG Blob without navigation and revokes it later', () => {
  vi.useFakeTimers()
  const create = vi.fn(() => 'blob:https://example.com/vector'), revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  const clicks: HTMLAnchorElement[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.isConnected).toBe(true)
    expect(this.target).toBe('')
    clicks.push(this)
  })
  const view = render(<EChart testId="export" ariaLabel="日本語の図" option={{ xAxis: {}, yAxis: {}, series: [{ type: 'scatter', data: [[1, 2]] }] }} />)
  downloadChartSvg(getInstanceByDom(view.getByTestId('export'))!, '日本語の図')
  expect(clicks[0].download).toBe('日本語の図.svg')
  expect(clicks[0].href).toBe('blob:https://example.com/vector')
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob)
  expect((create.mock.calls[0][0] as Blob).type).toBe('image/svg+xml;charset=utf-8')
  expect(clicks[0].isConnected).toBe(false)
  expect(revoke).not.toHaveBeenCalled()
  vi.advanceTimersByTime(30_000)
  expect(revoke).toHaveBeenCalledWith('blob:https://example.com/vector')
})
it('serializes a native SVG chart, excluding the toolbar and retaining Japanese labels', () => {
  const view = render(<EChart testId="export" option={{ xAxis: { type: 'category', data: ['質問一', '質問二'] }, yAxis: {}, series: [{ type: 'bar', data: [3, 5] }] }} />)
  const chart = getInstanceByDom(view.getByTestId('export'))!
  const svg = chartSvg(chart), doc = parse(svg)
  expect(doc.querySelector('parsererror')).toBeNull()
  expect(doc.documentElement.localName).toBe('svg')
  expect(svg).toContain('質問一')
  expect(svg).not.toContain('SVGを保存')
  expect(doc.querySelectorAll('path').length).toBeGreaterThan(2)
  expect(chart.isDisposed()).toBeFalsy()
})
it('exports the current Canvas tour frame and trails as real vectors without changing its option', () => {
  const option = tourOption([{ rowId: 'r1', x: 1, y: 2, color: '#ff0000', selected: true,
    trails: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }] }], 600, 400, '#1677ff')
  const original = JSON.stringify(option)
  const source = { isDisposed: () => false, getZr: () => ({ painter: { getType: () => 'canvas' } }),
    getOption: vi.fn(() => option), getWidth: () => 600, getHeight: () => 400 } as unknown as ECharts
  const svg = chartSvg(source), doc = parse(svg)
  expect(doc.querySelector('parsererror')).toBeNull()
  expect(doc.documentElement.getAttribute('width')).toBe('600')
  expect(doc.documentElement.getAttribute('height')).toBe('400')
  expect(doc.querySelector('image')).toBeNull()
  expect(svg).not.toContain('data:image/png')
  expect(svg).toContain('#1677ff')
  expect(svg).toContain('#141414')
  expect(doc.querySelectorAll('path').length).toBeGreaterThan(4)
  expect(JSON.stringify(option)).toBe(original)
})
it('cleans up the anchor and eventually releases its Blob even if clicking fails', () => {
  vi.useFakeTimers()
  const revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:failed', revokeObjectURL: revoke })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked') })
  expect(() => downloadBlob(new Blob(['test']), 'test.svg')).toThrow('blocked')
  expect(document.querySelector('a')).toBeNull()
  vi.runAllTimers()
  expect(revoke).toHaveBeenCalledWith('blob:failed')
})
