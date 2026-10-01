import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import LineMosaicPage from '../src/features/mosaic/LineMosaicPage'

vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => { throw new Error('No full column read') } }))
vi.mock('../src/features/pcp/MaAxisPicker', () => ({ default: ({ onAdd }: any) => <button onClick={() => onAdd([{ columnId: 'A' }])}>MA追加</button> }))
vi.mock('../src/features/mosaic/MosaicControlPanel', () => ({ MosaicControlPanel: (p: any) => <>
  <span data-testid="candidates">{p.allColumns.join(',')}</span>
  <button onClick={() => p.onColVarsChange(['Area'])}>属性を指定</button>
  <button onClick={() => p.onRowVarsChange(['A'])}>MAを指定</button>
  <button onClick={() => { p.onColVarsChange([]) }}>列を解除</button>
</> }))
vi.mock('../src/features/mosaic/LineMosaicCanvas', () => ({
  LineMosaicCanvas: ({ mosaicData }: any) => <div data-testid="mosaic-result">{mosaicData.evidenceClass}</div>,
  lineMosaicDimensions: () => ({ width: 720, height: 480 }),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup() {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, selectedRowIds: ['r7'] },
    globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: [] } },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column', columnId: 'Area' }, { kind: 'column', columnId: 'score' }, { kind: 'ma', groupId: 'g' }] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns: [
      { name: 'Area', columnId: 'Area', role: 'attribute', scaleType: 'nominal' },
      { name: 'score', columnId: 'score', role: 'question', scaleType: 'ratio' },
      { name: 'hidden', columnId: 'hidden', role: 'question', scaleType: 'nominal' },
      { name: 'A', columnId: 'A', role: 'question', scaleType: 'nominal', multiResponseGroup: 'g' }] } }
  const local = configureStore({ reducer: (current = state, action: any) => action.type === 'test/scope'
    ? { ...current, globalObservations: { ...current.globalObservations, scopeMode: 'sampled', sampling: { ...current.globalObservations.sampling, sampledRowIds: ['r7'] } } }
    : action.type === 'test/revision' ? { ...current, selection: { ...current.selection, dataRevision: 4 } } : current })
  return { local, view: render(<Provider store={local}><LineMosaicPage /></Provider>) }
}
const result: any = { evidenceClass: 'current-result', cells: [{ rowIds: ['r7'], totalCount: 1 }],
  target: null, maxCellFrequency: 1, scopeCount: 1, usedRows: 1, excludedRowCount: 0 }
const emptyResult: any = { ...result, evidenceClass: 'empty-result', cells: [],
  scopeCount: 0, usedRows: 0, excludedRowCount: 0 }

it('uses dictionary candidates, explicit MA, strict scope and revisions without raw data', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  const { view, local } = setup()
  expect(post).not.toHaveBeenCalled()
  expect(view.getByTestId('candidates')).toHaveTextContent(/^Area$/)
  fireEvent.click(view.getByText('MA追加'))
  expect(view.getByTestId('candidates')).toHaveTextContent('Area,A')
  fireEvent.click(view.getByText('属性を指定'))
  await view.findByTestId('mosaic-result')
  expect(view.getByTestId('mosaic-scope-summary')).toHaveTextContent('対象1行')
  fireEvent.click(view.getByText('MAを指定'))
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/summaries/line_mosaic', expect.objectContaining({
    columnVariables: ['Area'], rowVariables: ['A'], rowIds: [], expectedDataRevision: 3, expectedSchemaRevision: 2 })))
  expect(local.getState().selection.selectedRowIds).toEqual(['r7'])
})

it('renders an empty scope as a zero-result summary instead of an error', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(emptyResult)
  const { view } = setup()
  fireEvent.click(view.getByText('属性を指定'))
  await view.findByTestId('mosaic-scope-summary')
  expect(view.getByTestId('mosaic-scope-summary')).toHaveTextContent('対象0行')
  expect(view.getByTestId('mosaic-scope-summary')).toHaveTextContent('使用0行')
  expect(view.queryByTestId('mosaic-result')).toBeNull()
  expect(post).toHaveBeenLastCalledWith('/summaries/line_mosaic', expect.objectContaining({ rowIds: [] }))
})

it.each(['scope', 'revision', 'unmount'])('ignores a delayed mosaic response after %s', async change => {
  let finish!: (value: any) => void
  vi.spyOn(api, 'post').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { view, local } = setup()
  fireEvent.click(view.getByText('属性を指定'))
  const oldFinish = finish
  if (change === 'unmount') view.unmount()
  else act(() => { local.dispatch({ type: `test/${change}` }) })
  await act(async () => { oldFinish(result) })
  expect(view.queryByTestId('mosaic-result')).toBeNull()
  if (change !== 'unmount') {
    await act(async () => { finish(result) })
    expect(view.getByTestId('mosaic-result')).toHaveTextContent('current-result')
  }
})
