import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { store, pcpStateChanged } from '../src/app/store'
import PointerSelectionDropdown from '../src/features/selection/PointerSelectionDropdown'
import { beforeEach } from 'vitest'

function renderWithStore(ui: React.ReactElement) {
  return {
    ...render(<Provider store={store}>{ui}</Provider>),
    store,
  }
}

describe('PointerSelectionDropdown', () => {
  beforeEach(() => {
    store.dispatch(pcpStateChanged({ brushOperation: 'replace', hitMode: 'legacyVertex' }))
  })
  it('renders the shared "選択" button', () => {
    renderWithStore(<PointerSelectionDropdown testId="test-pointer-btn" />)
    const button = screen.getByTestId('test-pointer-btn')
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('選択')
  })

  it('opens popup showing "集合演算" above "PCPヒット判定" when clicked', async () => {
    renderWithStore(<PointerSelectionDropdown testId="test-pointer-btn" />)
    const button = screen.getByTestId('test-pointer-btn')
    fireEvent.click(button)

    await waitFor(() => {
      const brushLabel = screen.getByText('集合演算')
      const hitLabel = screen.getByText('PCPヒット判定')
      expect(brushLabel).toBeInTheDocument()
      expect(hitLabel).toBeInTheDocument()
      // Verify DOM order: 集合演算 comes before PCPヒット判定
      expect(brushLabel.compareDocumentPosition(hitLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  it('can put global selection actions in a supplied graph popup without PCP-only controls', async () => {
    const popupRoot = document.createElement('div')
    popupRoot.dataset.testid = 'selection-popup-root'
    document.body.appendChild(popupRoot)
    try {
      renderWithStore(
        <PointerSelectionDropdown
          testId="expanded-selection"
          getPopupContainer={() => popupRoot}
          includeSelectionActions
          showPcpHitMode={false}
          showSelectionCount
        />,
      )
      expect(screen.getByTestId('expanded-selection-count')).toHaveTextContent('選択: 0行')
      fireEvent.click(screen.getByTestId('expanded-selection'))
      await waitFor(() => {
        expect(popupRoot).toContainElement(screen.getByTestId('pointer-selection-menu-content'))
        expect(screen.getByTestId('expanded-selection-clear')).toBeDisabled()
        expect(screen.getByTestId('expanded-selection-focus')).toBeDisabled()
        expect(screen.getByTestId('expanded-selection-delete')).toBeDisabled()
        expect(screen.getByTestId('expanded-selection-reset')).toBeEnabled()
        expect(screen.queryByTestId('pcp-hit-mode-select')).toBeNull()
      })
    } finally {
      popupRoot.remove()
    }
  })

  it('updates Redux pcp.hitMode when PCPヒット判定 is changed', async () => {
    const { store } = renderWithStore(<PointerSelectionDropdown testId="test-pointer-btn" />)
    expect(store.getState().pcp.hitMode).toBe('legacyVertex')

    const button = screen.getByTestId('test-pointer-btn')
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByTestId('pcp-hit-mode-select')).toBeInTheDocument()
    })

    // Antd Select interaction
    const hitSelect = screen.getByTestId('pcp-hit-mode-select')
    const combobox = hitSelect.querySelector('.ant-select-selector')
    expect(combobox).toBeTruthy()
    if (combobox) {
      fireEvent.mouseDown(combobox)
    }

    // Select "線分交差" option
    await waitFor(() => {
      const option = screen.getByText('線分交差')
      expect(option).toBeInTheDocument()
      fireEvent.click(option)
    })

    expect(store.getState().pcp.hitMode).toBe('segment')
  })

  it('updates Redux pcp.brushOperation when 集合演算 is changed', async () => {
    const { store } = renderWithStore(<PointerSelectionDropdown testId="test-pointer-btn" />)
    expect(store.getState().pcp.brushOperation).toBe('replace')

    const button = screen.getByTestId('test-pointer-btn')
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByTestId('brush-operation-select')).toBeInTheDocument()
    })

    const brushSelect = screen.getByTestId('brush-operation-select')
    const combobox = brushSelect.querySelector('.ant-select-selector')
    expect(combobox).toBeTruthy()
    if (combobox) {
      fireEvent.mouseDown(combobox)
    }

    // Select "Add（追加）" option
    await waitFor(() => {
      const option = screen.getByText('Add（追加）')
      expect(option).toBeInTheDocument()
      fireEvent.click(option)
    })

    expect(store.getState().pcp.brushOperation).toBe('add')
  })

  it('opens graph expansion from panel entry and changes zoom without remount', async () => {
    const { GraphExpansionProvider } = await import('../src/features/common/GraphExpansion')
    const GraphPanel = (await import('../src/features/common/GraphPanel')).default
    renderWithStore(
      <GraphExpansionProvider>
        <GraphPanel graphId="test-target" title="Test Title" sizing="intrinsic" intrinsicSize={{ width: 560, height: 400 }}>
          <svg data-testid="test-svg" viewBox="0 0 560 400"><circle cx={100} cy={100} r={5} /></svg>
        </GraphPanel>
      </GraphExpansionProvider>
    )

    const host = screen.getByTestId('graph-host-test-target')
    const svg = screen.getByTestId('test-svg')
    fireEvent.click(screen.getByTestId('graph-expand-test-target'))

    await waitFor(() => {
      expect(screen.getByTestId('graph-expansion-bar')).toBeInTheDocument()
      expect(screen.getByTestId('graph-expansion-title')).toHaveTextContent('Test Title')
      expect(screen.getByTestId('graph-expansion-fit')).toBeInTheDocument()
      expect(screen.getByTestId('graph-expansion-zoom-out')).toBeInTheDocument()
      expect(screen.getByTestId('graph-expansion-zoom-label')).toHaveTextContent('フィット')
      expect(screen.getByTestId('graph-expansion-zoom-in')).toBeInTheDocument()
      expect(screen.getByTestId('graph-expansion-exit')).toBeInTheDocument()
    })
    // 同一 host・同一 svg が dialog 受け口へ移動する
    expect(screen.getByTestId('graph-expansion-dock')).toContainElement(host)
    expect(host).toContainElement(svg)

    fireEvent.click(screen.getByTestId('graph-expansion-zoom-in'))
    await waitFor(() => {
      expect(screen.getByTestId('graph-expansion-zoom-label')).toHaveTextContent('125%')
    })
    expect(screen.getByTestId('graph-expansion-dock')).toContainElement(host)

    fireEvent.click(screen.getByTestId('graph-expansion-exit'))
    await waitFor(() => {
      expect(screen.queryByTestId('graph-expansion-bar')).not.toBeInTheDocument()
    })
    expect(host).toContainElement(svg)
  })
})
