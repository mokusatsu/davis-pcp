import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { afterEach, expect, it, vi } from 'vitest'
import { store } from '../src/app/store'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import PcpPage from '../src/features/pcp/PcpPage'

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
  return { view, tree, measure }
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
