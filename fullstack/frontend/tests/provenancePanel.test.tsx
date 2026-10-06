import { cleanup, render, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import ProvenanceHistoryPanel from '../src/features/dataset/ProvenanceHistoryPanel'

vi.mock('../src/features/pcp/useDatasetColumns', () => ({
  invalidateColumnarCache: vi.fn(),
  useColumnarData: () => null,
}))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('renders provenance steps with revert actions', async () => {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1 },
    provenance: { ...base.provenance, ready: true,
      datasetId: 'd', dataRevision: 3, schemaRevision: 1, currentOperationId: 'op-2',
      rawDataRevision: 1, maskRevision: 1, maskFilter: 'all', loading: false, error: null,
      steps: [
        { operationId: 'op-1', operation: 'import', outputDataRevision: 1, timestamp: 't1', algorithmVersion: 'import-1' },
        { operationId: 'op-2', operation: 'impute', outputDataRevision: 2, timestamp: 't2', algorithmVersion: 'impute-mean-1' },
      ],
    },
  }
  const local = configureStore({ reducer: (s = state) => s,
    middleware: get => get({ serializableCheck: false }) })
  vi.spyOn(api, 'get').mockResolvedValue({
    datasetId: 'd', dataRevision: 3, schemaRevision: 1, currentOperationId: 'op-2',
    rawDataRevision: 1, maskRevision: 1, steps: [],
  })
  const view = render(<Provider store={local}><MemoryRouter><ProvenanceHistoryPanel /></MemoryRouter></Provider>)
  await waitFor(() => expect(view.getByTestId('provenance-panel')).toBeTruthy())
  const panel = view.getByTestId('provenance-panel')
  // Preserve control order and the import association; geometry needs browser QA.
  const actionNames = ['再現パッケージ出力', '再現パッケージ取込', 'Revert to Raw', 'Undo', 'Redo']
  const actions = actionNames.map(name => within(panel).getByRole('button', { name, exact: true }))
  expect(within(panel).getAllByRole('button').slice(0, 5)).toEqual(actions)
  const title = within(panel).getByText('データ来歴・操作履歴')
  expect(title.compareDocumentPosition(actions[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(panel.querySelector('input[type="file"][accept=".zip"]')?.closest('label'))
    .toContainElement(actions[1])
  expect(view.container.textContent).toContain('Revert to Raw')
  expect(view.container.textContent).toContain('impute')
  expect(view.container.textContent).toContain('この履歴へ戻す')
})
