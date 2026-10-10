import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as client from '../src/api/client'
import type { CodebookColumn, CodebookResponse } from '../src/api/client'
import {
  store, activeEntitiesSet, datasetLoaded, observationScopeChanged, pcpStateChanged,
  selectEffectiveRowIds, selectOrdinaryVariables, selectionApplied, variablesInitialized, weightColumnCleared,
} from '../src/app/store'
import { codebookReceived, codebookReset } from '../src/features/dataset/codebookSlice'
import ModelsPage from '../src/features/models/ModelsPage'
import LogisticRegressionPage from '../src/features/models/LogisticRegressionPage'
import DiscriminantAnalysisPage from '../src/features/models/DiscriminantAnalysisPage'
import GlobalHeaderControlBar from '../src/features/selection/GlobalHeaderControlBar'

// Use the exported Redux store, real header, pages, pickers and color hooks.
// Only dataset API reads are doubled; these setup-only cases never fit a model.
const rows = ['r1', 'r2', 'r3', 'r4']
const weight = { columnId: 'col-survey-weight', name: 'survey_weight', label: 'Survey expansion factor' }
const warning = `この分析は調査ウェイト（${weight.name}）を適用しません。表示値は非加重です。`
const pages = [
  { name: 'Models', Page: ModelsPage, pageId: 'models-page', runId: 'run-model',
    targetRole: 'モデルの目的変数', featuresRole: 'モデルの説明変数', settings: 'モデルの詳細設定' },
  { name: 'Logistic', Page: LogisticRegressionPage, pageId: 'logistic-regression-page', runId: 'run-logistic-btn',
    targetRole: 'ロジスティック回帰の目的変数', featuresRole: 'ロジスティック回帰の説明変数', settings: 'モデルの詳細設定' },
  { name: 'Discriminant', Page: DiscriminantAnalysisPage, pageId: 'discriminant-analysis-page', runId: 'run-discriminant-btn',
    targetRole: '判別分析の目的クラス', featuresRole: '判別分析の説明変数', settings: '判別分析の詳細設定' },
] as const

function column(name: string, extra: Partial<CodebookColumn> = {}): CodebookColumn {
  return { columnId: `col-${name}`, name, label: name, role: 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false,
    multiResponseGroup: null, ...extra }
}

function prepare(datasetId: string) {
  const saved: CodebookResponse = { datasetId, schemaRevision: 2, licenseText: '', licenseRevision: 1,
    columns: [column('outcome', { scaleType: 'nominal', valueLabels: { '0': 'No', '1': 'Yes' } }),
      column('predictor'), column(weight.name, { ...weight, role: 'weight' })],
    multiResponseGroups: [], weightConfig: { weightColumnId: weight.columnId, weightType: 'survey' }, surveyDesign: null }
  const schema = saved.columns.map(c => ({ columnId: c.columnId, name: c.name, semanticType: 'numeric' as const,
    physicalType: 'Float64', missingCount: 0 }))
  vi.spyOn(client.api, 'get').mockImplementation(async path => {
    if (path === `/datasets/${datasetId}`) return { schema } as any
    throw new Error(`Unexpected dataset read: ${path}`)
  })
  vi.spyOn(client, 'fetchArrowView').mockImplementation(async id => {
    expect(id).toBe(datasetId)
    return { __rowId__: rows, outcome: [0, 1, 0, 1], predictor: [1, 2, 3, 4], survey_weight: [1, 2, 1, 2] }
  })
  const post = vi.spyOn(client.api, 'post').mockImplementation(async path => {
    if (path === `/datasets/${datasetId}/color-domains`) return { domains: [] } as any
    throw new Error(`Unexpected analysis or mutation: ${path}`)
  })
  store.dispatch(codebookReset())
  store.dispatch(datasetLoaded({ datasetId, name: 'Weight disclosure fixture', rowIds: rows, dataRevision: 3 }))
  store.dispatch(variablesInitialized({ datasetId, variables: saved.columns.map(c => c.name),
    meta: Object.fromEntries(schema.map(c => [c.name, { ...c, isTargetCandidate: false }])) }))
  store.dispatch(codebookReceived(saved))
  store.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'col-outcome' }, { kind: 'column', columnId: 'col-predictor' }]))
  store.dispatch(weightColumnCleared())
  store.dispatch(pcpStateChanged({ colorBy: null }))
  store.dispatch(selectionApplied({ rowIds: ['r2', 'r4'], operation: 'replace', label: 'Setup selection' }))
  store.dispatch(observationScopeChanged('selected'))
  return post
}

