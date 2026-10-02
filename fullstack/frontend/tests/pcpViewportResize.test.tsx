import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { afterEach, expect, it, vi } from 'vitest'
import { store } from '../src/app/store'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import PcpPage from '../src/features/pcp/PcpPage'
import { renderPcp } from '../src/engine/pcpRenderer'
import { downloadBlob } from '../src/features/charts/chartExport'

const fixture = vi.hoisted(() => ({
  axes: Array.from({ length: 10 }, (_, index) => ({ key: `A${index}`, label: `A${index}`, type: 'numeric', min: 0, max: 10 })),
  columns: Array.from({ length: 10 }, (_, index) => ({ columnId: `A${index}`, name: `A${index}`, label: `A${index}`, type: 'numeric' })),
  data: { rowIds: ['r1'], rowIndex: new Map([['r1', 0]]), columns: {}, schema: [] },
  rows: [0], geometry: null as any, dimensions: [] as Array<{ width: number; height: number }>,
}))
vi.mock('../src/features/pcp/usePcpPipeline', () => ({
  buildAxes: () => fixture.axes, useActiveRows: () => fixture.rows,
  usePcpGeometry: (dimensions: { width: number; height: number }) => {
    fixture.dimensions.push({ width: dimensions.width, height: dimensions.height })
    return fixture.geometry
  }, usePcpSimplification: () => null,
}))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => fixture.data }))
vi.mock('../src/features/dataset/useCodebookColumn', () => ({
  useCodebook: () => ({ columns: fixture.columns, formatValueLabel: String,
    getColumn: (name: string) => fixture.columns.find(column => column.name === name) }),
}))
vi.mock('../src/theme/useL1ColorDomain', () => ({ useDatasetL1ColorDomains: () => [], l1Index: () => 0 }))
vi.mock('../src/api/client', () => ({ api: { get: async () => ({ entries: [] }) } }))
vi.mock('../src/engine/graphClient', () => ({ graphEngine: { kind: 'wasm' } }))
vi.mock('../src/engine/pcpRenderer', () => ({ renderPcp: vi.fn() }))
vi.mock('../src/features/charts/chartExport', () => ({ downloadBlob: vi.fn() }))
vi.mock('../src/features/common/ColumnQuestionTooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  ColumnQuestionText: ({ nameOrId }: { nameOrId: string }) => nameOrId,
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup(orientation: 'horizontal' | 'vertical' = 'horizontal') {
  fixture.dimensions = []
  fixture.geometry = null
  let width = 650.8, height = 450.8
  const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>()
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) { observers.set(this as unknown as ResizeObserver, { callback, targets: new Set() }) }
    observe = (target: Element) => { observers.get(this as unknown as ResizeObserver)!.targets.add(target) }
    unobserve = (target: Element) => { observers.get(this as unknown as ResizeObserver)!.targets.delete(target) }
    disconnect = () => { observers.delete(this as unknown as ResizeObserver) }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => Math.round(width))
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => Math.round(height))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'resize', dataRevision: 0 },
    codebook: { ...base.codebook, columns: fixture.columns },
    pcp: { ...base.pcp, order: fixture.axes.map(a => a.key), visibleColumns: fixture.axes.map(a => a.key), orientation },
  }
  const local = configureStore({ reducer: () => state, middleware: getDefault => getDefault({ serializableCheck: false }) })
  const tree = () => <Provider store={local}><GraphExpansionProvider><PcpPage /></GraphExpansionProvider></Provider>
  const view = render(tree())
  const measure = (nextWidth = width, nextHeight = height) => {
    width = nextWidth; height = nextHeight
    act(() => {
      for (const [observer, { callback, targets }] of observers) {
        const entries = [...targets].filter(target => target.getAttribute('data-testid') === 'graph-viewport-pcp/main')
          .map(target => ({ target, contentRect: { width, height },
            borderBoxSize: [{ inlineSize: width + 15, blockSize: height + 15 }],
          } as unknown as ResizeObserverEntry))
        if (entries.length) callback(entries, observer)
      }
    })
  }
  return { view, tree, measure, local, state }
}

