import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConfigProvider } from 'antd'
import { getInstanceByDom } from 'echarts'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import * as apiModule from '../src/api/client'
import type { CodebookColumn, CodebookResponse } from '../src/api/client'
import {
  activeEntitiesSet, datasetLoaded, focusSelected, observationScopeChanged, pcpStateChanged,
  selectionApplied, selectionCleared, store,
} from '../src/app/store'
import { graphEngine } from '../src/engine/graphClient'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import { codebookReceived } from '../src/features/dataset/codebookSlice'
import DistributionPage from '../src/features/distribution/DistributionPage'
import { invalidateColumnarCache, useColumnarData, type ColumnarData } from '../src/features/pcp/useDatasetColumns'
import fixture from './fixtures/boxplotEligibilityApiResponse.json'

// Real page, codebook hooks, raw columnar conversion, ECharts and LocalEngine.
// The transport is a replay of the independently captured API fixture. Synthetic
// component events below do not replace the separate real-pointer GUI gate.
beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    const surface = this.closest<HTMLElement>('[data-testid="distribution-svg"]')
    return Number.parseFloat(surface?.style.width ?? '') || 900
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    const surface = this.closest<HTMLElement>('[data-testid="distribution-svg"]')
    return Number.parseFloat(surface?.style.height ?? '') || 470
  })
})
afterEach(() => {
  cleanup()
  invalidateColumnarCache()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type Options = {
  values?: unknown[]
  spec?: Partial<CodebookColumn>
  groups?: (string | null)[]
  orientation?: 'horizontal' | 'vertical'
  selected?: string[]
  active?: string[]
  scope?: 'active' | 'selected' | 'all'
}

async function mount(options: Options = {}) {
  const values = options.values ?? fixture.arrow.x_missing
  const ids = options.values ? values.map((_, i) => `source-${i + 1}`) : fixture.arrow.__rowId__
  const raw: Record<string, unknown[]> = { __rowId__: [...ids], x_missing: [...values] }
  const column = { ...fixture.codebook.columns[0], ...(options.spec ?? {}) } as CodebookColumn
  const columns = [column]
  const schema = [...fixture.meta.schema]
  if (options.groups) {
    raw.group = [...options.groups]
    columns.push({ columnId: 'group', name: 'group', label: 'group', role: 'attribute', scaleType: 'nominal',
      categoryOrder: ['A', 'B'], missingCodes: [], valueLabels: {} } as CodebookColumn)
    schema.push({ ...fixture.meta.schema[0], columnId: 'group', name: 'group', semanticType: 'nominal' })
  }
  const before = structuredClone(raw)
  const datasetId = fixture.meta.datasetId
  store.dispatch(datasetLoaded({ datasetId, name: fixture.meta.name, rowIds: [...ids] }))
  store.dispatch(codebookReceived({ ...fixture.codebook, columns } as CodebookResponse))
  store.dispatch(activeEntitiesSet([{ kind: 'column', columnId: column.columnId }]))
  store.dispatch(pcpStateChanged({ colorBy: options.groups ? 'group' : null, brushOperation: 'replace' }))
  if (options.active) {
    store.dispatch(selectionApplied({ rowIds: options.active, operation: 'replace', label: 'test scope' }))
    store.dispatch(focusSelected())
    store.dispatch(selectionCleared())
  }
  if (options.selected) store.dispatch(selectionApplied({ rowIds: options.selected, operation: 'replace', label: 'test selection' }))
  store.dispatch(observationScopeChanged(options.scope ?? 'active'))
  const get = vi.spyOn(apiModule.api, 'get').mockResolvedValue({ ...fixture.meta, schema })
  const arrow = vi.spyOn(apiModule, 'fetchArrowView').mockResolvedValue(raw)
  vi.spyOn(apiModule.api, 'post').mockResolvedValue(fixture.summary)
  const box = vi.spyOn(graphEngine, 'boxStats')
  let observed: ColumnarData | null = null
  function RawProbe() { observed = useColumnarData(datasetId); return null }
  render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={store}><MemoryRouter>
    <GraphExpansionProvider><DistributionPage /><RawProbe /></GraphExpansionProvider>
  </MemoryRouter></Provider></ConfigProvider>)
  fireEvent.click(screen.getByText('箱ひげ図 (Box Plot)'))
  await screen.findByTestId('distribution-svg')
  if (options.orientation === 'vertical') fireEvent.click(screen.getByText('垂直配置 (変数列が横)'))
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  await waitFor(() => expect(observed).not.toBeNull())
  return { ids, raw, before, box, arrow, get, data: () => observed! }
}

function chart() {
  const surface = screen.getByTestId('distribution-svg')
  const element = surface.querySelector<HTMLElement>('[_echarts_instance_]')!
  const result = getInstanceByDom(element)
  expect(result).toBeDefined()
  return result!
}
function graphics() {
  const items: any[] = []
  const seen = new Set<string>()
  const walk = (list: any[]) => list.forEach(item => {
    if (!seen.has(item.id)) { items.push(item); seen.add(item.id) }
    if (item.elements) walk(item.elements)
    if (item.children) walk(item.children)
  })
  walk(chart().getOption().graphic as any[])
  return items
}
function marks() { return graphics().filter(item => item.type === 'circle' && item.info?.selectable && !item.silent) }
function titles() { return marks().map(item => item.info.title).sort() }
function visibleMark(title: string) { return graphics().find(item => item.type === 'circle' && item.silent && item.info?.title === title) }
function engineInputs(box: ReturnType<typeof vi.spyOn>) { return box.mock.calls.map(([values]) => Array.from(values as Float64Array)) }
function expectRawUnchanged(result: Awaited<ReturnType<typeof mount>>) {
  expect(result.raw).toEqual(result.before)
  expect(result.data().columns).toBe(result.raw)
  expect(result.data().rowIds).toEqual(result.ids)
  result.ids.forEach((id, index) => expect(result.data().rowIndex.get(id)).toBe(index))
  expect(Array.from(result.data().numeric.x_missing)).toEqual(result.before.x_missing.map(value => {
    const v = value == null ? NaN : Number(value)
    return Number.isFinite(v) ? v : NaN
  }))
}
function brush(from: [number, number], to: [number, number]) {
  const surface = screen.getByTestId('distribution-svg')
  expect(surface).toHaveStyle({ userSelect: 'none' })
  const svg = surface.querySelector('svg')!
  const width = Number(svg.dataset.logicalWidth), height = Number(svg.dataset.logicalHeight)
  const rect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) })
  surface.getBoundingClientRect = svg.getBoundingClientRect = rect
  fireEvent.pointerDown(surface, { clientX: from[0], clientY: from[1], button: 0 })
  fireEvent.pointerMove(surface, { clientX: to[0], clientY: to[1], button: 0 })
  const overlay = graphics().find(item => item.type === 'rect' && item.style?.fill === 'rgba(42,120,214,0.15)')
  expect(overlay).toBeDefined()
  expect(overlay.silent).toBe(true)
  expect(overlay.style.lineWidth).toBeGreaterThanOrEqual(1.5)
  fireEvent.pointerUp(surface, { clientX: to[0], clientY: to[1], button: 0 })
}

