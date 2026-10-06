import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as client from '../src/api/client'
import type { CodebookColumn, CodebookResponse } from '../src/api/client'
import AppShell from '../src/app/AppShell'
import { store, datasetLoaded, variablesInitialized, weightColumnCleared } from '../src/app/store'
import { codebookReceived, codebookReset } from '../src/features/dataset/codebookSlice'

// AppShell, useWorkspacePersistence, GlobalHeaderControlBar, ColumnSelect,
// ActiveModal, Ant Design, and the complete exported Redux store stay real.
// Only unrelated analysis/editor/license-information surfaces are omitted.
vi.mock('../src/app/KeepAliveOutlet', () => ({ default: () => <div>Proof analysis page</div> }))
vi.mock('../src/features/common/LicenseModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookEditorModal', () => ({ default: () => null }))
const clone = <T,>(value: T): T => structuredClone(value)
const aId = 'dataset-a', bId = 'dataset-b', w1 = 'a-only-weight-1', w2 = 'a-only-weight-2'
function column(columnId: string, name: string, role: 'weight' | 'question'): CodebookColumn {
  return { columnId, name, label: name, role, scaleType: 'ratio', valueLabels: {}, categoryOrder: [],
    missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }
}
const baseBooks: Record<string, CodebookResponse> = {
  [aId]: { datasetId: aId, schemaRevision: 1, licenseText: '', licenseRevision: 1,
    columns: [column(w1, 'A weight one', 'weight'), column(w2, 'A weight two', 'weight')],
    multiResponseGroups: [], weightConfig: null, surveyDesign: null },
  [bId]: { datasetId: bId, schemaRevision: 1, licenseText: '', licenseRevision: 1,
    columns: [column('b-value', 'B value', 'question')],
    multiResponseGroups: [], weightConfig: null, surveyDesign: null },
}
let books: Record<string, CodebookResponse>
const meta = (id: string) => ({ name: id === aId ? 'Dataset A' : 'Dataset B', dataRevision: 1,
  schema: books[id].columns.map(c => ({ columnId: c.columnId, name: c.name, semanticType: 'numeric', physicalType: 'Float64', missingCount: 0 })) })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
type DeferredMeta = ReturnType<typeof deferred<ReturnType<typeof meta>>>
let holds: Map<string, DeferredMeta>
let actionSpy: ReturnType<typeof vi.spyOn>
let calls: string[]

