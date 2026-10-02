import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider, useSelector } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { message } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
import CorrespondenceAnalysisPage from '../src/features/models/CorrespondenceAnalysisPage'
import MultipleCorrespondencePage from '../src/features/models/MultipleCorrespondencePage'
import FamdPage from '../src/features/models/FamdPage'

// Keep the actual pages, store projections, fit APIs, lifecycle hook and Ant
// controls; these tests do not need chart rendering or the column-picker modal.
vi.mock('../src/features/dataset/useCodebookColumn', () => ({ useCodebook: () => useSelector((s: any) => s.codebook) }))
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (p: any) => <select aria-label={p.placeholder}
  multiple={p.mode === 'multiple'} value={p.value ?? (p.mode === 'multiple' ? [] : '')}
  onChange={e => p.onChange(p.mode === 'multiple' ? [...e.target.selectedOptions].map(o => o.value) : e.target.value)}>
  <option value="">選択</option>{p.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
</select> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => children }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ default: () => null, getBrushOp: () => 'replace' }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#123456' }) }))
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))
vi.mock('../src/features/models/caFigure', () => ({ default: ({ highlighted }: any) => <output data-testid="category-highlight">{[...highlighted].join(',')}</output> }))
vi.mock('../src/features/models/caTables', () => ({ EigenvalueTable: () => null, CategoryTable: () => null }))
vi.mock('../src/features/models/McaFigure', async importOriginal => ({
  ...await importOriginal<any>(), default: ({ highlighted, testId }: any) => <output data-testid={testId}>{[...highlighted].join(',')}</output>,
}))
vi.mock('../src/features/models/FamdFigure', async importOriginal => ({
  ...await importOriginal<any>(), default: ({ highlighted, testId }: any) => <output data-testid={testId}>{[...highlighted].join(',')}</output>, CorrelationCircle: () => null,
}))

