import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import type { ComponentProps, ReactNode } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as client from '../src/api/client'
import type { CodebookColumn, CodebookResponse } from '../src/api/client'
import {
  store, activeEntitiesSet, datasetLoaded, observationScopeChanged, pcpStateChanged,
  selectEffectiveRowIds, selectOrdinaryVariables, selectionApplied, variablesInitialized, weightColumnCleared,
} from '../src/app/store'
import ClustersPage from '../src/features/clustering/ClustersPage'
import { codebookReceived, codebookReset } from '../src/features/dataset/codebookSlice'
import PcaPage from '../src/features/pca/PcaPage'
import type { PcaResponse } from '../src/features/pca/types'
import GlobalHeaderControlBar from '../src/features/selection/GlobalHeaderControlBar'
import type { TgtCanvas } from '../src/features/tgt/TgtCanvas'
import TgtPage from '../src/features/tgt/TgtPage'

// Keep the exported store/reducers, header, pages, pickers and data conversion.
// Only API responses and plot/animation boundaries are doubled.
const projection = vi.hoisted(() => ({ current: null as ComponentProps<typeof TgtCanvas> | null }))
vi.mock('../src/features/tgt/TgtCanvas', () => ({ TgtCanvas: (props: ComponentProps<typeof TgtCanvas>) => {
  projection.current = props
  return <div data-testid="touring-projection-input">{JSON.stringify({ rowIds: props.rowIds, matrix: props.dataMatrix })}</div>
} }))
vi.mock('../src/features/charts/EChartSurface', async () => {
  const { forwardRef } = await import('react')
  return { default: forwardRef<SVGSVGElement, ComponentProps<'svg'>>((props, ref) => <svg {...props} ref={ref} />) }
})
vi.mock('../src/features/charts/RowScatter', () => ({ default: ({ points, testId }: {
  points: { rowId: string; x: number; y: number }[]; testId: string
}) => <div data-testid={testId}>{JSON.stringify(points)}</div> }))

const rows = ['r1', 'r2', 'r3', 'r4']
const selectedRows = ['r1', 'r2', 'r3']
const weight = { columnId: 'col-survey-weight', name: 'survey_weight', label: 'Survey expansion factor' }
const warning = `この分析は調査ウェイト（${weight.name}）を適用しません。表示値は非加重です。`
const noticeText = `ウェイト未適用${warning}`
const sparseWarning = '設定されたウェイトはSparsePCAで未対応です。無視・頻度展開は行いません。実行するには「明示的に非加重」を選択してください。'
const insufficient = 'Grand Tour には3つ以上の分析可能な変数（間隔・比率・明示選択する順序尺度）が必要です。上部の変数セレクタから追加してください。'

function column(name: string, extra: Partial<CodebookColumn> = {}): CodebookColumn {
  return { columnId: `col-${name}`, name, label: name, role: 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false,
    multiResponseGroup: null, ...extra }
}

