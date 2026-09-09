import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { buildL1Domains, useDatasetL1ColorDomains, type L1ColorDomain } from '../src/theme/useL1ColorDomain'

const post = vi.hoisted(() => vi.fn())
vi.mock('../src/api/client', () => ({ api: { post } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shares compact domain requests, matches raw category ordering, and hides stale revisions', async () => {
  const base = store.getState()
  const columns = [{ columnId: 'q', name: 'Q', categoryOrder: ['10', 'unused'], missingCodes: ['99'] }]
  const state = configureStore({ reducer: (s = { ...base,
    selection: { ...base.selection, datasetId: 'domain-projection' },
    codebook: { ...base.codebook, datasetId: 'domain-projection', schemaRevision: 1, columns },
  }, action: any) => action.type === 'revision' ? { ...s, codebook: { ...s.codebook, schemaRevision: 2 } } : s,
  middleware: g => g({ serializableCheck: false }) })
  post.mockResolvedValueOnce({ domains: [{ key: 'Q', codes: ['2', '10'], counts: [2, 1], numeric: true }] })
  const seen: (L1ColorDomain[] | null)[] = []
  function Probe({ index }: { index: number }) { seen[index] = useDatasetL1ColorDomains('domain-projection'); return null }
  render(<Provider store={state}><Probe index={0} /><Probe index={1} /></Provider>)
  await waitFor(() => expect(seen[0]).not.toBeNull())
  expect(seen[0]).toBe(seen[1])
  expect(post).toHaveBeenCalledTimes(1)
  const raw = buildL1Domains({ schema: [{ name: 'Q', semanticType: 'numeric', columnId: 'q' }],
    columns: { Q: [2, 10, 2, 99, null] }, rowIds: [], rowIndex: new Map(), numeric: {}, categories: {}, minMax: {} }, columns as any)
  expect(seen[0]?.[0].codes).toEqual(raw[0].codes)
  expect(seen[0]?.[0].entropy).toBeCloseTo(0.918295834)
  let finish: (value: unknown) => void = () => {}
  post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  act(() => { state.dispatch({ type: 'revision' }) })
  expect(seen).toEqual([null, null])
  await act(async () => { finish({ domains: [] }) })
  await waitFor(() => expect(seen[0]).toEqual([]))
  expect(post).toHaveBeenCalledTimes(2)
})
