import apiRecords from './fixtures/qqplotApiResponses.json'
import { Component, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { ConfigProvider } from 'antd'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { getInstanceByDom } from 'echarts'
import AppShell from '../src/app/AppShell'
import QQPlotView from '../src/features/qqplot/QQPlotView'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import { store } from '../src/app/store'
import { api } from '../src/api/client'

const state = vi.hoisted(() => ({ data: null as any }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => state.data }))
vi.mock('../src/app/KeepAliveOutlet', () => ({ default: () => useLocation().pathname === '/distribution' ? <QQPlotView /> : <div data-testid="other-page" /> }))
// Confine the test to QQ rendering and the real shell/menu. No observation dialog is loaded.
vi.mock('../src/features/selection/GlobalHeaderControlBar', () => ({ default: () => null }))
vi.mock('../src/features/common/LicenseModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookEditorModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/DatasetLicenseNotice', () => ({ default: () => null }))
vi.mock('../src/app/useWorkspacePersistence', () => ({ useWorkspacePersistence: () => ({ sessions: [], datasetLicense: null }) }))
vi.mock('../src/theme/useL1Selection', () => ({ useL1Selection: () => {} }))

// Exact responses captured from the real FastAPI route at 6852106; see the API regression
// for the input recipes and independent finite-zero oracle. No hand-authored null payload.
const records = apiRecords as Record<string, any>
class AuditBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() { return this.state.error ? <div data-testid="uncaught-render-error">{this.state.error.message}</div> : this.props.children }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount(caseName = 'irisConstant') {
  const record = records[caseName]
  const response = record.response
  const isIrisRecovery = caseName === 'irisConstant'
  const names = isIrisRecovery ? ['petal_width_cm', 'sepal_length_cm'] : [response.column]
  const rowIds = record.request.rowIds ?? response.points.map((point: any) => point.rowId)
  const base = store.getState()
  const columns = names.map(name => ({ columnId: name, name, label: name, role: 'question', scaleType: 'ratio' }))
  state.data = { schema: names.map(name => ({ name, semanticType: 'numeric' })), rowIds,
    rowIndex: new Map(rowIds.map((id: string, index: number) => [id, index])),
    columns: isIrisRecovery ? { petal_width_cm: [.2, .2, .2, .2, .2], sepal_length_cm: [5.1, 4.9, 4.7, 4.6, 5.] }
      : { [response.column]: response.points.map((point: any) => point.sampleValue) } }
  const initial = { ...base,
    selection: { ...base.selection, datasetId: record.request.datasetId, dataRevision: 1, allRowIds: rowIds, activeRowIds: rowIds, selectedRowIds: [] },
    codebook: { ...base.codebook, datasetId: record.request.datasetId, columns, isLoading: false },
    globalVariables: { ...base.globalVariables, activeEntities: names.map(columnId => ({ kind: 'column', columnId })) },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' } }
  const local = configureStore({ reducer: (value = initial) => value, middleware: defaults => defaults({ serializableCheck: false }) })
  const post = vi.spyOn(api, 'post').mockImplementation(async (url, body: any) => {
    expect(url).toBe('/summaries/qqplot')
    expect(body.datasetId).toBe(record.request.datasetId)
    expect(body.rowIds).toEqual(rowIds)
    if (isIrisRecovery) return records[body.column === 'petal_width_cm' ? 'irisConstant' : 'irisFiniteNormal'].response
    expect(body.column).toBe(response.column)
    return response
  })
  render(<AuditBoundary><ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}>
    <MemoryRouter initialEntries={['/distribution']}><GraphExpansionProvider><AppShell /></GraphExpansionProvider></MemoryRouter>
  </Provider></ConfigProvider></AuditBoundary>)
  return { post }
}
async function settled(expectedColumn?: string) {
  await waitFor(() => expect(screen.queryByTestId('qqplot-diagnostics') || screen.queryByTestId('uncaught-render-error')).not.toBeNull())
  expect(screen.queryByTestId('uncaught-render-error')).not.toBeInTheDocument()
  expect(screen.getByTestId('app-shell')).toBeInTheDocument()
  expect(screen.getByTestId('main-nav')).toBeInTheDocument()
  expect(screen.getByTestId('qqplot-column-select')).toBeInTheDocument()
  if (expectedColumn) await waitFor(() => expect(screen.getByTestId('qqplot-canvas')).toHaveAttribute('aria-label', `理論正規分位点 × サンプル分位点 (${expectedColumn})`))
}
const diagnostic = (label: string) => screen.getByText(label).parentElement!
function lineSeries() {
  const chart = getInstanceByDom(screen.getByTestId('qqplot-canvas'))
  expect(chart).toBeDefined()
  return (chart!.getOption().series as any[]).filter(series => series.type === 'line')
}
async function chooseColumn(name: string) {
  // Real ColumnSelect / AntD popup and options, not a replacement native select.
  const selector = screen.getByTestId('qqplot-column-select')
  const input = within(selector).getByRole('combobox')
  fireEvent.mouseDown(input)
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')]
      .find(element => within(element as HTMLElement).queryByText(name, { exact: true }) !== null)
    expect(found).toBeDefined()
    return found!
  })
  fireEvent.click(option)
  fireEvent.keyDown(input, { key: 'Escape', code: 'Escape', keyCode: 27 })
  await settled(name)
}
function expectUnavailable() {
  expect(diagnostic('Shapiro-Wilk 検定:')).toHaveTextContent('W = 算出不能, p = 算出不能')
  expect(screen.getByText('判定不能')).toBeInTheDocument()
  expect(screen.queryByText(/非正規分布/)).not.toBeInTheDocument()
  expect(screen.queryByText(/^正規分布/)).not.toBeInTheDocument()
  expect(diagnostic('歪度 (Skewness):')).toHaveTextContent('算出不能')
  expect(diagnostic('尖度 (Kurtosis):')).toHaveTextContent('算出不能')
  expect(diagnostic('Q1-Q3 頑健基準線:')).toHaveTextContent('算出不能')
  expect(screen.queryByText('(対称に近い)')).not.toBeInTheDocument()
  expect(screen.queryByText('(正規に近い)')).not.toBeInTheDocument()
  expect(lineSeries()).toHaveLength(0)
}