it.each(['horizontal', 'vertical'] as const)('FE-04 excludes saved API sentinel from engine and rendered geometry: %s', async orientation => {
  const result = await mount({ orientation })
  expect(engineInputs(result.box)).toEqual([[1, 2, 3, 4]])
  expect(await result.box.mock.results[0].value).toEqual([1, 1.75, 2.5, 3.25, 4])
  expect(fixture.summary.columns.x_missing.denominators.valid).toBe(4)
  expect(fixture.summary.columns.x_missing.median).toBe(2.5)
  expect(titles()).toEqual(['ROW-000001: 1.00', 'ROW-000002: 2.00', 'ROW-000003: 3.00', 'ROW-000004: 4.00'])
  const box = graphics().find(item => item.type === 'rect' && item.style?.opacity === 0.18)
  const median = graphics().find(item => item.type === 'line' && item.style?.lineWidth === 2)
  expect(box).toBeDefined()
  expect(median).toBeDefined()
  if (orientation === 'horizontal') {
    marks().map(mark => mark.shape.cx).sort((a, b) => a - b)
      .forEach((x, index) => expect(x).toBeCloseTo([120, 373.3333333333333, 626.6666666666666, 880][index], 10))
    expect(box.shape.x).toBe(310)
    expect(box.shape.width).toBe(380)
    expect(median.shape.x1).toBe(500)
  } else {
    expect(marks().map(mark => mark.shape.cy).sort((a, b) => a - b)).toEqual([46, 172, 298, 424])
    expect(box.shape.y).toBe(140.5)
    expect(box.shape.height).toBe(189)
    expect(median.shape.y1).toBe(235)
  }
  expectRawUnchanged(result)
})

