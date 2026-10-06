import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { api, type CodebookColumn } from '../src/api/client'
import { datasetLoaded, globalObservationsSlice, globalVariablesSlice, selectionReducer,
  store, variablesInitialized } from '../src/app/store'
import { codebookReadAccepted, codebookReceived, codebookSlice } from '../src/features/dataset/codebookSlice'
import { provenanceReducer } from '../src/features/dataset/provenanceSlice'
import { useScoreSaveRefresh, type ScoreSaveReceipt } from '../src/features/models/useScoreSaveRefresh'
import { GlobalHeaderControlBar } from '../src/features/selection/GlobalHeaderControlBar'
import TablePage from '../src/features/table/TablePage'

// The actual helper, accepted codebook read, central selection, Variables popup,
// Table component and its request/render path stay real. Only transport and
// unrelated color/closed modal surfaces are omitted.
vi.mock('../src/theme/useL1ColorDomain', () => ({ useDatasetL1ColorDomains: () => [] }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/selection/VariableSelectionModal', () => ({ default: () => null }))
vi.mock('../src/features/selection/ObservationModal', () => ({ default: () => null }))

const savedName = 'Saved_score'
const rowIds = ['r1', 'r2', 'r3']
const owner = { resultId: 'fit-selection' }
const savedCopy = `${savedName}を保存しました（3行）。新列は利用可能です。Tableに表示するには、Variablesで新列を選択してください。`
function column(name: string): CodebookColumn {
  return { columnId: `${name}-id`, name, label: name, scaleType: 'ratio', role: 'question',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false,
    multiResponseGroup: null }
}
function SaveControl() {
  const save = useScoreSaveRefresh(owner)
  return <>
    <button disabled={save.saving} onClick={() => void save.save(savedName,
      () => api.post<ScoreSaveReceipt>('/analysis-results/fit-selection/materialize', {
        context: { datasetId: 'synthetic', expectedDataRevision: 1, expectedSchemaRevision: 1 },
        source: 'fit', columns: [{ sourceField: 'coordinate:1', name: savedName }],
        idempotencyKey: 'selection-proof',
      }), error => String(error))}>Save fixture score</button>
    {save.notice}
  </>
}
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(async () => {
  cleanup()
  await act(async () => { message.destroy() })
  vi.restoreAllMocks()
})

// Keep the actual save, preserved selection and user-selected Table display in
// one coherent control, with room for measured hosted-runner variation.
it('makes saved columns available without changing common selection, and Table displays one after its Variables checkbox is selected', async () => {
  const initialColumns = Array.from({ length: 6 }, (_, i) => column(`X${i + 1}`))
  let server = { dataRevision: 1, schemaRevision: 1, columns: initialColumns }
  const book = () => structuredClone({ datasetId: 'synthetic', schemaRevision: server.schemaRevision,
    licenseText: '', licenseRevision: 1, columns: server.columns, multiResponseGroups: [],
    weightConfig: null, surveyDesign: null })
  const accepted: unknown[] = []
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/datasets/synthetic/codebook') return book() as any
    if (path === '/datasets/synthetic') return { dataRevision: server.dataRevision, schemaRevision: server.schemaRevision } as any
    if (path.startsWith('/datasets/synthetic/imputation-mask?')) return { maskRevision: 0, entries: [] } as any
    throw new Error(`Unexpected GET ${path}`)
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => {
    if (path === '/analysis-results/fit-selection/materialize') {
      expect(body.columns).toEqual([{ sourceField: 'coordinate:1', name: savedName }])
      server = { dataRevision: 2, schemaRevision: 2, columns: [...initialColumns, column(savedName)] }
      return { createdColumns: [{ name: savedName }], writtenRowCount: rowIds.length,
        dataRevision: 2, schemaRevision: 2 } as any
    }
    if (path === '/datasets/synthetic/table-view') {
      if (body.expectedDataRevision !== server.dataRevision || body.expectedSchemaRevision !== server.schemaRevision)
        throw new Error('Table request requires the canonical revisions')
      const columns = body.entityIds.map((entity: { columnId: string }) => {
        const found = server.columns.find(c => c.columnId === entity.columnId)
        expect(found).toBeDefined()
        return found!
      }) as CodebookColumn[]
      // Return only the requested selected entities, as Table's transport does.
      return { entities: columns.map(c => ({ kind: 'column', columnId: c.columnId, label: c.name, sortable: true })),
        rows: rowIds.map((rowId, i) => ({ rowId, cells: columns.map(c => {
          const value = c.name === savedName ? [.25, -.5, .75][i] : i + 1
          return { value, text: String(value), isMissing: false }
        }) })), total: rowIds.length } as any
    }
    throw new Error(`Unexpected POST ${path}`)
  })
  const base = store.getState()
  const local = configureStore({ reducer: {
    selection: selectionReducer, codebook: codebookSlice.reducer,
    globalVariables: globalVariablesSlice.reducer, globalObservations: globalObservationsSlice.reducer,
    provenance: provenanceReducer, pcp: () => base.pcp,
  }, middleware: defaults => defaults({ serializableCheck: false }).concat(() => next => action => {
    if (codebookReadAccepted.match(action)) accepted.push(action)
    return next(action)
  }) })
  local.dispatch(datasetLoaded({ datasetId: 'synthetic', name: 'Selection fixture', rowIds, dataRevision: 1 }))
  local.dispatch(variablesInitialized({ datasetId: 'synthetic', variables: initialColumns.map(c => c.name),
    meta: Object.fromEntries(initialColumns.map(c => [c.name, { columnId: c.columnId, name: c.name,
      semanticType: 'numeric' as const, physicalType: 'Float64', missingCount: 0, isTargetCandidate: false }])) }))
  local.dispatch(codebookReceived(book()))
  const originalSelection = structuredClone(local.getState().globalVariables.activeEntities)
  render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><MemoryRouter>
    <GlobalHeaderControlBar /><SaveControl /><div data-testid="actual-table"><TablePage /></div>
  </MemoryRouter></Provider></ConfigProvider>)
  const table = within(screen.getByTestId('actual-table'))
  await waitFor(() => expect(table.getByRole('columnheader', { name: 'X6 (X6)' })).toBeVisible())
  expect(screen.getByTestId('global-var-btn')).toHaveTextContent('6 / 6')

  fireEvent.click(screen.getByText('Save fixture score'))
  await waitFor(() => expect(screen.getByText(savedCopy)).toBeVisible())
  expect(accepted).toHaveLength(1)
  expect(local.getState().selection.dataRevision).toBe(2)
  expect(local.getState().codebook.schemaRevision).toBe(2)
  expect(local.getState().codebook.columns).toHaveLength(7)
  expect(local.getState().globalVariables.activeEntities).toEqual(originalSelection)
  expect(screen.getByTestId('global-var-btn')).toHaveTextContent('6 / 7')
  await waitFor(() => expect(table.getByRole('columnheader', { name: 'X6 (X6)' })).toBeVisible())
  expect(table.queryByRole('columnheader', { name: `${savedName} (${savedName})` })).toBeNull()
  const canonicalRequests = () => post.mock.calls.filter(([path, body]: any) => path.endsWith('/table-view')
    && body.expectedDataRevision === 2 && body.expectedSchemaRevision === 2)
  await waitFor(() => expect(canonicalRequests().length).toBeGreaterThan(0))
  expect((canonicalRequests().at(-1)![1] as any).entityIds).toEqual(originalSelection)

  fireEvent.click(screen.getByTestId('global-var-btn'))
  const popup = await screen.findByTestId('var-popover')
  const checkbox = within(popup).getByRole('checkbox', { name: /Saved_score/ })
  // AntD visually hides the native input inside its visible clickable label.
  const checkboxLabel = checkbox.closest('label')!
  await waitFor(() => expect(checkboxLabel).toBeVisible())
  expect(checkbox).not.toBeChecked()
  fireEvent.click(checkboxLabel)
  expect(checkbox).toBeChecked()
  expect(local.getState().globalVariables.activeEntities).toEqual([
    ...originalSelection!, { kind: 'column', columnId: `${savedName}-id` },
  ])
  await waitFor(() => expect(table.getByRole('columnheader', { name: `${savedName} (${savedName})` })).toBeVisible())
  expect(table.getByText('0.25')).toBeVisible()
  expect((canonicalRequests().at(-1)![1] as any).entityIds).toEqual([
    ...originalSelection!, { kind: 'column', columnId: `${savedName}-id` },
  ])
  expect(screen.getByTestId('global-var-btn')).toHaveTextContent('7 / 7')
  expect(post.mock.calls.filter(([path]) => path.endsWith('/materialize'))).toHaveLength(1)
  expect(get.mock.calls.filter(([path]) => path === '/datasets/synthetic/codebook')).toHaveLength(1)
}, 10000)
