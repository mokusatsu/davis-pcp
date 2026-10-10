import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { CodebookColumn } from '../src/api/client'
import KeyDriverAnalysisPage from '../src/features/models/kda/KeyDriverAnalysisPage'
import PenaltyRewardPage from '../src/features/pra/PenaltyRewardPage'
import { createScopeSnapshot } from '../src/features/selection/analysisScope'
import { readKdaPraHandoff, type KdaPraHandoff } from '../src/features/pra/kdaHandoff'
import {
  store, selectionReducer, globalObservationsSlice, globalVariablesSlice,
  datasetLoaded, variablesInitialized, activeEntitiesSet,
} from '../src/app/store'
import { codebookSlice, draftColumnUpdated, fetchCodebookThunk } from '../src/features/dataset/codebookSlice'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), getCodebook: vi.fn() }))
vi.mock('../src/api/client', () => ({ api: mocks, getCodebook: mocks.getCodebook }))
// Keep the actual pages, Redux, AntD, ColumnSelect dialogs and navigation.
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div>, useGraphPopupContainer: () => undefined }))

const rows = ['r1', 'r2', 'r3']
function column(name: string, role: CodebookColumn['role'], extra: Partial<CodebookColumn> = {}): CodebookColumn {
  return { columnId: name, name, label: name, scaleType: 'ratio', role,
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null, ...extra }
}
const mixedColumns = [
  column('source_excel_row', 'id', { scaleType: 'id' }),
  column('F1', 'attribute', { scaleType: 'nominal' }),
  column('Q7', 'question', { scaleType: 'ordinal' }),
  column('Q8', 'question', { scaleType: 'ordinal' }),
  column('weight', 'weight'), column('other', 'other'), column('inactive', 'question'),
  column('MA1', 'question', { multiResponseGroup: 'ma' }), column('text', 'question', { scaleType: 'text' }),
]
const mixedNames = [...mixedColumns.map(c => c.name), 'absent']
function metadata(names: string[], stringNames: string[] = []) {
  // Physical metadata deliberately has no role. Saved scale distinguishes
  // numeric-coded nominal F1 from measured numeric scores.
  return { schema: names.map(name => ({ name,
    semanticType: name === 'text' || stringNames.includes(name) ? 'text' : name === 'F1' ? 'nominal' : name === 'source_excel_row' ? 'identifier' : 'numeric',
    physicalType: name === 'text' || stringNames.includes(name) ? 'string' : ['F1', 'source_excel_row'].includes(name) ? 'int' : 'float',
  })) }
}
function book(columns: CodebookColumn[], schemaRevision = 1) {
  return { datasetId: 'd', schemaRevision, columns, multiResponseGroups: [] }
}
function localStore(names: string[]) {
  const base = store.getState()
  const local = configureStore({
    reducer: (s = base, a: any) => ({ ...s,
      selection: selectionReducer(s.selection, a),
      globalVariables: globalVariablesSlice.reducer(s.globalVariables, a),
      globalObservations: globalObservationsSlice.reducer(s.globalObservations, a),
      codebook: codebookSlice.reducer(s.codebook, a),
    }),
    middleware: get => get({ serializableCheck: false }),
  })
  local.dispatch(datasetLoaded({ datasetId: 'd', name: 'role fixture', rowIds: rows, dataRevision: 1 }))
  local.dispatch(variablesInitialized({ datasetId: 'd', variables: names }))
  local.dispatch(activeEntitiesSet(names.filter(name => name !== 'inactive').map(columnId => ({ kind: 'column', columnId }))))
  return local
}
async function mount(page: ReactNode, columns = mixedColumns, names = mixedNames, state?: unknown, stringNames: string[] = []) {
  mocks.get.mockResolvedValue(metadata(names, stringNames))
  mocks.getCodebook.mockResolvedValue(book(columns))
  const local = localStore(names)
  await local.dispatch(fetchCodebookThunk('d'))
  render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}>
    <MemoryRouter initialEntries={[{ pathname: '/penalty-reward', state }]}>{page}</MemoryRouter>
  </Provider></ConfigProvider>)
  await waitFor(() => expect(screen.queryByText(/(?:数値列|分析列)を読み込んでから実行してください。/)).toBeNull())
  return local
}
function picker(id: string) {
  const wrapper = screen.getByTestId(id).closest('.column-select-multi-wrap')! as HTMLElement
  fireEvent.click(within(wrapper).getByRole('button', { name: '変数を選択' }))
  return screen.getByRole('dialog')
}
async function closePicker(dialog: HTMLElement, commit = false) {
  fireEvent.click(within(dialog).getByRole('button', { name: commit ? /決\s*定/ : 'キャンセル' }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}
async function choose(id: string, values: string[], multiple = false) {
  const dialog = picker(id)
  const results = within(dialog).getByLabelText('検索結果')
  // Assert that every requested value is an actual eligible control.
  for (const value of values) expect(within(results).getByRole(multiple ? 'checkbox' : 'radio', { name: value, exact: true })).toBeEnabled()
  for (const input of within(results).queryAllByRole(multiple ? 'checkbox' : 'radio') as HTMLInputElement[]) {
    const desired = values.includes(input.closest('label')?.textContent ?? '')
    if (multiple ? input.checked !== desired : desired) fireEvent.click(input)
  }
  await closePicker(dialog, true)
}
function selected(id: string) {
  return [...screen.getByTestId(id).querySelectorAll('.ant-tag, .ant-select-selection-item')]
    .map(el => el.textContent?.replace(/close|ⓘ/g, ''))
}
function candidateNames(dialog: HTMLElement, multiple = false) {
  return within(within(dialog).getByLabelText('検索結果')).queryAllByRole(multiple ? 'checkbox' : 'radio')
    .map(input => input.closest('label')?.textContent)
}
function kdaResponse(body: any) {
  return { run_id: 'role-kda', method: 'shapley_lmg', outcome: { name: body.outcome, label: body.outcome, type: 'numeric' },
    model: { r_squared: .8, n_valid: body.rowIds.length, vif_max: 1, vif_coverage: 'all_drivers', warnings: [] },
    drivers: body.drivers.map((name: string) => ({ name, label: name, kind: 'numeric', importance_raw: .4, importance_pct: 50,
      direction: 1, standardized_coef: .4, raw_slope: .5, pearson_r: .4, vif: 1, note: '' })),
    what_if_baseline: { outcome_mean: 3, driver_means: {}, raw_slopes: {} },
  }
}
function praResponse(body: any) {
  return { run_id: 'role-pra', outcome: { name: body.outcome, label: body.outcome, type: 'numeric' },
    scale: { min: 1, max: 5, neutral: 3 },
    model: { r_squared: .5, n_valid: body.rowIds.length, alpha: .05, asymmetry_alpha: .15, warnings: [] },
    attributes: [], all_basic_dissatisfied_row_ids: [],
  }
}
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  mocks.post.mockImplementation(async (path: string, body: any) => path === '/models/kda' ? kdaResponse(body) : praResponse(body))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

for (const [name, Page, prefix, predictorId, predictorKey, endpoint] of [
  ['KDA', KeyDriverAnalysisPage, 'kda', 'kda-drivers-select', 'drivers', '/models/kda'],
  ['PRA', PenaltyRewardPage, 'pra', 'pra-attributes-select', 'attributes', '/pra/evaluate'],
] as const) describe(`${name} saved codebook role eligibility`, () => {
  const outcomeId = `${prefix}-outcome-select`, runId = `${prefix}-run-btn`, errorId = `${prefix}-input-error`
  const payload = (outcome: string, predictors: string[], schemaRevision = 1) => ({
    datasetId: 'd', rowIds: rows, expectedDataRevision: 1, expectedSchemaRevision: schemaRevision,
    outcome, [predictorKey]: predictors,
  })

  it('offers only active ordinary numeric questions as outcomes', async () => {
    await mount(<Page />)
    const dialog = picker(outcomeId)
    expect(candidateNames(dialog)).toEqual(['Q7', 'Q8'])
    for (const forbidden of ['source_excel_row', 'F1', 'weight', 'other', 'inactive', 'MA1', 'text', 'absent']) {
      expect(within(dialog).queryByRole('radio', { name: forbidden, exact: true })).toBeNull()
    }
  })

  it('offers question and attribute predictors, retaining numeric nominal F1', async () => {
    await mount(<Page />)
    await choose(outcomeId, ['Q7'])
    const dialog = picker(predictorId)
    expect(candidateNames(dialog, true)).toEqual(['F1', 'Q8'])
    for (const forbidden of ['Q7', 'source_excel_row', 'weight', 'other', 'inactive', 'MA1', 'text', 'absent']) {
      expect(within(dialog).queryByRole('checkbox', { name: forbidden, exact: true })).toBeNull()
    }
  })

  it('defaults to the last eligible question and all other eligible predictors in metadata order', async () => {
    await mount(<Page />)
    expect(selected(outcomeId)).toEqual(['Q8'])
    expect(selected(predictorId)).toEqual(['F1', 'Q7'])
    expect(screen.getByTestId(runId)).toBeEnabled()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('repopulates only eligible predictors on a Q7 outcome change and submits exact chosen controls', async () => {
    await mount(<Page />)
    await choose(predictorId, ['F1'], true)
    await choose(outcomeId, ['Q7'])
    expect(selected(predictorId)).toEqual(['F1', 'Q8'])
    await choose(predictorId, ['Q8'], true)
    fireEvent.click(screen.getByTestId(runId))
    await waitFor(() => expect(mocks.post.mock.calls).toEqual([[endpoint, payload('Q7', ['Q8'])]]))
  })

  it('uses the canonical inferred Q1/question and x/attribute roles when numeric metadata has no roles', async () => {
    const columns = [column('Q1', 'question'), column('x', 'attribute')]
    const local = await mount(<Page />, columns, ['Q1', 'x'])
    expect(metadata(['Q1', 'x']).schema.every(c => !('role' in c))).toBe(true)
    expect(selected(outcomeId)).toEqual(['Q1'])
    expect(selected(predictorId)).toEqual(['x'])
    expect(screen.getByTestId(runId)).toBeEnabled()
    // Unsaved edits never grant x outcome eligibility or invalidate saved Q1.
    act(() => {
      local.dispatch(draftColumnUpdated({ columnId: 'Q1', patch: { role: 'id' } }))
      local.dispatch(draftColumnUpdated({ columnId: 'x', patch: { role: 'question' } }))
    })
    const dialog = picker(outcomeId)
    expect(candidateNames(dialog)).toEqual(['Q1'])
    await closePicker(dialog)
    fireEvent.click(screen.getByTestId(runId))
    await waitFor(() => expect(mocks.post.mock.calls).toEqual([[endpoint, payload('Q1', ['x'])]]))
  })

  it('tolerates an omitted role only on a matched incomplete column as attribute, never question or absent-column inference', async () => {
    const { role: _omittedRole, ...incomplete } = column('Q99', 'question')
    // Deliberately incomplete response, unlike the complete canonical fixture above.
    const columns = [column('Q1', 'question'), incomplete as CodebookColumn]
    await mount(<Page />, columns, ['Q1', 'Q99', 'absent'])
    const outcomes = picker(outcomeId)
    expect(candidateNames(outcomes)).toEqual(['Q1'])
    await closePicker(outcomes)
    const predictors = picker(predictorId)
    expect(candidateNames(predictors, true)).toEqual(['Q99'])
    expect(selected(outcomeId)).toEqual(['Q1'])
    expect(selected(predictorId)).toEqual(['Q99'])
    await closePicker(predictors)
    fireEvent.click(screen.getByTestId(runId))
    await waitFor(() => expect(mocks.post.mock.calls).toEqual([[endpoint, payload('Q1', ['Q99'])]]))
  })

  it('keeps all-attribute predictors available, blocks the missing question, and recovers only after saved reclassification and selection', async () => {
    const columns = [column('x', 'attribute'), column('y', 'attribute')]
    const local = await mount(<Page />, columns, ['x', 'y'])
    expect(selected(outcomeId)).toEqual([])
    expect(screen.getByTestId(errorId)).toHaveTextContent('コードブックで役割を「質問」に設定')
    expect(screen.getByTestId(errorId)).toHaveTextContent('共通の有効変数')
    const outcomes = picker(outcomeId)
    expect(candidateNames(outcomes)).toEqual([])
    await closePicker(outcomes)
    const predictors = picker(predictorId)
    expect(candidateNames(predictors, true)).toEqual(['x', 'y'])
    await closePicker(predictors)
    expect(screen.getByTestId(runId)).toBeDisabled()
    fireEvent.click(screen.getByTestId(runId))
    expect(mocks.post).not.toHaveBeenCalled()
    mocks.getCodebook.mockResolvedValue(book([column('x', 'question'), column('y', 'attribute')], 2))
    await act(async () => { await local.dispatch(fetchCodebookThunk('d')) })
    await waitFor(() => expect(screen.getByTestId(errorId)).toHaveTextContent('役割が「質問」の列が対象'))
    expect(selected(outcomeId)).toEqual([])
    expect(screen.getByTestId(runId)).toBeDisabled()
    await choose(outcomeId, ['x'])
    expect(selected(predictorId)).toEqual(['y'])
    fireEvent.click(screen.getByTestId(runId))
    await waitFor(() => expect(mocks.post.mock.calls).toEqual([[endpoint, payload('x', ['y'], 2)]]))
  })

  it('keeps a lone question selected as outcome while lack of predictors separately blocks execution', async () => {
    await mount(<Page />, [column('Q1', 'question')], ['Q1'])
    expect(selected(outcomeId)).toEqual(['Q1'])
    const outcomes = picker(outcomeId)
    expect(candidateNames(outcomes)).toEqual(['Q1'])
    await closePicker(outcomes)
    expect(selected(predictorId)).toEqual([])
    expect(screen.getByTestId(errorId)).toHaveTextContent('1つ以上選択してください')
    expect(screen.getByTestId(runId)).toBeDisabled()
    fireEvent.click(screen.getByTestId(runId))
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it.each([false, true])('prunes role-only revisions without auto-selection, preserving valid choices (outcome reclassified=%s)', async changeOutcome => {
    const columns = [column('Q7', 'question'), column('Q8', 'question'), column('F1', 'attribute'),
      column('x', 'attribute'), column('z', 'attribute'), column('keep', 'question'), column('new', 'other')]
    const names = columns.map(c => c.name)
    const local = await mount(<Page />, columns, names)
    await choose(outcomeId, ['Q7'])
    await choose(predictorId, ['Q8', 'F1', 'x', 'z', 'keep'], true)
    const roles: Record<string, CodebookColumn['role']> = {
      Q7: changeOutcome ? 'attribute' : 'question', Q8: 'attribute', F1: 'id', x: 'weight', z: 'other', keep: 'question', new: 'question',
    }
    let finishMetadata!: (value: ReturnType<typeof metadata>) => void
    mocks.get.mockReturnValueOnce(new Promise(resolve => { finishMetadata = resolve }))
    mocks.getCodebook.mockResolvedValue(book(columns.map(c => ({ ...c, role: roles[c.name] })), 2))
    await act(async () => { await local.dispatch(fetchCodebookThunk('d')) })
    expect(local.getState().selection.dataRevision).toBe(1)
    expect(local.getState().codebook.schemaRevision).toBe(2)
    expect(screen.getByTestId(runId)).toBeDisabled()
    fireEvent.click(screen.getByTestId(runId))
    expect(mocks.post).not.toHaveBeenCalled()
    await act(async () => { finishMetadata(metadata(names)) })
    await waitFor(() => expect(selected(predictorId)).toEqual(['Q8', 'keep']))
    expect(selected(outcomeId)).toEqual(changeOutcome ? [] : ['Q7'])
    expect(selected(predictorId)).not.toContain('new')
    if (changeOutcome) {
      expect(screen.getByTestId(errorId)).toHaveTextContent('役割が「質問」')
      expect(screen.getByTestId(runId)).toBeDisabled()
      await choose(outcomeId, ['keep'])
    } else {
      expect(screen.getByTestId(runId)).toBeEnabled()
    }
    await choose(predictorId, ['Q8'], true)
    fireEvent.click(screen.getByTestId(runId))
    await waitFor(() => expect(mocks.post.mock.calls).toEqual([[endpoint, payload(changeOutcome ? 'keep' : 'Q7', ['Q8'], 2)]]))
  })
})

describe('KDA saved analysis scale eligibility', () => {
  const columns = [column('Q1', 'question'), column('Q2', 'question', { scaleType: 'ordinal' }),
    column('Q6', 'question', { scaleType: 'nominal' }),
    column('F1', 'attribute', { scaleType: 'nominal' }),
    column('string_attribute', 'attribute', { scaleType: 'nominal' }),
    column('string_question', 'question', { scaleType: 'nominal' }),
    column('coded_text', 'question', { scaleType: 'text' }), column('coded_id', 'question', { scaleType: 'id' }),
    column('nominal_weight', 'weight', { scaleType: 'nominal' }), column('nominal_other', 'other', { scaleType: 'nominal' }),
    column('nominal_id', 'id', { scaleType: 'nominal' }), column('inactive', 'question', { scaleType: 'nominal' }),
    column('MA1', 'question', { scaleType: 'nominal', multiResponseGroup: 'ma' })]
  const names = [...columns.map(c => c.name), 'absent']
  const strings = ['string_attribute', 'string_question', 'nominal_other']

  it('admits numeric and string nominal drivers but excludes nominal outcomes and saved text/id scales', async () => {
    await mount(<KeyDriverAnalysisPage />, columns, names, undefined, strings)
    expect(selected('kda-outcome-select')).toEqual(['Q2'])
    expect(selected('kda-drivers-select')).toEqual(['Q1', 'Q6', 'F1', 'string_attribute', 'string_question'])
    const outcomes = picker('kda-outcome-select')
    expect(candidateNames(outcomes)).toEqual(['Q1', 'Q2'])
    await closePicker(outcomes)
    const predictors = picker('kda-drivers-select')
    expect(candidateNames(predictors, true)).toEqual(['Q1', 'Q6', 'F1', 'string_attribute', 'string_question'])
    await closePicker(predictors)
    await choose('kda-drivers-select', ['F1', 'string_attribute', 'string_question'], true)
    expect(screen.queryByTestId('kda-input-error')).toBeNull()
    fireEvent.click(screen.getByTestId('kda-run-btn'))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/models/kda', {
      datasetId: 'd', rowIds: rows, expectedDataRevision: 1, expectedSchemaRevision: 1,
      outcome: 'Q2', drivers: ['F1', 'string_attribute', 'string_question'],
    }))
  })

  it('keeps the PRA standalone physical numeric candidates and copy unchanged', async () => {
    await mount(<PenaltyRewardPage />, columns, names, undefined, strings)
    const predictors = picker('pra-attributes-select')
    expect(candidateNames(predictors, true)).toEqual(['Q1', 'Q2', 'Q6', 'F1', 'coded_text'])
    expect(within(predictors).queryByRole('checkbox', { name: 'string_attribute', exact: true })).toBeNull()
    await closePicker(predictors)
    // Existing standalone eligibility remains physical-numeric and role-based.
    expect(selected('pra-outcome-select')).toEqual(['coded_id'])
  })

  it('ignores scale drafts and prunes saved scale revisions without selecting newly eligible drivers', async () => {
    const initial = [column('Q1', 'question'), column('F1', 'attribute', { scaleType: 'nominal' }),
      column('string_attribute', 'attribute', { scaleType: 'nominal' }), column('later', 'attribute', { scaleType: 'text' })]
    const ns = initial.map(c => c.name)
    const local = await mount(<KeyDriverAnalysisPage />, initial, ns, undefined, ['string_attribute', 'later'])
    expect(selected('kda-drivers-select')).toEqual(['F1', 'string_attribute'])
    act(() => { local.dispatch(draftColumnUpdated({ columnId: 'string_attribute', patch: { scaleType: 'text' } })) })
    expect(selected('kda-drivers-select')).toEqual(['F1', 'string_attribute'])
    let finishMetadata!: (value: ReturnType<typeof metadata>) => void
    mocks.get.mockReturnValueOnce(new Promise(resolve => { finishMetadata = resolve }))
    mocks.getCodebook.mockResolvedValue(book(initial.map(c => c.name === 'string_attribute' ? { ...c, scaleType: 'text' }
      : c.name === 'later' ? { ...c, scaleType: 'nominal' } : c) as CodebookColumn[], 2))
    await act(async () => { await local.dispatch(fetchCodebookThunk('d')) })
    expect(screen.getByTestId('kda-run-btn')).toBeDisabled()
    expect(screen.getByTestId('kda-input-error')).toHaveTextContent('分析列を読み込んでから')
    await act(async () => { finishMetadata(metadata(ns, ['string_attribute', 'later'])) })
    await waitFor(() => expect(selected('kda-drivers-select')).toEqual(['F1']))
    expect(selected('kda-outcome-select')).toEqual(['Q1'])
    const candidates = picker('kda-drivers-select')
    expect(candidateNames(candidates, true)).toEqual(['F1', 'later'])
    await closePicker(candidates)
    fireEvent.click(screen.getByTestId('kda-run-btn'))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/models/kda', expect.objectContaining({
      expectedSchemaRevision: 2, outcome: 'Q1', drivers: ['F1'],
    })))
  })
})