it.each([
  { name: 'only missingCodes', values: [0, 1, 99], spec: { missingCodes: ['99'], missingReasons: {} }, expected: [0, 1] },
  { name: 'reason-only keys', values: [0, 1, 99], spec: { missingCodes: [], missingReasons: { '99': 'not_applicable' } }, expected: [0, 1, 99] },
  { name: 'declared not-applicable', values: [0, 1, 99], spec: { missingCodes: ['99'], missingReasons: { '99': 'not_applicable' } }, expected: [0, 1] },
  { name: 'closed raw domain', values: [0, 1, 2, 99], spec: { missingCodes: [], categoryOrder: ['0', '2'] }, expected: [0, 2] },
  { name: 'labels-only open domain', values: [0, 1, 99], spec: { missingCodes: [], valueLabels: { '1': 'one' } }, expected: [0, 1, 99] },
  { name: 'no eligibility metadata', values: [0, 1, 99], spec: { missingCodes: undefined, missingReasons: undefined, categoryOrder: undefined, valueLabels: undefined }, expected: [0, 1, 99] },
  { name: 'null and nonfinite preserve zero', values: [0, null, NaN, Infinity, -Infinity, 1], spec: { missingCodes: [] }, expected: [0, 1] },
  { name: 'numeric and exact string code identity', values: [0, 99, '99', '99.0', ' 99 '], spec: { missingCodes: ['99'] }, expected: [0, 99, 99] },
  { name: 'empty eligible set', values: [99, null], spec: { missingCodes: ['99'] }, expected: [] },
  { name: 'single eligible zero', values: [99, 0], spec: { missingCodes: ['99'] }, expected: [0] },
  { name: 'constant eligible set', values: [2, 99, 2], spec: { missingCodes: ['99'] }, expected: [2, 2] },
  { name: 'raw ordinal reversal retained', values: [10, 30, 99], spec: { missingCodes: ['99'], scaleType: 'ordinal', categoryOrder: ['30', '10'], isReversed: true }, expected: [10, 30] },
] as const)('keeps correct engine rows and raw source for $name', async ({ name, values, spec, expected }) => {
  const result = await mount({ values: [...values], spec: spec as Partial<CodebookColumn> })
  expect(engineInputs(result.box)).toEqual(expected.length ? [[...expected]] : [])
  expect(marks()).toHaveLength(expected.length)
  if (!expected.length) expect(graphics().filter(item => item.type === 'rect' && item.style?.opacity === 0.18)).toEqual([])
  if (name === 'numeric and exact string code identity') {
    expect(titles()).toEqual(['source-1: 0.00', 'source-4: 99.00', 'source-5: 99.00'])
  }
  if (expected.length === 1 || (expected.length > 1 && expected.every(v => v === expected[0]))) {
    expect(await result.box.mock.results[0].value).toEqual(Array(5).fill(expected[0]))
  }
  expectRawUnchanged(result)
})

it.each([
  ['horizontal', true], ['vertical', true], ['horizontal', false], ['vertical', false],
] as const)('brush shares eligible rows: %s, excluded interior values=%s', async (orientation, excludes) => {
  const result = await mount({ orientation, values: [0, 1, 2, 3, 4], spec: excludes
    ? { missingCodes: ['2'], categoryOrder: ['0', '2', '3', '4'] }
    : { missingCodes: [], categoryOrder: [] } })
  expect(engineInputs(result.box)).toEqual(excludes ? [[0, 3, 4]] : [[0, 1, 2, 3, 4]])
  brush(orientation === 'horizontal' ? [119, 65] : [121, 45], orientation === 'horizontal' ? [881, 190] : [681, 425])
  expect(store.getState().selection.selectedRowIds).toEqual(excludes ? ['source-1', 'source-4', 'source-5'] : result.ids)
  expectRawUnchanged(result)
})