beforeEach(() => {
  calls = []; holds = new Map(); books = clone(baseBooks)
  vi.spyOn(client.api, 'get').mockImplementation(async (path: string) => {
    calls.push(path)
    if (path === '/datasets') return { datasets: [aId, bId].map(id => ({ datasetId: id, name: id === aId ? 'Dataset A' : 'Dataset B', rowCount: 2, columnCount: books[id].columns.length })) } as any
    if (path === '/datasets/samples') return { samples: [] } as any
    const id = path.split('/')[2]
    if (path === `/datasets/${id}/codebook`) return clone(books[id]) as any
    if (path === `/datasets/${id}`) return await (holds.get(id)?.promise ?? Promise.resolve(meta(id))) as any
    throw new Error(`Unexpected read: ${path}`)
  })
  vi.spyOn(client.api, 'post').mockImplementation(async (path: string) => {
    if (path.endsWith('/color-domains')) return { domains: [] } as any
    throw new Error(`Unexpected mutation: ${path}`)
  })
  vi.spyOn(client, 'fetchArrowView').mockImplementation(async id => ({ __rowId__: [`${id}-r1`, `${id}-r2`] }))
  store.dispatch(codebookReset())
  store.dispatch(datasetLoaded({ datasetId: aId, name: 'Dataset A', rowIds: ['a-r1', 'a-r2'], dataRevision: 1 }))
  store.dispatch(variablesInitialized({ datasetId: aId, variables: books[aId].columns.map(c => c.name),
    meta: Object.fromEntries(meta(aId).schema.map(c => [c.name, { ...c, isTargetCandidate: false }])) as any }))
  store.dispatch(codebookReceived(clone(books[aId])))
  store.dispatch(weightColumnCleared())
  actionSpy = vi.spyOn(store, 'dispatch')
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const mount = () => render(<Provider store={store}><MemoryRouter initialEntries={['/table']}><AppShell /></MemoryRouter></Provider>)
const currentDialog = () => screen.getByRole('dialog', { name: '変数を選択', exact: true })
async function openWeight() {
  fireEvent.click(within(screen.getByTestId('global-weight-controls')).getByRole('button', { name: '変数を選択', exact: true }))
  return await screen.findByRole('dialog', { name: '変数を選択', exact: true })
}
function stageWeight(dialog: HTMLElement, label = 'A weight one') {
  fireEvent.click(within(dialog).getByRole('radio', { name: label, exact: true }))
}
async function commit(dialog = currentDialog()) {
  fireEvent.click(within(dialog).getByRole('button', { name: /^決\s*定$/ }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '変数を選択', exact: true })).not.toBeInTheDocument())
}
async function cancel(dialog = currentDialog()) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '変数を選択', exact: true })).not.toBeInTheDocument())
}
async function chooseDataset(id = bId) {
  expect(screen.queryByRole('dialog', { name: '変数を選択', exact: true })).not.toBeInTheDocument()
  const installedId = store.getState().selection.datasetId
  const previousReads = calls.filter(path => path === `/datasets/${id}`).length
  const waiting = deferred<ReturnType<typeof meta>>()
  holds.set(id, waiting)
  fireEvent.mouseDown(within(screen.getByTestId('dataset-selector')).getByRole('combobox'))
  const title = id === aId ? 'Dataset A (2行)' : 'Dataset B (2行)'
  await waitFor(() => expect(document.querySelector(`.ant-select-item-option[title="${title}"]`)).not.toBeNull())
  fireEvent.click(document.querySelector(`.ant-select-item-option[title="${title}"]`)!)
  await waitFor(() => expect(calls.filter(path => path === `/datasets/${id}`).length).toBeGreaterThan(previousReads))
  expect(calls).toContain(`/datasets/${id}/codebook`)
  expect(client.fetchArrowView).toHaveBeenCalledWith(id, [])
  expect(screen.getByText('データセットを読み込んでいます…')).toBeInTheDocument()
  expect(store.getState().selection.datasetId).toBe(installedId)
  return waiting
}
async function finish(waiting: DeferredMeta, id = bId) {
  await act(async () => { waiting.resolve(meta(id)); await waiting.promise })
  await waitFor(() => expect(store.getState().selection.datasetId).toBe(id))
  await waitFor(() => expect(screen.queryByText('データセットを読み込んでいます…')).not.toBeInTheDocument())
}
async function commitInitialWeight(label = 'A weight one') {
  const dialog = await openWeight(); stageWeight(dialog, label); await commit(dialog)
}

