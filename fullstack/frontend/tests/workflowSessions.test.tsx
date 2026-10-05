import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AppShell from '../src/app/AppShell'
import { store, selectionReducer, globalObservationsSlice, globalVariablesSlice, datasetLoaded, variablesInitialized, selectionApplied } from '../src/app/store'
import { codebookSlice, fetchCodebookThunk } from '../src/features/dataset/codebookSlice'

const apiMock = vi.hoisted(() => ({get: vi.fn(),post: vi.fn(),put: vi.fn(),upload: vi.fn(),view: vi.fn(),getCodebook: vi.fn(), notification:{success:vi.fn(), error:vi.fn(), info:vi.fn(), warning:vi.fn()}}))
vi.mock('../src/app/KeepAliveOutlet', () => ({ default: () => <div>Analysis content</div> }))
vi.mock('../src/features/common/LicenseModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookEditorModal', () => ({ default: () => null }))
vi.mock('../src/features/selection/GlobalHeaderControlBar', () => ({ default: () => null }))
vi.mock('../src/theme/useL1Selection', () => ({ useL1Selection: () => {} }))
vi.mock('../src/api/client', () => ({ api: apiMock, fetchArrowView: apiMock.view, getCodebook:apiMock.getCodebook, downloadExport:vi.fn() }))
vi.mock('antd', async importOriginal => {const actual = await importOriginal<typeof import('antd')>(); return {...actual, notification:{...actual.notification,useNotification:()=>[apiMock.notification,null]}}})
const list = [{datasetId:'a',name:'Data A',rowCount:2},{datasetId:'b',name:'Data B',rowCount:2},{datasetId:'c',name:'Data C',rowCount:2}]
const meta=(id:string)=>({name:`Data ${id.toUpperCase()}`,dataRevision:1,schema:[{columnId:`${id}x`,name:`${id}x`,semanticType:'numeric'}]})
const codebook=(id:string)=>({datasetId:id,schemaRevision:1,columns:[{columnId:`${id}x`,name:`${id}x`,scaleType:'ratio'}],multiResponseGroups:[]})
function deferred<T>() { let resolve!:(value:T)=>void; let reject!:(reason:any)=>void; const promise = new Promise<T>((res,rej)=>{resolve=res;reject=rej});return{promise,resolve,reject} }
function localStore(initialDataset:string|null='a') {
 const base=store.getState(); const local=configureStore({reducer:(state=base,action:any)=>({...state,selection:selectionReducer(state.selection,action), globalVariables:globalVariablesSlice.reducer(state.globalVariables,action),globalObservations:globalObservationsSlice.reducer(state.globalObservations,action),codebook:codebookSlice.reducer(state.codebook,action)}),middleware:get=>get({serializableCheck:false})})
 if(initialDataset){local.dispatch(datasetLoaded({datasetId:initialDataset,name:`Data ${initialDataset.toUpperCase()}`,rowIds:[`${initialDataset}1`,`${initialDataset}2`],dataRevision:1}));local.dispatch(variablesInitialized({datasetId:initialDataset,variables:[`${initialDataset}x`]}))}
 return local
}
function mount(local=localStore()){const view=render(<Provider store={local}><MemoryRouter initialEntries={['/pcp']}><AppShell /></MemoryRouter></Provider>);return{...view,local}}
async function save(name='saved-a') {fireEvent.click(screen.getByTestId('save-button')); const dialog=(await screen.findByTestId('session-name')).closest('[role=dialog]') as HTMLElement; fireEvent.change(within(dialog).getByTestId('session-name'),{target:{value:name}}); fireEvent.click(within(dialog).getByRole('button',{name:/保\s*存/}));return dialog}
// An error render does not guarantee AntD's internal loading effect has settled.
// Keep the exact accessible name and require an actionable button before one click.
async function readyButton(container:HTMLElement,name:string|RegExp) {
 return waitFor(()=>{
  const button=within(container).getByRole('button',{name});
  expect(button).toBeEnabled();expect(button).not.toHaveClass('ant-btn-loading');
  return button;
 });
}
async function chooseDataset(id:string){fireEvent.mouseDown(screen.getByTestId('dataset-selector').querySelector('.ant-select-selector')!);fireEvent.click(await screen.findByText(`Data ${id.toUpperCase()} (2行)`))}
beforeEach(()=>{vi.clearAllMocks();apiMock.get.mockImplementation(async(path:string)=>path==='/datasets'?{datasets:list}:meta(path.split('/').at(-1)!));apiMock.view.mockImplementation(async(id:string)=>({__rowId__:[`${id}1`,`${id}2`]}));apiMock.getCodebook.mockImplementation(async(id:string)=>codebook(id));apiMock.post.mockResolvedValue({sessionId:'sess-a',revision:1,versionToken:'token-r1'});apiMock.put.mockResolvedValue({sessionId:'sess-a',revision:2,versionToken:'token-r2'})})
afterEach(()=>{cleanup();vi.restoreAllMocks()})


