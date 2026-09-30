import { configureStore } from '@reduxjs/toolkit'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type CodebookColumn } from '../src/api/client'
import { codebookSlice, fetchCodebookThunk, saveCodebookThunk, draftColumnUpdated } from '../src/features/dataset/codebookSlice'

const draft: CodebookColumn = { columnId: 'q', name: 'Q', label: 'Q', role: 'question', scaleType: 'ordinal',
  categoryOrder: [], valueLabels: {}, missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }
const saved = { ...draft, categoryOrder: ['1', '2', '3', '4', '5', '6'] }
afterEach(() => vi.restoreAllMocks())

function setup() {
  const local = configureStore({ reducer: { codebook: codebookSlice.reducer } })
  local.dispatch(fetchCodebookThunk.pending('load', 'd'))
  local.dispatch(fetchCodebookThunk.fulfilled({ datasetId: 'd', schemaRevision: 1, columns: [draft] }, 'load', 'd'))
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
