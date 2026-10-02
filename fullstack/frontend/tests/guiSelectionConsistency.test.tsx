import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { store, datasetLoaded, groupsReplaced, selectionApplied, pcpStateChanged } from '../src/app/store'
import SelectionMenu, { getBrushOp } from '../src/features/selection/SelectionMenu'
import PointerSelectionDropdown from '../src/features/selection/PointerSelectionDropdown'
import GlobalHeaderControlBar from '../src/features/selection/GlobalHeaderControlBar'
import { SELECTION_LABELS } from '../src/features/selection/selectionLabels'
vi.mock('../src/theme/useL1ColorDomain',()=>({useDatasetL1ColorDomains:()=>[]}))
vi.mock('../src/features/common/L1Legend',()=>({default:()=>null}))
vi.mock('../src/features/common/ColumnSelect',()=>({default:()=>null}))
vi.mock('../src/features/selection/VariableSelectionModal',()=>({default:()=>null}))
vi.mock('../src/features/selection/ObservationModal',()=>({default:()=>null}))
afterEach(()=>cleanup())
beforeEach(()=>{store.dispatch(datasetLoaded({datasetId:'d',name:'D',rowIds:['a','b','c']}));store.dispatch(pcpStateChanged({brushOperation:'add',colorBy:null}))})
function wrap(ui:React.ReactNode){return <Provider store={store}><MemoryRouter>{ui}</MemoryRouter></Provider>}
describe('I05/I19/I21 and W01 shared controls',()=>{
 it.each(['add','replace','subtract','toggle'] as const)('Redux %s drives getter, page and header menus',async(op)=>{
  const view=render(wrap(<><SelectionMenu/><PointerSelectionDropdown/></>))
  act(()=>{store.dispatch(pcpStateChanged({brushOperation:op}))})
  expect(getBrushOp()).toBe(op)
  fireEvent.click(screen.getByTestId('selection-menu'))
  await waitFor(()=>expect(screen.getByTestId('brush-operation')).toHaveTextContent(op[0].toUpperCase()+op.slice(1)))
  fireEvent.click(screen.getByTestId('pointer-selection-dropdown'))
  await waitFor(()=>expect(screen.getByTestId('brush-operation-select')).toHaveTextContent(op[0].toUpperCase()+op.slice(1)))
  view.unmount()
 })
 it('temporary exclusion uses one immediate/reversible contract in the page menu',async()=>{
  store.dispatch(selectionApplied({rowIds:['b'],operation:'replace',label:'test'}))
  render(wrap(<SelectionMenu/>))
  fireEvent.click(screen.getByTestId('selection-menu'))
  const remove=await screen.findByTestId('delete-selection')
  expect(remove).toHaveTextContent(SELECTION_LABELS.exclude)
  expect(remove).toHaveAttribute('title',SELECTION_LABELS.excludeHelp)
  fireEvent.click(remove)
  expect(store.getState().selection.activeRowIds).toEqual(['a','c'])
  expect(screen.queryByText('選択行を作業集合から除外しますか？')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('reset-working-set'))
  expect(store.getState().selection.activeRowIds).toEqual(['a','b','c'])
 })
 it('header identifies current L2 groups and can disable L2 without clearing groups or L1',async()=>{
  store.dispatch(groupsReplaced([{groupId:'g',name:'Cluster A',rowIds:['a'],color:'#123456',source:'cluster',evidenceClass:'exploratory'}]))
  store.dispatch(pcpStateChanged({colorBy:'group'}))
  render(wrap(<GlobalHeaderControlBar/>))
  expect(screen.getByTestId('global-color-btn')).toHaveTextContent('L1＋L2')
  fireEvent.click(screen.getByTestId('global-color-btn'))
  expect(await screen.findByTestId('global-l2-status')).toHaveTextContent('有効（1グループ）')
  expect(screen.getByLabelText('L2色分け凡例')).toHaveTextContent('Cluster A')
  fireEvent.click(screen.getByTestId('global-l2-disable'))
  expect(store.getState().selection.l2ColorEnabled).toBe(false)
  expect(store.getState().selection.groups).toHaveLength(1)
  expect(store.getState().pcp.colorBy).toBe('group')
  expect(screen.getByTestId('global-color-btn')).toHaveTextContent('L1')
  expect(screen.queryByTestId('global-l2-disable')).not.toBeInTheDocument()
 })
})