it('WF03: same-dataset saves use the returned token and name, switching datasets creates a new session', async () => {
 const {local}=mount(); await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 await save('A workspace'); await waitFor(()=>expect(apiMock.notification.success).toHaveBeenCalledTimes(1));
 await save('A renamed'); await waitFor(()=>expect(apiMock.put).toHaveBeenCalledTimes(1));
 expect(apiMock.put.mock.calls[0]).toEqual(['/sessions/sess-a',expect.objectContaining({name:'A renamed',versionToken:'token-r1',state:expect.objectContaining({datasetId:'a'})})]);
 await waitFor(()=>expect(apiMock.notification.success).toHaveBeenCalledTimes(2));
 await chooseDataset('b'); await waitFor(()=>expect(local.getState().codebook.datasetId).toBe('b'));
 await save('B workspace'); await waitFor(()=>expect(apiMock.post).toHaveBeenCalledTimes(2));
 expect(apiMock.put).toHaveBeenCalledTimes(1); expect(apiMock.post.mock.calls[1][1].datasetId).toBe('b');
})

it.each(['post','put'] as const)('WF04: %s failure keeps draft and persistent error, explicit retry succeeds', async method => {
 const {local}=mount(); await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 if(method==='put'){await save(); await waitFor(()=>expect(apiMock.notification.success).toHaveBeenCalledTimes(1));}
 apiMock[method].mockRejectedValueOnce({code:'STORAGE_ERROR',message:'DISK_FULL_TEST'});
 const dialog=await save('recoverable-draft'); await within(dialog).findByText(/DISK_FULL_TEST/);
 expect(within(dialog).getByTestId('session-name')).toHaveValue('recoverable-draft');
 const failedAttempts=apiMock[method].mock.calls.length;
 fireEvent.click(await readyButton(dialog,/保\s*存/));
 await waitFor(()=>expect(apiMock[method]).toHaveBeenCalledTimes(failedAttempts+1));
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'セッション保存'})).not.toBeInTheDocument());
})

it('WF04: pending save is single-flight, cannot be cancelled/reopened, and keeps subsequent drafts safe', async () => {
 const first=deferred<any>();apiMock.post.mockImplementationOnce(()=>first.promise);
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));const dialog=await save('first draft');
 const saveButton=within(dialog).getByRole('button',{name:/保\s*存/});fireEvent.click(saveButton);
 expect(apiMock.post).toHaveBeenCalledTimes(1);expect(saveButton).toBeDisabled();
 expect(within(dialog).getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();
 expect(within(dialog).getByTestId('session-name')).toBeDisabled();
 expect(screen.getByTestId('save-button')).toBeDisabled();expect(within(dialog).getByText(/保存処理中は閉じられません/)).toBeInTheDocument();
 await act(async()=>{first.resolve({sessionId:'sess-first',revision:1,versionToken:'first-token'});await first.promise});
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'セッション保存'})).not.toBeInTheDocument());
 fireEvent.click(screen.getByTestId('save-button'));expect(await screen.findByTestId('session-name')).toHaveValue('first draft');
})

it.each(['metadata','codebook','rows'])('WF05: latest request wins when old %s response arrives late', async pending => {
 const old=deferred<any>();
 if(pending==='metadata')apiMock.get.mockImplementation(async(path:string)=>path==='/datasets'?{datasets:list}:path==='/datasets/b'?old.promise:meta(path.split('/').at(-1)!));
 if(pending==='codebook')apiMock.getCodebook.mockImplementation(async(id:string)=>id==='b'?old.promise:codebook(id));
 if(pending==='rows')apiMock.view.mockImplementation(async(id:string)=>id==='b'?old.promise:{__rowId__:[`${id}1`,`${id}2`]});
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));await chooseDataset('b');await chooseDataset('c');
 await waitFor(()=>expect(local.getState().codebook.datasetId).toBe('c'));
 await act(async()=>{old.resolve(pending==='metadata'?meta('b'):pending==='codebook'?codebook('b'):{__rowId__:['b1','b2']});await old.promise});
 expect(local.getState().selection.datasetId).toBe('c');expect(local.getState().selection.allRowIds).toEqual(['c1','c2']);expect(local.getState().codebook.datasetId).toBe('c');
})