it.each(['horizontal', 'vertical'] as const)('uses GraphPanel as the only size source for %s PCP at fractional browser sizes', orientation => {
  const { view, measure } = setup(orientation)
  // Existing loading indicators stay centered in the visible viewport.
  expect(view.getByTestId('plot-canvas-area').style[orientation === 'horizontal' ? 'width' : 'height']).toBe('100%')
  for (const [width, height] of [[650.8, 450.8], [430.6, 350.6], [1180.9, 650.9], [420.1, 330.1]]) {
    measure(width, height)
    measure() // RO repeats must not let rounded client dimensions overwrite the logical viewport.
    expect(fixture.dimensions.at(-1)).toEqual({
      width: orientation === 'horizontal' ? Math.max(Math.floor(width), 900) : Math.floor(width),
      height: orientation === 'vertical' ? Math.max(Math.floor(height), 480) : Math.floor(height),
    })
    expect(view.getByTestId('graph-surface-pcp/main').style.height).toBe(`${Math.floor(height)}px`)
  }
  fireEvent.click(view.getByTestId('graph-expand-pcp/main'))
  measure(1132.796875, 598.59375)
  measure()
  expect(fixture.dimensions.at(-1)).toEqual({ width: 1132, height: 598 })
})


function paintedGeometry() {
  return { nRows: 1, nAxes: 10, rowIds: ['r1'], points: new Float64Array(20),
    axisPos: Array.from({ length: 10 }, (_, i) => 40 + 80 * i),
    bounds: { left: 40, right: 860, top: 20, bottom: 350 } }
}

it('keeps local PCP output exportable when worker posting fails, and stops retrying until the dataset changes', async () => {
  const workers: any[] = []
  class FailedWorker {
    postMessage = vi.fn(() => { throw new DOMException('not cloneable', 'DataCloneError') })
    terminate = vi.fn()
    constructor() { workers.push(this) }
  }
  vi.stubGlobal('Worker', FailedWorker)
  vi.stubGlobal('OffscreenCanvas', class {})
  const { view, tree, measure } = setup()
  fixture.geometry = paintedGeometry()
  await act(async () => view.rerender(tree()))
  await waitFor(() => expect(view.getByTestId('pcp-export-svg')).toBeEnabled())
  fireEvent.click(view.getByTestId('pcp-export-svg'))
  await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'PCP.svg'))
  for (let i = 0; i < 5; i++) await act(async () => measure(500 + i, 400 + i))
  expect(vi.mocked(renderPcp)).toHaveBeenCalled()
  expect(workers).toHaveLength(1)
  expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
  expect(workers[0].terminate).toHaveBeenCalledTimes(1)
})

it.each(['unmount', 'dataset'] as const)('disposes an in-flight page painter on %s and closes stale frames without making them exportable', async change => {
  const workers: any[] = []
  class PendingWorker {
    onmessage: ((event: any) => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { workers.push(this) }
  }
  vi.stubGlobal('Worker', PendingWorker)
  vi.stubGlobal('OffscreenCanvas', class {})
  const { view, tree, local, state } = setup()
  fixture.geometry = paintedGeometry()
  await act(async () => view.rerender(tree()))
  expect(workers).toHaveLength(1)
  const first = workers[0]
  if (change === 'unmount') view.unmount()
  else {
    await act(async () => {
      local.replaceReducer(() => ({ ...state, selection: { ...state.selection, datasetId: 'replacement' } }))
    })
    expect(view.getByTestId('pcp-export-svg')).toBeDisabled()
  }
  expect(first.terminate).toHaveBeenCalledTimes(1)
  const frame = { close: vi.fn() }
  await act(async () => first.onmessage?.({ data: { id: first.postMessage.mock.calls[0][0].id, ok: true, frame } }))
  expect(frame.close).toHaveBeenCalledTimes(1)
  if (change === 'dataset') expect(view.getByTestId('pcp-export-svg')).toBeDisabled()
})
