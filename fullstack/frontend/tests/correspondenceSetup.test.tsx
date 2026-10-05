import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import CorrespondenceAnalysisPage from '../src/features/models/CorrespondenceAnalysisPage'
import * as ca from '../src/features/models/caApi'

function SelectInput(p: any) {
  return <><select id={p.id} aria-label={p['aria-label']} style={p.style} aria-describedby={p['aria-describedby']} multiple={p.mode === 'multiple'}
    disabled={p.disabled} value={p.value ?? (p.mode === 'multiple' ? [] : '')}
    onChange={e => p.onChange(p.mode === 'multiple' ? [...e.target.selectedOptions].map(o => o.value) : e.target.value)}>
    {p.mode !== 'multiple' && <option value="">選択</option>}
    {p.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>{p.emptyHint && !p.options.length && <div>{p.emptyHint.reason}{p.emptyHint.guidance}
    <button onClick={p.emptyHint.onOpenCodebook}>コードブックを開く</button></div>}</>
}
vi.mock('../src/features/common/ColumnSelect', () => ({ default: SelectInput }))
vi.mock('antd', async original => ({ ...await original<any>(), Select: SelectInput }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div> }))
vi.mock('../src/features/models/caFigure', () => ({ default: ({ scaling }: any) => <output data-testid="ca-map">{scaling}</output> }))
vi.mock('../src/features/models/caTables', () => ({ EigenvalueTable: () => null, CategoryTable: () => null }))
vi.mock('../src/features/models/useAnalysisResultLifecycle', () => ({ useAnalysisResultLifecycle: () => ({ liveRevisions: null, linkedCategoryIds: new Set() }) }))

const columns = [
  { columnId: 'A', name: 'A', scaleType: 'nominal' },
  { columnId: 'B', name: 'B', scaleType: 'ordinal' },
  { columnId: 'C', name: 'C', scaleType: 'binary' },
  { columnId: 'label', name: 'label', scaleType: 'text' },
  { columnId: 'x', name: 'x', scaleType: 'ratio' },
  { columnId: 'y', name: 'y', scaleType: 'interval' },
].map(c => ({ ...c, label: c.name, role: 'question', multiResponseGroup: null }))
function fixture(id = 'fit-1'): any {
  return { resultId: id, config: {}, meta: { datasetId: 'd', dataRevision: 1, schemaRevision: 1, scopeCount: 2, fitCount: 2, exclusionCounts: {}, weightApplied: false },
    summary: { rank: 1, totalInertia: 1, eigenvalues: [1], inertiaRatio: [1], cumulativeInertiaRatio: [1], pearson: { status: 'not_applicable', reason: 'test' } },
    details: { rowCategories: [], columnCategories: [], omittedCategories: [], table: [], mapScaling: 'symmetric' } }
}
function mount({ weighted = false, active = null as null | string[] } = {}) {
  const base = store.getState()
  const state = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 1, allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, columns, isLoading: false,
      weightConfig: weighted ? { weightColumnId: 'x', weightType: 'survey' as const } : null },
    globalVariables: { ...base.globalVariables, activeEntities: active?.map(columnId => ({ kind: 'column' as const, columnId })) ?? null } }
  const local = configureStore({ reducer: (s = state, action: any) => ({ ...s, codebook: codebookSlice.reducer(s.codebook as any, action) }),
    middleware: get => get({ serializableCheck: false }) })
  return { local, ...render(<Provider store={local}><CorrespondenceAnalysisPage /></Provider>) }
}
function choose(label: string, values: string[]) {
  const input = screen.getByLabelText(label) as HTMLSelectElement
  for (const option of input.options) option.selected = values.includes(option.value)
  fireEvent.change(input)
}
function panel(title: string) { return screen.getByText(title, { selector: '.analysis-settings-title' }).closest('details') as HTMLDetailsElement }
async function run() {
  const button = screen.getByTestId('ca-run')
  await waitFor(() => expect(button).not.toHaveClass('ant-btn-loading'))
  fireEvent.click(button)
  await waitFor(() => expect(button).not.toHaveClass('ant-btn-loading'))
}
function pickRespondents() { choose('CAの行変数', ['A']); choose('CAの列変数', ['B']) }
beforeEach(() => { vi.spyOn(ca, 'runCa').mockResolvedValue(fixture()) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps required responsive fields visible, optional values mounted, and Run at its own primary footer', async () => {
  mount()
  expect(screen.getByLabelText('CAの行変数')).toHaveAccessibleDescription('共通選択内のカテゴリ変数から選択します。')
  expect(screen.getByLabelText('CAの行変数')).toHaveStyle({ width: '100%', minWidth: '0' })
  expect(screen.getByTestId('ca-run')).toBeDisabled()
  expect(screen.getByTestId('ca-run')).toHaveClass('ant-btn-primary')
  expect(screen.getByTestId('ca-run').closest('.analysis-run-row')).not.toBeNull()
  expect(panel('重み・欠損値（次回の分析）').open).toBe(false)
  expect(panel('入力・配置図のヘルプ').open).toBe(false)
  pickRespondents()
  await run()
  expect(ca.runCa).toHaveBeenCalledWith(expect.objectContaining({ weightMode: 'dataset', missingPolicy: 'exclude' }),
    { kind: 'respondents', rowVariable: 'A', columnVariable: 'B' }, 'symmetric')
  panel('重み・欠損値（次回の分析）').open = true
  choose('CAの欠損値の扱い', ['include_missing'])
  choose('CAの重み', ['none'])
  panel('重み・欠損値（次回の分析）').open = false
  expect(panel('重み・欠損値（次回の分析）').querySelector('summary')).toHaveTextContent('重みなし ／ 欠損を含める')
  expect(screen.getByText('対象または次回の分析設定が変更されています。表示中の結果は前回実行分です。')).toBeVisible()
  await run()
  expect(ca.runCa).toHaveBeenLastCalledWith(expect.objectContaining({ weightMode: 'none', missingPolicy: 'include_missing' }), expect.anything(), 'symmetric')
})