it('WF05: failed dataset load leaves current workspace intact and retry recovers', async () => {
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 apiMock.getCodebook.mockRejectedValueOnce(new Error('CODEBOOK_FAILURE'));await chooseDataset('b');await screen.findByText(/CODEBOOK_FAILURE/);
 expect(local.getState().selection.datasetId).toBe('a');expect(local.getState().codebook.datasetId).toBe('a');
 fireEvent.click(screen.getByRole('button',{name:'再試行',exact:true}));await waitFor(()=>expect(local.getState().codebook.datasetId).toBe('b'));
 expect(local.getState().selection.datasetId).toBe('b');expect(screen.queryByText(/CODEBOOK_FAILURE/)).not.toBeInTheDocument();
})

async function savedRecord() {
 const first=mount();await waitFor(()=>expect(first.local.getState().codebook.columns).toHaveLength(1));
 act(()=>first.local.dispatch(selectionApplied({rowIds:['a2'],operation:'replace',label:'keep me'})));
 await save('recover me');await waitFor(()=>expect(apiMock.notification.success).toHaveBeenCalledTimes(1));
 const body=apiMock.post.mock.calls[0][1];first.unmount();
 return {sessionId:'sess-a',revision:3,versionToken:'token-r3',...body};
}
function sessionApi(record:any){apiMock.get.mockImplementation(async(path:string)=>path==='/datasets'?{datasets:list}:path==='/sessions'?{sessions:[record]}:path==='/sessions/sess-a'?record:meta(path.split('/').at(-1)!))}
async function openSaved(){fireEvent.click(screen.getByTestId('open-session-button'));fireEvent.click(await screen.findByRole('button',{name:'recover me を開く'}));}

it('WF06: reopen saved work after remount restores the correct dataset, selection and versionToken', async () => {
 const record=await savedRecord();sessionApi(record);const {local}=mount(localStore('b'));
 await waitFor(()=>expect(local.getState().codebook.datasetId).toBe('b'));await openSaved();
 await waitFor(()=>expect(local.getState().selection.selectedRowIds).toEqual(['a2']));
 expect(local.getState().selection.datasetId).toBe('a');expect(local.getState().codebook.datasetId).toBe('a');
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'保存済みセッションを開く'})).not.toBeInTheDocument());
 await save('restored');await waitFor(()=>expect(apiMock.put).toHaveBeenCalledTimes(1));expect(apiMock.put.mock.calls[0][1].versionToken).toBe('token-r3');
})

it.each(['generation','record-dataset','snapshot-version','unknown-row'])('WF06: rejects %s mismatch without changing the existing workspace', async mismatch => {
 const record=await savedRecord();
 if(mismatch==='generation')record.state.dataRevision=2;
 if(mismatch==='record-dataset')record.datasetId='b';
 if(mismatch==='snapshot-version')record.state.workspaceVersion=42;
 if(mismatch==='unknown-row')record.state.selectedRowIds=['foreign'];
 sessionApi(record);const {local}=mount(localStore('b'));await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 const before=local.getState();await openSaved();await screen.findAllByText(/セッションを開けませんでした/);
 expect(local.getState()).toBe(before);expect(screen.getByRole('dialog',{name:'保存済みセッションを開く'})).toBeInTheDocument();
})

it('WF04/WF06: conflict is explicit; reload obtains current token and snapshot for the next save', async () => {
 const record=await savedRecord();sessionApi(record);const {local}=mount(localStore('a'));await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));await openSaved();
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'保存済みセッションを開く'})).not.toBeInTheDocument());
 apiMock.put.mockRejectedValueOnce({code:'SESSION_CONFLICT',message:'他のクライアントが保存しました'});await save('conflicting draft');await screen.findByText(/保存できませんでした/);
 record.revision=4;record.versionToken='token-r4';record.state.selectedRowIds=['a1'];
 fireEvent.click(screen.getByRole('button',{name:'保存済みを開き直す'}));await waitFor(()=>expect(local.getState().selection.selectedRowIds).toEqual(['a1']));
 await save('retry');await waitFor(()=>expect(apiMock.put).toHaveBeenCalledTimes(2));expect(apiMock.put.mock.calls[1][1].versionToken).toBe('token-r4');
})