it.each(['horizontal', 'vertical'] as const)('groups eligible rows with stable IDs and keeps group geometry: %s', async orientation => {
  const result = await mount({ orientation, values: [0, 2, 4, 6, 3, 5], groups: ['A', 'A', 'B', 'B', 'A', null],
    spec: { missingCodes: ['3'] } })
  expect(engineInputs(result.box)).toEqual([[0, 2], [4, 6], [5]])
  expect(titles()).toEqual(['source-1: 0.00', 'source-2: 2.00', 'source-3: 4.00', 'source-4: 6.00', 'source-6: 5.00'])
  // Start outside the marks' coarse-pointer hit regions so the mark-click guard
  // correctly yields to a range brush rather than treating this as a point click.
  brush(orientation === 'vertical' ? [133, 45] : [80, 30], orientation === 'vertical' ? [305, 425] : [881, 190])
  expect(store.getState().selection.selectedRowIds).toEqual(orientation === 'vertical'
    ? ['source-1', 'source-2'] : ['source-1', 'source-2', 'source-3', 'source-4', 'source-6'])
  expectRawUnchanged(result)
})

it('preserves active and selected scope membership and shared mark selection/hover', async () => {
  const result = await mount({ active: ['ROW-000004', 'ROW-000002', 'ROW-000005'], selected: ['ROW-000004'], scope: 'active' })
  expect(engineInputs(result.box)).toEqual([[2, 4]])
  expect(titles()).toEqual(['ROW-000002: 2.00', 'ROW-000004: 4.00'])
  const selectedFill = visibleMark('ROW-000004: 4.00').style.fill
  expect(visibleMark('ROW-000002: 2.00').style.opacity).toBe(0.28)
  const mark = marks().find(item => item.info.title === 'ROW-000002: 2.00')
  act(() => { mark.onmouseover({ event: new MouseEvent('mouseover') }) })
  expect(store.getState().selection.hoveredRowId).toBe('ROW-000002')
  act(() => { mark.onclick({ event: new MouseEvent('click') }) })
  expect(store.getState().selection.selectedRowIds).toEqual(['ROW-000004', 'ROW-000002'])
  act(() => { mark.onmouseout({ event: new MouseEvent('mouseout') }) })
  expect(store.getState().selection.hoveredRowId).toBeNull()
  expect(visibleMark('ROW-000002: 2.00').style.fill).toBe(selectedFill)
  expect(visibleMark('ROW-000002: 2.00').style.opacity).toBe(0.95)
  act(() => { store.dispatch(observationScopeChanged('selected')) })
  await waitFor(() => expect(engineInputs(result.box).at(-1)).toEqual([4, 2]))
  act(() => { store.dispatch(selectionApplied({ rowIds: ['ROW-000004', 'ROW-000005'], operation: 'replace', label: 'scope control' })) })
  await waitFor(() => expect(engineInputs(result.box).at(-1)).toEqual([4]))
  expect(titles()).toEqual(['ROW-000004: 4.00'])
  expectRawUnchanged(result)
})

it('reads updated eligibility metadata while retaining the same raw columnar source', async () => {
  const result = await mount()
  const original = result.data()
  const calls = result.arrow.mock.calls.length
  act(() => { store.dispatch(codebookReceived({ ...fixture.codebook, schemaRevision: 3,
    columns: [{ ...fixture.codebook.columns[0], missingCodes: ['3', '99'] }] } as CodebookResponse)) })
  await waitFor(() => expect(engineInputs(result.box).at(-1)).toEqual([1, 2, 4]))
  await waitFor(() => expect(titles()).toEqual(['ROW-000001: 1.00', 'ROW-000002: 2.00', 'ROW-000004: 4.00']))
  expect(result.data()).toBe(original)
  expect(result.arrow).toHaveBeenCalledTimes(calls)
  expectRawUnchanged(result)
})
