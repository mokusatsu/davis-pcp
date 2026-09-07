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
  it('renders "ポインター選択" button', () => {
    renderWithStore(<PointerSelectionDropdown testId="test-pointer-btn" />)
    const button = screen.getByTestId('test-pointer-btn')
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('ポインター選択')
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

  it('renders FocusBar with two separate divs for selection and zoom controls', async () => {
    // Dynamic import Focus components
    const { FocusModeProvider, FocusBar, FocusEnterButton } = await import('../src/features/common/FocusMode')
    
    renderWithStore(
      <FocusModeProvider>
        <div>
          <FocusEnterButton targetId="test-target" title="Test Title" />
          <FocusBar />
        </div>
      </FocusModeProvider>
    )

    // Trigger focus mode
    const enterBtn = screen.getByTestId('focus-enter-test-target')
    fireEvent.click(enterBtn)

    await waitFor(() => {
      // FocusBar root
      expect(screen.getByTestId('focus-bar')).toBeInTheDocument()

      // Two separate divs: selection and zoom
      const selectionDiv = screen.getByTestId('focus-bar-selection')
      const zoomDiv = screen.getByTestId('focus-bar-zoom')
      expect(selectionDiv).toBeInTheDocument()
      expect(zoomDiv).toBeInTheDocument()

      // Check drag handle and title
      expect(screen.getByTestId('focus-drag-handle')).toBeInTheDocument()
      expect(screen.getByTestId('focus-title')).toHaveTextContent('Test Title')
      expect(screen.getByText(/選択: \d+行/)).toBeInTheDocument()
      expect(screen.getByTestId('focus-pointer-selection')).toBeInTheDocument()
      expect(screen.getByTestId('focus-clear-selection')).toBeInTheDocument()
      expect(screen.getByTestId('focus-focus-selection')).toBeInTheDocument()
      expect(screen.getByTestId('focus-delete-selection')).toBeInTheDocument()
      expect(screen.getByTestId('focus-reset-selection')).toBeInTheDocument()

      // Check zoom controls in zoomDiv
      expect(screen.getByTestId('focus-fit')).toBeInTheDocument()
      expect(screen.getByTestId('focus-zoom-out')).toBeInTheDocument()
      expect(screen.getByTestId('focus-zoom-label')).toBeInTheDocument()
      expect(screen.getByTestId('focus-zoom-in')).toBeInTheDocument()
      expect(screen.getByTestId('focus-exit')).toBeInTheDocument()
    })
  })

  it('supports drag moving and double-click reset on FocusBar', async () => {
    const { FocusModeProvider, FocusBar, FocusEnterButton } = await import('../src/features/common/FocusMode')
    
    renderWithStore(
      <FocusModeProvider>
        <div>
          <FocusEnterButton targetId="test-target-drag" title="Drag Target" />
          <FocusBar />
        </div>
      </FocusModeProvider>
    )

    const enterBtn = screen.getByTestId('focus-enter-test-target-drag')
    fireEvent.click(enterBtn)

    await waitFor(() => {
      expect(screen.getByTestId('focus-bar')).toBeInTheDocument()
    })

    const focusBar = screen.getByTestId('focus-bar')
    const dragHandle = screen.getByTestId('focus-drag-handle')

    // Initial style check (no left style set initially)
    expect(focusBar.style.left).toBe('')
    expect(focusBar.style.right).toBe('16px')

    // Mock getBoundingClientRect
    focusBar.getBoundingClientRect = () => ({
      x: 800,
      y: 8,
      left: 800,
      top: 8,
      right: 1200,
      bottom: 48,
      width: 400,
      height: 40,
      toJSON: () => {},
    })

    // Simulate mousedown on drag handle
    fireEvent.mouseDown(dragHandle, { button: 0, clientX: 810, clientY: 15 })

    // Simulate window mousemove (dx = 510 - 810 = -300, newX = 800 - 300 = 500px, dy = 115 - 15 = 100, newY = 8 + 100 = 108px)
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 510, clientY: 115 }))
    })

    // Expect left & top to be updated
    await waitFor(() => {
      expect(focusBar.style.left).toBe('500px')
      expect(focusBar.style.top).toBe('108px')
    })

    // Simulate mouseup
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    // Simulate double click to reset
    act(() => {
      fireEvent.doubleClick(dragHandle)
    })

    await waitFor(() => {
      expect(focusBar.style.left).toBe('')
      expect(focusBar.style.right).toBe('16px')
    })
  })
})