it('WF06: a failed session listing has a persistent error and retry; cancelled reads do not reopen it', async () => {
 const listRequest=deferred<any>(); const {local}=mount(); await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 apiMock.get.mockRejectedValueOnce(new Error('LIST_FAILED'));fireEvent.click(screen.getByTestId('open-session-button'));
 await screen.findByText(/LIST_FAILED/);apiMock.get.mockResolvedValueOnce({sessions:[]});
 fireEvent.click(await readyButton(document.body,'一覧を再読込'));
 await screen.findByText('保存済みセッションがありません。');expect(screen.queryByText(/LIST_FAILED/)).not.toBeInTheDocument();
 const completedReads=apiMock.get.mock.calls.length;
 apiMock.get.mockImplementationOnce(()=>listRequest.promise);fireEvent.click(await readyButton(document.body,'一覧を再読込'));
 await waitFor(()=>expect(apiMock.get).toHaveBeenCalledTimes(completedReads+1));
 expect(apiMock.get).toHaveBeenLastCalledWith('/sessions');
 fireEvent.click(screen.getByRole('button',{name:'Close',exact:true}));
 await act(async()=>{listRequest.resolve({sessions:[{sessionId:'old',name:'late record',datasetId:'a',revision:1}]});await listRequest.promise});
 expect(screen.queryByRole('dialog',{name:'保存済みセッションを開く'})).not.toBeInTheDocument();
})

it('WF04: conflict copy saves a separate record while cancelling never writes', async () => {
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));await save('original');await waitFor(()=>expect(apiMock.notification.success).toHaveBeenCalledTimes(1));
 apiMock.put.mockRejectedValueOnce({code:'SESSION_CONFLICT',message:'CONFLICT'});await save('local copy');await screen.findByText(/CONFLICT/);
 fireEvent.click(screen.getByRole('button',{name:'Cancel',exact:true}));expect(apiMock.post).toHaveBeenCalledTimes(1);
 apiMock.put.mockRejectedValueOnce({code:'SESSION_CONFLICT',message:'CONFLICT'});await save('local copy');await screen.findByText(/CONFLICT/);
 fireEvent.click(screen.getByRole('button',{name:'コピーとして保存'}));await waitFor(()=>expect(apiMock.post).toHaveBeenCalledTimes(2));
 expect(apiMock.post.mock.calls[1][1]).toEqual(expect.objectContaining({name:'local copy',datasetId:'a'}));
})

it('WF05: a late old failure does not replace the latest dataset with an error', async () => {
 const old=deferred<any>();apiMock.get.mockImplementation(async(path:string)=>path==='/datasets'?{datasets:list}:path==='/datasets/b'?old.promise:meta(path.split('/').at(-1)!));
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));await chooseDataset('b');await chooseDataset('c');
 await waitFor(()=>expect(local.getState().selection.datasetId).toBe('c'));
 await act(async()=>{old.reject(new Error('OLD_FAILURE'));await old.promise.catch(()=>{})});
 expect(local.getState().codebook.datasetId).toBe('c');expect(screen.queryByText(/OLD_FAILURE/)).not.toBeInTheDocument();
})

it('WF04: Save As opens a named draft and recovers from failure without overwriting the original', async () => {
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));await save('original');await waitFor(()=>expect(apiMock.notification.success).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('button',{name:/Save As$/}));const input=await screen.findByTestId('session-name');expect(input).toHaveValue('original (copy)');
 const dialog=input.closest('[role=dialog]') as HTMLElement;apiMock.post.mockRejectedValueOnce(new Error('COPY_FAILED'));fireEvent.click(within(dialog).getByRole('button',{name:/保\s*存/}));
 await within(dialog).findByText(/COPY_FAILED/);fireEvent.click(await readyButton(dialog,/保\s*存/));
 await waitFor(()=>expect(apiMock.post).toHaveBeenCalledTimes(3));expect(apiMock.put).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'セッション保存'})).not.toBeInTheDocument());
})

