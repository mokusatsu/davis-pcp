import { getInstanceByDom } from 'echarts'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { api } from '../src/api/client'
import { store, selectionApplied } from '../src/app/store'
import * as selectionMenu from '../src/features/selection/SelectionMenu'
import MultiResponseBarChart from '../src/features/barchart/MultiResponseBarChart'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const summary = { groupId: 'services', label: '利用サービス',
  denominators: { total: 3, target: 3, valid: 2, partial: 1, invalid: 0, missing: 0, notApplicable: 0 },
  allUnselectedN: 1, totalResponses: 1,
  items: [{ columnId: 'A', name: 'A', label: 'サービスA', selectedN: 1, selectedInSelection: 0, pctRespondent: 50, pctResponse: 100 }] }
function setup() {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 2, selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, activeRowIds: ['r2', 'r7', 'r9'], totalRowIds: ['r2', 'r7', 'r9'] },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'ma', groupId: 'services' }] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 3, isLoading: false,
      columns: [{ columnId: 'A', name: 'A', role: 'question', scaleType: 'nominal', multiResponseGroup: 'services' },
        { columnId: 'area', name: 'Area', label: '地域', role: 'attribute', scaleType: 'nominal' }],
      multiResponseGroups: [{ groupId: 'services', label: '利用サービス' }] } }
  const local = configureStore({ reducer: (s = state, action: any) => action.type === 'test/scope'
    ? { ...s, globalObservations: { ...s.globalObservations, activeRowIds: action.payload } } : s,
    middleware: get => get({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const post = vi.spyOn(api, 'post').mockImplementation(async path => path.endsWith('/matches') ? { rowIds: ['r9'] } as any
    : path.endsWith('/comparison') ? { attributeMissingExcluded: 0, strata: [{ code: 'F', label: '女性', summary }] } as any
      : { groups: [summary] } as any)
  const view = render(<Provider store={local}><MultiResponseBarChart /></Provider>)
  return { local, dispatch, post, view }
}

it.each(['replace', 'add', 'subtract', 'toggle'] as const)('uses %s and the attribute code when selecting a bar', async operation => {
  vi.spyOn(selectionMenu, 'getBrushOp').mockReturnValue(operation)
  const { view, dispatch, post } = setup()
  await waitFor(() => expect(view.getByRole('button', { name: 'A 全体の回答者を選択' })).toBeEnabled())
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'MA比較属性' }))
  fireEvent.click(await view.findByText('Area — 地域'))
  const bar = await view.findByRole('button', { name: 'A 女性の回答者を選択' })
  await waitFor(() => expect(bar).toBeEnabled())
  expect(view.getByTestId('ma-barchart')).toHaveTextContent('1人 / 50.0%')
  fireEvent.click(bar)
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: selectionApplied.type,
    payload: expect.objectContaining({ rowIds: ['r9'], operation }) })))
  expect(post).toHaveBeenLastCalledWith('/datasets/d/matches', expect.objectContaining({
    groupId: 'services', optionColumnIds: ['A'], attributeFilter: { columnId: 'area', code: 'F' },
    rowIds: ['r2', 'r7', 'r9'], expectedDataRevision: 2, expectedSchemaRevision: 3,
  }))
})

it('ignores delayed matches after scope changes and after unmount', async () => {
  const { view, local, dispatch, post } = setup()
  let finish!: (value: any) => void
  await waitFor(() => expect(view.getByRole('button', { name: 'A 全体の回答者を選択' })).toBeEnabled())
  post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(view.getByRole('button', { name: 'A 全体の回答者を選択' }))
  act(() => { local.dispatch({ type: 'test/scope', payload: [] }) })
  dispatch.mockClear()
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/summaries/multi-response', expect.objectContaining({ rowIds: [] })))
  await act(async () => { finish({ rowIds: ['obsolete'] }) })
  expect(dispatch).not.toHaveBeenCalled()
  await waitFor(() => expect(view.getByRole('button', { name: 'A 全体の回答者を選択' })).toBeEnabled())
  post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(view.getByRole('button', { name: 'A 全体の回答者を選択' }))
  view.unmount()
  await act(async () => { finish({ rowIds: ['after-unmount'] }) })
  expect(dispatch).not.toHaveBeenCalled()
})

it('pages comparison categories without changing the global count scale', async () => {
  const { view, post } = setup()
  await waitFor(() => expect(view.getByRole('button', { name: 'A 全体の回答者を選択' })).toBeEnabled())
  post.mockImplementationOnce(async () => ({ attributeMissingExcluded: 0,
    strata: Array.from({ length: 21 }, (_, index) => ({ code: String(index), label: `群${index}`,
      summary: { ...summary, items: [{ ...summary.items[0], selectedN: index === 20 ? 100 : 1 }] } })) }) as any)
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'MA比較属性' }))
  fireEvent.click(await view.findByText('Area — 地域'))
  await view.findByRole('button', { name: 'A 群0の回答者を選択' })
  expect(view.getAllByRole('button', { name: /の回答者を選択$/ })).toHaveLength(10)
  const chart = getInstanceByDom(view.getByTestId('ma-grouped-chart'))!
  expect((chart.getOption().xAxis as any)[0].max).toBe(100)
  expect((chart.getOption().series as any)[0].data[0].value).toBe(1)
  fireEvent.click(view.getByTitle('3'))
  expect(view.getAllByRole('button', { name: /の回答者を選択$/ })).toHaveLength(1)
  expect((chart.getOption().xAxis as any)[0].max).toBe(100)
  expect((chart.getOption().series as any)[0].data[0].value).toBe(100)
  expect(post).toHaveBeenCalledTimes(2)
})
