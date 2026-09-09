import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { store, type RootState } from '../src/app/store'
import { useL1Selection } from '../src/theme/useL1Selection'
import { useRowColorResolver, type RowColorResolver } from '../src/theme/useRowColor'
import { l1Color, vizTheme, composedColor } from '../src/theme/viz'
import type { ColumnarData } from '../src/features/pcp/useDatasetColumns'

const fixture = vi.hoisted(() => ({ data: null as any, info: vi.fn(), load: vi.fn() }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: (...args: unknown[]) => { fixture.load(...args); return fixture.data } }))
vi.mock('../src/theme/useL1ColorDomain', async importOriginal => {
  const original = await importOriginal<typeof import('../src/theme/useL1ColorDomain')>()
  return { ...original, useDatasetL1ColorDomains: () => fixture.data ? original.buildL1Domains(fixture.data) : null }
})
vi.mock('antd', () => ({ message: { info: fixture.info } }))
function data(n: number): ColumnarData {
  const values = Array.from({ length: n }, (_, i) => i)
  return { rowIds: [...values.map(String), 'missing'], rowIndex: new Map([...values.map((i): [string, number] => [String(i), i]), ['missing', n]]),
    schema: [{ columnId: 'q', name: 'Q', semanticType: 'numeric' }], columns: { Q: [...values, null] }, numeric: {}, minMax: {}, categories: {} }
}
function setup() {
  const base = store.getState()
  const initial = { ...base, selection: { ...base.selection, datasetId: 'ds' }, codebook: { ...base.codebook, datasetId: 'ds', isLoading: false } }
  return configureStore({ reducer: (state: RootState = initial, action: any) => {
    if (action.type === 'patch') return { ...state, ...action.payload }
    if (action.type === 'pcp/pcpStateChanged') return { ...state, pcp: { ...state.pcp, ...action.payload } }
    return state
  }, middleware: g => g({ serializableCheck: false }) })
}
afterEach(() => { cleanup(); fixture.info.mockClear(); fixture.load.mockClear() })
describe('global L1 state', () => {
  it('keeps manual clear through codebook refresh and temporary loading', async () => {
    fixture.data = data(20)
    const state = setup()
    function Probe() { useL1Selection(); return null }
    render(<Provider store={state}><Probe /></Provider>)
    await waitFor(() => expect(state.getState().pcp.colorBy).toBe('Q'))
    act(() => { state.dispatch({ type: 'pcp/pcpStateChanged', payload: { colorBy: null } }) })
    fixture.data = null
    act(() => { state.dispatch({ type: 'patch', payload: { codebook: { ...state.getState().codebook, isLoading: true } } }) })
    fixture.data = data(20)
    act(() => { state.dispatch({ type: 'patch', payload: { codebook: { ...state.getState().codebook, isLoading: false, schemaRevision: 2 } } }) })
    expect(state.getState().pcp.colorBy).toBeNull()
    expect(fixture.info).not.toHaveBeenCalled()
  })
  it('invalidates a selected column at 21 values once, outside PCP', async () => {
    fixture.data = data(20)
    const state = setup()
    function Probe() { useL1Selection(); return null }
    render(<Provider store={state}><Probe /></Provider>)
    await waitFor(() => expect(state.getState().pcp.colorBy).toBe('Q'))
    fixture.data = data(21)
    act(() => { state.dispatch({ type: 'patch', payload: { codebook: { ...state.getState().codebook, schemaRevision: 2 } } }) })
    await waitFor(() => expect(state.getState().pcp.colorBy).toBeNull())
    expect(fixture.info).toHaveBeenCalledTimes(1)
  })
  it('resolves numeric row colors, preserves them for selected rows, and composes L2 for missing', () => {
    fixture.data = data(20)
    const state = setup()
    state.dispatch({ type: 'pcp/pcpStateChanged', payload: { colorBy: 'Q' } })
    let resolver: RowColorResolver
    function Probe() { resolver = useRowColorResolver(); return null }
    render(<Provider store={state}><Probe /></Provider>)
    for (let i = 0; i < 20; i++) expect(resolver!.getColor(String(i))).toBe(l1Color(vizTheme(false), i))
    expect(fixture.load).toHaveBeenLastCalledWith('ds', ['Q'])
    act(() => { state.dispatch({ type: 'patch', payload: { selection: { ...state.getState().selection, selectedRowIds: ['1'], l2ColorEnabled: true,
      groups: [{ groupId: 'g', name: 'g', color: '', source: 'test', evidenceClass: '', rowIds: ['1', 'missing'] }] } } }) })
    expect(resolver!.getColor('1')).toBe(composedColor(vizTheme(false), { l1: l1Color(vizTheme(false), 1), l2Group: 0 }))
    expect(resolver!.getColor('missing')).toBe(composedColor(vizTheme(false), { l1: null, l2Group: 0 }))
    expect(resolver!.isSelected('1')).toBe(true)
    act(() => { state.dispatch({ type: 'pcp/pcpStateChanged', payload: { colorBy: null } }) })
    expect(fixture.load).toHaveBeenLastCalledWith('ds', [])
    expect(resolver!.getColor('1')).toBe(composedColor(vizTheme(false), { l1: null, l2Group: 0 }))
    expect(resolver!.isSelected('1')).toBe(true)
  })
  it('uses an explicit projected source without loading another dataset', () => {
    fixture.data = data(20)
    const source = data(2)
    source.rowIds = ['b', 'a', 'missing']
    source.rowIndex = new Map(source.rowIds.map((id, index) => [id, index]))
    const state = setup()
    state.dispatch({ type: 'pcp/pcpStateChanged', payload: { colorBy: 'Q' } })
    let resolver: RowColorResolver
    function Probe() { resolver = useRowColorResolver(source); return null }
    render(<Provider store={state}><Probe /></Provider>)
    expect(fixture.load).toHaveBeenLastCalledWith(null, ['Q'])
    expect(resolver!.getColor('a')).toBe(l1Color(vizTheme(false), 1))
    expect(resolver!.getColor('b')).toBe(l1Color(vizTheme(false), 0))
  })
})