it('WF05: a stale background codebook fetch cannot prune variables after a newer prepared install', async () => {
 const old=deferred<any>();const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 apiMock.getCodebook.mockImplementationOnce(()=>old.promise);let pending:any;act(()=>{pending=local.dispatch(fetchCodebookThunk('a'))});
 await chooseDataset('b');await waitFor(()=>expect(local.getState().selection.datasetId).toBe('b'));await chooseDataset('a');await waitFor(()=>expect(local.getState().selection.datasetId).toBe('a'));
 await act(async()=>{old.resolve({...codebook('a'),columns:[]});await pending});
 expect(local.getState().codebook.columns).toHaveLength(1);expect(local.getState().globalVariables.activeEntities).toEqual([{kind:'column',columnId:'ax'}]);
})

it('WF05: import completion cannot undo a later explicit dataset choice', async () => {
 const upload=deferred<any>();apiMock.upload.mockImplementationOnce(()=>upload.promise);
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 const file=new File(['x\n1\n'], 'fixture.csv', {type:'text/csv'});
 fireEvent.change(document.querySelector('input[type=file]')!, {target:{files:[file]}});
 await waitFor(()=>expect(apiMock.upload).toHaveBeenCalledTimes(1));expect(screen.getByTestId('save-button')).toBeDisabled();
 await chooseDataset('c');await waitFor(()=>expect(local.getState().selection.datasetId).toBe('c'));
 await act(async()=>{upload.resolve({datasetId:'b',name:'Data B'});await upload.promise});
 await waitFor(()=>expect(apiMock.notification.success).toHaveBeenCalled());
 expect(local.getState().selection.datasetId).toBe('c');expect(local.getState().codebook.datasetId).toBe('c');
})

it('WF05: current import loads its dataset; failed upload releases the busy state', async () => {
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 const file=new File(['x\n1\n'], 'fixture.csv', {type:'text/csv'});
 apiMock.upload.mockRejectedValueOnce(new Error('UPLOAD_FAILED'));
 fireEvent.change(document.querySelector('input[type=file]')!, {target:{files:[file]}});
 await waitFor(()=>expect(apiMock.notification.error).toHaveBeenCalled());expect(screen.getByTestId('save-button')).toBeEnabled();
 apiMock.upload.mockResolvedValueOnce({datasetId:'b',name:'Data B'});
 fireEvent.change(document.querySelector('input[type=file]')!, {target:{files:[file]}});
 await waitFor(()=>expect(local.getState().selection.datasetId).toBe('b'));expect(local.getState().codebook.datasetId).toBe('b');
})

it('WF05: delayed bootstrap listing cannot overtake an explicit newer dataset selection', async () => {
 const bootstrap=deferred<any>();const selected=deferred<any>();let listings=0;
 apiMock.get.mockImplementation(async(path:string)=>path==='/datasets'?(++listings===1?bootstrap.promise:{datasets:list}):path==='/datasets/c'?selected.promise:meta(path.split('/').at(-1)!));
 const {local}=mount(localStore(null));await waitFor(()=>expect(listings).toBe(1));await chooseDataset('c');
 await act(async()=>{bootstrap.resolve({datasets:list});await bootstrap.promise});
 expect(apiMock.get.mock.calls.some(([path])=>path==='/datasets/a')).toBe(false);
 await act(async()=>{selected.resolve(meta('c'));await selected.promise});
 await waitFor(()=>expect(local.getState().selection.datasetId).toBe('c'));expect(local.getState().codebook.datasetId).toBe('c');
})

