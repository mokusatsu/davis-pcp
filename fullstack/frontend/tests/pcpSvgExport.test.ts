import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import PcpPage from '../src/features/pcp/PcpPage'
import { buildPcpLabelLayout } from '../src/engine/pcpLabelLayout'
import { pcpSvg } from '../src/engine/pcpSvgExport'
import { rowColor, type PcpRenderSpec } from '../src/engine/pcpRenderer'
import { vizTheme } from '../src/theme/viz'

const fixture = vi.hoisted(() => ({
  axes: ['A', 'B', 'C'].map(key => ({ key, label: key, type: 'numeric', min: 0, max: 10 })),
  columns: ['A', 'B', 'C'].map(name => ({ columnId: name, name, label: name, type: 'numeric' })),
  data: { rowIds: ['r1'], rowIndex: new Map([['r1', 0]]), columns: { A: [1], B: [2], C: [3] }, schema: [] },
  rows: [0], geometry: null as any,
}))
vi.mock('../src/features/pcp/usePcpPipeline', () => ({
  buildAxes: () => fixture.axes, useActiveRows: () => fixture.rows,
  usePcpGeometry: () => fixture.geometry, usePcpSimplification: () => null,
}))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => fixture.data }))
vi.mock('../src/features/dataset/useCodebookColumn', () => ({
  useCodebook: () => ({ columns: fixture.columns, formatValueLabel: String,
    getColumn: (name: string) => fixture.columns.find(column => column.name === name) }),
}))
vi.mock('../src/theme/useL1ColorDomain', () => ({ useDatasetL1ColorDomains: () => [], l1Index: () => 0 }))
vi.mock('../src/api/client', () => ({ api: { get: async () => ({ entries: [] }) } }))
vi.mock('../src/engine/graphClient', () => ({ graphEngine: { kind: 'wasm' } }))
vi.mock('../src/features/common/ColumnQuestionTooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  ColumnQuestionText: ({ nameOrId }: { nameOrId: string }) => nameOrId,
}))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function spec(overrides: Partial<PcpRenderSpec> = {}): PcpRenderSpec {
  return {
    width: 360, height: 240, dpr: 2, orientation: 'horizontal',
    points: new Float64Array([40, 140, 180, 60, 320, 100,
      40, 100, 180, 140, 320, 40, 40, 40, 180, 100, 320, 140]),
    nRows: 3, nAxes: 3, axisPos: [40, 180, 320],
    bounds: { left: 40, right: 320, top: 40, bottom: 180 },
    axes: ['A', 'B', 'C'].map(key => ({ key, label: key, isCategorical: false, min: 0, max: 10 })),
    reversed: {}, style: { showContext: true, lineOpacity: 0.22, lineWidth: 1, selectedLineWidthBoost: 1.3 },
    rowColorSlots: new Uint16Array([0, 0xffff, 0x8101]),
    categoricalPalette: ['#eb6834', '#1baf7a'], selectedFlags: new Uint8Array([0, 1, 0]),
    hoveredRow: -1, maxContextRows: 4000, clusterSizes: null, viewportX: 0,
    ...overrides,
  }
}

function parse(renderSpec: PcpRenderSpec): SVGSVGElement {
  const svg = pcpSvg(renderSpec)
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(document.querySelector('parsererror')).toBeNull()
  expect(svg).not.toMatch(/(?:NaN|Infinity|<image|data:image|<canvas)/)
  return document.documentElement as unknown as SVGSVGElement
}

const paths = (svg: SVGSVGElement) => [...svg.querySelectorAll('path')]
const theme = vizTheme(false)

