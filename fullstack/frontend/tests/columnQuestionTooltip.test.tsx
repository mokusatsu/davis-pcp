import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import ColumnQuestionTooltip from '../src/features/common/ColumnQuestionTooltip'
import GraphPanel from '../src/features/common/GraphPanel'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import { codebookSlice, fetchCodebookThunk, draftColumnUpdated, saveCodebookThunk, codebookSaveAccepted, codebookReadAccepted } from '../src/features/dataset/codebookSlice'
import type { CodebookColumn } from '../src/api/client'

const column: CodebookColumn = { columnId: 'q-id', name: 'Q', label: '質問です\n<script>文字列</script>', scaleType: 'ratio', role: 'question',
  valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }
function setup(label = column.label, datasetId = 'ds') {
  const state = store.getState()
  const loading = codebookSlice.reducer(state.codebook, fetchCodebookThunk.pending('load', 'ds'))
  const loaded = codebookSlice.reducer(loading, codebookReadAccepted({ datasetId: 'ds', schemaRevision: 1, columns: [] }, 'load'))
  const cb = { ...loaded, datasetId: 'ds', columns: [{ ...column, label }], draftColumns: [{ ...column, label }] }
  return configureStore({ reducer: {
    codebook: codebookSlice.reducer,
    selection: (s = { ...state.selection, datasetId }) => s,
    pcp: (s = state.pcp) => s,
  }, preloadedState: { codebook: cb }, middleware: g => g({ serializableCheck: false }) })
}
afterEach(cleanup)
describe('column question popup', () => {
  it('shows escaped saved text by ID and dismisses on Escape without stealing focus', async () => {
    render(<Provider store={setup()}><ColumnQuestionTooltip nameOrId="q-id">Q</ColumnQuestionTooltip></Provider>)
    const trigger = screen.getByText('Q')
    act(() => { trigger.focus() })
    const popup = await screen.findByRole('tooltip')
    expect(popup.textContent).toContain('<script>文字列</script>')
    expect(popup.querySelector('script')).toBeNull()
    expect(trigger).toHaveAttribute('aria-describedby')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(popup).not.toBeVisible())
    expect(trigger).toHaveFocus()
  })
  it('does not leak unsaved edits but updates an open popup after save', async () => {
    const testStore = setup('保存済み')
    render(<Provider store={testStore}><ColumnQuestionTooltip nameOrId="Q" /></Provider>)
    fireEvent.focus(screen.getByText('Q'))
    await waitFor(() => expect(screen.getByText('保存済み')).toBeVisible())
    act(() => { testStore.dispatch(draftColumnUpdated({ columnId: 'q-id', patch: { label: '下書き' } })) })
    expect(screen.queryByText('下書き')).toBeNull()
    act(() => { testStore.dispatch(saveCodebookThunk.pending('save', undefined)); testStore.dispatch(codebookSaveAccepted({ datasetId: 'ds', schemaRevision: 2, columns: [{ ...column, label: '保存後' }], submittedColumns: [{ ...column, label: '下書き' }], multiResponseGroups: [], submittedGroups: [] } as any, 'save')) })
    await waitFor(() => expect(screen.getByText('保存後')).toBeVisible())
  })
  it.each([['   ', 'ds'], ['別の設問', 'other']])('omits unavailable questions (%s/%s)', (label, dataset) => {
    const { container } = render(<Provider store={setup(label, dataset)}><ColumnQuestionTooltip nameOrId="Q" /></Provider>)
    expect(container.querySelector('[data-column-question]')).toBeNull()
  })
  it('keeps SVG valid and prevents label pointerdown from starting a brush', async () => {
    let brushed = false
    const { container } = render(<Provider store={setup()}><svg onPointerDown={() => { brushed = true }}>
      <ColumnQuestionTooltip nameOrId="Q" svg><text>Q</text></ColumnQuestionTooltip>
    </svg></Provider>)
    expect(container.querySelector('svg span')).toBeNull()
    fireEvent.pointerDown(screen.getByText('Q'))
    expect(brushed).toBe(false)
    fireEvent.focus(screen.getByText('Q'))
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible())
  })
  it('opens the information control without selecting its surrounding option', async () => {
    let selected = false
    render(<Provider store={setup('設問です')}><div onClick={() => { selected = true }}>
      <ColumnQuestionTooltip nameOrId="Q" info />
    </div></Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Qの設問文を表示' }))
    await waitFor(() => expect(screen.getByText('設問です')).toBeVisible())
    expect(selected).toBe(false)
  })
  it('puts an expanded graph axis question popup inside the dialog popup root', async () => {
    const testStore = setup()
    render(
      <Provider store={testStore}>
        <GraphExpansionProvider>
          <GraphPanel graphId="test/tooltip" title="設問付き図" sizing="intrinsic" intrinsicSize={{ width: 320, height: 180 }}>
            <svg viewBox="0 0 320 180"><ColumnQuestionTooltip nameOrId="Q" svg><text x={20} y={40}>Q</text></ColumnQuestionTooltip></svg>
          </GraphPanel>
        </GraphExpansionProvider>
      </Provider>,
    )
    fireEvent.click(screen.getByTestId('graph-expand-test/tooltip'))
    await screen.findByTestId('graph-expansion-dialog')
    fireEvent.focus(screen.getByText('Q'))
    const popup = await screen.findByRole('tooltip')
    expect(screen.getByTestId('graph-expansion-popup')).toContainElement(popup)
  })
})
