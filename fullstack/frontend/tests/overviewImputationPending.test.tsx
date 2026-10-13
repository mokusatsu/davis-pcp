import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, isInaccessible, render, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { Provider } from 'react-redux'
import { activeEntitiesSet, datasetLoaded, selectionApplied, selectionReducer, store, variablesInitialized, weightColumnSet, type RootState } from '../src/app/store'
import { api, type CodebookResponse } from '../src/api/client'
import { codebookReceived, codebookSlice } from '../src/features/dataset/codebookSlice'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import KeepAliveOutlet from '../src/app/KeepAliveOutlet'
import OverviewPage from '../src/features/dataset/OverviewPage'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Real Overview, ColumnTable, ImputationModal, ActiveModal, and reducers.
// Only unrelated dialogs/history, chart rendering, and transport are replaced.
vi.mock('../src/features/dataset/BinningModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/OneHotModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/AddVariableModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/features/charts/EChartSurface', () => ({ default: () => null }))
vi.mock('../src/features/charts/CategoryBars', () => ({ default: () => null }))

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0)) await dispose()
  vi.restoreAllMocks()
})

it('keeps direct Imputation Apply single-flight for dataset A after Overview deactivation and reopening', async () => {
  const base = store.getState()
  const book = { datasetId: 'a', schemaRevision: 1, multiResponseGroups: [], columns: [{
    columnId: 'x', name: 'x', label: 'x', role: 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null,
  }] }
  const initial = { ...base,
    selection: { ...base.selection, datasetId: 'a', revision: 1, dataRevision: 1,
      allRowIds: ['a-r1', 'a-r2'], activeRowIds: ['a-r1', 'a-r2'], activeRowIdSet: new Set(['a-r1', 'a-r2']), selectedRowIds: [] },
    codebook: { ...base.codebook, ...book, isLoading: false },
  } as RootState
  const local = configureStore({ reducer: (state = initial, action: any) => ({ ...state,
    selection: selectionReducer(state.selection, action), codebook: codebookSlice.reducer(state.codebook, action),
  }), middleware: defaults => defaults({ serializableCheck: false }) })
  const requests: { path: string; body: any; promise: Promise<any>; reject: (error: Error) => void }[] = []
  const unexpected: string[] = []
  let settledCount = 0
  // Toast rendering is unrelated to mutation admission; pending requests are
  // rejected only after the final oracle, during cleanup of this bounded proof.
  for (const kind of ['success', 'warning', 'error'] as const) {
    vi.spyOn(message, kind).mockImplementation(() => (() => {}) as any)
  }
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/datasets/a/codebook') return book as any
    if (path !== '/datasets/a') {
      unexpected.push(`GET ${path}`)
      throw new Error(`Unexpected GET ${path}`)
    }
    return { datasetId: 'a', name: 'Dataset A', format: 'csv', rowCount: 2, columnCount: 1,
      fingerprint: 'a-1', dataRevision: 1, schemaRevision: 1, rowIdentity: 'stable', createdAt: '2026-10-12T00:00:00Z',
      schema: [{ columnId: 'x', name: 'x', physicalType: 'Float64', semanticType: 'numeric',
        role: 'numeric_axis', missingCount: 1, uniqueCount: 1, min: 4, max: 4 }],
    } as any
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path, body: any) => {
    if (path === '/summaries') return { rowCount: 2, columns: { x: { count: 1, missing: 1,
      uniqueCount: 1, min: 4, max: 4, mean: 4 } } } as any
    if (path !== '/datasets/a/impute') {
      unexpected.push(`POST ${path}`)
      throw new Error(`Unexpected POST ${path}; this regression requires no preview`)
    }
    let reject!: (error: Error) => void
    const promise = new Promise<any>((_resolve, fail) => { reject = fail })
    requests.push({ path, body, promise, reject })
    try { return await promise } finally { settledCount++ }
  })
  disposals.push(async () => {
    await act(async () => {
      const settled = Promise.allSettled(requests.map(request => request.promise))
      requests.forEach(request => request.reject(new Error('test cleanup after admission oracle')))
      await settled
    })
  })
  const ui = (active: boolean) => <ConfigProvider theme={{ token: { motion: false } }}>
    <Provider store={local}><AnalysisViewActivityContext.Provider value={active}>
      <OverviewPage />
    </AnalysisViewActivityContext.Provider></Provider>
  </ConfigProvider>
  const view = render(ui(true))
  const open = async () => {
    fireEvent.click(await view.findByTestId('btn-impute-x'))
    const dialog = await view.findByRole('dialog')
    const mean = within(dialog).getByRole('radio', { name: 'Mean (平均値)', exact: true })
    fireEvent.click(mean)
    // A shared pending lock may disable the entire reopened form. When editable,
    // choosing Mean must work and supplies the same valid direct-Apply request.
    if (!(mean as HTMLInputElement).disabled) expect(mean).toBeChecked()
    return within(dialog).getByTestId('btn-execute-imputation')
  }
  const apply = await open()
  expect(apply).toBeEnabled()
  fireEvent.click(apply)
  fireEvent.click(apply)
  expect(requests, 'Repeated Apply within the same modal instance stays single-flight').toHaveLength(1)
  expect(apply).toBeDisabled()
  expect(requests[0].body).toEqual({ columns: ['x'], predictorColumns: undefined,
    strategy: 'mean', options: { seed: 42 }, inPlace: true, planHash: undefined })
  expect(post.mock.calls.filter(([path]) => path.endsWith('/impute/preview'))).toHaveLength(0)
  expect(settledCount).toBe(0)
  console.info('IMPUTATION_SAME_INSTANCE_GUARD', JSON.stringify({ admitted: requests.length,
    settled: settledCount, applyDisabled: (apply as HTMLButtonElement).disabled,
    previewRequests: 0, body: requests[0].body }))

  view.rerender(ui(false))
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
  expect(apply).not.toBeInTheDocument()
  view.rerender(ui(true))
  expect(view.queryByRole('dialog')).toBeNull()
  const reopened = await open()
  expect(reopened).not.toBe(apply)
  fireEvent.click(reopened)
  expect(unexpected).toEqual([])
  expect(post.mock.calls.filter(([path]) => path.endsWith('/impute/preview'))).toHaveLength(0)
  expect(settledCount).toBe(0)
  console.info('IMPUTATION_PENDING_ADMISSIONS', JSON.stringify({ settled: settledCount,
    previewRequests: 0, requests: requests.map(({ path, body }) => ({ path, body })) }))
  expect(requests, 'Navigation/reopen must not admit a second impute for A while the first is pending').toHaveLength(1)
})