function handoff(outcome = 'Q7', drivers = ['Q8'], sourceRunId = 'valid-source'): KdaPraHandoff {
  return { version: 1, kind: 'kda-to-pra', sourceRunId, datasetId: 'd', dataRevision: 1, schemaRevision: 1,
    outcome, drivers, scopeSnapshot: createScopeSnapshot('selected', ['r1'], 'd', 1, 1),
    sourceConclusion: { kind: 'shapley-importance', method: 'shapley_lmg', rSquared: .8, nValid: 1,
      drivers: drivers.map(name => ({ name, importancePct: 100 / drivers.length, direction: 1 })) },
  }
}

describe('PRA original handoff role validation', () => {
  it.each([
    ['attribute outcome', false], ['attribute outcome', true],
    ['mixed valid and ID predictors', false], ['mixed valid and ID predictors', true],
  ] as const)('blocks %s after effects and local repair (already mounted=%s)', async (reason, mounted) => {
    const source = reason === 'attribute outcome'
      ? handoff('F1', ['Q8'], 'invalid-roles')
      : handoff('Q7', ['Q8', 'source_excel_row'], 'invalid-roles')
    // Same-dataset, same-revision, structurally valid source: only roles fail.
    expect(readKdaPraHandoff(source)).not.toBeNull()
    function Receiver() {
      const navigate = useNavigate()
      return <><button onClick={() => navigate('/penalty-reward', { state: { kdaHandoff: source } })}>receive invalid handoff</button><PenaltyRewardPage /></>
    }
    const local = await mount(<Receiver />, mixedColumns, mixedNames, { kdaHandoff: mounted ? handoff() : source })
    if (mounted) {
      await waitFor(() => expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('valid-source'))
      expect(screen.getByTestId('pra-run-btn')).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'receive invalid handoff' }))
    }
    await waitFor(() => expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('KDAの引継ぎ変数を利用できません'))
    expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent(reason === 'attribute outcome' ? '役割が「質問」の列' : '役割が「質問」または「属性」の列')
    expect(screen.getByTestId('pra-run-btn')).toBeDisabled()
    fireEvent.click(screen.getByTestId('pra-run-btn'))
    // Refresh the same active names to settle pruning without making source
    // revisions stale. The remaining Q8 must not license a partial handoff.
    act(() => { local.dispatch(activeEntitiesSet(mixedNames.filter(n => n !== 'inactive').map(columnId => ({ kind: 'column', columnId })))) })
    await waitFor(() => expect(selected('pra-attributes-select')).toEqual(['Q8']))
    expect(selected('pra-outcome-select')).toEqual(reason === 'attribute outcome' ? [] : ['Q7'])
    expect(screen.getByTestId('pra-run-btn')).toBeDisabled()
    expect(mocks.post).not.toHaveBeenCalled()
    await choose('pra-outcome-select', ['Q7'])
    await choose('pra-attributes-select', ['Q8'], true)
    expect(screen.getByTestId('pra-run-btn')).toBeDisabled()
    expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('KDAの引継ぎ変数を利用できません')
    fireEvent.click(screen.getByTestId('pra-run-btn'))
    expect(mocks.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '引継ぎを解除して共通対象を使う' }))
    expect(screen.getByTestId('pra-run-btn')).toBeEnabled()
    fireEvent.click(screen.getByTestId('pra-run-btn'))
    await waitFor(() => expect(mocks.post.mock.calls).toEqual([['/pra/evaluate', {
      datasetId: 'd', rowIds: rows, expectedDataRevision: 1, expectedSchemaRevision: 1, outcome: 'Q7', attributes: ['Q8'],
    }]]))
  })
})