function deferred<T = any>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fitResult(id: string): any {
  return { resultId: id, config: {}, capabilities: {},
    meta: { datasetId: 'd', dataRevision: 1, schemaRevision: 1, scopeCount: 2, fitCount: 2, warnings: [], exclusionCounts: {} },
    summary: { rank: 2, totalInertia: 1, eigenvalues: [0.7, 0.3], inertiaRatio: [0.7, 0.3], cumulativeInertiaRatio: [0.7, 1],
      rawInertiaRatio: [0.7, 0.3], nVariables: 2, nCategories: 2, nNumericVariables: 1, nCategoricalVariables: 1,
      pearson: { status: 'not_applicable' } },
    details: { rowCategories: [], columnCategories: [], table: [], mapScaling: 'symmetric', categories: [], variables: [],
      omittedCategories: [], maDiagnostics: [], categoricalVariables: [], numericVariables: [], variableRelation: [] },
  }
}
function localStore() {
  const base = store.getState()
  const columns = ['cat1', 'cat2', 'num'].map(name => ({ columnId: name, name, label: name, scaleType: name === 'num' ? 'ratio' : 'nominal', role: 'question', multiResponseGroup: null }))
  const state = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 1, allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'], selectedRowIds: [] as string[] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, columns },
    globalVariables: { ...base.globalVariables, activeEntities: null } }
  return configureStore({ reducer: (current = state, action: any) => action.type === 'test/selection'
    ? { ...current, selection: { ...current.selection, ...action.payload } } : current,
  middleware: get => get({ serializableCheck: false }) })
}
function choose(label: string, values: string[]) {
  const input = screen.getByLabelText(label) as HTMLSelectElement
  for (const option of input.options) option.selected = values.includes(option.value)
  fireEvent.change(input)
}
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
let visibility: DocumentVisibilityState
function tabVisible(visible: boolean) {
  act(() => { visibility = visible ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
}
const revisionCalls = () => vi.mocked(api.get).mock.calls.filter(([url]) => url.startsWith('/datasets/'))
const membershipCalls = () => vi.mocked(api.post).mock.calls.filter(([, body]) => (body as any)?.table === 'members')
beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(api, 'get').mockImplementation(async url => (url.startsWith('/datasets/')
    ? { dataRevision: 1, schemaRevision: 1 } : { total: 0, rows: [], nextOffset: null }) as any)
  vi.spyOn(api, 'post').mockImplementation(async (url, body: any) => (body?.table === 'members'
    ? { payload: JSON.stringify({ rows: [['a', 'r1'], ['b', 'r2']] }), nextOffset: null } : fitResult(url)) as any)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe.each([
  ['CA', CorrespondenceAnalysisPage, 'ca-run'],
  ['MCA', MultipleCorrespondencePage, 'mca-run'],
  ['FAMD', FamdPage, 'famd-run'],
] as const)('%s page background work', (name, Page, runButton) => {
  function mount() {
    const local = localStore()
    let active = true
    const element = () => <Provider store={local}><AnalysisViewActivityContext.Provider value={active}><Page /></AnalysisViewActivityContext.Provider></Provider>
    const view = render(element())
    if (name === 'CA') { choose('行変数', ['cat1']); choose('列変数', ['cat2']) }
    else { choose('nominal/ordinalを選択', name === 'MCA' ? ['cat1', 'cat2'] : ['cat1']); if (name === 'FAMD') choose('interval/ratioを選択', ['num']) }
    return { ...view, local, activity: (value: boolean) => { active = value; view.rerender(element()) },
      select: (selectedRowIds: string[]) => act(() => { local.dispatch({ type: 'test/selection', payload: { selectedRowIds } }) }) }
  }

  it('suspends a fitted hidden route/tab, coalesces selection, refreshes on re-entry, and preserves the fit', async () => {
    const view = mount()
    fireEvent.click(screen.getByTestId(runButton))
    await tick()
    expect(revisionCalls()).toHaveLength(1)
    view.activity(false)
    view.select(['r1']); view.select(['r1', 'r2']); view.select(['r2'])
    await tick(60000)
    expect(revisionCalls()).toHaveLength(1)
    expect(membershipCalls()).toHaveLength(0)
    expect(view.local.getState().selection.selectedRowIds).toEqual(['r2'])
    view.activity(true)
    await tick()
    expect(revisionCalls()).toHaveLength(2)
    expect(membershipCalls()).toHaveLength(1)
    if (name !== 'CA') fireEvent.click(screen.getByRole('tab', { name: /カテゴリ.*図/ }))
    expect(screen.getByTestId(name === 'CA' ? 'category-highlight' : `${name.toLowerCase()}-category-svg`)).toHaveTextContent('b')
    tabVisible(false)
    view.select(['r1'])
    await tick(60000)
    expect(revisionCalls()).toHaveLength(2)
    expect(membershipCalls()).toHaveLength(1)
    tabVisible(true)
    await tick()
    expect(revisionCalls()).toHaveLength(3)
    expect(membershipCalls()).toHaveLength(2)
    expect(screen.getByTestId(name === 'CA' ? 'category-highlight' : `${name.toLowerCase()}-category-svg`)).toHaveTextContent('a')
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url.startsWith('/models/'))).toHaveLength(1)
  })

  it('does not cancel a user-requested fit when hidden; background polling starts only after re-entry', async () => {
    const pendingFit = deferred()
    vi.mocked(api.post).mockReturnValueOnce(pendingFit.promise)
    const view = mount()
    fireEvent.click(screen.getByTestId(runButton))
    view.activity(false)
    await act(async () => { pendingFit.resolve(fitResult('completed-while-hidden')) })
    await tick(60000)
    expect(revisionCalls()).toHaveLength(0)
    expect(screen.getByText(/この結果の対象:/)).toBeInTheDocument()
    view.activity(true)
    await tick()
    expect(revisionCalls()).toHaveLength(1)
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url.startsWith('/models/'))).toHaveLength(1)
  })

  it('does not poll more than once while pending and ignores the response after dataset reset/unmount', async () => {
    const pendingRevision = deferred()
    vi.mocked(api.get).mockImplementation(url => (url.startsWith('/datasets/') ? pendingRevision.promise
      : Promise.resolve({ rows: [], nextOffset: null })) as any)
    const view = mount()
    fireEvent.click(screen.getByTestId(runButton))
    await tick(60000)
    expect(revisionCalls()).toHaveLength(1)
    act(() => { view.local.dispatch({ type: 'test/selection', payload: { datasetId: 'next' } }) })
    await act(async () => { pendingRevision.resolve({ dataRevision: 99, schemaRevision: 99 }) })
    expect(screen.queryByText(/この結果の対象:/)).not.toBeInTheDocument()
    expect(screen.queryByText('stale（古い版）')).not.toBeInTheDocument()
    view.unmount()
    await tick(60000)
    expect(revisionCalls()).toHaveLength(1)
  })
})