function prepare(datasetId: string, activeNames = ['x', 'y', 'z'], response?: { path: string; body: unknown }) {
  const saved: CodebookResponse = { datasetId, schemaRevision: 2, licenseText: '', licenseRevision: 1,
    columns: [column('x', { missingCodes: ['99'] }), column('y'), column('z'),
      column(weight.name, { ...weight, role: 'weight' })],
    multiResponseGroups: [], weightConfig: { weightColumnId: weight.columnId, weightType: 'survey' }, surveyDesign: null }
  const schema = saved.columns.map(c => ({ columnId: c.columnId, name: c.name, semanticType: 'numeric' as const,
    physicalType: 'Float64', missingCount: 0 }))
  const raw = { __rowId__: rows, x: [10, 99, 30, 40], y: [1, 2, 3, 4], z: [5, 6, 7, 8], survey_weight: [1, 100, 3, 4] }
  vi.spyOn(client.api, 'get').mockImplementation(async path => {
    if (path === `/datasets/${datasetId}`) return { schema } as any
    throw new Error(`Unexpected dataset read: ${path}`)
  })
  vi.spyOn(client, 'fetchArrowView').mockImplementation(async id => {
    expect(id).toBe(datasetId)
    return raw
  })
  const post = vi.spyOn(client.api, 'post').mockImplementation(async path => {
    if (path === `/datasets/${datasetId}/color-domains`) return { domains: [] } as any
    if (response && path === response.path) return response.body as any
    throw new Error(`Unexpected analysis or mutation: ${path}`)
  })
  store.dispatch(codebookReset())
  store.dispatch(datasetLoaded({ datasetId, name: 'Projection weight disclosure fixture', rowIds: rows, dataRevision: 3 }))
  store.dispatch(variablesInitialized({ datasetId, variables: saved.columns.map(c => c.name),
    meta: Object.fromEntries(schema.map(c => [c.name, { ...c, isTargetCandidate: false }])) }))
  store.dispatch(codebookReceived(saved))
  store.dispatch(activeEntitiesSet(activeNames.map(name => ({ kind: 'column', columnId: `col-${name}` }))))
  store.dispatch(weightColumnCleared())
  store.dispatch(pcpStateChanged({ colorBy: null }))
  store.dispatch(selectionApplied({ rowIds: selectedRows, operation: 'replace', label: 'Projection fixture selection' }))
  store.dispatch(observationScopeChanged('selected'))
  return { raw, activeNames, analysisCalls: () => post.mock.calls.filter(([path]) => !path.endsWith('/color-domains')) }
}

function mount(page: ReactNode) {
  return render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={store}>
    <MemoryRouter initialEntries={['/touring']}><GlobalHeaderControlBar />{page}</MemoryRouter>
  </Provider></ConfigProvider>)
}

async function setWeight(enabled: boolean) {
  const control = screen.getByTestId('global-weight-select')
  if (enabled) {
    fireEvent.mouseDown(within(control).getByRole('combobox'))
    const option = await waitFor(() => {
      const match = document.querySelector(`.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${weight.name}"]`)
      expect(match).not.toBeNull()
      return match!
    })
    fireEvent.click(option)
  } else {
    const clear = control.querySelector('.ant-select-clear')
    expect(clear).not.toBeNull()
    fireEvent.mouseDown(clear!)
  }
  expect(store.getState().globalVariables.weightColumnId).toBe(enabled ? weight.columnId : null)
  expect(control).toHaveTextContent(enabled ? weight.name : '未選択')
  if (!enabled) expect(control).not.toHaveTextContent(weight.name)
}

async function chooseXY(role: string, labels: string[]) {
  fireEvent.click(screen.getByRole('button', { name: `${role}を選択`, exact: true }))
  const dialog = (await screen.findByRole('textbox', { name: `${role}を変数名・質問文で絞り込み` })).closest('[role="dialog"]') as HTMLElement
  await waitFor(() => expect(dialog).toBeVisible())
  const choices = within(dialog).getAllByRole('checkbox')
  expect(choices.map(input => input.closest('label')?.textContent)).toEqual(labels)
  expect(choices.every(input => (input as HTMLInputElement).checked)).toBe(true)
  fireEvent.click(choices[2])
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}

function variablesWithoutWeight() {
  const { weightColumnId: _id, weightSelectionRevision: _revision, ...variables } = store.getState().globalVariables
  return variables
}

function unchangedSource(fixture: ReturnType<typeof prepare>) {
  const source = store.getState(), variables = variablesWithoutWeight()
  const raw = JSON.stringify(fixture.raw), requests = structuredClone(fixture.analysisCalls())
  expect(source.codebook.columns.find(c => c.columnId === weight.columnId)?.name).toBe(weight.name)
  expect(source.codebook.weightConfig).toEqual({ weightColumnId: weight.columnId, weightType: 'survey' })
  expect(source.globalVariables.activeEntities).not.toContainEqual({ kind: 'column', columnId: weight.columnId })
  return () => {
    expect(store.getState().selection).toEqual(source.selection)
    expect(store.getState().codebook).toEqual(source.codebook)
    expect(store.getState().globalObservations).toEqual(source.globalObservations)
    expect(variablesWithoutWeight()).toEqual(variables)
    expect(selectOrdinaryVariables(store.getState()).activeVariableIds).toEqual(fixture.activeNames)
    expect(selectEffectiveRowIds(store.getState())).toEqual(selectedRows)
    expect(screen.getByRole('radio', { name: 'Selected (3)', exact: true })).toBeChecked()
    expect(JSON.stringify(fixture.raw)).toBe(raw)
    expect(fixture.analysisCalls()).toEqual(requests)
  }
}