describe('global weight picker installed-dataset ownership', () => {
  it('retires an A draft opened during pending B preparation before B can accept its column', async () => {
    mount()
    const waiting = await chooseDataset()
    const dialog = await openWeight(); stageWeight(dialog)
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    expect(within(dialog).getByRole('status')).toHaveTextContent('1件選択中')
    const oldPicker = screen.getByTestId('global-weight-select')
    actionSpy.mockClear()
    await finish(waiting)
    expect(dialog).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '変数を選択', exact: true })).not.toBeInTheDocument()
    expect(screen.getByTestId('global-weight-select')).not.toBe(oldPicker)
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    const reopened = await openWeight()
    expect(within(reopened).queryAllByRole('radio')).toHaveLength(0)
    expect(within(reopened).getByRole('status')).toHaveTextContent('0件選択中')
    await commit(reopened)
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    expect(actionSpy.mock.calls.map(([action]) => action)).not.toContainEqual({
      type: 'globalVariables/weightColumnSet', payload: { columnId: w1, datasetId: bId },
    })
  })
  it('retires an untouched A dialog and reopens B with null committed and inline values', async () => {
    mount(); await commitInitialWeight()
    expect(screen.getByTestId('global-weight-select')).toHaveTextContent('A weight one')
    const waiting = await chooseDataset()
    const dialog = await openWeight()
    expect(within(dialog).getByRole('status')).toHaveTextContent('1件選択中')
    await finish(waiting)
    expect(dialog).not.toBeInTheDocument()
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    const reopened = await openWeight()
    expect(within(reopened).getByRole('status')).toHaveTextContent('0件選択中')
    await commit(reopened)
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    expect(screen.getByTestId('global-weight-select')).toHaveTextContent('未選択')
    expect(screen.getByTestId('global-weight-select')).not.toHaveTextContent('A weight one')
  })
  it('failed B preparation preserves A and its edited draft', async () => {
    mount()
    const waiting = await chooseDataset()
    const dialog = await openWeight(); stageWeight(dialog)
    await act(async () => { waiting.reject(new Error('Proof B preparation unavailable')); await waiting.promise.catch(() => {}) })
    await screen.findByText('データセット読込に失敗しました: Proof B preparation unavailable')
    expect(store.getState().selection.datasetId).toBe(aId)
    expect(currentDialog()).toBe(dialog)
    expect(within(dialog).getByRole('radio', { name: 'A weight one', exact: true })).toBeChecked()
    await commit(dialog)
    expect(store.getState().globalVariables.weightColumnId).toBe(w1)
  })
  it('cancel during pending B preparation discards the draft and B reopens empty', async () => {
    mount()
    const waiting = await chooseDataset()
    const dialog = await openWeight(); stageWeight(dialog)
    await cancel(dialog); await finish(waiting)
    const reopened = await openWeight()
    expect(within(reopened).getByRole('status')).toHaveTextContent('0件選択中')
    expect(within(reopened).queryAllByRole('radio')).toHaveLength(0)
    await commit(reopened)
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
  })
  it('cancel/reopen within A keeps the committed value and discards an uncommitted replacement', async () => {
    mount(); await commitInitialWeight()
    const dialog = await openWeight(); stageWeight(dialog, 'A weight two'); await cancel(dialog)
    const reopened = await openWeight()
    expect(within(reopened).getByRole('radio', { name: 'A weight one', exact: true })).toBeChecked()
    expect(within(reopened).getByRole('radio', { name: 'A weight two', exact: true })).not.toBeChecked()
    await commit(reopened)
    expect(store.getState().globalVariables.weightColumnId).toBe(w1)
  })
  it('real same-dataset reinstall preserves A committed weight and A draft, superseding B', async () => {
    mount(); await commitInitialWeight()
    const pendingB = await chooseDataset(), pendingA = await chooseDataset(aId)
    const dialog = await openWeight(); stageWeight(dialog, 'A weight two')
    await finish(pendingA, aId)
    expect(currentDialog()).toBe(dialog)
    expect(store.getState().globalVariables.weightColumnId).toBe(w1)
    expect(within(dialog).getByRole('radio', { name: 'A weight two', exact: true })).toBeChecked()
    await commit(dialog)
    expect(store.getState().globalVariables.weightColumnId).toBe(w2)
    await act(async () => { pendingB.resolve(meta(bId)); await pendingB.promise })
    expect(store.getState().selection.datasetId).toBe(aId)
    expect(store.getState().globalVariables.weightColumnId).toBe(w2)
  })
  it('committed A weight resets in Redux on B installation with no dialog open', async () => {
    mount(); await commitInitialWeight()
    const waiting = await chooseDataset(); await finish(waiting)
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    expect(screen.queryByRole('dialog', { name: '変数を選択', exact: true })).not.toBeInTheDocument()
    expect(screen.getByTestId('global-weight-select')).toHaveTextContent('未選択')
    expect(screen.getByTestId('global-weight-select')).not.toHaveTextContent('A weight one')
  })
  it('inline-picked A weight also clears visibly after B installation and a null dialog commit', async () => {
    mount()
    fireEvent.mouseDown(within(screen.getByTestId('global-weight-select')).getByRole('combobox'))
    await waitFor(() => expect(document.querySelector('.ant-select-item-option[title="A weight one"]')).not.toBeNull())
    fireEvent.click(document.querySelector('.ant-select-item-option[title="A weight one"]')!)
    expect(store.getState().globalVariables.weightColumnId).toBe(w1)
    expect(screen.getByTestId('global-weight-select')).toHaveTextContent('A weight one')
    const waiting = await chooseDataset(); await finish(waiting)
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    expect(screen.getByTestId('global-weight-select')).toHaveTextContent('未選択')
    const dialog = await openWeight()
    expect(within(dialog).getByRole('status')).toHaveTextContent('0件選択中')
    await commit(dialog)
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    expect(screen.getByTestId('global-weight-select')).toHaveTextContent('未選択')
    expect(screen.getByTestId('global-weight-select')).not.toHaveTextContent('A weight one')
  })
  it('Variable Manager replaces an edited A draft when B installs', async () => {
    mount()
    const waiting = await chooseDataset()
    fireEvent.click(screen.getByTestId('global-var-btn'))
    fireEvent.click(await screen.findByTestId('open-var-manager-btn'))
    const dialog = await screen.findByTestId('variable-selection-modal')
    expect(dialog).toBeVisible()
    const list = within(dialog).getByRole('listbox', { name: '選択・表示変数' })
    expect(within(list).getAllByRole('option')).toHaveLength(2)
    fireEvent.click(within(list).getAllByRole('option')[0])
    fireEvent.click(within(dialog).getByRole('button', { name: '選択から除外', exact: true }))
    expect(within(list).getAllByRole('option')).toHaveLength(1)
    await finish(waiting)
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    expect(within(list).getByRole('option')).toHaveTextContent('B value')
    expect(within(dialog).queryByText(/A weight/)).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByTestId('var-manager-apply-btn'))
    expect(store.getState().globalVariables.activeEntities).toEqual([{ kind: 'column', columnId: 'b-value' }])
  })

  it('a fresh eligible B selection commits only B after A draft retirement', async () => {
    books[bId].columns.push(column('b-only-weight', 'B weight', 'weight'))
    mount()
    const waiting = await chooseDataset()
    const oldDialog = await openWeight(); stageWeight(oldDialog)
    await finish(waiting)
    expect(oldDialog).not.toBeInTheDocument()
    const fresh = await openWeight()
    expect(within(fresh).queryByRole('radio', { name: 'A weight one', exact: true })).not.toBeInTheDocument()
    expect(within(fresh).getByRole('radio', { name: 'B weight', exact: true })).not.toBeChecked()
    stageWeight(fresh, 'B weight'); await commit(fresh)
    expect(store.getState().globalVariables.datasetId).toBe(bId)
    expect(store.getState().globalVariables.weightColumnId).toBe('b-only-weight')
    expect(actionSpy).toHaveBeenCalledWith({ type: 'globalVariables/weightColumnSet', payload: { columnId: 'b-only-weight', datasetId: bId } })
    expect(screen.getByTestId('global-weight-select')).toHaveTextContent('B weight')
  })
  it('returning A after A to B does not revive the retired A draft', async () => {
    mount()
    const pendingB = await chooseDataset()
    const oldDialog = await openWeight(); stageWeight(oldDialog, 'A weight two')
    await finish(pendingB)
    expect(oldDialog).not.toBeInTheDocument()
    const pendingA = await chooseDataset(aId); await finish(pendingA, aId)
    const reopened = await openWeight()
    expect(within(reopened).getByRole('status')).toHaveTextContent('0件選択中')
    expect(within(reopened).getByRole('radio', { name: 'A weight two', exact: true })).not.toBeChecked()
    expect(store.getState().globalVariables.weightColumnId).toBeNull()
    stageWeight(reopened); await commit(reopened)
    expect(store.getState().globalVariables.weightColumnId).toBe(w1)
  })

})
