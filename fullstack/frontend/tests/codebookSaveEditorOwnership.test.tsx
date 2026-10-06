import { configureStore, type Middleware, type MiddlewareAPI, type UnknownAction } from '@reduxjs/toolkit'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { notification } from 'antd'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CodebookColumn, type CodebookResponse, type updateCodebook } from '../src/api/client'
import { datasetLoaded, selectionReducer } from '../src/app/store'
import CodebookEditorModal from '../src/features/dataset/CodebookEditorModal'
import {
  codebookReceived,
  codebookReadAccepted,
  codebookSaveAccepted,
  codebookSlice,
  draftColumnUpdated,
  editorModalClosed,
  editorModalOpened,
  fetchCodebookThunk,
  saveCodebookThunk,
} from '../src/features/dataset/codebookSlice'

// Keep the real modal, footer buttons, and notification portals. The child
// editors have no role in Save's request or editor-session ownership.
vi.mock('../src/features/dataset/CodebookVariableList', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookDetailForm', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookGridView', () => ({ default: () => null }))
vi.mock('../src/features/dataset/BulkLabelPasteModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookCsvImportDialog', () => ({ default: () => null }))
vi.mock('../src/features/dataset/MultiResponseGroupDialog', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookLicenseEditor', () => ({ default: () => null }))

const notices = { success: vi.fn(), error: vi.fn() }
const successTitle = 'コードブック保存完了'
const errorTitle = '保存失敗'
const deliveryError = '保存応答を受信できませんでした'
const outcomes = ['success', 'error'] as const
type Outcome = typeof outcomes[number]
type SaveResponse = Awaited<ReturnType<typeof updateCodebook>>
type SaveRequest = ReturnType<ReturnType<typeof saveCodebookThunk>>
type CodebookUpdate = { columns: Partial<CodebookColumn>[]; expectedSchemaRevision: number;
  multiResponseGroups?: CodebookResponse['multiResponseGroups'] }

beforeEach(() => {
  notices.success.mockClear()
  notices.error.mockClear()
  const useNotification = notification.useNotification
  vi.spyOn(notification, 'useNotification').mockImplementation((...args) => {
    const [noticeApi, holder] = useNotification(...args)
    return [{
      ...noticeApi,
      success: config => {
        notices.success(config)
        return noticeApi.success(config)
      },
      error: config => {
        notices.error(config)
        return noticeApi.error(config)
      },
    }, holder]
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function snapshot(datasetId: string): CodebookResponse {
  const column: CodebookColumn = {
    columnId: 'q', name: 'Q', label: `${datasetId} saved question`,
    role: 'question', scaleType: 'ordinal', categoryOrder: ['1', '2'],
    valueLabels: { '1': 'Low', '2': 'High' }, missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null,
  }
  return { datasetId, schemaRevision: 1, columns: [column], multiResponseGroups: [],
    weightConfig: null, surveyDesign: null }
}

function createServer() {
  const saved = new Map(['A', 'B'].map(id => [id, snapshot(id)]))
  const deliveries: Array<{
    expectedSchemaRevision: number
    response: SaveResponse
    resolve: (value: SaveResponse) => void
    reject: (reason: Error) => void
  }> = []
  const commit = (datasetId: string, update: CodebookUpdate): SaveResponse => {
    const current = saved.get(datasetId)
    if (!current) throw new Error(`Unexpected codebook dataset: ${datasetId}`)
    if (update.expectedSchemaRevision !== current.schemaRevision) throw new Error('SCHEMA_REVISION_CONFLICT')
    const committed: CodebookResponse = {
      ...structuredClone(current),
      schemaRevision: current.schemaRevision + 1,
      columns: current.columns.map(column => ({ ...column,
        ...structuredClone(update.columns.find(patch => patch.columnId === column.columnId)) })),
      multiResponseGroups: structuredClone(update.multiResponseGroups ?? current.multiResponseGroups),
    }
    saved.set(committed.datasetId, committed)
    return {
      status: 'success', datasetId: committed.datasetId, schemaRevision: committed.schemaRevision,
      updatedColumns: update.columns.length, codebook: structuredClone(committed),
    }
  }
  const put = vi.spyOn(api, 'put').mockImplementation(<T,>(path: string, body: unknown): Promise<T> => {
    const datasetId = /^\/datasets\/([^/]+)\/codebook$/.exec(path)?.[1]
    if (!datasetId) throw new Error(`Unexpected codebook PUT: ${path}`)
    const update = body as CodebookUpdate
    // Commit immediately, using the same expected-revision rule as the server.
    // Only delivery is delayed. A failed delivery models a lost response after
    // commit, rather than two successful writes against an impossible revision.
    const response = commit(datasetId, update)
    const pending = new Promise<SaveResponse>((resolve, reject) => {
      deliveries.push({ expectedSchemaRevision: update.expectedSchemaRevision, response, resolve, reject })
    })
    return pending as Promise<T>
  })
  return { put, deliveries, commit, read: (datasetId: string) => structuredClone(saved.get(datasetId)!) }
}

function setup(onAction?: (action: UnknownAction, api: MiddlewareAPI) => void) {
  const server = createServer()
  const requests: SaveRequest[] = []
  const actions: UnknownAction[] = []
  const capture: Middleware = middlewareApi => next => action => {
    const result = next(action)
    if (typeof action === 'function') {
      if (result && typeof result === 'object' && 'requestId' in result) requests.push(result as SaveRequest)
    } else if (action && typeof action === 'object' && 'type' in action) {
      actions.push(action as UnknownAction)
      onAction?.(action as UnknownAction, middlewareApi)
    }
    return result
  }
  const local = configureStore({
    reducer: { selection: selectionReducer, codebook: codebookSlice.reducer },
    middleware: get => get({ serializableCheck: false }).prepend(capture),
  })
  const install = (datasetId: string) => {
    local.dispatch(datasetLoaded({ datasetId, name: `${datasetId}.csv`, rowIds: ['r1'], dataRevision: 1 }))
    local.dispatch(codebookReceived(server.read(datasetId)))
    local.dispatch(editorModalOpened())
  }
  install('A')
  local.dispatch(draftColumnUpdated({ columnId: 'q', patch: { label: 'first submitted question' } }))
  const mount = () => render(<Provider store={local}><CodebookEditorModal /></Provider>)
  return { local, server, requests, actions, install, mount, view: mount() }
}

const saveButton = () => screen.getByRole('button', { name: /保\s*存/ })
const clickSave = () => fireEvent.click(saveButton())

async function deliver(context: ReturnType<typeof setup>, index: number, outcome: Outcome) {
  const delivery = context.server.deliveries[index]
  const request = context.requests[index]
  let result!: Awaited<SaveRequest>
  await act(async () => {
    if (outcome === 'success') delivery.resolve(delivery.response)
    else delivery.reject(new Error(deliveryError))
    result = await request
  })
  return result
}

function expectNoNotice() {
  expect(notices.success).not.toHaveBeenCalled()
  expect(notices.error).not.toHaveBeenCalled()
  expect(screen.queryByText(successTitle)).not.toBeInTheDocument()
  expect(screen.queryByText(errorTitle)).not.toBeInTheDocument()
}

describe('Codebook Save editor-session ownership', () => {
  it('shows the current successful save and keeps the accepted request receipt', async () => {
    const context = setup()
    clickSave()
    const requestId = context.requests[0].requestId
    expect(context.local.getState().codebook).toMatchObject({ isSaving: true, saveRequestId: requestId })
    expect(saveButton()).toBeDisabled()
    expect(context.server.put).toHaveBeenCalledWith('/datasets/A/codebook', expect.objectContaining({
      expectedSchemaRevision: 1, columns: [expect.objectContaining({ label: 'first submitted question' })],
    }))
    const result = await deliver(context, 0, 'success')
    expect(saveCodebookThunk.fulfilled.match(result)).toBe(true)
    expect(await screen.findByText(successTitle)).toBeVisible()
    expect(notices.success).toHaveBeenCalledOnce()
    expect(notices.success).toHaveBeenCalledWith(expect.objectContaining({
      description: 'コードブックの変更を保存しました（リビジョン: 2）。',
    }))
    expect(notices.error).not.toHaveBeenCalled()
    expect(context.local.getState().codebook).toMatchObject({
      schemaRevision: 2, isSaving: false, saveRequestId: requestId, hasChanges: false, isEditorOpen: true,
      columns: [expect.objectContaining({ label: 'first submitted question' })],
    })
  })

  it('shows the current error, retains the draft, and makes Save available again', async () => {
    const context = setup()
    clickSave()
    const requestId = context.requests[0].requestId
    const result = await deliver(context, 0, 'error')
    expect(saveCodebookThunk.rejected.match(result)).toBe(true)
    expect(await screen.findByText(errorTitle)).toBeVisible()
    expect(screen.getByText(deliveryError)).toBeVisible()
    expect(notices.error).toHaveBeenCalledOnce()
    expect(notices.success).not.toHaveBeenCalled()
    expect(context.local.getState().codebook).toMatchObject({
      schemaRevision: 1, isSaving: false, saveRequestId: requestId, hasChanges: true, isEditorOpen: true,
      draftColumns: [expect.objectContaining({ label: 'first submitted question' })],
    })
    expect(saveButton()).not.toBeDisabled()
  })

  it('sends one request for same-tick double clicks and rejects an additional pending thunk by condition', async () => {
    const context = setup()
    const button = saveButton()
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(context.server.put).toHaveBeenCalledOnce()
    expect(context.requests).toHaveLength(1)
    const firstRequestId = context.requests[0].requestId
    let duplicate!: Awaited<SaveRequest>
    await act(async () => { duplicate = await context.local.dispatch(saveCodebookThunk()) })
    expect(saveCodebookThunk.rejected.match(duplicate)).toBe(true)
    if (saveCodebookThunk.rejected.match(duplicate)) expect(duplicate.meta.condition).toBe(true)
    expect(context.server.put).toHaveBeenCalledOnce()
    expect(context.local.getState().codebook).toMatchObject({ isSaving: true, saveRequestId: firstRequestId })
    expectNoNotice()
    await deliver(context, 0, 'success')
    expect(await screen.findByText(successTitle)).toBeVisible()
    expect(notices.success).toHaveBeenCalledOnce()
  })

  it.each(outcomes)('Cancel suppresses an old %s notice without cancelling canonical save settlement', async outcome => {
    const context = setup()
    clickSave()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(context.local.getState().codebook.isEditorOpen).toBe(false)
    const result = await deliver(context, 0, outcome)
    expectNoNotice()
    expect(context.local.getState().codebook).toMatchObject({
      isEditorOpen: false, isSaving: false, schemaRevision: outcome === 'success' ? 2 : 1,
      saveRequestId: context.requests[0].requestId,
    })
    if (outcome === 'success') {
      expect(saveCodebookThunk.fulfilled.match(result)).toBe(true)
      expect(context.local.getState().codebook.columns).toEqual(context.server.read('A').columns)
      expect(context.local.getState().codebook.hasChanges).toBe(false)
    }
  })

  it.each(outcomes)('same-tick close/reopen suppresses an old %s notice while preserving the reopened editor', async outcome => {
    const context = setup()
    clickSave()
    act(() => {
      context.local.dispatch(editorModalClosed())
      context.local.dispatch(editorModalOpened())
    })
    expect(context.local.getState().codebook.isSaving).toBe(true)
    await deliver(context, 0, outcome)
    expectNoNotice()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
    expect(context.local.getState().codebook).toMatchObject({
      isEditorOpen: true, isSaving: false, schemaRevision: outcome === 'success' ? 2 : 1,
    })
    if (outcome === 'success') expect(context.local.getState().codebook.columns).toEqual(context.server.read('A').columns)
  })

  it.each(outcomes)('A → B → A ignores old %s delivery while a newer Save owns the reopened editor', async outcome => {
    const context = setup()
    clickSave()
    const oldRequestId = context.requests[0].requestId
    expect(context.server.read('A').schemaRevision).toBe(2)
    act(() => {
      context.install('B')
      // Reinstallation reads the first PUT's committed revision, even though
      // that PUT's response has not been delivered to the original editor.
      context.install('A')
      context.local.dispatch(draftColumnUpdated({ columnId: 'q', patch: { label: 'newer submitted question' } }))
    })
    clickSave()
    const newerRequestId = context.requests[1].requestId
    expect(newerRequestId).not.toBe(oldRequestId)
    expect(context.server.deliveries.map(delivery => delivery.expectedSchemaRevision)).toEqual([1, 2])
    expect(context.server.read('A').schemaRevision).toBe(3)
    const beforeOldDelivery = context.local.getState().codebook
    const oldResult = await deliver(context, 0, outcome)
    expect(saveCodebookThunk.rejected.match(oldResult)).toBe(true)
    expect(oldResult.payload).toMatchObject({ code: 'CODEBOOK_SAVE_SUPERSEDED' })
    expectNoNotice()
    expect(context.local.getState().codebook).toEqual(beforeOldDelivery)
    expect(context.local.getState().codebook).toMatchObject({
      datasetId: 'A', schemaRevision: 2, isEditorOpen: true, isSaving: true,
      saveRequestId: newerRequestId, hasChanges: true,
      draftColumns: [expect.objectContaining({ label: 'newer submitted question' })],
    })
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
    expect(saveButton()).toBeDisabled()
    await deliver(context, 1, 'success')
    expect(await screen.findByText(successTitle)).toBeVisible()
    expect(notices.success).toHaveBeenCalledOnce()
    expect(notices.success).toHaveBeenCalledWith(expect.objectContaining({
      description: 'コードブックの変更を保存しました（リビジョン: 3）。',
    }))
    expect(notices.error).not.toHaveBeenCalled()
    expect(context.local.getState().codebook).toMatchObject({
      schemaRevision: 3, isSaving: false, hasChanges: false, isEditorOpen: true, saveRequestId: newerRequestId,
      columns: [expect.objectContaining({ label: 'newer submitted question' })],
    })
  })

  it.each(outcomes)('unmount/remount makes the old %s completion silent, including calls to the old notification API', async outcome => {
    const context = setup()
    clickSave()
    context.view.unmount()
    context.mount()
    expect(saveButton()).toBeDisabled()
    await deliver(context, 0, outcome)
    expectNoNotice()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
    expect(context.local.getState().codebook).toMatchObject({
      isEditorOpen: true, isSaving: false, schemaRevision: outcome === 'success' ? 2 : 1,
    })
  })

  it('observes synchronous close/reopen inside the automatic fulfilled acknowledgment before showing a notice', async () => {
    let acknowledgmentCount = 0
    const context = setup((action, middlewareApi) => {
      if (saveCodebookThunk.fulfilled.match(action)) {
        acknowledgmentCount++
        middlewareApi.dispatch(editorModalClosed())
        middlewareApi.dispatch(editorModalOpened())
      }
    })
    clickSave()
    const result = await deliver(context, 0, 'success')
    expect(saveCodebookThunk.fulfilled.match(result)).toBe(true)
    expect(acknowledgmentCount).toBe(1)
    expect(context.actions.filter(saveCodebookThunk.fulfilled.match)).toHaveLength(1)
    expectNoNotice()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
    expect(context.local.getState().codebook).toMatchObject({
      schemaRevision: 2, isEditorOpen: true, isSaving: false, hasChanges: false,
      saveRequestId: context.requests[0].requestId,
      columns: [expect.objectContaining({ label: 'first submitted question' })],
    })
  })

  it.each([
    { name: 'a newer same-dataset fetch', roundtrip: false },
    { name: 'an old accepted snapshot after an intervening newer fetch', roundtrip: true },
  ])('keeps $name installed silently across the automatic fulfilled acknowledgment', async ({ roundtrip }) => {
    let context!: ReturnType<typeof setup>
    context = setup((action, middlewareApi) => {
      if (codebookSaveAccepted.match(action)) {
        // The original save has really installed rev2 at this point. A second
        // writer can now validly commit rev3 against it before a fetch delivers
        // that newer snapshot, all before RTK dispatches save/fulfilled.
        const acceptedSnapshot = context.server.read('A')
        const newer = context.server.commit('A', {
          expectedSchemaRevision: 2,
          columns: [{ columnId: 'q', label: 'newer external question' }],
        })
        middlewareApi.dispatch(fetchCodebookThunk.pending('newer-read', 'A'))
        middlewareApi.dispatch(codebookReadAccepted(newer.codebook, 'newer-read'))
        if (roundtrip) {
          // An accepted read of an older snapshot must not revive ownership
          // merely because the final values match the old save result again.
          middlewareApi.dispatch(fetchCodebookThunk.pending('older-snapshot-read', 'A'))
          middlewareApi.dispatch(codebookReadAccepted(acceptedSnapshot, 'older-snapshot-read'))
        }
      }
    })
    const installGeneration = context.local.getState().selection.revision
    clickSave()
    const result = await deliver(context, 0, 'success')
    expect(saveCodebookThunk.fulfilled.match(result)).toBe(true)
    expect(result.payload).toMatchObject({ schemaRevision: 2 })
    expect(context.server.put).toHaveBeenCalledOnce()
    expect(context.actions.filter(action => [
      codebookSaveAccepted.type, fetchCodebookThunk.pending.type,
      codebookReadAccepted.type, saveCodebookThunk.fulfilled.type,
    ].includes(action.type)).map(action => action.type)).toEqual([
      codebookSaveAccepted.type, fetchCodebookThunk.pending.type,
      codebookReadAccepted.type,
      ...(roundtrip ? [fetchCodebookThunk.pending.type, codebookReadAccepted.type] : []),
      saveCodebookThunk.fulfilled.type,
    ])
    expectNoNotice()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
    expect(context.local.getState().selection.revision).toBe(installGeneration)
    const finalLabel = roundtrip ? 'first submitted question' : 'newer external question'
    expect(context.local.getState().codebook).toMatchObject({
      datasetId: 'A', schemaRevision: roundtrip ? 2 : 3, isEditorOpen: true, isSaving: false,
      isLoading: false, hasChanges: false, saveRequestId: null,
      fetchRequestId: roundtrip ? 'older-snapshot-read' : 'newer-read',
      columns: [expect.objectContaining({ label: finalLabel })],
      draftColumns: [expect.objectContaining({ label: finalLabel })],
    })
    expect(context.local.getState().codebook.columns).toEqual(roundtrip
      ? context.server.deliveries[0].response.codebook.columns : context.server.read('A').columns)
  })

  it('acknowledges a read of the save’s own committed snapshot and cleans the unchanged submitted draft', async () => {
    const context = setup()
    clickSave()
    const committed = context.server.read('A')
    expect(committed.schemaRevision).toBe(2)
    act(() => {
      context.local.dispatch(fetchCodebookThunk.pending('own-canonical-read', 'A'))
      context.local.dispatch(codebookReadAccepted(committed, 'own-canonical-read'))
    })
    const beforeResponse = context.local.getState().codebook
    expect(beforeResponse).toMatchObject({
      datasetId: 'A', schemaRevision: 2, isEditorOpen: true, isSaving: false,
      isLoading: false, saveRequestId: context.requests[0].requestId,
      columns: [expect.objectContaining({ label: 'first submitted question' })],
    })
    const result = await deliver(context, 0, 'success')
    expect(saveCodebookThunk.fulfilled.match(result)).toBe(true)
    expect(await screen.findByText(successTitle)).toBeVisible()
    expect(notices.success).toHaveBeenCalledOnce()
    expect(notices.error).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
    expect(context.local.getState().codebook).toMatchObject({
      schemaRevision: 2, isEditorOpen: true, isSaving: false, hasChanges: false,
      saveRequestId: context.requests[0].requestId,
    })
    expect(context.local.getState().codebook.columns).toEqual(committed.columns)
    expect(context.local.getState().codebook.draftColumns).toEqual(committed.columns)
  })
})
