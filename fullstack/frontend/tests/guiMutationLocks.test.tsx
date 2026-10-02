import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { api, importCodebook } from '../src/api/client'
import BinningModal from '../src/features/dataset/BinningModal'
import OneHotModal from '../src/features/dataset/OneHotModal'
import ImputationModal from '../src/features/dataset/ImputationModal'
import CodebookCsvImportDialog from '../src/features/dataset/CodebookCsvImportDialog'
import VerificationConfigModal from '../src/features/mining/VerificationConfigModal'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
vi.mock('../src/features/charts/EChart',()=>({default:()=>null}))
vi.mock('../src/features/charts/EChartSurface',()=>({default:()=>null}))
vi.mock('../src/features/common/ColumnSelect',()=>({default:()=>null}))
vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), importCodebook:vi.fn() }))
afterEach(()=>{cleanup();vi.restoreAllMocks()})
function deferred(){let resolve!: (v:any)=>void;let reject!: (e:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function wrap(ui:React.ReactNode,active=true){return <Provider store={store}><AnalysisViewActivityContext.Provider value={active}>{ui}</AnalysisViewActivityContext.Provider></Provider>}
const binPreview={column:'x',method:'equal_width',edges:[0,1],bins:[{binIndex:0,label:'BIN',min:0,max:1,count:1,ratio:1}],histogram:{counts:[],edges:[0,1]},min:0,max:1,count:1}

describe('I22 shared in-flight mutation contract',()=>{
 it.each(['binning','onehot','imputation'] as const)('%s disables editing, cancellation and repeated submit; restores controls on failure',async(kind)=>{
  const pending=deferred(),close=vi.fn(),success=vi.fn()
  const post=vi.spyOn(api,'post')
  if(kind==='binning')post.mockResolvedValueOnce(binPreview as any)
  post.mockReturnValue(pending.promise)
  const ui=kind==='binning'?<BinningModal open datasetId="d" columnName="x" onClose={close} onSuccess={success}/>
    :kind==='onehot'?<OneHotModal open datasetId="d" columnName="x" categories={['a','b']} onClose={close} onSuccess={success}/>
    :<ImputationModal open datasetId="d" columnsWithMissing={[{name:'x',missing:1,total:3}]} onClose={close} onSuccess={success}/>
  render(wrap(ui))
  const submit=screen.getByRole('button',{name:kind==='binning'?'ビン列を生成':kind==='onehot'?'0/1二値列を生成':'補完を適用'})
  await waitFor(()=>expect(submit).toBeEnabled())
  fireEvent.click(submit);fireEvent.click(submit)
  expect(post).toHaveBeenCalledTimes(kind==='binning'?2:1)
  expect(screen.getByRole('button',{name:'キャンセル'})).toBeDisabled()
  expect(screen.queryByRole('button',{name:'Close'})).not.toBeInTheDocument()
  for(const input of screen.getAllByRole('textbox'))expect(input).toBeDisabled()
  for(const checkbox of screen.queryAllByRole('checkbox'))expect(checkbox).toBeDisabled()
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape',keyCode:27})
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByText('データを更新しています。処理中は編集・キャンセルできません。')).toBeInTheDocument()
  await act(async()=>{pending.reject(new Error('SAVE_FAILED'));try{await pending.promise}catch{}})
  expect(screen.getByRole('button',{name:'キャンセル'})).toBeEnabled()
  expect(submit).toBeEnabled()
  expect(success).not.toHaveBeenCalled()
 })
 it('one-hot completion reports its original dataset without closing the new dialog',async()=>{
  const pending=deferred(),success=vi.fn(),close=vi.fn()
  vi.spyOn(api,'post').mockReturnValue(pending.promise)
  const ui=(id:string)=><OneHotModal open datasetId={id} columnName="x" categories={['a','b']} onClose={close} onSuccess={success}/>
  const view=render(wrap(ui('old')))
  fireEvent.click(screen.getByRole('button',{name:'0/1二値列を生成'}))
  view.rerender(wrap(ui('new')))
  await act(async()=>{pending.resolve({});await pending.promise})
  expect(success).toHaveBeenCalledWith('old');expect(close).not.toHaveBeenCalled()
 })
 it('codebook import disables upload and every modal dismissal while committing',async()=>{
  const pending=deferred(),close=vi.fn(),success=vi.fn()
  vi.mocked(importCodebook).mockReturnValue(pending.promise)
  const view=render(wrap(<CodebookCsvImportDialog open datasetId="d" onClose={close} onSuccess={success}/>))
  const fileInput=document.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(fileInput,{target:{files:[new File(['name,label\nx,X'],'dictionary.csv',{type:'text/csv'})]}})
  const submit=screen.getByRole('button',{name:'インポート実行'})
  await waitFor(()=>expect(submit).toBeEnabled())
  fireEvent.click(submit);fireEvent.click(submit)
  expect(importCodebook).toHaveBeenCalledOnce()
  expect(screen.getByRole('button',{name:'キャンセル'})).toBeDisabled()
  expect(document.querySelector('input[type=file]')).toBeDisabled()
  expect(screen.queryByRole('button',{name:'Close'})).not.toBeInTheDocument()
  view.unmount()
  await act(async()=>{pending.resolve({updatedColumns:1,schemaRevision:2});await pending.promise})
  expect(success).toHaveBeenCalledWith('d');expect(close).not.toHaveBeenCalled()
 })
 it('I09 hides the mining modal on route change and calls its close handler',async()=>{
  const close=vi.fn()
  const ui=<VerificationConfigModal open candidateCount={2} candidateSetHash="hash" datasets={[]} currentDatasetId="d" alpha={0.05} onCancel={close} onRun={()=>{}}/>
  const view=render(wrap(ui))
  await waitFor(()=>expect(screen.getByRole('dialog')).toBeVisible())
  view.rerender(wrap(ui,false))
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(close).toHaveBeenCalled()
 })
})
