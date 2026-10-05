import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import KeyDriverAnalysisPage from '../src/features/models/kda/KeyDriverAnalysisPage'
import PenaltyRewardPage from '../src/features/pra/PenaltyRewardPage'
import { AnalysisViewActivityContext, createScopeSnapshot } from '../src/features/selection/analysisScope'
import { captureKdaPraHandoff, readKdaPraHandoff, type KdaPraHandoff } from '../src/features/pra/kdaHandoff'
import { store, selectionReducer, globalObservationsSlice, globalVariablesSlice, datasetLoaded, variablesInitialized, datasetValuesUpdated, activeEntitiesSet, selectOrdinaryVariables, selectionApplied } from '../src/app/store'
import { codebookSlice, fetchCodebookThunk } from '../src/features/dataset/codebookSlice'
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), getCodebook: vi.fn() }))
vi.mock('../src/api/client', () => ({ api: mocks, getCodebook: mocks.getCodebook }))
// Pages, Redux, real AntD/ColumnSelect and navigation remain real. Only charts are doubled.
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div>, useGraphPopupContainer: () => undefined }))
const names = ['x', 'y', 'z', 'extra'], rows = ['r1', 'r2', 'r3']
function book(ns = names, revision = 1) { return { datasetId: 'd', schemaRevision: revision, columns: ns.map(name => ({ columnId: name, name, label: name, scaleType: 'ratio', role: 'question', valueLabels: {}, categoryOrder: [], missingCodes: [], isReversed: false })), multiResponseGroups: [] } }
function metadata(ns = names) { return { schema: ns.map(name => ({ name, semanticType: 'numeric', physicalType: 'float' })) } }
function localStore() {
  const base = store.getState()
  const local = configureStore({ reducer: (s = base, a: any) => ({ ...s, selection: selectionReducer(s.selection, a), globalVariables: globalVariablesSlice.reducer(s.globalVariables, a), globalObservations: globalObservationsSlice.reducer(s.globalObservations, a), codebook: codebookSlice.reducer(s.codebook, a) }), middleware: get => get({ serializableCheck: false }) })
  local.dispatch(datasetLoaded({ datasetId: 'd', name: 'test', rowIds: rows, dataRevision: 1 })); local.dispatch(variablesInitialized({ datasetId: 'd', variables: names })); return local
}
function kdaResponse(body: any) { return { run_id: 'kda-run-1', method: 'shapley_lmg', outcome: { name: body.outcome, label: body.outcome, type: 'numeric' }, model: { r_squared: .84, n_valid: body.rowIds.length, vif_max: 1, warnings: [] }, drivers: body.drivers.map((name: string) => ({ name, label: name, importance_raw: .42, importance_pct: 50, direction: 1, standardized_coef: .4, raw_slope: .5, pearson_r: .4, vif: 1, note: '' })), what_if_baseline: { outcome_mean: 5, driver_means: {}, raw_slopes: {} } } }
function praResponse(body: any) { return { run_id: 'pra-run', outcome: { name: body.outcome, label: body.outcome, type: 'numeric' }, scale: { min: 1, max: 5, neutral: 3 }, model: { r_squared: .5, n_valid: body.rowIds.length, alpha: .05, asymmetry_alpha: .15, warnings: [] }, attributes: [], all_basic_dissatisfied_row_ids: [] } }
function handoff(overrides: Partial<KdaPraHandoff> = {}): KdaPraHandoff { return { version: 1, kind: 'kda-to-pra', sourceRunId: 'kda-source', datasetId: 'd', dataRevision: 1, schemaRevision: 1, outcome: 'x', drivers: ['y', 'z'], scopeSnapshot: createScopeSnapshot('selected', ['r1'], 'd', 1, 1), sourceConclusion: { kind: 'shapley-importance', method: 'shapley_lmg', rSquared: .84, nValid: 1, drivers: [{ name: 'y', importancePct: 60, direction: 1 }, { name: 'z', importancePct: 40, direction: -1 }] }, ...overrides } }
function picker(id: string) { fireEvent.click(within(screen.getByTestId(id).closest('.column-select-multi-wrap')! as HTMLElement).getByRole('button', { name: '変数を選択' })); return screen.getByRole('dialog') }
async function choose(id: string, values: string[], multiple = false) {
  const dialog = picker(id), results = within(dialog).getByLabelText('検索結果')
  for (const input of within(results).getAllByRole(multiple ? 'checkbox' : 'radio') as HTMLInputElement[]) {
    const desired = values.includes(input.closest('label')?.textContent ?? ''); if (multiple ? input.checked !== desired : desired) fireEvent.click(input)
  }
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ })); await waitFor(() => expect(dialog).not.toBeVisible())
}
function selected(id: string) { return [...screen.getByTestId(id).querySelectorAll('.ant-tag, .ant-select-selection-item')].map(el => el.textContent?.replace(/close|ⓘ/g, '')) }
function tree(local: ReturnType<typeof localStore>, page: React.ReactNode, path = '/penalty-reward', state?: unknown) { return <Provider store={local}><MemoryRouter initialEntries={[{ pathname: path, state }]}>{page}</MemoryRouter></Provider> }
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element)); mocks.get.mockResolvedValue(metadata()); mocks.getCodebook.mockResolvedValue(book()); mocks.post.mockImplementation(async (path: string, body: any) => path === '/models/kda' ? kdaResponse(body) : praResponse(body)) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function KeptPages({ praVisited = false }: { praVisited?: boolean }) {
  const navigate = useNavigate(), location = useLocation(), [visited, setVisited] = useState(praVisited), praActive = location.pathname === '/penalty-reward'
  if (praActive && !visited) setVisited(true)
  return <><button onClick={() => navigate('/key-drivers')}>visit KDA</button><button onClick={() => navigate('/penalty-reward')}>visit PRA</button><output data-testid="location-state">{JSON.stringify(location.state)}</output>
    <AnalysisViewActivityContext.Provider value={!praActive}><div style={{ display: praActive ? 'none' : 'block' }}><KeyDriverAnalysisPage /></div></AnalysisViewActivityContext.Provider>
    {(visited || praActive) && <AnalysisViewActivityContext.Provider value={praActive}><div style={{ display: praActive ? 'block' : 'none' }}><PenaltyRewardPage /></div></AnalysisViewActivityContext.Provider>}</>
}
describe('WF-01 executed KDA handoff', () => {
  it.each([false, true])('preserves executed inputs, revisions, conclusion and population (PRA visited=%s)', async praVisited => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); render(tree(local, <KeptPages praVisited={praVisited} />, '/key-drivers'))
    await waitFor(() => expect(screen.getByTestId('kda-run-btn')).toBeEnabled()); await choose('kda-outcome-select', ['x']); await choose('kda-drivers-select', ['y', 'z'], true)
    act(() => { local.dispatch(selectionApplied({ rowIds: ['r1'], operation: 'replace', label: 'fit' })); local.dispatch(globalObservationsSlice.actions.observationScopeChanged('selected')) })
    let finish!: (value: any) => void; mocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByTestId('kda-run-btn')); const payload = mocks.post.mock.calls[0][1]
    // Neither edited controls nor changed shared rows may rewrite an in-flight result's origin.
    await choose('kda-outcome-select', ['extra']); act(() => { local.dispatch(selectionApplied({ rowIds: ['r2'], operation: 'replace', label: 'next' })) })
    await act(async () => { finish(kdaResponse(payload)) })
    expect(screen.getByTestId('send-robustness-btn')).toBeDisabled(); expect(screen.getByText(/KDAのShapley重要度の頑健性検証には未対応/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('send-pra-btn')); await waitFor(() => expect(selected('pra-outcome-select')).toEqual(['x'])); expect(selected('pra-attributes-select')).toEqual(['y', 'z'])
    expect(JSON.parse(screen.getByTestId('location-state').textContent!).kdaHandoff).toMatchObject({ sourceRunId: 'kda-run-1', datasetId: 'd', dataRevision: 1, schemaRevision: 1, outcome: 'x', drivers: ['y', 'z'], scopeSnapshot: { rowIds: ['r1'], scope: 'selected' }, sourceConclusion: { kind: 'shapley-importance', rSquared: .84 } })
    expect(screen.getByTestId('pra-inherited-scope')).toHaveTextContent('1行に固定'); expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('頑健性を検証するものではありません')
    fireEvent.click(screen.getByTestId('pra-run-btn')); await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/pra/evaluate', { datasetId: 'd', expectedDataRevision: 1, expectedSchemaRevision: 1, outcome: 'x', attributes: ['y', 'z'], rowIds: ['r1'] })); await screen.findByTestId('asymmetry-test-table')
    expect(within(screen.getByTestId('penalty-reward-page')).queryByText(/現在の入力と異なる実行済み結果/)).toBeNull(); expect(mocks.post.mock.calls.some(([path]) => path.startsWith('/robustness'))).toBe(false)
    fireEvent.click(screen.getByText('visit KDA')); fireEvent.click(screen.getByText('visit PRA')); expect(selected('pra-outcome-select')).toEqual(['x']); expect(screen.getByTestId('asymmetry-test-table')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '引継ぎを解除して共通対象を使う' })); fireEvent.click(screen.getByTestId('pra-run-btn')); await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/pra/evaluate', expect.objectContaining({ rowIds: ['r2'] })))
  }, 15000)
  it.each(['data', 'schema', 'dataset', 'rows', 'malformed'])('blocks stale/invalid %s handoffs and permits explicit recovery', async reason => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); const source = handoff()
    if (reason === 'data') source.dataRevision = 0; if (reason === 'schema') source.schemaRevision = 0; if (reason === 'dataset') source.datasetId = 'other'; if (reason === 'rows') source.scopeSnapshot.rowIds = ['missing-row']
    render(tree(local, <PenaltyRewardPage />, '/penalty-reward', { kdaHandoff: reason === 'malformed' ? { version: 42 } : source })); await screen.findByTestId('pra-kda-handoff')
    expect(screen.getByTestId('pra-run-btn')).toBeDisabled(); fireEvent.click(screen.getByTestId('pra-run-btn')); expect(mocks.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '引継ぎを解除して共通対象を使う' })); await waitFor(() => expect(screen.getByTestId('pra-run-btn')).toBeEnabled()); fireEvent.click(screen.getByTestId('pra-run-btn')); await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/pra/evaluate', expect.objectContaining({ rowIds: rows })))
  })
  it('retains inherited rows when variables change and blocks a later stale generation', async () => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); render(tree(local, <PenaltyRewardPage />, '/penalty-reward', { kdaHandoff: handoff() })); await screen.findByTestId('pra-kda-handoff'); await choose('pra-attributes-select', ['y'], true)
    expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('変数設定が元のKDAと異なります'); fireEvent.click(screen.getByTestId('pra-run-btn')); await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/pra/evaluate', expect.objectContaining({ rowIds: ['r1'], attributes: ['y'] })))
    act(() => { local.dispatch(datasetValuesUpdated({ datasetId: 'd', dataRevision: 2 })) }); await waitFor(() => expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('データ世代と一致しません')); expect(screen.getByTestId('pra-run-btn')).toBeDisabled(); expect(screen.queryByTestId('asymmetry-test-table')).toBeNull()
  })
  it('replaces a previous handoff and discards its delayed response', async () => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); const second = handoff({ sourceRunId: 'second', outcome: 'extra', scopeSnapshot: createScopeSnapshot('active', ['r2', 'r3'], 'd', 1, 1) })
    function Receiver() { const navigate = useNavigate(); return <><button onClick={() => navigate('/penalty-reward', { state: { kdaHandoff: second } })}>send new handoff</button><PenaltyRewardPage /></> }
    render(tree(local, <Receiver />, '/penalty-reward', { kdaHandoff: handoff() })); await screen.findByTestId('pra-kda-handoff'); let finish!: (value: any) => void; mocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByTestId('pra-run-btn')); const payload = mocks.post.mock.calls[0][1]; fireEvent.click(screen.getByText('send new handoff')); await waitFor(() => expect(selected('pra-outcome-select')).toEqual(['extra'])); await act(async () => { finish(praResponse(payload)) })
    expect(screen.queryByTestId('asymmetry-test-table')).toBeNull(); expect(screen.getByTestId('pra-run-btn')).toBeEnabled(); fireEvent.click(screen.getByTestId('pra-run-btn')); await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/pra/evaluate', expect.objectContaining({ outcome: 'extra', rowIds: ['r2', 'r3'] })))
  })
  it('distinguishes requested population from source and PRA valid counts', async () => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d'))
    const source = handoff({ scopeSnapshot: createScopeSnapshot('all', rows, 'd', 1, 1) })
    source.sourceConclusion.nValid = 2
    mocks.post.mockImplementationOnce(async (_path: string, body: any) => {
      const response = praResponse(body); response.model.n_valid = 2; return response
    })
    render(tree(local, <PenaltyRewardPage />, '/penalty-reward', { kdaHandoff: source }))
    await screen.findByTestId('pra-kda-handoff')
    expect(screen.getByTestId('pra-inherited-scope')).toHaveTextContent('要求対象: KDA実行時の全体 (All) 3行に固定')
    expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('KDA有効2行（欠損除外後）')
    fireEvent.click(screen.getByTestId('pra-run-btn'))
    expect(await screen.findByTestId('pra-valid-population')).toHaveTextContent('このPRA結果の有効行数: 2行')
  })
  it('copies sampling provenance and rejects unsupported/partial contracts', () => {
    const original = handoff({ scopeSnapshot: createScopeSnapshot('sampled', ['r1'], 'd', 1, 1, { sampleId: 'sample', seed: 42, sourceRowCount: 3 } as any) }), copy = readKdaPraHandoff(captureKdaPraHandoff(original))!
    original.drivers.push('extra'); original.scopeSnapshot.rowIds.push('r2'); original.scopeSnapshot.sampling!.seed = 9
    expect(copy.drivers).toEqual(['y', 'z']); expect(copy.scopeSnapshot.rowIds).toEqual(['r1']); expect(copy.scopeSnapshot.sampling).toMatchObject({ seed: 42, sourceRowCount: 3 }); expect(readKdaPraHandoff({ ...copy, version: 0 })).toBeNull(); expect(readKdaPraHandoff({ ...copy, outcome: 'y' })).toBeNull(); expect(readKdaPraHandoff({ ...copy, scopeSnapshot: { ...copy.scopeSnapshot, rowIds: [] } })).toBeNull()
  })
})
// Good-behavior regressions converted from audit SE06 schema-candidates.test.tsx.
for (const [name, Page, prefix, predictorId] of [['KDA', KeyDriverAnalysisPage, 'kda', 'kda-drivers-select'], ['PRA', PenaltyRewardPage, 'pra', 'pra-attributes-select']] as const) describe(`${name} WF-07/WF-09`, () => {
  it('refreshes added active numeric candidates without remounting or resetting valid controls', async () => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); const display = (active = true) => tree(local, <AnalysisViewActivityContext.Provider value={active}><Page /></AnalysisViewActivityContext.Provider>), mounted = render(display())
    await waitFor(() => expect(screen.getByTestId(`${prefix}-run-btn`)).toBeEnabled()); await choose(`${prefix}-outcome-select`, ['x']); await choose(predictorId, ['y'], true); mounted.rerender(display(false))
    const next = [...names, 'derived']; mocks.get.mockResolvedValue(metadata(next)); mocks.getCodebook.mockResolvedValue(book(next, 2))
    await act(async () => { local.dispatch(datasetValuesUpdated({ datasetId: 'd', dataRevision: 2 })); await local.dispatch(fetchCodebookThunk('d')); local.dispatch(activeEntitiesSet(next.map(columnId => ({ kind: 'column', columnId })))) }); mounted.rerender(display())
    expect(selectOrdinaryVariables(local.getState()).activeVariableIds).toEqual(next); await waitFor(() => expect(screen.getByTestId(`${prefix}-run-btn`)).toBeEnabled()); expect(selected(`${prefix}-outcome-select`)).toEqual(['x']); expect(selected(predictorId)).toEqual(['y'])
    const dialog = picker(`${prefix}-outcome-select`); expect(within(dialog).getByRole('radio', { name: 'derived' })).toBeInTheDocument(); fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' })); await choose(predictorId, ['y', 'derived'], true); fireEvent.click(screen.getByTestId(`${prefix}-run-btn`))
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith(prefix === 'kda' ? '/models/kda' : '/pra/evaluate', expect.objectContaining({ outcome: 'x', [prefix === 'kda' ? 'drivers' : 'attributes']: ['y', 'derived'], expectedDataRevision: 2, expectedSchemaRevision: 2 })))
  })
  it('prunes removed columns and recovers after selecting a valid replacement', async () => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); render(tree(local, <Page />)); await waitFor(() => expect(screen.getByTestId(`${prefix}-run-btn`)).toBeEnabled()); await choose(`${prefix}-outcome-select`, ['x']); await choose(predictorId, ['y', 'z'], true)
    mocks.get.mockResolvedValue(metadata(['y', 'extra'])); mocks.getCodebook.mockResolvedValue(book(['y', 'extra'], 2)); await act(async () => { local.dispatch(datasetValuesUpdated({ datasetId: 'd', dataRevision: 2 })); await local.dispatch(fetchCodebookThunk('d')) })
    await waitFor(() => expect(screen.getByTestId(`${prefix}-input-error`)).toHaveTextContent('目的変数に有効な数値列')); expect(screen.getByTestId(`${prefix}-run-btn`)).toBeDisabled(); expect(selected(predictorId)).toEqual(['y']); await choose(`${prefix}-outcome-select`, ['extra']); expect(screen.getByTestId(`${prefix}-run-btn`)).toBeEnabled()
  })
  it('disables empty predictors, labels the retained result and successfully reruns after repair', async () => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); render(tree(local, <Page />)); await waitFor(() => expect(screen.getByTestId(`${prefix}-run-btn`)).toBeEnabled()); fireEvent.click(screen.getByTestId(`${prefix}-run-btn`)); await screen.findByTestId(prefix === 'kda' ? 'kda-contrast-table' : 'asymmetry-test-table'); await choose(predictorId, [], true)
    expect(screen.getByTestId(`${prefix}-run-btn`)).toBeDisabled(); expect(screen.getByTestId(`${prefix}-input-error`)).toHaveTextContent('1つ以上選択してください'); expect(screen.getByText(/入力の不足を修正すると再実行できます/)).toBeInTheDocument(); fireEvent.click(screen.getByTestId(`${prefix}-run-btn`)); expect(mocks.post).toHaveBeenCalledTimes(1)
    await choose(predictorId, ['y', 'z'], true); fireEvent.click(screen.getByTestId(`${prefix}-run-btn`)); await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2)); await waitFor(() => expect(screen.queryByText(/現在の入力と異なる実行済み結果/)).toBeNull())
  })
  it('blocks zero observation scope and recovers after row selection', async () => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); local.dispatch(globalObservationsSlice.actions.observationScopeChanged('selected')); render(tree(local, <Page />)); await waitFor(() => expect(screen.getByTestId(`${prefix}-input-error`)).toHaveTextContent('分析対象が0行')); expect(screen.getByTestId(`${prefix}-run-btn`)).toBeDisabled()
    act(() => { local.dispatch(selectionApplied({ rowIds: ['r1'], operation: 'replace', label: 'recover' })) }); expect(screen.getByTestId(`${prefix}-run-btn`)).toBeEnabled(); fireEvent.click(screen.getByTestId(`${prefix}-run-btn`)); await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(prefix === 'kda' ? '/models/kda' : '/pra/evaluate', expect.objectContaining({ rowIds: ['r1'] })))
  })
  it('shows metadata failure and supports an explicit retry', async () => {
    const local = localStore(); await local.dispatch(fetchCodebookThunk('d')); mocks.get.mockRejectedValueOnce(new Error('network failure')); render(tree(local, <Page />)); await screen.findByText(/数値列の読込みに失敗/); expect(screen.getByTestId(`${prefix}-run-btn`)).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '列を再読込み' })); await waitFor(() => expect(screen.getByTestId(`${prefix}-run-btn`)).toBeEnabled())
  })
})