function readNotice(root: HTMLElement) {
  const alert = within(root).queryByTestId('weight-unsupported-alert')
  if (alert) expect(alert).toBeVisible()
  return alert?.textContent ?? null
}

function assertNotices(notices: (string | null)[]) {
  // Baseline reaches this assertion only after every header transition and
  // setup/source/result invariant, so the intended failure is the missing notice.
  expect(notices).toEqual([noticeText, null, noticeText])
  expect(screen.getByText(warning, { exact: true })).toBeVisible()
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(() => { cleanup(); projection.current = null; vi.restoreAllMocks() })

it('Clusters keeps an explicit result and edited inputs through header weight on/off/on', async () => {
  // Same minimal response shape as clustersRequest.test.tsx, with fixture row IDs.
  const result = { resultId: 'weight-clusters', method: 'kmeans', k: 2, rowIds: selectedRows,
    labels: [0, 1, 1], diagnostics: {}, linkageMatrix: null, evidenceClass: 'test' }
  const fixture = prepare('weight-clusters', undefined, { path: '/clusters', body: result })
  mount(<ClustersPage />)
  const root = screen.getByTestId('clusters-page'), page = within(root)
  await chooseXY('クラスタリングの数値列', ['x: x', 'y: y', 'z: z'])
  const settings = page.getByText('クラスタリングの詳細設定', { exact: true }).closest('details')!
  act(() => { settings.open = true })
  fireEvent.change(page.getByTestId('cluster-k'), { target: { value: '2' } })
  fireEvent.change(page.getByTestId('cluster-seed'), { target: { value: '7' } })
  expect(fixture.analysisCalls()).toEqual([])
  expect(readNotice(root)).toBeNull()
  fireEvent.click(page.getByTestId('run-clustering'))
  await page.findByRole('button', { name: 'cluster 1 (2)', exact: true })
  expect(fixture.analysisCalls()).toEqual([['/clusters', {
    datasetId: 'weight-clusters', activeRowIds: selectedRows, expectedDataRevision: 3, expectedSchemaRevision: 2,
    method: 'kmeans', k: 2, seed: 7, linkage: 'average', distance: 'euclidean', classColumn: undefined,
    columns: ['x', 'y'], categoricalColumns: undefined, scaling: 'zscore', acuity: .1, cutoff: .001,
    alphaSmooth: .6, numWeight: 1,
  }]])
  const assertSource = unchangedSource(fixture), scope = page.getByTestId('analysis-scope-summary').textContent
  function assertSetupAndResult() {
    assertSource()
    expect(page.getByTestId('cluster-numeric-columns').textContent).toContain('x: x')
    expect(page.getByTestId('cluster-numeric-columns').textContent).toContain('y: y')
    expect(page.getByTestId('cluster-numeric-columns')).not.toHaveTextContent('z: z')
    expect(page.getByTestId('cluster-numeric-columns')).not.toHaveTextContent(weight.name)
    expect(page.getByRole('radio', { name: 'KMeans', exact: true })).toBeChecked()
    expect(page.getByTestId('cluster-k')).toHaveValue('2')
    expect(page.getByTestId('cluster-seed')).toHaveValue('7')
    expect(page.getByTestId('run-clustering')).toBeEnabled()
    expect(page.getByTestId('analysis-scope-summary').textContent).toBe(scope)
    expect(store.getState().selection.clusterResult).toEqual(result)
    expect(page.getByRole('button', { name: 'cluster 0 (1)', exact: true })).toBeVisible()
    expect(page.getByRole('button', { name: 'cluster 1 (2)', exact: true })).toBeVisible()
    expect(page.queryByTestId('cluster-previous-result')).toBeNull()
  }
  assertSetupAndResult()
  const notices: (string | null)[] = []
  for (const enabled of [true, false, true]) {
    await setWeight(enabled)
    assertSetupAndResult()
    notices.push(readNotice(root))
  }
  assertNotices(notices)
})

it('ordinary PCA retains its result and owns the notice while SparsePCA keeps its configured-weight opt-out', async () => {
  // Compact scores/loadings use the response shape in pcaAxisAccessibility.test.tsx.
  const result: PcaResponse = { columns: ['x', 'y'], nSamples: 2, nComponents: 2, useCorrelation: false,
    eigenvalues: [2, 1], explainedVarianceRatio: [2 / 3, 1 / 3], cumulativeVarianceRatio: [2 / 3, 1],
    kaiserThreshold: 1, kaiserThresholdComponents: 2, eigenvectors: [[1, 0], [0, 1]],
    loadings: { x: [1, 0], y: [0, 1] }, scores: [{ rowId: 'r1', pc: [-1, 0] }, { rowId: 'r3', pc: [1, 0] }], evidenceClass: 'test' }
  const fixture = prepare('weight-pca', undefined, { path: '/models/pca', body: result })
  mount(<PcaPage />)
  const root = screen.getByTestId('pca-page'), page = within(root)
  await chooseXY('通常PCAの分析変数', ['x', 'y', 'z'])
  fireEvent.click(page.getByRole('radio', { name: '分散共分散行列', exact: true }))
  expect(fixture.analysisCalls()).toEqual([])
  expect(readNotice(root)).toBeNull()
  fireEvent.click(page.getByTestId('pca-run-button'))
  await waitFor(() => expect(page.getByTestId('pca-biplot-canvas')).toHaveTextContent('r3'))
  expect(fixture.analysisCalls()).toEqual([['/models/pca', { datasetId: 'weight-pca', columns: ['x', 'y'],
    useCorrelation: false, rowIds: selectedRows, expectedSchemaRevision: 2, expectedDataRevision: 3 }]])
  const assertSource = unchangedSource(fixture), scope = page.getByTestId('analysis-scope-summary').textContent
  function assertSetupAndResult() {
    assertSource()
    expect(page.getByTestId('pca-columns-select')).toHaveTextContent('x')
    expect(page.getByTestId('pca-columns-select')).toHaveTextContent('y')
    expect(page.getByTestId('pca-columns-select')).not.toHaveTextContent('z')
    expect(page.getByTestId('pca-columns-select')).not.toHaveTextContent(weight.name)
    expect(page.getByRole('radio', { name: '分散共分散行列', exact: true })).toBeChecked()
    expect(page.getByTestId('pca-run-button')).toBeEnabled()
    expect(page.getByTestId('analysis-scope-summary').textContent).toBe(scope)
    expect(page.queryByText('実行時の対象・設定を保持しています。現在の入力で計算するには再実行してください。')).toBeNull()
    expect(JSON.parse(page.getByTestId('pca-biplot-canvas').textContent!)).toEqual([
      { rowId: 'r1', x: -1, y: 0 }, { rowId: 'r3', x: 1, y: 0 },
    ])
    expect(page.getByTestId('pca-loading-table')).toHaveTextContent('共分散PCA負荷量（元変数の単位）')
    expect(page.getByTestId('pca-loading-table')).toHaveTextContent('+1.000')
  }
  assertSetupAndResult()
  const notices: (string | null)[] = []
  for (const enabled of [true, false, true]) {
    await setWeight(enabled)
    assertSetupAndResult()
    notices.push(readNotice(root))
  }
  fireEvent.click(screen.getByRole('radio', { name: 'SparsePCA', exact: true }))
  const sparse = within(screen.getByTestId('sparse-pca-panel'))
  expect(root).not.toBeVisible()
  const ordinaryNotice = page.queryByTestId('weight-unsupported-alert')
  if (ordinaryNotice) expect(ordinaryNotice).not.toBeVisible()
  expect(sparse.queryByTestId('weight-unsupported-alert')).toBeNull()
  expect(sparse.getByText(sparseWarning, { exact: true })).toBeVisible()
  expect(sparse.getByRole('radio', { name: 'データセット設定に従う', exact: true })).toBeChecked()
  expect(sparse.getByTestId('sparse-pca-run')).toBeDisabled()
  await setWeight(false)
  assertSource()
  expect(sparse.getByText(sparseWarning, { exact: true })).toBeVisible()
  expect(sparse.getByTestId('sparse-pca-run')).toBeDisabled()
  fireEvent.click(sparse.getByRole('radio', { name: '明示的に非加重', exact: true }))
  expect(sparse.queryByText(sparseWarning, { exact: true })).toBeNull()
  expect(sparse.getByTestId('sparse-pca-run')).toBeEnabled()
  await setWeight(true)
  assertSource()
  expect(sparse.getByRole('radio', { name: '明示的に非加重', exact: true })).toBeChecked()
  expect(sparse.getByTestId('sparse-pca-run')).toBeEnabled()
  expect(sparse.queryByText(sparseWarning, { exact: true })).toBeNull()
  expect(sparse.queryByTestId('weight-unsupported-alert')).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: '通常PCA', exact: true }))
  expect(root).toBeVisible()
  assertSetupAndResult()
  assertNotices(notices)
})

