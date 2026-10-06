import { configureStore } from '@reduxjs/toolkit'
import { afterEach, expect, it, vi } from 'vitest'
import { datasetLoaded, selectionReducer } from '../src/app/store'
import { api, type CodebookColumn } from '../src/api/client'
import { codebookSlice, fetchCodebookThunk, codebookReadAccepted, saveCodebookThunk, draftColumnUpdated } from '../src/features/dataset/codebookSlice'

const draft: CodebookColumn = { columnId: 'q', name: 'Q', label: 'Q', role: 'question', scaleType: 'ordinal',
  categoryOrder: [], valueLabels: {}, missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }
const saved = { ...draft, categoryOrder: ['1', '2', '3', '4', '5', '6'] }
afterEach(() => vi.restoreAllMocks())

function setup() {
  const local = configureStore({ reducer: { codebook: codebookSlice.reducer, selection: selectionReducer },
    middleware: get => get({ serializableCheck: false }) })
  local.dispatch(datasetLoaded({ datasetId: 'd', name: 'D', rowIds: ['r1'], dataRevision: 1 }))
  local.dispatch(fetchCodebookThunk.pending('load', 'd'))
  local.dispatch(codebookReadAccepted({ datasetId: 'd', schemaRevision: 1, columns: [draft] }, 'load'))
  return local
}

it('uses the server-normalized order immediately after save, identically to reloading', async () => {
  const local = setup()
  const canonical = { datasetId: 'd', schemaRevision: 2, columns: [saved], multiResponseGroups: [] }
  vi.spyOn(api, 'put').mockResolvedValue({ datasetId: 'd', schemaRevision: 2, codebook: canonical })
  await local.dispatch(saveCodebookThunk())
  expect(local.getState().codebook.columns).toEqual([saved])
  expect(local.getState().codebook.draftColumns).toEqual([saved])
  expect(local.getState().codebook.hasChanges).toBe(false)
  vi.spyOn(api, 'get').mockResolvedValue(canonical)
  await local.dispatch(fetchCodebookThunk('d'))
  expect(local.getState().codebook.columns).toEqual([saved])
})

it('keeps a newer draft while exposing the normalized saved snapshot', async () => {
  const local = setup()
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'put').mockImplementation(() => new Promise(resolve => { finish = resolve }) as any)
  const saving = local.dispatch(saveCodebookThunk())
  local.dispatch(draftColumnUpdated({ columnId: 'q', patch: { label: 'unsaved next edit' } }))
  finish({ datasetId: 'd', schemaRevision: 2, codebook: { datasetId: 'd', schemaRevision: 2, columns: [saved] } })
  await saving
  expect(local.getState().codebook.columns).toEqual([saved])
  expect(local.getState().codebook.draftColumns[0].label).toBe('unsaved next edit')
  expect(local.getState().codebook.hasChanges).toBe(true)
})

it('does not roll back a saved license when an older same-dataset fetch completes', async () => {
  const { saveLicenseTextThunk, licenseMetadataReceived } = await import('../src/features/dataset/codebookSlice')
  const local = setup()
  local.dispatch(licenseMetadataReceived({ datasetId: 'd', licenseText: 'before', licenseRevision: 2 }))
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'get').mockImplementation(() => new Promise(resolve => { finish = resolve }) as any)
  const fetch = local.dispatch(fetchCodebookThunk('d'))
  vi.spyOn(api, 'put').mockResolvedValue({ codebook: { licenseText: 'latest', licenseRevision: 3 } })
  await local.dispatch(saveLicenseTextThunk({ datasetId: 'd', licenseText: 'latest', expectedLicenseRevision: 2 }))
  finish({ datasetId: 'd', schemaRevision: 1, columns: [draft], licenseText: 'before', licenseRevision: 2 })
  await fetch
  expect(local.getState().codebook.licenseText).toBe('latest')
  expect(local.getState().codebook.licenseRevision).toBe(3)
})
