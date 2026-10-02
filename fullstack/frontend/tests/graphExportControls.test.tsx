import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AsyncExportButton from '../src/features/common/AsyncExportButton'
import GraphExportControl from '../src/features/charts/GraphExportControl'
import { downloadPng, svgDimensions } from '../src/features/charts/chartExport'
import { downloadPng as caPng } from '../src/features/models/caExport'
import { downloadPng as mcaPng } from '../src/features/models/mcaApi'
import { downloadPng as lrPng } from '../src/features/models/lrApi'
import { downloadPng as cjPng } from '../src/features/models/conjointApi'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const svg = (attributes: string) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><circle cx="20" cy="20" r="10"/></svg>`, 'image/svg+xml').documentElement as unknown as SVGSVGElement

it.each([
  ['width="560" height="420"', 560, 420],
  ['width="1200px" height="300px"', 1200, 300],
  ['viewBox="0 0 200 800" width="100%" height="100%"', 200, 800],
  ['viewBox="0 0 400 300" width="800"', 800, 600],
  ['viewBox="0 0 400 300" height="600"', 800, 600],
  ['width="1in" height="72pt"', 96, 96],
])('uses intrinsic SVG dimensions for %s', (attributes, width, height) => {
  expect(svgDimensions(svg(attributes as string))).toEqual({ width, height })
})
it('rejects invalid dimensions instead of silently stretching to a fixed canvas', () => {
  expect(() => svgDimensions(svg('width="100%" height="auto"'))).toThrow('幅・高さ')
})
it('shares exactly one PNG implementation across all previous entry points', () => {
  expect([caPng, mcaPng, lrPng, cjPng].every(fn => fn === downloadPng)).toBe(true)
})

function mockRaster(failure?: 'image' | 'context' | 'blob' | 'draw') {
  const create = vi.fn(() => 'blob:export'), revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  vi.stubGlobal('Image', class {
    onload?: () => void
    onerror?: () => void
    set src(_value: string) { queueMicrotask(() => failure === 'image' ? this.onerror?.() : this.onload?.()) }
  })
  const drawImage = vi.fn(() => { if (failure === 'draw') throw new Error('cannot draw') })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => failure === 'context' ? null : ({ fillRect: vi.fn(), drawImage } as any))
  const dimensions: number[][] = []
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) {
    dimensions.push([this.width, this.height]); callback(failure === 'blob' ? null : new Blob(['PNG'], { type: 'image/png' }))
  })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { create, revoke, drawImage, dimensions, click }
}
it.each([[560, 420], [1200, 300], [200, 800]])('keeps %s × %s shape at 2x PNG resolution', async (width, height) => {
  const mocks = mockRaster()
  await downloadPng(svg(`width="${width}" height="${height}"`), 'plot.png')
  expect(mocks.dimensions).toEqual([[width * 2, height * 2]])
  expect(mocks.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, width * 2, height * 2)
  expect(mocks.click).toHaveBeenCalledTimes(1)
  expect(mocks.create).toHaveBeenCalledTimes(2)
  expect(mocks.revoke).toHaveBeenCalledTimes(1)
})
it.each(['image', 'context', 'blob', 'draw'] as const)('rejects %s failure and releases its source URL', async failure => {
  const mocks = mockRaster(failure)
  await expect(downloadPng(svg('viewBox="0 0 560 420"'), 'plot.png')).rejects.toThrow()
  expect(mocks.click).not.toHaveBeenCalled()
  expect(mocks.revoke).toHaveBeenCalledTimes(1)
})

it('announces progress, prevents double activation and reports successful download start', async () => {
  let resolve!: () => void
  const run = vi.fn(() => new Promise<void>(done => { resolve = done }))
  const view = render(<AsyncExportButton onExport={run} statusLabel="固有値CSV">固有値CSV</AsyncExportButton>)
  const button = view.getByRole('button', { name: '固有値CSV' })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(run).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('aria-busy', 'true')
  expect(view.getByRole('status')).toHaveTextContent('準備中')
  await act(async () => resolve())
  expect(button).toBeEnabled()
  expect(view.getByRole('status')).toHaveTextContent('ダウンロードを開始')
})
it('catches rejected API objects and permits retry without an unhandled rejection', async () => {
  const run = vi.fn().mockRejectedValueOnce({ message: 'network unavailable' }).mockResolvedValueOnce(undefined)
  const view = render(<AsyncExportButton onExport={run} statusLabel="設定JSON">設定JSON</AsyncExportButton>)
  const button = view.getByRole('button', { name: '設定JSON' })
  fireEvent.click(button)
  expect(await view.findByRole('alert')).toHaveTextContent('設定JSONを保存できませんでした: network unavailable')
  fireEvent.click(button)
  await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('ダウンロードを開始'))
  expect(view.queryByRole('alert')).toBeNull()
  expect(run).toHaveBeenCalledTimes(2)
})
it('ignores a late completion after the result key changes', async () => {
  let reject!: (error: Error) => void
  const old = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const current = vi.fn().mockResolvedValue(undefined)
  const view = render(<AsyncExportButton exportKey="old" onExport={old}>CSV</AsyncExportButton>)
  fireEvent.click(view.getByRole('button'))
  view.rerender(<AsyncExportButton exportKey="new" onExport={current}>CSV</AsyncExportButton>)
  await act(async () => reject(new Error('old error')))
  expect(view.queryByRole('alert')).toBeNull()
  expect(view.getByRole('button')).toBeEnabled()
  fireEvent.click(view.getByRole('button'))
  await waitFor(() => expect(current).toHaveBeenCalledTimes(1))
})
it('uses the same small, named, keyboard-safe graph control for SVG/PNG', async () => {
  const pointer = vi.fn(), key = vi.fn(), save = vi.fn()
  const view = render(<div onPointerDown={pointer} onPointerUp={pointer} onKeyDown={key}>
    <GraphExportControl graphLabel="PCP" onExport={save} />
    <GraphExportControl graphLabel="MCA" target="カテゴリ図" format="png" onExport={save} />
  </div>)
  const button = view.getByRole('button', { name: 'PCP：SVGを保存' })
  expect(button).toHaveClass('ant-btn-sm')
  expect(view.getByRole('button', { name: 'MCA：カテゴリ図 PNGを保存' })).toHaveClass('ant-btn-sm')
  fireEvent.pointerDown(button); fireEvent.pointerUp(button); fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.click(button)
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(pointer).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled()
})