it('treats map scaling as live display state and does not overwrite a pending-run edit', async () => {
  mount(); pickRespondents(); await run()
  fireEvent.click(screen.getByRole('radio', { name: '行主' }))
  expect(screen.getByTestId('ca-map')).toHaveTextContent('row_principal')
  expect(screen.queryByText(/対象または次回の分析設定が変更されています/)).not.toBeInTheDocument()
  expect(ca.runCa).toHaveBeenCalledTimes(1)
  let resolve!: (value: any) => void
  vi.mocked(ca.runCa).mockReturnValueOnce(new Promise(done => { resolve = done }))
  fireEvent.click(screen.getByTestId('ca-run'))
  expect(ca.runCa).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'row_principal')
  fireEvent.click(screen.getByRole('radio', { name: '列主' }))
  await act(async () => { resolve(fixture('fit-2')) })
  expect(screen.getByTestId('ca-map')).toHaveTextContent('column_principal')
  expect(screen.queryByText(/対象または次回の分析設定が変更されています/)).not.toBeInTheDocument()
  expect(screen.getByText(/設定JSONは実行時の設定を出力します/)).toBeVisible()
})

it('keeps contingency semantics and acknowledgement required and exposes double-weight repair', async () => {
  mount({ weighted: true })
  fireEvent.click(screen.getByRole('radio', { name: '分割表' }))
  choose('CAの行ラベル列', ['label']); choose('CAの数値セル列', ['x', 'y'])
  expect(screen.getByLabelText('CAの欠損値の扱い')).toBeDisabled()
  expect(panel('重み・欠損値（次回の分析）').open).toBe(true)
  expect(screen.getByText(/分割表にはデータ設定の重みを適用できません/)).toBeVisible()
  expect(screen.getByTestId('ca-run')).toBeDisabled()
  choose('CAの重み', ['none'])
  expect(screen.getByTestId('ca-run')).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'セルが独立した観測の度数であることを確認する' }))
  await run()
  expect(ca.runCa).toHaveBeenLastCalledWith(expect.objectContaining({ weightMode: 'none', missingPolicy: 'exclude' }),
    { kind: 'contingency', rowLabelColumn: 'label', valueColumns: ['x', 'y'], cellSemantics: 'frequency', independentCountsAcknowledged: true }, 'symmetric')
  fireEvent.click(screen.getByRole('radio', { name: '質量 (mass)' })); await run()
  expect(ca.runCa).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ cellSemantics: 'mass', independentCountsAcknowledged: false }), 'symmetric')
})

it('explains an empty shared selection and opens the existing codebook editor', () => {
  const { local } = mount({ active: ['x', 'y'] })
  expect(screen.getAllByText(/現在の共通選択内に使えるカテゴリ変数がありません/)).toHaveLength(2)
  fireEvent.click(screen.getAllByRole('button', { name: 'コードブックを開く' })[0])
  expect(local.getState().codebook.isEditorOpen).toBe(true)
})

it('preserves a visible completed result and marks changed next-run inputs after a failed rerun', async () => {
  mount(); pickRespondents(); await run()
  choose('CAの列変数', ['C'])
  vi.mocked(ca.runCa).mockRejectedValueOnce(new Error('retry failed'))
  await run()
  expect(screen.getByText('retry failed')).toBeVisible()
  expect(screen.getByTestId('ca-map')).toBeInTheDocument()
  expect(screen.getByText(/対象または次回の分析設定が変更されています/)).toBeVisible()
})