describe('native PCP vector export', () => {
  it('exports horizontal paths and unrotated axis labels with the same L1/L2 colors', () => {
    const input = spec()
    const svg = parse(input)
    expect(svg.getAttribute('width')).toBe('360')
    expect(svg.getAttribute('height')).toBe('240')
    expect(svg.getAttribute('viewBox')).toBe('0 0 360 240')
    const context = paths(svg).filter(path => path.getAttribute('opacity') === '0.22')
    expect(context.map(path => path.getAttribute('d'))).toEqual([
      'M40 140 L180 60 L320 100', 'M40 40 L180 100 L320 140',
    ])
    expect(context.map(path => path.getAttribute('stroke'))).toEqual([rowColor(input, 0), rowColor(input, 2)])
    expect(context.every(path => path.getAttribute('stroke-linecap') === 'round')).toBe(true)
    const axisLabel = [...svg.querySelectorAll('text')].find(text => text.textContent === 'A')!
    expect(axisLabel.getAttribute('transform')).toBe('matrix(1 0 0 1 0 0)')
    expect(axisLabel.getAttribute('style')).toContain('700 11px system-ui, sans-serif')
    expect(axisLabel.getAttribute('text-anchor')).toBe('middle')
    expect(axisLabel.getAttribute('opacity')).toBe('1')
  })

  it('preserves selected-line halos and hover highlighting in paint order', () => {
    const svg = parse(spec({ hoveredRow: 1 }))
    const selected = paths(svg).filter(path => path.getAttribute('d') === 'M40 100 L180 140 L320 40')
    expect(selected.map(path => [path.getAttribute('stroke'), path.getAttribute('stroke-width'), path.getAttribute('opacity')]))
      .toEqual([[theme.surface, '4.8', '0.88'], [theme.selection, '2.3', '0.96'],
        [theme.surface, '7', '1'], [theme.selection, '4', '1']])
    // Context opacity and the hover's temporary width must not leak to axes.
    const axis = paths(svg).find(path => path.getAttribute('d') === 'M40 40 L40 180')!
    expect(axis.getAttribute('stroke-width')).toBe('1')
    expect(axis.getAttribute('opacity')).toBe('1')
  })

  it('keeps missing values as gaps instead of joining across them', () => {
    const input = spec({ nRows: 1, nAxes: 5, axisPos: [40, 110, 180, 250, 320],
      points: new Float64Array([40, 140, 110, 100, NaN, NaN, 250, 100, 320, 60]),
      axes: ['A', 'B', 'C', 'D', 'E'].map(key => ({ key, label: key, isCategorical: false, min: 0, max: 10 })),
      selectedFlags: new Uint8Array(1), rowColorSlots: new Uint16Array([0]),
    })
    const context = paths(parse(input)).find(path => path.getAttribute('opacity') === '0.22')!
    expect(context.getAttribute('d')).toBe('M40 140 L110 100 M250 100 L320 60')
  })

  it('records imputation dashes and diamonds without leaking dashes to axes', () => {
    const svg = parse(spec({ imputedAxes: new Map([[0, new Set([1])]]) }))
    const dashed = [...svg.querySelectorAll('path[stroke-dasharray]')]
    expect(dashed.map(path => path.getAttribute('d'))).toEqual(['M40 140 L180 60', 'M180 60 L320 100'])
    expect(dashed.every(path => path.getAttribute('stroke-dasharray') === '4 3'
      && path.getAttribute('stroke') === '#7c3aed')).toBe(true)
    const diamond = svg.querySelector('path[fill="#7c3aed"]')!
    expect(diamond.getAttribute('d')).toBe('M180 56 L184 60 L180 64 L176 60 Z')
    expect(diamond.getAttribute('opacity')).toBe('1')
    expect(svg.querySelector(`path[stroke="${theme.axis}"][stroke-dasharray]`)).toBeNull()
  })

  it('exports a clipped, scrolled viewport independently of display scale and DPR', () => {
    const input = spec({ viewportX: 80, viewportY: 12, dpr: 3 })
    const svg = parse(input)
    expect(pcpSvg(input)).toBe(pcpSvg({ ...input, dpr: 1 }))
    expect(svg.querySelector('g')?.getAttribute('clip-path')).toBe('url(#pcp-viewport)')
    expect(svg.querySelector('clipPath rect')?.getAttribute('width')).toBe('360')
    expect(svg.querySelector('clipPath rect')?.getAttribute('height')).toBe('240')
    expect(paths(svg)[0].getAttribute('transform')).toBe('matrix(1 0 0 1 -80 -12)')
    const background = svg.querySelector('g > rect')!
    expect(background.getAttribute('transform')).toBe('matrix(1 0 0 1 0 0)')
    expect(background.getAttribute('width')).toBe('360')
    expect(background.getAttribute('fill')).toBe(theme.surface)
  })

  it('exports vertical orientation, reversed ticks, and vertical scrolling', () => {
    const input = spec({ orientation: 'vertical', viewportY: 35, nRows: 1,
      points: new Float64Array([80, 40, 240, 110, 160, 180]), axisPos: [40, 110, 180],
      selectedFlags: new Uint8Array(1), rowColorSlots: new Uint16Array([0]), reversed: { A: true },
    })
    const svg = parse(input)
    const context = paths(svg).find(path => path.getAttribute('opacity') === '0.22')!
    expect(context.getAttribute('d')).toBe('M80 40 L240 110 L160 180')
    expect(context.getAttribute('transform')).toBe('matrix(1 0 0 1 0 -35)')
    expect(paths(svg).some(path => path.getAttribute('d') === 'M40 40 L320 40')).toBe(true)
    const texts = [...svg.querySelectorAll('text')]
    const firstTick = texts.find(text => text.textContent === '0.0')!
    const layout = buildPcpLabelLayout(input)
    const tickLayout = layout.ticks[0]
    expect(Number(firstTick.getAttribute('x'))).toBe(tickLayout.x + tickLayout.width / 2)
    expect(Number(firstTick.getAttribute('y'))).toBe(tickLayout.y)
    expect(firstTick.getAttribute('text-anchor')).toBe('middle')
    expect(firstTick.getAttribute('dominant-baseline')).toBe('text-before-edge')
    const label = texts.find(text => text.textContent === 'A')!
    expect(Number(label.getAttribute('x'))).toBe(layout.axes[0].x + layout.axes[0].width)
    expect(Number(label.getAttribute('y'))).toBe(layout.axes[0].y)
    expect(label.getAttribute('transform')).toBe('matrix(1 0 0 1 0 -35)')
  })

  it('escapes labels as XML text and retains categorical value labels', () => {
    const input = spec()
    input.axes[0] = { key: 'A', label: 'A<&"\'', isCategorical: true,
      min: 0, max: 1, categories: ['0', '1'], valueLabels: { '0': '<svg/>', '1': '&"\'>' } }
    const serialized = pcpSvg(input)
    expect(serialized).toContain('A&lt;&amp;&quot;&apos;')
    const svg = parse(input)
    expect(svg.querySelectorAll('svg')).toHaveLength(0)
    const texts = [...svg.querySelectorAll('text')].map(text => text.textContent)
    expect(texts).toContain('A<&"\'')
    expect(texts.join('')).toContain('<svg/>')
    expect(texts.join('')).toContain('&"\'>')
  })

  it('retains the current deterministic subset, selected rows and cluster widths', () => {
    const input = spec({ maxContextRows: 1, clusterSizes: new Uint32Array([9, 1, 1]) })
    const svg = parse(input)
    const context = paths(svg).filter(path => path.getAttribute('opacity') === '0.22')
    expect(context).toHaveLength(1)
    expect(context[0].getAttribute('d')).toBe('M40 140 L180 60 L320 100')
    expect(context[0].getAttribute('stroke-width')).toBe('5')
    expect(svg.querySelector(`path[stroke="${theme.selection}"]`)).not.toBeNull()
    const hidden = parse({ ...input, style: { ...input.style, showContext: false } })
    expect(paths(hidden).some(path => path.getAttribute('opacity') === '0.22')).toBe(false)
    expect(hidden.querySelector(`path[stroke="${theme.selection}"]`)).not.toBeNull()
  })

  it('does not mutate the painted spec and rejects invalid viewport dimensions', () => {
    const input = spec()
    const before = { points: [...input.points], flags: [...input.selectedFlags], axes: structuredClone(input.axes) }
    pcpSvg(input)
    expect([...input.points]).toEqual(before.points)
    expect([...input.selectedFlags]).toEqual(before.flags)
    expect(input.axes).toEqual(before.axes)
    expect(input.dpr).toBe(2)
    expect(() => pcpSvg({ ...input, width: 0 })).toThrow('visible viewport')
    expect(() => pcpSvg({ ...input, height: Infinity })).toThrow('non-finite')
  })
})

