import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AppShell from '../src/app/AppShell'
import { globalObservationsSlice, selectionReducer, store } from '../src/app/store'
import { SELECTION_LABELS } from '../src/features/selection/selectionLabels'

vi.mock('../src/app/KeepAliveOutlet', () => ({ default: () => <div data-testid="analysis-content">Analysis content</div> }))
vi.mock('../src/features/common/LicenseModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookEditorModal', () => ({ default: () => null }))
vi.mock('../src/features/selection/VariableSelectionModal', () => ({ default: () => null }))
vi.mock('../src/features/selection/ObservationModal', () => ({ default: () => null }))
vi.mock('../src/theme/useL1Selection', () => ({ useL1Selection: () => {} }))
vi.mock('../src/theme/useL1ColorDomain', () => ({ useDatasetL1ColorDomains: () => [] }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/api/client', () => ({ api: { get: async () => ({ columns: [], datasets: [] }) }, downloadExport: vi.fn() }))

let resizeViewport: (width: number) => void
beforeEach(() => {
  let width = 1024
  const queries: { query: MediaQueryList; listeners: Set<(event: MediaQueryListEvent) => void> }[] = []
  const matches = (query: string) => query.includes('min-width')
    ? width >= Number(query.match(/\d+/)?.[0])
    : width <= Number(query.match(/\d+/)?.[0])
  vi.spyOn(window, 'matchMedia').mockImplementation(media => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const query = {
      get matches() { return matches(media) },
      media, onchange: null,
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      dispatchEvent: vi.fn(),
    } as MediaQueryList
    queries.push({ query, listeners })
    return query
  })
  resizeViewport = nextWidth => {
    act(() => {
      width = nextWidth
      for (const { query, listeners } of queries) {
        for (const listener of listeners) listener({ matches: query.matches, media: query.media } as MediaQueryListEvent)
      }
    })
  }
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount(selectedRowIds: string[] = []) {
  const base = store.getState()
  const initialState = { ...base,
    selection: { ...base.selection, datasetId: 'layout', allRowIds: ['r1'], activeRowIds: ['r1'], selectedRowIds },
    codebook: { ...base.codebook, datasetId: 'layout' },
  }
  const local = configureStore({ reducer: (state = initialState, action) => ({
    ...state, selection: selectionReducer(state.selection, action),
    globalObservations: globalObservationsSlice.reducer(state.globalObservations, action),
  }) })
  return { ...render(<Provider store={local}><MemoryRouter initialEntries={['/penalty-reward']}><AppShell /></MemoryRouter></Provider>), local }
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

it.each([375, 767, 768, 1024])('keeps selection outside the analysis layout below 768px (%ipx)', async width => {
  resizeViewport(width)
  mount()
  const toggle = screen.getByTestId('toggle-sidebar')
  const workspace = screen.getByTestId('analysis-workspace')
  expect(toggle).toHaveAttribute('aria-expanded', String(width >= 768))
  expect(Boolean(within(workspace).queryByTestId('selected-sidebar'))).toBe(width >= 768)
  expect(screen.queryByRole('dialog', { name: '選択行', exact: true })).not.toBeInTheDocument()
  expect(screen.getByRole('main', { name: '分析画面' })).toHaveStyle({ flex: '1', minWidth: '0' })
  expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 768px)')

  if (width < 768) {
    expect(toggle).toHaveAttribute('aria-haspopup', 'dialog')
    const content = screen.getByTestId('analysis-content')
    fireEvent.click(toggle)
    const dialog = await screen.findByRole('dialog', { name: '選択行', exact: true })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-controls', 'selected-rows-drawer')
    expect(workspace).not.toContainElement(dialog)
    expect(within(workspace).queryByTestId('selected-sidebar')).not.toBeInTheDocument()
    expect(screen.getByTestId('analysis-content')).toBe(content)
    expect(dialog.closest('.ant-drawer-content-wrapper')).toHaveStyle({ width: 'min(320px, calc(100vw - 24px))' })
  }
})

it.each([true, false])('restores the desktop sidebar preference across mobile resize (open=%s)', async desktopOpen => {
  const { local } = mount(['r1'])
  const toggle = screen.getByTestId('toggle-sidebar')
  if (!desktopOpen) fireEvent.click(toggle)
  const selection = local.getState().selection
  const content = screen.getByTestId('analysis-content')

  resizeViewport(375)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByTestId('selected-sidebar')).not.toBeInTheDocument()
  fireEvent.click(toggle)
  await screen.findByRole('dialog', { name: '選択行', exact: true })

  resizeViewport(768)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '選択行', exact: true })).not.toBeInTheDocument())
  expect(toggle).toHaveAttribute('aria-expanded', String(desktopOpen))
  expect(Boolean(screen.queryByTestId('selected-sidebar'))).toBe(desktopOpen)
  resizeViewport(1024)
  expect(toggle).toHaveAttribute('aria-expanded', String(desktopOpen))
  resizeViewport(375)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('dialog', { name: '選択行', exact: true })).not.toBeInTheDocument()
  expect(screen.getByTestId('analysis-content')).toBe(content)
  expect(local.getState().selection).toBe(selection)
})