async function choose(roleName: string, value: string, multiple = false) {
  fireEvent.click(screen.getByRole('button', { name: `${roleName}を選択`, exact: true }))
  const search = await screen.findByRole('textbox', { name: `${roleName}を変数名・質問文で絞り込み` })
  const dialog = search.closest('[role="dialog"]') as HTMLElement
  await waitFor(() => expect(dialog).toBeVisible())
  const candidates = within(dialog).getAllByRole(multiple ? 'checkbox' : 'radio')
  expect(candidates.map(input => input.closest('label')?.textContent)).toEqual(multiple ? ['predictor'] : ['outcome', 'predictor'])
  fireEvent.click(within(dialog).getByRole(multiple ? 'checkbox' : 'radio', { name: value, exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog).not.toBeVisible())
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

function editNumber(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

function changeSettings(config: typeof pages[number]) {
  const page = within(screen.getByTestId(config.pageId))
  const settings = page.getByText(config.settings, { exact: true }).closest('details')!
  act(() => { settings.open = true })
  if (config.name === 'Models') {
    fireEvent.click(page.getByRole('radio', { name: 'ランダムフォレスト (Random Forest)', exact: true }))
    editNumber(page.getByTestId('max-depth'), '6')
    editNumber(page.getByTestId('n-estimators'), '120')
    return () => {
      expect(page.getByRole('radio', { name: 'ランダムフォレスト (Random Forest)', exact: true })).toBeChecked()
      expect(page.getByTestId('max-depth')).toHaveValue('6')
      expect(page.getByTestId('n-estimators')).toHaveValue('120')
      expect(settings.querySelector('summary')).toHaveTextContent('最大深さ: 6 / 決定木の本数: 120')
    }
  }
  if (config.name === 'Logistic') {
    fireEvent.click(page.getByRole('radio', { name: 'L2', exact: true }))
    editNumber(page.getByRole('spinbutton', { name: 'C値 (Inverse Penalty)', exact: true }), '2.5')
    fireEvent.click(page.getByRole('checkbox', { name: '切片項 (Intercept)', exact: true }))
    return () => {
      expect(page.getByRole('radio', { name: 'L2', exact: true })).toBeChecked()
      expect(page.getByRole('spinbutton', { name: 'C値 (Inverse Penalty)', exact: true })).toHaveValue('2.5')
      expect(page.getByRole('checkbox', { name: '切片項 (Intercept)', exact: true })).not.toBeChecked()
      expect(settings.querySelector('summary')).toHaveTextContent('正則化: L2 / C値: 2.5 / 切片: なし')
    }
  }
  fireEvent.click(page.getByRole('radio', { name: 'QDA', exact: true }))
  fireEvent.click(page.getByRole('radio', { name: '等確率', exact: true }))
  return () => {
    expect(page.getByRole('radio', { name: 'QDA', exact: true })).toBeChecked()
    expect(page.getByRole('radio', { name: '等確率', exact: true })).toBeChecked()
    expect(page.getByRole('radio', { name: 'Auto', exact: true })).toBeDisabled()
    expect(settings.querySelector('summary')).toHaveTextContent('手法: QDA / 縮小: QDAでは不使用 / 事前確率: 等確率')
  }
}

function variablesWithoutWeight() {
  const { weightColumnId: _id, weightSelectionRevision: _revision, ...variables } = store.getState().globalVariables
  return variables
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(pages)('$name discloses header weight on/off/on without changing setup, source or selection or running analysis', async config => {
  const post = prepare(`weight-disclosure-${config.name.toLowerCase()}`)
  const { Page } = config
  render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={store}><MemoryRouter>
    <GlobalHeaderControlBar /><Page />
  </MemoryRouter></Provider></ConfigProvider>)
  const page = within(screen.getByTestId(config.pageId))
  expect(page.getByTestId(config.runId)).toBeDisabled()
  await choose(config.targetRole, 'outcome')
  await choose(config.featuresRole, 'predictor', true)
  const assertSettings = changeSettings(config)
  const source = store.getState(), variables = variablesWithoutWeight()
  const scope = page.getByTestId('analysis-scope-summary').textContent
  const target = page.getByRole('combobox', { name: config.targetRole }).closest('.column-select-multi-wrap')!
  const features = page.getByRole('combobox', { name: config.featuresRole }).closest('.column-select-multi-wrap')!
  function assertUnchangedSetup() {
    expect(target).toHaveTextContent('outcome')
    expect(features).toHaveTextContent('predictor')
    expect(target).not.toHaveTextContent(weight.name)
    expect(features).not.toHaveTextContent(weight.name)
    expect(page.getByTestId(config.runId)).toBeEnabled()
    assertSettings()
    expect(page.getByTestId('analysis-scope-summary').textContent).toBe(scope)
    expect(page.getByTestId('analysis-scope-summary')).toHaveTextContent('選択中の行 (Selected) 2行')
    expect(screen.getByRole('radio', { name: 'Selected (2)', exact: true })).toBeChecked()
    expect(store.getState().selection).toEqual(source.selection)
    expect(store.getState().codebook).toEqual(source.codebook)
    expect(store.getState().globalObservations).toEqual(source.globalObservations)
    expect(variablesWithoutWeight()).toEqual(variables)
    expect(selectOrdinaryVariables(store.getState()).activeVariableIds).toEqual(['outcome', 'predictor'])
    expect(selectEffectiveRowIds(store.getState())).toEqual(['r2', 'r4'])
    expect(post.mock.calls.filter(([path]) => !path.endsWith('/color-domains'))).toEqual([])
  }
  expect(source.codebook.columns.find(c => c.columnId === weight.columnId)?.name).toBe(weight.name)
  expect(source.globalVariables.activeEntities).not.toContainEqual({ kind: 'column', columnId: weight.columnId })
  expect(source.globalVariables.weightColumnId).toBeNull()
  expect(screen.getByTestId('global-weight-select')).toHaveTextContent('未選択')
  expect(page.queryByTestId('weight-unsupported-alert')).toBeNull()
  assertUnchangedSetup()
  const notices: (string | null)[] = []
  for (const enabled of [true, false, true]) {
    await setWeight(enabled)
    assertUnchangedSetup()
    const notice = page.queryByTestId('weight-unsupported-alert')
    if (notice) expect(notice).toBeVisible()
    notices.push(notice?.textContent ?? null)
  }
  // Baseline reaches this disclosure assertion only after all real header
  // transitions and setup/source/selection invariants have succeeded.
  expect(notices).toEqual([`ウェイト未適用${warning}`, null, `ウェイト未適用${warning}`])
  const notice = within(page.getByTestId('weight-unsupported-alert'))
  expect(notice.getByText('ウェイト未適用', { exact: true })).toBeVisible()
  expect(notice.getByText(warning, { exact: true })).toBeVisible()
})