function pageSetup() {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (target.getAttribute('data-testid') === 'graph-viewport-pcp/main')
        this.callback([{ target, contentRect: { width: 360, height: 240 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    disconnect() {} unobserve() {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240)
  const context = Object.fromEntries(['setTransform', 'clearRect', 'drawImage', 'save', 'restore',
    'translate', 'rotate', 'fillRect', 'setLineDash', 'beginPath', 'moveTo', 'lineTo', 'closePath',
    'stroke', 'fill', 'fillText'].map(name => [name, vi.fn()]))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'first', dataRevision: 0, selectedRowIds: ['r1'] },
    codebook: { ...base.codebook, columns: fixture.columns },
    pcp: { ...base.pcp, order: ['A', 'B', 'C'], visibleColumns: ['A', 'B', 'C'] },
  }
  const pageStore = configureStore({ reducer: (current = state, action) => action.type === 'test/switchDataset'
    ? { ...current, selection: { ...current.selection, datasetId: String(action.payload ?? 'second') } } : current,
    middleware: getDefault => getDefault({ serializableCheck: false }),
  })
  const tree = () => createElement(Provider, { store: pageStore, children:
    createElement(GraphExpansionProvider, { children: createElement(PcpPage) }) })
  const geometry = { ...spec(), rowIds: ['r1'], points: new Float64Array([40, 140, 180, 60, 320, 100]), nRows: 1 }
  return { context, pageStore, tree, geometry }
}

describe('PCP SVG control lifecycle', () => {
  it('downloads only a painted frame, follows expansion, and disables during dataset reset', async () => {
    const { pageStore, tree, geometry } = pageSetup()
    fixture.geometry = null
    const create = vi.fn(() => 'blob:pcp-svg')
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true)
      expect(this.download).toBe('PCP.svg')
    })
    const view = render(tree())
    const button = view.getByRole('button', { name: 'PCP：SVGを保存' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(click).not.toHaveBeenCalled()

    fixture.geometry = geometry
    view.rerender(tree())
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    fireEvent.click(button)
    expect(click).toHaveBeenCalledTimes(1) // Pending reactivation is suppressed.
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await waitFor(() => expect(button).toBeEnabled())
    expect(click).toHaveBeenCalledTimes(2)
    expect((create.mock.calls[0][0] as Blob).type).toBe('image/svg+xml;charset=utf-8')
    const downloaded = await new Promise<string>(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(create.mock.calls[0][0] as Blob)
    })
    expect(downloaded).toContain('viewBox="0 0 360 240"')
    expect(downloaded).toContain('M40 140 L180 60 L320 100')
    expect(downloaded).not.toContain('<image')
    expect(pageStore.getState().selection.selectedRowIds).toEqual(['r1'])
    const layout = buildPcpLabelLayout(geometry)
    for (const label of layout.axes) {
      const hit = view.getByTestId(`pcp-axis-label-${geometry.axes[label.axisIndex].key}`)
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(Number(hit.getAttribute(key))).toBe(label[key])
      expect(hit.getAttribute('transform')).toBeNull()
      expect(hit).toHaveAttribute('aria-label', geometry.axes[label.axisIndex].label)
    }

    fireEvent.click(view.getByTestId('graph-expand-pcp/main'))
    const dialog = await view.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'PCP：SVGを保存' })).toBe(button)
    fireEvent.click(button)
    expect(click).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(button).toBeEnabled())
    create.mockImplementationOnce(() => { throw new Error('download unavailable') })
    fireEvent.click(button)
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('download unavailable'))
    fireEvent.click(button)
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull())
    await waitFor(() => expect(button).toBeEnabled())
    expect(click).toHaveBeenCalledTimes(4)
    fireEvent.click(within(dialog).getByRole('button', { name: '拡大を戻す' }))
    expect(view.getByRole('button', { name: 'PCP：SVGを保存' })).toBe(button)

    fixture.geometry = null
    act(() => { pageStore.dispatch({ type: 'test/switchDataset' }) })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(click).toHaveBeenCalledTimes(4)
    fixture.geometry = geometry
    view.rerender(tree())
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(click).toHaveBeenCalledTimes(5)
  })

  it('discards both failed and successful late worker frames after dataset changes', async () => {
    const { pageStore, tree, geometry, context } = pageSetup()
    fixture.geometry = geometry
    let worker: any
    const requests: number[] = []
    vi.stubGlobal('OffscreenCanvas', class { constructor(readonly width: number, readonly height: number) {} })
    vi.stubGlobal('Worker', class {
      onmessage: ((event: unknown) => void) | null = null
      constructor() { worker = this }
      postMessage(message: { id: number }) { requests.push(message.id) }
    })
    const view = render(tree())
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    fixture.geometry = null
    act(() => { pageStore.dispatch({ type: 'test/switchDataset' }) })
    await act(async () => { worker.onmessage({ data: { id: requests[0], ok: false, error: 'old frame failed' } }) })
    expect(view.getByRole('button', { name: 'PCP：SVGを保存' })).toBeDisabled()
    expect(context.fillRect).not.toHaveBeenCalled()
    expect(context.drawImage).not.toHaveBeenCalled()

    fixture.geometry = geometry
    view.rerender(tree())
    await waitFor(() => expect(requests).toHaveLength(2))
    fixture.geometry = null
    act(() => { pageStore.dispatch({ type: 'test/switchDataset', payload: 'third' }) })
    await act(async () => { worker.onmessage({ data: { id: requests[1], ok: true } }) })
    expect(view.getByRole('button', { name: 'PCP：SVGを保存' })).toBeDisabled()
    expect(context.fillRect).not.toHaveBeenCalled()
    expect(context.drawImage).not.toHaveBeenCalled()
  })
})