it.each([true, false])('Touring preserves its eligible=%s branch through header weight on/off/on', async eligible => {
  const fixture = prepare(`weight-touring-${eligible}`, eligible ? ['x', 'y', 'z'] : ['x', 'y'])
  const view = mount(<TgtPage />)
  if (eligible) {
    await screen.findByTestId('touring-projection-input')
    fireEvent.click(screen.getByTestId('tgt-play-pause'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tracking軌跡', exact: true }))
  } else {
    await screen.findByText(insufficient, { exact: true })
  }
  expect(client.fetchArrowView).toHaveBeenCalled()
  expect(fixture.analysisCalls()).toEqual([])
  const assertSource = unchangedSource(fixture), engine = projection.current?.engine
  function assertProjectionOrEligibility() {
    assertSource()
    if (eligible) {
      const canvas = projection.current!
      expect(canvas.rowIds).toEqual(['r1', 'r3'])
      expect(canvas.dataMatrix).toHaveLength(2)
      canvas.dataMatrix.forEach((row, i) => {
        expect(row).toHaveLength(3)
        row.forEach(value => expect(value).toBeCloseTo((i === 0 ? -1 : 1) / Math.sqrt(2), 12))
      })
      expect(canvas.engine).toBe(engine)
      expect(canvas.isPlaying).toBe(false)
      expect(canvas.isTracking).toBe(false)
      expect(screen.getByTestId('tgt-play-pause')).toHaveTextContent('再生 (Space)')
      expect(screen.getByTestId('tgt-step')).toBeEnabled()
      expect(screen.getByRole('checkbox', { name: 'Tracking軌跡', exact: true })).not.toBeChecked()
      expect(screen.getByTestId('tgt-columns-select')).not.toHaveTextContent(weight.name)
      expect(screen.getByTestId('tgt-projection-circle')).toHaveTextContent('x')
      expect(screen.getByTestId('tgt-projection-circle')).toHaveTextContent('y')
      expect(screen.getByTestId('tgt-projection-circle')).toHaveTextContent('z')
      expect(screen.getByTestId('touring-missing-policy')).toHaveTextContent('完全ケース')
      expect(screen.getByTestId('touring-missing-policy')).toHaveTextContent('共通対象 3行 / 投影 2行 / 欠損・無効値による除外 1行')
      expect(screen.getByText('順序尺度は対象変数で明示的に選択してください。コードブックの順序順位と逆転を投影に使います。ID・名義尺度・重み・MA子は対象外です。', { exact: true })).toBeVisible()
    } else {
      expect(screen.getByTestId('empty-state-panel')).toBeVisible()
      expect(screen.getByText(insufficient, { exact: true })).toBeVisible()
      expect(screen.queryByTestId('tgt-page')).toBeNull()
      expect(screen.queryByTestId('touring-projection-input')).toBeNull()
      expect(screen.queryByTestId('touring-missing-policy')).toBeNull()
      expect(projection.current).toBeNull()
    }
  }
  assertProjectionOrEligibility()
  expect(readNotice(view.container)).toBeNull()
  const notices: (string | null)[] = []
  for (const enabled of [true, false, true]) {
    await setWeight(enabled)
    assertProjectionOrEligibility()
    notices.push(readNotice(view.container))
  }
  assertNotices(notices)
})