describe('PRA original handoff nominal compatibility', () => {
  it.each([
    ['F1', false], ['F1', true], ['string_nominal', false], ['string_nominal', true],
  ] as const)('blocks the whole %s source after local repair (already mounted=%s)', async (nominalName, mounted) => {
    const columns = [...mixedColumns, column('string_nominal', 'attribute', { scaleType: 'nominal' })]
    const names = [...mixedNames, 'string_nominal']
    const source = handoff('Q7', ['Q8', nominalName], 'legacy-nominal-source')
    // Old history may contain a numeric direction for a saved nominal column.
    expect(readKdaPraHandoff(source)).not.toBeNull()
    function Receiver() {
      const navigate = useNavigate()
      return <><button onClick={() => navigate('/penalty-reward', { state: { kdaHandoff: source } })}>receive nominal source</button><PenaltyRewardPage /></>
    }
    const local = await mount(<Receiver />, columns, names, { kdaHandoff: mounted ? handoff() : source }, ['string_nominal'])
    if (mounted) {
      await waitFor(() => expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('valid-source'))
      expect(screen.getByTestId('pra-run-btn')).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'receive nominal source' }))
    }
    await waitFor(() => expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('この分析全体を引き継げません'))
    expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent(`名義尺度の要因（${nominalName}）`)
    expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('低評価・高評価の順序')
    expect(screen.getByTestId('pra-run-btn')).toBeDisabled()
    act(() => { local.dispatch(draftColumnUpdated({ columnId: nominalName, patch: { scaleType: 'ordinal' } })) })
    await choose('pra-outcome-select', ['Q7'])
    await choose('pra-attributes-select', ['Q8'], true)
    expect(selected('pra-attributes-select')).toEqual(['Q8'])
    expect(screen.getByTestId('pra-kda-handoff')).toHaveTextContent('変数設定を編集しても元の引継ぎは利用できません')
    expect(screen.getByTestId('pra-run-btn')).toBeDisabled()
    fireEvent.click(screen.getByTestId('pra-run-btn'))
    expect(mocks.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '引継ぎを解除して共通対象を使う' }))
    expect(screen.getByTestId('pra-run-btn')).toBeEnabled()
    fireEvent.click(screen.getByTestId('pra-run-btn'))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/pra/evaluate', {
      datasetId: 'd', rowIds: rows, expectedDataRevision: 1, expectedSchemaRevision: 1, outcome: 'Q7', attributes: ['Q8'],
    }))
  })
})