it.each(['Escape', 'close', 'mask'])('dismisses and reopens the mobile drawer with focus restored (%s)', async dismissal => {
  resizeViewport(375)
  mount()
  const toggle = screen.getByTestId('toggle-sidebar')
  fireEvent.click(toggle)
  const dialog = await screen.findByRole('dialog', { name: '選択行', exact: true })
  const close = within(dialog).getByRole('button', { name: '選択行サイドバーを閉じる' })
  // rc-util downgrades layout effects in NODE_ENV=test, so its portal's initial
  // autofocus runs before attachment in jsdom. Exercise the real focus trap
  // after attachment; actual initial autofocus is also checked in browser QA.
  close.focus()
  if (dismissal === 'Escape') fireEvent.keyDown(close, { key: 'Escape', keyCode: 27 })
  else if (dismissal === 'close') fireEvent.click(close)
  else fireEvent.click(dialog.closest('.ant-drawer')!.querySelector('.ant-drawer-mask')!)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '選択行', exact: true })).not.toBeInTheDocument())
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveFocus()
  fireEvent.click(toggle)
  await screen.findByRole('dialog', { name: '選択行', exact: true })
})

it('keeps the mobile drawer connected to central selection and closes it after statistics navigation', async () => {
  resizeViewport(375)
  const { local } = mount(['r1'])
  const toggle = screen.getByTestId('toggle-sidebar')
  fireEvent.click(toggle)
  const dialog = await screen.findByRole('dialog', { name: '選択行', exact: true })
  expect(within(dialog).getByText('選択行 1 / active 1 / 全1')).toBeInTheDocument()
  fireEvent.click(within(dialog).getByTestId('sidebar-stats-button'))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '選択行', exact: true })).not.toBeInTheDocument())
  expect(screen.getByTestId('navigation-current')).toHaveTextContent('記述統計（Statistics）')
  expect(local.getState().globalObservations.scopeMode).toBe('selected')

  fireEvent.click(toggle)
  const reopened = await screen.findByRole('dialog', { name: '選択行', exact: true })
  fireEvent.click(within(reopened).getByRole('button', { name: new RegExp(SELECTION_LABELS.clear) }))
  expect(local.getState().selection.selectedRowIds).toEqual([])
  expect(within(reopened).getByText('選択行 0 / active 1 / 全1')).toBeInTheDocument()
})

it('returns focus to the toggle when a focused desktop sidebar is removed by a narrow viewport', () => {
  mount(['r1'])
  const stats = within(screen.getByTestId('selected-sidebar')).getByTestId('sidebar-stats-button')
  act(() => stats.focus())
  expect(stats).toHaveFocus()
  resizeViewport(375)
  expect(screen.queryByTestId('selected-sidebar')).not.toBeInTheDocument()
  expect(screen.getByTestId('toggle-sidebar')).toHaveFocus()
})
