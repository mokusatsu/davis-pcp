import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/api/client'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../src/app/store'
import StatisticsPage from '../src/features/dataset/StatisticsPage'
import { graphEngine } from '../src/engine/graphClient'
const fixture = vi.hoisted(() => ({ rowIds:['r1','r2'], rowIndex:new Map([['r1',0],['r2',1]]), schema:[{columnId:'x',name:'X',semanticType:'numeric'}], columns:{X:[10,90]}, numeric:{X:new Float64Array([10,90])}, minMax:{X:{min:10,max:90}},categories:{} }))
vi.mock('../src/features/pcp/useDatasetColumns',()=>({useColumnarData:()=>fixture}))
vi.mock('../src/engine/graphClient',()=>({graphEngine:{describeNumeric:vi.fn()}}))
vi.mock('../src/features/common/ColumnTable',()=>({default:({dataSource}:any)=><pre data-testid="stats-json">{JSON.stringify(dataSource)}</pre>}))
vi.mock('../src/features/charts/EChartSurface',()=>({default:()=>null}))
vi.mock('../src/features/common/L1Legend',()=>({default:()=>null}))
vi.mock('../src/features/dataset/MultiResponseStatistics',()=>({default:()=>null}))
vi.mock('../src/features/common/GraphPanel',()=>({default:({children}:any)=><div>{children}</div>,useGraphPopupContainer:()=>undefined}))
vi.mock('../src/features/common/GraphExpansion',()=>({useGraphExpansion:()=>({openWhenAvailable:()=>{},session:null})}))
function localStore(){const base=store.getState();const initial={...base,selection:{...base.selection,datasetId:'d',allRowIds:fixture.rowIds,activeRowIds:fixture.rowIds,selectedRowIds:[]},globalVariables:{...base.globalVariables,activeEntities:[{kind:'column',columnId:'x'}]},codebook:{...base.codebook,datasetId:'d',columns:[{columnId:'x',name:'X',label:'X',role:'question',scaleType:'ratio',missingCodes:[],missingReasons:{},valueLabels:{},categoryOrder:[],isReversed:false,multiResponseGroup:null}]}};return configureStore({reducer:(state=initial,a:any)=>a.type==='test/scope'?{...state,selection:{...state.selection,activeRowIds:a.payload}}:state,middleware:g=>g({serializableCheck:false})})}
// Explicit unweighted transport mock for the independent numeric companion.
beforeEach(() => { vi.spyOn(api, 'post').mockImplementation(async (_path, body: any) => ({
  datasetId: body.datasetId, dataRevision: body.expectedDataRevision, schemaRevision: body.expectedSchemaRevision,
  weightStatus: 'omitted', columns: {},
}) as any) })
afterEach(()=>{cleanup();vi.clearAllMocks();vi.restoreAllMocks()})
it('WF-02 clears old-scope values, explains failure and retries the current input', async () => {
  const call = vi.mocked(graphEngine.describeNumeric)
  call.mockResolvedValueOnce([2,0,50,56.57,10,10,50,90,90])
  const local = localStore()
  const view = render(<Provider store={local}><MemoryRouter><StatisticsPage/></MemoryRouter></Provider>)
  await waitFor(() => expect(view.getByTestId('stats-json')).toHaveTextContent('"mean":"50.000"'))
  call.mockRejectedValueOnce(new Error('graph worker failed'))
  act(() => local.dispatch({ type: 'test/scope', payload: ['r1'] }))
  expect(view.getByTestId('stats-json')).not.toHaveTextContent('50.000')
  await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('集計に失敗'))
  expect(view.getByTestId('analysis-scope-summary')).toHaveTextContent('1行')
  expect(view.getByTestId('stats-json')).toHaveTextContent('[]')
  call.mockResolvedValueOnce([1,0,10,0,10,10,10,10,10])
  fireEvent.click(view.getByRole('button', { name: '再試行' }))
  await waitFor(() => expect(view.getByTestId('stats-json')).toHaveTextContent('"mean":"10.000"'))
  expect(view.queryByRole('alert')).toBeNull()
  expect(call).toHaveBeenLastCalledWith(new Float64Array([10]))
})

it.each(['success', 'failure'])('ignores a superseded request that ends in %s', async (completion) => {
  const call = vi.mocked(graphEngine.describeNumeric)
  let resolve!: (value: number[]) => void
  let reject!: (error: Error) => void
  call.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no }))
  const local = localStore()
  const view = render(<Provider store={local}><MemoryRouter><StatisticsPage/></MemoryRouter></Provider>)
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  expect(view.getByTestId('stats-json')).toHaveTextContent('[]')
  call.mockResolvedValueOnce([1,0,10,0,10,10,10,10,10])
  act(() => local.dispatch({ type: 'test/scope', payload: ['r1'] }))
  await waitFor(() => expect(view.getByTestId('stats-json')).toHaveTextContent('"mean":"10.000"'))
  await act(async () => {
    if (completion === 'success') resolve([2,0,50,56.57,10,10,50,90,90])
    else reject(new Error('obsolete failure'))
  })
  expect(view.getByTestId('stats-json')).toHaveTextContent('"mean":"10.000"')
  expect(view.queryByRole('alert')).toBeNull()
})

it('positive control: successful refresh replaces mean with the actual selected working row',async()=>{
const call=vi.mocked(graphEngine.describeNumeric);call.mockResolvedValueOnce([2,0,50,56.57,10,10,50,90,90]);const local=localStore();const view=render(<Provider store={local}><MemoryRouter><StatisticsPage/></MemoryRouter></Provider>);
await waitFor(()=>expect(view.getByTestId('stats-json')).toHaveTextContent('"mean":"50.000"'));call.mockResolvedValueOnce([1,0,10,0,10,10,10,10,10]);act(()=>local.dispatch({type:'test/scope',payload:['r1']}));await waitFor(()=>expect(view.getByTestId('stats-json')).toHaveTextContent('"mean":"10.000"'));expect(view.getByTestId('stats-json')).toHaveTextContent('"count":1');
})
