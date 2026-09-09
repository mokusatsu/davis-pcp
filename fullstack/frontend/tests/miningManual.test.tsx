import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import SubgroupMiningPage from '../src/features/mining/SubgroupMiningPage'

vi.mock('../src/features/common/FocusMode', () => ({ useFocusMode: () => ({ focused: false }), FocusTarget: ({ children }: any) => children, FocusEnterButton: () => null }))
vi.mock('../src/features/mining/useMiningTargets', () => ({ useMiningTargets: () => ({ attributes: ['x'], questions: ['a'], ready: true, control: <span>Targets</span> }) }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('never executes either mining method on entry, mode changes or tab switches', async () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    globalObservations: { ...base.globalObservations, activeRowIds: ['r1', 'r2'] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2 },
  }), middleware: g => g({ serializableCheck: false }) })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ run_id: 'run', mode: 'standard', summary: {}, insights: [] })
  const view = render(<Provider store={local}><MemoryRouter><SubgroupMiningPage /></MemoryRouter></Provider>)
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(view.getByText('複合条件のみ'))
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: /指定対象で実行/ }))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenLastCalledWith('/mining/modern-subgroup', expect.objectContaining({ attributeCols: ['x'], targetQuestions: ['a'],
    rowIds: ['r1', 'r2'], expectedSchemaRevision: 2, expectedDataRevision: 3 }))
  fireEvent.click(view.getByRole('tab', { name: /単変量総当たり/ }))
  expect(post).toHaveBeenCalledTimes(1)
  fireEvent.click(view.getByTestId('mining-run-button'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect(post).toHaveBeenLastCalledWith('/mining/subgroups', expect.objectContaining({ attributeCols: ['x'], questionCols: ['a'],
    rowIds: ['r1', 'r2'], expectedSchemaRevision: 2, expectedDataRevision: 3 }))
})