it('discloses already rendered Distribution counts while in-place imputation refreshes the codebook', async () => {
  // This case exercises actual KeepAlive navigation, both pages, the mutation
  // event, real Redux reducers, and the asynchronous fetchCodebook thunk.
  // This is lifecycle-only coverage, not backend numerical validation. The
  // fixtures model Mean filling two ordinary missing x values with 4 while
  // preserving the declared (unobserved) -99 missing category and unit weights.
  const defer = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }
  const book: CodebookResponse = { datasetId: 'value-refresh', schemaRevision: 7,
    columns: [
      { columnId: 'x', name: 'x', label: 'Response', role: 'question', scaleType: 'ratio',
        valueLabels: { '4': 'Four', '-99': 'Missing code' }, categoryOrder: ['4'],
        missingCodes: ['-99'], missingReasons: { '-99': 'no_answer' }, isReversed: false, multiResponseGroup: null },
      { columnId: 'w', name: 'w', label: 'Survey weight', role: 'weight', scaleType: 'ratio',
        valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null },
    ], multiResponseGroups: [], weightConfig: { weightColumnId: 'w', weightType: 'survey' } }
  const schema = book.columns.map(column => ({ columnId: column.columnId, name: column.name,
    physicalType: 'Float64', semanticType: 'numeric', role: 'numeric_axis', missingCount: column.name === 'x' ? 2 : 0,
    uniqueCount: 1, min: column.name === 'w' ? 1 : 4, max: column.name === 'w' ? 1 : 4 }))
  const initialMeta = { datasetId: book.datasetId, name: 'Value refresh', format: 'csv',
    rowCount: 4, columnCount: 2, fingerprint: 'before', dataRevision: 11,
    schemaRevision: book.schemaRevision, rowIdentity: 'stable', createdAt: '2026-10-12T00:00:00Z', schema }
  const currentMeta = { ...initialMeta, fingerprint: 'after', dataRevision: 12,
    schema: schema.map(column => ({ ...column, missingCount: 0 })) }
  const oldSummary = { columns: { x: {
    denominators: { total: 4, target: 4, valid: 2, missing: 2, notApplicable: 0 },
    distribution: [
      { code: '4', label: 'Four', count: 2, percentageValid: 100, percentageTotal: 50 },
      { code: null, label: 'Missing value', count: 2, percentageValid: 0, percentageTotal: 50, isMissing: true, missingReason: 'no_answer' },
      { code: '-99', label: 'Missing code', count: 0, percentageValid: 0, percentageTotal: 0, isMissing: true, missingReason: 'no_answer' },
    ],
  } }, selectedCountByCode: { x: { '4': 1 } } }
  const currentSummary = { columns: { x: {
    denominators: { total: 4, target: 4, valid: 4, missing: 0, notApplicable: 0 },
    distribution: [
      { code: '4', label: 'Four', count: 4, percentageValid: 100, percentageTotal: 100 },
      { code: '-99', label: 'Missing code', count: 0, percentageValid: 0, percentageTotal: 0, isMissing: true, missingReason: 'no_answer' },
    ],
  } }, selectedCountByCode: { x: { '4': 1 } } }
  const mutation = defer<any>(), metadata = defer<any>(), codebook = defer<CodebookResponse>()
  const oldCards = defer<typeof oldSummary>(), currentCards = defer<typeof currentSummary>()
  const cardRequests: any[] = [], mutationBodies: any[] = [], unexpected: string[] = []
  let committed = false, metadataReadsAfterCommit = 0, codebookReads = 0
  for (const kind of ['success', 'warning', 'error'] as const) {
    vi.spyOn(message, kind).mockImplementation(() => (() => {}) as any)
  }
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === `/datasets/${book.datasetId}/codebook`) { codebookReads++; return codebook.promise as any }
    if (path === `/datasets/${book.datasetId}`) {
      if (committed) { metadataReadsAfterCommit++; return metadata.promise }
      return initialMeta as any
    }
    unexpected.push(`GET ${path}`)
    throw new Error(`Unexpected GET ${path}`)
  })
  vi.spyOn(api, 'post').mockImplementation(async (path, body: any) => {
    if (path === `/datasets/${book.datasetId}/impute`) { mutationBodies.push(body); return mutation.promise }
    if (path.endsWith('/color-domains')) return { domains: [] } as any
    if (path === '/summaries') {
      if (body.columns) {
        cardRequests.push(body)
        if (body.expectedDataRevision === 11) return oldCards.promise as any
        if (body.expectedDataRevision === 12) return currentCards.promise as any
        throw new Error(`Unexpected card revision ${body.expectedDataRevision}`)
      }
      return { rowCount: 4, columns: { x: { count: committed ? 4 : 2, missing: committed ? 0 : 2,
        uniqueCount: 1, min: 4, max: 4, mean: 4 },
        w: { count: 4, missing: 0, uniqueCount: 1, min: 1, max: 1, mean: 1 } } } as any
    }
    unexpected.push(`POST ${path}`)
    throw new Error(`Unexpected POST ${path}`)
  })

  // Ordinary dataset installation only. Every later revision/loading transition
  // below must come from the production mutation completion path.
  store.dispatch(datasetLoaded({ datasetId: book.datasetId, name: initialMeta.name,
    rowIds: ['r1', 'r2', 'r3', 'r4'], dataRevision: initialMeta.dataRevision }))
  store.dispatch(variablesInitialized({ datasetId: book.datasetId, variables: ['x', 'w'],
    meta: Object.fromEntries(book.columns.map(column => [column.name, { columnId: column.columnId,
      name: column.name, semanticType: 'numeric', physicalType: 'Float64', missingCount: 0, isTargetCandidate: false }])) }))
  store.dispatch(codebookReceived(book))
  store.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'x' }]))
  store.dispatch(weightColumnSet({ datasetId: book.datasetId, columnId: 'w' }))
  store.dispatch(selectionApplied({ rowIds: ['r2'], operation: 'replace', label: 'Existing selection' }))
  const before = store.getState()
  function Navigation() {
    const navigate = useNavigate()
    return <button onClick={() => navigate('/distribution')}>Open Distribution</button>
  }
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={store}>
    <MemoryRouter initialEntries={['/overview']}><Navigation /><KeepAliveOutlet /></MemoryRouter>
  </Provider></ConfigProvider>)
  fireEvent.click(await view.findByTestId('btn-impute-x'))
  const dialog = within(await view.findByRole('dialog'))
  fireEvent.click(dialog.getByRole('radio', { name: 'Mean (平均値)', exact: true }))
  fireEvent.click(dialog.getByTestId('btn-execute-imputation'))
  expect(mutationBodies).toEqual([{ columns: ['x'], predictorColumns: undefined,
    strategy: 'mean', options: { seed: 42 }, inPlace: true, planHash: undefined }])
  expect(codebookReads).toBe(0)
  fireEvent.click(view.getByRole('button', { name: 'Open Distribution' }))
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(cardRequests).toHaveLength(1))
  const overviewTab = view.container.querySelector('[data-tab-path="/overview"]')!
  const distributionTab = view.container.querySelector('[data-tab-path="/distribution"]')!
  expect(overviewTab).toHaveAttribute('data-tab-active', 'false')
  expect(overviewTab).not.toBeVisible()
  expect(distributionTab).toHaveAttribute('data-tab-active', 'true')
  const expectedRequest = { datasetId: book.datasetId, rowIds: before.selection.activeRowIds,
    selectedRowIds: ['r2'], columns: ['x'], expectedDataRevision: 11, expectedSchemaRevision: 7,
    weightColumn: 'w', weightMode: 'column' }
  expect(cardRequests[0]).toEqual(expectedRequest)
  expect(view.getByTestId('cards-loading')).toBeVisible()

  // The differential from the pending-old-response case: this response has
  // ALREADY rendered while revision 11 is current, before mutation completion.
  await act(async () => { oldCards.resolve(oldSummary); await oldCards.promise })
  const oldCard = within(await view.findByTestId('question-card-x'))
  expect(oldCard.getByTestId('denominators-bar')).toBeVisible()
  expect(oldCard.getByTestId('denominators-bar')).toHaveTextContent('有効: 2')
  expect(oldCard.getByTestId('denominators-bar')).toHaveTextContent('無回答: 2')
  expect(oldCard.getByTestId('category-x-4')).toHaveTextContent('100.0% (2)')
  expect(oldCard.getByTestId('category-x-4')).toHaveTextContent('1選択中')
  expect(view.queryByTestId('cards-loading')).toBeNull()
  expect(store.getState().selection.dataRevision).toBe(11)
  expect(codebookReads).toBe(0)

  await act(async () => { committed = true; mutation.resolve({ datasetId: book.datasetId, dataRevision: 12 }); await mutation.promise })
  await waitFor(() => expect(metadataReadsAfterCommit).toBe(1))
  expect(store.getState().selection.dataRevision).toBe(11)
  await act(async () => { metadata.resolve(currentMeta); await metadata.promise })
  await waitFor(() => expect(codebookReads).toBe(1))
  expect(store.getState().selection.dataRevision).toBe(12)
  expect(store.getState().codebook.isLoading).toBe(true)
  expect(store.getState().codebook.schemaRevision).toBe(7)
  expect(cardRequests).toHaveLength(1)

  // A live summary may hide old counts OR disclose loading/error/staleness.
  // Do not demand a particular component or apply saved-model snapshot rules.
  // Restrict the oracle to the ACTIVE Distribution pane: a hidden Overview
  // refresh notice cannot explain old counts to the person viewing this pane.
  const pane = within(distributionTab as HTMLElement)
  const isShown = (element: Element | null): element is HTMLElement =>
    !!element && !isInaccessible(element) && window.getComputedStyle(element).opacity !== '0'
  const heldDenominators = pane.queryByTestId('denominators-bar')
  const heldCategory = pane.queryByTestId('category-x-4')
  const oldCountsVisible = (isShown(heldDenominators) && /有効:\s*2/.test(heldDenominators.textContent ?? ''))
    || (isShown(heldCategory) && /100\.0%\s*\(2\)/.test(heldCategory.textContent ?? ''))
  const noticePattern = /loading|pending|refreshing|stale|out.?of.?date|previous (?:result|data)|(?:集計|読込|読み込|読み込み|更新|再取得|再計算).{0,12}(?:中|待|失敗|必要)|取得に失敗|旧(?:結果|データ|版)|古い|前回(?:の|実行|結果|集計)|最新.{0,10}(?:ない|ありません)/i
  const visibleNotices = pane.queryAllByText(noticePattern).filter(isShown).map(element => element.textContent)
  const pendingIndicators = Array.from(distributionTab.querySelectorAll(
    '[data-testid="cards-loading"], [role="progressbar"], [aria-busy="true"], .ant-spin-spinning',
  )).filter(isShown)
  const heldState = store.getState()
  expect(heldState.selection.allRowIds).toBe(before.selection.allRowIds)
  expect(heldState.selection.activeRowIds).toBe(before.selection.activeRowIds)
  expect(heldState.selection.selectedRowIds).toBe(before.selection.selectedRowIds)
  expect(heldState.codebook.columns).toBe(before.codebook.columns)
  expect(heldState.codebook.weightConfig).toEqual(before.codebook.weightConfig)
  expect(heldState.globalObservations).toBe(before.globalObservations)
  expect(heldState.globalVariables).toEqual(before.globalVariables)
  expect(heldState.pcp).toBe(before.pcp)
  const heldObservation = { dataRevision: heldState.selection.dataRevision,
    schemaRevision: heldState.codebook.schemaRevision, codebookLoading: heldState.codebook.isLoading,
    oldCountsVisible, visibleNotices, pendingIndicators: pendingIndicators.length,
    denominators: heldDenominators?.textContent, category: heldCategory?.textContent,
    cardRequestRevisions: cardRequests.map(request => request.expectedDataRevision),
    activePaneText: distributionTab.textContent }
  console.info('DISTRIBUTION_ALREADY_RENDERED_DURING_CODEBOOK_READ', JSON.stringify(heldObservation))
  const heldCountsAreHiddenOrDisclosed = !oldCountsVisible || visibleNotices.length > 0 || pendingIndicators.length > 0
  // Capture the held-read oracle now, then let the real lifecycle finish so a
  // failing disclosure assertion can distinguish temporary exposure from a
  // permanent inability to retrieve the revision-12 summary.

  await act(async () => { codebook.resolve(book); await codebook.promise })
  await waitFor(() => expect(cardRequests).toHaveLength(2))
  expect(store.getState().codebook.isLoading).toBe(false)
  expect(cardRequests[1]).toEqual({ ...expectedRequest, expectedDataRevision: 12 })
  expect(view.getByTestId('cards-loading')).toBeVisible()
  await act(async () => { currentCards.resolve(currentSummary); await currentCards.promise })
  const card = within(await view.findByTestId('question-card-x'))
  expect(card.getByTestId('denominators-bar')).toHaveTextContent('有効: 4')
  expect(card.getByTestId('denominators-bar')).toHaveTextContent('無回答: 0')
  expect(card.getByTestId('denominators-bar')).not.toHaveTextContent('有効: 2')
  expect(card.getByTestId('category-x-4')).toHaveTextContent('100.0% (4)')
  expect(card.getByTestId('category-x-4')).toHaveTextContent('1選択中')
  expect(card.getByTestId('category-x--99')).toHaveTextContent('対象外 (0)')
  const after = store.getState()
  expect(after.selection).toEqual({ ...before.selection, dataRevision: 12 })
  expect(after.selection.allRowIds).toBe(before.selection.allRowIds)
  expect(after.selection.activeRowIds).toBe(before.selection.activeRowIds)
  expect(after.selection.selectedRowIds).toBe(before.selection.selectedRowIds)
  expect(after.codebook.columns).toBe(before.codebook.columns)
  expect(after.codebook.weightConfig).toEqual(before.codebook.weightConfig)
  expect(after.codebook.columns[0].missingCodes).toEqual(['-99'])
  expect(after.codebook.columns[0].missingReasons).toEqual({ '-99': 'no_answer' })
  expect(after.globalVariables).toEqual(before.globalVariables)
  expect(after.globalObservations).toBe(before.globalObservations)
  expect(after.pcp).toBe(before.pcp)
  expect(mutationBodies).toHaveLength(1)
  expect(cardRequests).toHaveLength(2)
  expect(unexpected).toEqual([])
  console.info('DISTRIBUTION_ALREADY_RENDERED_RECOVERY', JSON.stringify({ requestRevisions: cardRequests.map(request => request.expectedDataRevision),
    schemaRevision: after.codebook.schemaRevision, codebookReads, selectedRows: after.selection.selectedRowIds,
    currentValidCount: 4, unchangedRowReferences: true, heldCountsAreHiddenOrDisclosed }))
  expect(heldCountsAreHiddenOrDisclosed,
    'After dataRevision 11→12, already-rendered revision-11 counts must be hidden or explicitly disclosed as loading/error/stale while the codebook read is pending',
  ).toBe(true)
})
