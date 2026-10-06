import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { getInstanceByDom } from 'echarts'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import CovariancePage from '../src/features/covariance/CovariancePage'

// Keep the actual radios, GraphPanel, MatrixHeatmap, ECharts and cell inspector.
// Distinct response matrices make selecting raw precision a detectable regression.
const result = {
  columns: ['x', 'y', 'z'], nRows: 4, means: { x: 1, y: 2, z: 3 }, stds: { x: 2, y: 3, z: 4 },
  covariance: [[4, 1, 2], [1, 9, 3], [2, 3, 16]], correlation: [[1, .1667, .25], [.1667, 1, .25], [.25, .25, 1]],
  precision: [[.27, -.02, -.03], [-.02, .12, -.02], [-.03, -.02, .07]],
  partialCorrelation: [[1, .1111, .2182], [.1111, 1, .2182], [.2182, .2182, 1]],
  diagnostics: { generalizedVariance: 500, logGeneralizedVariance: 6.2146, totalVariance: 29, conditionNumber: 4.83, isSingular: false },
}
function mount() {
  const base = store.getState()
  const columns = result.columns.map(name => ({ name, columnId: `${name}-id`, label: `${name} question`,
    role: 'question', scaleType: 'ratio', multiResponseGroup: null, valueLabels: {}, missingCodes: [], missingReasons: {}, isReversed: false }))
  const initial = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: ['r1', 'r2', 'r3', 'r4'], activeRowIds: ['r1', 'r2', 'r3', 'r4'] },
    globalVariables: { ...base.globalVariables, allVariables: result.columns, activeEntities: columns.map(c => ({ kind: 'column', columnId: c.columnId })) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns, isLoading: false },
  } as any
  const local = configureStore({ reducer: (state = initial) => state,
    middleware: defaults => defaults({ serializableCheck: false, immutableCheck: false }) })
  render(<Provider store={local}><MemoryRouter><CovariancePage /></MemoryRouter></Provider>)
  return local
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(560)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(api, 'post').mockResolvedValue(result)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('labels every actual displayed matrix and its export while switching modes without requests or numerical changes', async () => {
  const local = mount(), before = local.getState()
  await screen.findByTestId('covariance-matrix')
  expect(api.post).toHaveBeenCalledTimes(1)
  expect(api.post).toHaveBeenCalledWith('/statistics/covariance', {
    datasetId: 'd', columns: ['x', 'y', 'z'], rowIds: ['r1', 'r2', 'r3', 'r4'], expectedSchemaRevision: 2, expectedDataRevision: 3,
  })
  const radios = within(screen.getByRole('radiogroup', { name: '共分散の表示行列' }))
  expect(radios.getAllByRole('radio').map(radio => radio.closest('label')?.textContent)).toEqual([
    '共分散行列 (Covariance Σ)', '相関行列 (Correlation R)', '偏相関行列 (Partial Correlation)',
  ])
  expect(radios.getByRole('radio', { name: '共分散行列 (Covariance Σ)' })).toBeChecked()
  expect(radios.getByRole('radio', { name: '偏相関行列 (Partial Correlation)' })).toHaveAttribute('value', 'prec')
  expect(screen.getByText(/選択列の逆共分散行列/)).toHaveTextContent(
    '選択列の逆共分散行列から算出した偏相関行列（選択した他の変数を統制した相関）',
  )
  expect(screen.queryByText(/精度行列/)).not.toBeInTheDocument()

  const host = screen.getByTestId('covariance-matrix')
  await waitFor(() => expect(getInstanceByDom(host)).toBeDefined())
  const chart = getInstanceByDom(host)!
  for (const [mode, title, matrix, bound, decimals] of [
    ['cov', '分散共分散行列', result.covariance, 16, 3],
    ['corr', '相関行列', result.correlation, 1, 2],
    ['prec', '偏相関行列', result.partialCorrelation, 1, 2],
    ['cov', '分散共分散行列', result.covariance, 16, 3],
  ] as const) {
    fireEvent.click(screen.getByTestId(`covariance-mode-${mode}`))
    const titleRow = screen.getByTestId('graph-host-covariance/matrix').querySelector('.graph-panel-title-row')!
    expect(within(titleRow as HTMLElement).getByText(title, { exact: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `${title}を拡大表示` })).toBeInTheDocument()
    expect(host.getAttribute('aria-label')).toMatch(new RegExp(`^${title}。`))
    expect(screen.getByRole('button', { name: `${title}：SVGを保存` })).toBeInTheDocument()
    const option = chart.getOption(), series = (option.series as any[])[0]
    expect(series.data.map((cell: any) => cell.raw)).toEqual(matrix.flat())
    expect((option.visualMap as any[])[0]).toMatchObject({ min: -bound, max: bound })
    expect(series.label.formatter({ data: series.data[1] })).toBe(matrix[0][1].toFixed(decimals))
    expect(getInstanceByDom(host)).toBe(chart)
    expect(api.post).toHaveBeenCalledTimes(1)
  }

  // Real keyboard selection preserves the existing cross-mode cell inspector.
  act(() => { host.focus() })
  fireEvent.keyDown(host, { key: 'ArrowRight' })
  fireEvent.keyDown(host, { key: 'Enter' })
  await waitFor(() => expect(screen.getByTestId('graph-controls-covariance/matrix')).toHaveTextContent('選択セル:'))
  const inspector = screen.getByTestId('graph-controls-covariance/matrix')
  const selectedDetails = inspector.textContent
  expect(selectedDetails).toContain('共分散:')
  expect(selectedDetails).toContain('相関:')
  expect(selectedDetails).toContain('偏相関:')
  fireEvent.click(screen.getByTestId('covariance-mode-prec'))
  expect(inspector.textContent).toBe(selectedDetails)
  expect((chart.getOption().series as any[])[0].data.filter((cell: any) => cell.itemStyle.borderWidth === 3)).toHaveLength(1)
  expect(api.post).toHaveBeenCalledTimes(1)
  expect(local.getState()).toBe(before)
})
