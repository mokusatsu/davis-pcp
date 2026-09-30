import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionApplied } from '../src/app/store'
import { getInstanceByDom } from 'echarts'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import { api } from '../src/api/client'
import SurpriseAssociationView from '../src/features/relationships/SurpriseAssociationView'

vi.mock('../src/features/pcp/MaAxisPicker', () => ({ default: ({ onAdd }: any) => <button onClick={() => onAdd(['a', 'b'].map(columnId => ({ kind: 'maOption', groupId: 'q', columnId })))}>Choose options</button> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('runs only on explicit execution with selected columns, scope and revisions', async () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'manual', dataRevision: 3, selectedRowIds: ['r'] },
    globalObservations: { ...base.globalObservations, scopeMode: 'selected', selectedRowIds: ['r'], activeRowIds: ['r'], totalRowIds: ['r'] },
    codebook: { ...base.codebook, datasetId: 'manual', schemaRevision: 2, columns: ['a', 'b'].map(name => ({
      columnId: name, name, role: 'question', scaleType: 'nominal', multiResponseGroup: 'q',
    })) }, globalVariables: { ...base.globalVariables, activeEntities: null },
  }) as any, middleware: g => g({ serializableCheck: false }) })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ run_id: 'run', pairs: [], pair_matrix: { columns: [], matrix: [] } })
  const view = render(<Provider store={local}><MemoryRouter><SurpriseAssociationView /></MemoryRouter></Provider>)
  expect(post).not.toHaveBeenCalled()
  expect(view.getByTestId('refresh-surprise-btn')).toBeDisabled()
  fireEvent.click(view.getByText('Choose options'))
  expect(post).not.toHaveBeenCalled()
  fireEvent.keyDown(view.getByRole('slider'), { key: 'ArrowRight', keyCode: 39 })
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(view.getByTestId('refresh-surprise-btn'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith('/relationships/surprise', expect.objectContaining({ datasetId: 'manual', columns: ['a', 'b'], rowIds: ['r'],
    expectedSchemaRevision: 2, expectedDataRevision: 3 }))
})

it('renders the native association heatmap with pair details and preserves its instance during expansion', async () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'heatmap', dataRevision: 3 },
    globalObservations: { ...base.globalObservations, activeRowIds: ['r'], totalRowIds: ['r'] },
    codebook: { ...base.codebook, datasetId: 'heatmap', schemaRevision: 2, columns: ['a', 'b'].map(name => ({
      columnId: name, name, label: `${name} full question`, role: 'question', scaleType: 'nominal', multiResponseGroup: 'q',
    })) }, globalVariables: { ...base.globalVariables, activeEntities: null },
  }) as any, middleware: g => g({ serializableCheck: false }) })
  const pair = {
    id: 'a-b', x: { name: 'a', label: 'A', type: 'categorical' }, y: { name: 'b', label: 'B', type: 'categorical' },
    primary: { measure: 'corrected_v', value: .7, sign: 1, signed_value: .7 },
    secondary: { pearson_r: null, spearman_rho: null, kendall_tau: null, correlation_ratio: null },
    strength: .7, unexpectedness_lift: .6, max_lift: 2,
    surprise: { strength: .7, unexpectedness_empirical: .6, unexpectedness_lift: .6, unexpectedness: .6, surprise_score: .65 },
    top_lift: { cell: 'A=1 × B=1', lift: 2, p_obs: .5, p_expected: .25, row_ids: ['r'] }, n_valid: 1,
  }
  const post = vi.spyOn(api, 'post').mockResolvedValue({ run_id: 'run', pairs: [pair], pair_matrix: { columns: ['a', 'b'], matrix: [[1, .7], [.7, 1]] } })
  const dispatch = vi.spyOn(local, 'dispatch')
  const view = render(<Provider store={local}><MemoryRouter><GraphExpansionProvider><SurpriseAssociationView /></GraphExpansionProvider></MemoryRouter></Provider>)
  fireEvent.click(view.getByText('Choose options'))
  fireEvent.click(view.getByTestId('refresh-surprise-btn'))
  await view.findByTestId('top-lift-inspector')
  fireEvent.click(view.getByText('階層化ヒートマップ (Heatmap)'))
  const chartDom = await view.findByTestId('surprise-heatmap-chart')
  const chart = getInstanceByDom(chartDom)!
  const options = chart.getOption() as any
  expect(options.series[0].type).toBe('heatmap')
  expect(options.series[0].data.map((cell: any) => cell.raw)).toEqual([1, .7, .7, 1])
  expect(options.xAxis[0].data).toEqual(['a — a full question', 'b — b full question'])
  act(() => { (chart as any).trigger('click', { data: { row: 1, col: 0 } }) })
  expect(view.getByTestId('top-lift-inspector')).toHaveTextContent('A=1 × B=1')
  fireEvent.click(screen.getByTestId('graph-expand-associations/heatmap'))
  fireEvent.click(screen.getByTestId('graph-expansion-zoom-in'))
  expect(getInstanceByDom(view.getByTestId('surprise-heatmap-chart'))).toBe(chart)
  fireEvent.click(screen.getByTestId('graph-expansion-exit'))
  expect(getInstanceByDom(view.getByTestId('surprise-heatmap-chart'))).toBe(chart)
  expect(post).toHaveBeenCalledTimes(1)
  fireEvent.click(view.getByTestId('select-lift-pcp'))
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: selectionApplied.type, payload: expect.objectContaining({ rowIds: ['r'] }) }))
})