it('FE-01 keeps the shell and real variable changes alive through constant → finite → constant', async () => {
  const { post } = mount()
  await settled('petal_width_cm')
  expectUnavailable()
  const shell = screen.getByTestId('app-shell')
  await chooseColumn('sepal_length_cm')
  expect(screen.getByText('正規分布 (p ≥ 0.05)')).toBeInTheDocument()
  expect(diagnostic('歪度 (Skewness):')).toHaveTextContent('-0.158')
  expect(lineSeries()).toHaveLength(1)
  await chooseColumn('petal_width_cm')
  expectUnavailable()
  expect(post.mock.calls.map(([, body]: any) => body.column)).toEqual(['petal_width_cm', 'sepal_length_cm', 'petal_width_cm'])
  expect(screen.getByTestId('app-shell')).toBe(shell)
})

it('FE-01 keeps the real shell menu operable after a constant result', async () => {
  mount()
  await settled('petal_width_cm')
  expectUnavailable()
  const shell = screen.getByTestId('app-shell')
  // The real shell menu remains operable after the unavailable result.
  fireEvent.click(screen.getByTestId('feature-list-button'))
  fireEvent.click(screen.getByRole('menuitem', { name: 'データ・概要' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'データ表（Table）' }))
  expect(screen.getByTestId('navigation-current')).toHaveTextContent('データ表（Table）')
  expect(screen.getByTestId('other-page')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('feature-list-button'))
  fireEvent.click(screen.getByRole('menuitem', { name: '可視化' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '分布（Distribution）' }))
  await settled('petal_width_cm')
  expectUnavailable()
  expect(screen.getByTestId('app-shell')).toBe(shell)
})

it.each([
  ['irisFiniteNonNormal', false],
  ['finiteZeroSkewAndIntercept', true],
  ['finiteZeroSlope', false],
] as const)('FE-01 preserves finite diagnostics and reference lines: %s', async (name, normal) => {
  mount(name)
  await settled(records[name].response.column)
  expect(screen.queryByText('判定不能')).not.toBeInTheDocument()
  expect(screen.getByText(normal ? '正規分布 (p ≥ 0.05)' : '非正規分布 (p < 0.05)')).toBeInTheDocument()
  const line = lineSeries()
  expect(line).toHaveLength(1)
  expect(line[0].data.flat().every(Number.isFinite)).toBe(true)
  if (name === 'finiteZeroSkewAndIntercept') {
    expect(diagnostic('歪度 (Skewness):')).toHaveTextContent('0.000 (対称に近い)')
    expect(diagnostic('歪度 (Skewness):')).not.toHaveTextContent('算出不能')
    expect(line[0].data[0][1]).toBeLessThan(0)
    expect(line[0].data[1][1]).toBeGreaterThan(0)
  }
  if (name === 'finiteZeroSlope') {
    expect(diagnostic('Q1-Q3 頑健基準線:')).toHaveTextContent('Slope: 0.000')
    expect(line[0].data.map((point: number[]) => point[1])).toEqual([0, 0])
  }
})
