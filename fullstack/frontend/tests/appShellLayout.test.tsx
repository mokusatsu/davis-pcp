import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import AppShell from '../src/app/AppShell'
import { store } from '../src/app/store'

vi.mock('../src/app/KeepAliveOutlet', () => ({ default: () => <div data-testid="analysis-content">Analysis content</div> }))
vi.mock('../src/features/common/LicenseModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookEditorModal', () => ({ default: () => null }))
vi.mock('../src/features/selection/VariableSelectionModal', () => ({ default: () => null }))
vi.mock('../src/features/selection/ObservationModal', () => ({ default: () => null }))
vi.mock('../src/theme/useL1Selection', () => ({ useL1Selection: () => {} }))
vi.mock('../src/theme/useL1ColorDomain', () => ({ useDatasetL1ColorDomains: () => [] }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/api/client', () => ({ api: { get: async () => ({ columns: [], datasets: [] }) }, downloadExport: vi.fn() }))

afterEach(cleanup)

function mount() {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'layout', allRowIds: ['r1'], activeRowIds: ['r1'] },
    codebook: { ...base.codebook, datasetId: 'layout' },
  }) })
  return render(<Provider store={local}><MemoryRouter initialEntries={['/penalty-reward']}><AppShell /></MemoryRouter></Provider>)
}

// jsdom cannot lay out a zoomed viewport. These guard the overflow contract;
// actual Chrome 200% zoom / wheel reachability is covered by browser QA.
it('L02 preserves an analysis allocation and allows the shell to scroll an oversized header away', () => {
  mount()
  expect(screen.getByTestId('app-shell')).toHaveStyle({ height: '100dvh', minHeight: '0', overflowY: 'auto' })
  expect(screen.getByTestId('analysis-workspace')).toHaveStyle({ minHeight: 'min(320px, 100dvh)', overflow: 'hidden', flex: '1' })
  expect(screen.getByRole('main', { name: '分析画面' })).toHaveStyle({ height: '100%', overflowY: 'auto' })
  // Sidebar changes must not replace or hide the analysis / scrolling shell.
  const content = screen.getByTestId('analysis-content')
  fireEvent.click(screen.getByTestId('toggle-sidebar'))
  expect(screen.queryByTestId('selected-sidebar')).not.toBeInTheDocument()
  expect(screen.getByTestId('analysis-content')).toBe(content)
  fireEvent.click(screen.getByTestId('toggle-sidebar'))
  expect(screen.getByTestId('selected-sidebar')).toBeInTheDocument()
  expect(screen.getByTestId('analysis-content')).toBe(content)
})

it('L02 wraps complete header controls without squeezing their labels into vertical text', () => {
  mount()
  for (const id of ['global-variable-controls', 'global-weight-controls', 'global-scope-controls', 'observation-scope-group']) {
    expect(screen.getByTestId(id)).toHaveStyle({ display: 'flex', flexWrap: 'wrap' })
  }
  expect(screen.getByText('ウェイト:')).toHaveStyle({ whiteSpace: 'nowrap', flexShrink: '0' })
  expect(screen.getByText('表示・次回分析対象:')).toHaveStyle({ whiteSpace: 'nowrap' })
  expect(screen.getByTestId('global-var-btn')).toHaveStyle({ minWidth: '0', maxWidth: '100%' })
  expect(screen.getByTestId('scope-active')).toBeInTheDocument()
  expect(screen.getByTestId('scope-selected')).toBeInTheDocument()
  expect(screen.getByTestId('scope-sampled')).toBeInTheDocument()
  expect(screen.getByTestId('scope-all')).toBeInTheDocument()
})