it('LICENSE: only explicit dropdown switching shows the saved selected dataset notice, each time', async () => {
 apiMock.getCodebook.mockImplementation(async(id:string)=>({...codebook(id),licenseText:id==='a'?'License A\n©':'License B\n©'}));
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 // AntD retains closed modal content, so node existence alone can find the previous license.
 const selectedLicense=(datasetId:string,text:string)=>waitFor(()=>{
  expect(local.getState().selection.datasetId).toBe(datasetId);
  expect(local.getState().codebook.datasetId).toBe(datasetId);
  const dialog=screen.getByRole('dialog',{name:'ライセンス情報'});
  expect(dialog).toBeVisible();
  expect(within(dialog).getByTestId('dataset-license-text').textContent).toBe(text);
  return dialog;
 });
 expect(screen.queryByRole('dialog',{name:'ライセンス情報'})).not.toBeInTheDocument();
 await chooseDataset('b');const first=await selectedLicense('b','License B\n©');
 fireEvent.click(within(first).getByRole('button',{name:'OK'}));
 await chooseDataset('a');const second=await selectedLicense('a','License A\n©');
 fireEvent.click(within(second).getByRole('button',{name:'OK'}));await chooseDataset('b');
 await selectedLicense('b','License B\n©');
})
it('LICENSE: a stale licensed load cannot show a popup over the later unlicensed selection', async () => {
 const old=deferred<any>();apiMock.getCodebook.mockImplementation(async(id:string)=>id==='b'?old.promise:codebook(id));
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 await chooseDataset('b');await chooseDataset('c');await waitFor(()=>expect(local.getState().selection.datasetId).toBe('c'));
 await act(async()=>{old.resolve({...codebook('b'),licenseText:'OLD LICENSE'});await old.promise});
 expect(screen.queryByRole('dialog',{name:'ライセンス情報'})).not.toBeInTheDocument();
})
it('LICENSE: failed reads show no stale notice; explicit retry shows the correct saved license', async () => {
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 apiMock.getCodebook.mockRejectedValueOnce(new Error('LICENSE_LOAD_FAILED'));await chooseDataset('b');await screen.findByText(/LICENSE_LOAD_FAILED/);
 expect(screen.queryByRole('dialog',{name:'ライセンス情報'})).not.toBeInTheDocument();
 apiMock.getCodebook.mockResolvedValueOnce({...codebook('b'),licenseText:'RETRY LICENSE'});
 fireEvent.click(screen.getByRole('button',{name:'再試行',exact:true}));
 expect((await screen.findByTestId('dataset-license-text')).textContent).toBe('RETRY LICENSE');
})

it('SAMPLES: a delayed lazy sample import cannot replace a later dataset choice or open its license', async () => {
 const old=deferred<any>();apiMock.post.mockImplementationOnce(()=>old.promise);
 apiMock.get.mockImplementation(async(path:string)=>path==='/datasets'?{datasets:list}:path==='/datasets/samples'?{samples:[{id:'wine',name:'Wine',rowCount:178}]}:meta(path.split('/').at(-1)!));
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 fireEvent.mouseDown(screen.getByTestId('dataset-selector').querySelector('.ant-select-selector')!);
 fireEvent.click(await screen.findByText('Wine (178行・組込み)'));
 await waitFor(()=>expect(apiMock.post).toHaveBeenCalledWith('/datasets/import/sample',{sampleId:'wine'}));
 await chooseDataset('c');await waitFor(()=>expect(local.getState().selection.datasetId).toBe('c'));
 await act(async()=>{old.resolve({datasetId:'b'});await old.promise});
 expect(local.getState().selection.datasetId).toBe('c');
 expect(screen.queryByRole('dialog',{name:'ライセンス情報'})).not.toBeInTheDocument();
})
it('SAMPLES: catalog failure leaves ordinary dataset listing and selection usable', async () => {
 apiMock.get.mockImplementation(async(path:string)=>{if(path==='/datasets/samples')throw Error('CATALOG_FAILED');return path==='/datasets'?{datasets:list}:meta(path.split('/').at(-1)!)});
 const {local}=mount();await waitFor(()=>expect(local.getState().codebook.columns).toHaveLength(1));
 await chooseDataset('b');await waitFor(()=>expect(local.getState().selection.datasetId).toBe('b'));
 expect(screen.getByText(/CATALOG_FAILED/)).toBeInTheDocument();
})
it('LICENSE: opening a saved session does not trigger a dropdown-only notice', async () => {
 const record=await savedRecord();sessionApi(record);
 apiMock.getCodebook.mockImplementation(async(id:string)=>({...codebook(id),licenseText:'Session license'}));
 const {local}=mount(localStore('b'));await waitFor(()=>expect(local.getState().codebook.datasetId).toBe('b'));
 await openSaved();await waitFor(()=>expect(local.getState().selection.datasetId).toBe('a'));
 expect(screen.queryByRole('dialog',{name:'ライセンス情報'})).not.toBeInTheDocument();
})

it('SAMPLES: startup never mistakes a similarly named user upload for official Iris', async () => {
 apiMock.get.mockImplementation(async(path:string)=>path==='/datasets'?{datasets:[{datasetId:'a',name:'My iris study',rowCount:2}]}:path==='/datasets/samples'?{samples:[{id:'iris',name:'Iris (built-in sample)',rowCount:150,datasetId:null}]}:meta(path.split('/').at(-1)!));
 const {local}=mount(localStore(null));
 await waitFor(()=>expect(local.getState().selection.datasetId).toBe('a'));
 expect(apiMock.post).not.toHaveBeenCalled();
})
