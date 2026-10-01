import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import { describe, expect, it, vi } from 'vitest'
import GraphPanel, { useGraphPopupContainer } from '../src/features/common/GraphPanel'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'

function PopupContainerProbe() {
  const popupContainer = useGraphPopupContainer()
  const container = popupContainer()
  return <span data-testid="popup-container-probe">{container.dataset.testid ?? container.tagName}</span>
}

function setup() {
  return render(
    <StrictMode>
      <Provider store={store}>
        <GraphExpansionProvider>
          <GraphPanel graphId="test/graph" title="テスト図" sizing="intrinsic" intrinsicSize={{ width: 560, height: 400 }}>
            <svg data-testid="test-svg" viewBox="0 0 560 400"><circle data-testid="test-point" cx={100} cy={100} r={5} /></svg>
            <PopupContainerProbe />
          </GraphPanel>
        </GraphExpansionProvider>
      </Provider>
    </StrictMode>,
  )
}

describe('GraphExpansion route/dataset guard', () => {
  it('route/dataset 変更で拡大が終了する', async () => {
    const local = configureStore({ reducer: () => store.getState(), middleware: g => g({ serializableCheck: false }) })
    const { unmount } = render(
      <Provider store={local}>
        <GraphExpansionProvider>
          <GraphPanel graphId="route/graph" title="経路図" sizing="intrinsic" intrinsicSize={{ width: 200, height: 150 }}>
            <svg data-testid="route-svg" viewBox="0 0 200 150"><circle cx={50} cy={50} r={5} /></svg>
          </GraphPanel>
        </GraphExpansionProvider>
      </Provider>,
    )
    fireEvent.click(screen.getByTestId('graph-expand-route/graph'))
    await waitFor(() => {
      expect(screen.getByTestId('graph-expansion-zoom-label')).toBeInTheDocument()
    })
    unmount()
    void api
  })
})

describe('GraphExpansion session', () => {
  it('通常表示の intrinsic surface は拡大変形を適用しない', () => {
    setup()
    const surface = screen.getByTestId('graph-surface-test/graph')
    expect(surface).toHaveAttribute('data-graph-scale', '1')
    expect(surface.style.transform).toBe('')
  })

  it('通常表示の intrinsic surface は内容高を伸ばせる最低寸法になる', () => {
    setup()
    const surface = screen.getByTestId('graph-surface-test/graph')
    const extent = screen.getByTestId('graph-extent-test/graph')
    expect(surface.style.height).toBe('auto')
    expect(surface.style.minHeight).toBe('400px')
    expect(extent.style.height).toBe('')
    expect(extent.style.minHeight).toBe('400px')
  })

  it('HTMLカード型は通常時だけ親列幅へ追従する', async () => {
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe = () => {
        this.callback([{ contentRect: { width: 476, height: 320 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      unobserve = () => {}
      disconnect = () => {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    try {
      render(
        <Provider store={store}>
          <GraphExpansionProvider>
            <GraphPanel graphId="viewport-card" title="カード図" sizing="intrinsic" intrinsicSize={{ width: 560, height: 320 }} normalWidth="viewport">
              <div>カード内容</div>
            </GraphPanel>
          </GraphExpansionProvider>
        </Provider>,
      )

      await waitFor(() => {
        expect(screen.getByTestId('graph-surface-viewport-card').style.width).toBe('476px')
      })
      expect(screen.getByTestId('graph-extent-viewport-card').style.width).toBe('476px')
      expect(screen.getByTestId('graph-surface-viewport-card').style.height).toBe('auto')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ポップアップは通常時は body、拡大時は dialog 内へ送る', async () => {
    setup()
    expect(screen.getByTestId('popup-container-probe')).toHaveTextContent('BODY')

    fireEvent.click(screen.getByTestId('graph-expand-test/graph'))
    await waitFor(() => {
      expect(screen.getByTestId('popup-container-probe')).toHaveTextContent('graph-expansion-popup')
    })
  })

  it('拡大バー右端の選択メニューは dialog 内に全選択操作を表示する', async () => {
    setup()
    fireEvent.click(screen.getByTestId('graph-expand-test/graph'))
    await waitFor(() => expect(screen.getByTestId('graph-expansion-selection')).toBeInTheDocument())
    expect(screen.getByTestId('graph-expansion-selection-count')).toHaveTextContent('選択: 0行')

    fireEvent.click(screen.getByTestId('graph-expansion-selection'))
    await waitFor(() => {
      const popupRoot = screen.getByTestId('graph-expansion-popup')
      expect(popupRoot).toContainElement(screen.getByTestId('pointer-selection-menu-content'))
      expect(screen.getByTestId('graph-expansion-selection-clear')).toBeDisabled()
      expect(screen.getByTestId('graph-expansion-selection-focus')).toBeDisabled()
      expect(screen.getByTestId('graph-expansion-selection-delete')).toBeDisabled()
      expect(screen.getByTestId('graph-expansion-selection-reset')).toBeEnabled()
      expect(screen.queryByTestId('pcp-hit-mode-select')).toBeNull()
    })
  })

  it('通常時は slot に host があり、拡大で dialog の受け口へ同じ host が移る', async () => {
    const { container } = setup()
    const host = screen.getByTestId('graph-host-test/graph')
    const svg = screen.getByTestId('test-svg')
    expect(host).toContainElement(svg)

    fireEvent.click(screen.getByTestId('graph-expand-test/graph'))
    await waitFor(() => {
      expect(screen.getByTestId('graph-expansion-dialog')).toBeInTheDocument()
    })
    const dock = screen.getByTestId('graph-expansion-dock')
    // 同一 host が dialog 受け口へ移動し、描画子は同一要素のまま
    expect(dock).toContainElement(host)
    expect(host).toContainElement(svg)
    expect(screen.getByTestId('graph-expansion-zoom-label')).toHaveTextContent('フィット')

    // 倍率変更で host・svg は同一のまま。
    // フィットからの「＋」は 125%（設計 6.2）。
    fireEvent.click(screen.getByTestId('graph-expansion-zoom-in'))
    await waitFor(() => {
      expect(screen.getByTestId('graph-expansion-zoom-label')).toHaveTextContent('125%')
    })
    expect(dock).toContainElement(host)
    expect(host).toContainElement(svg)
    const surface = screen.getByTestId('graph-surface-test/graph')
    expect(surface.getAttribute('data-graph-scale')).not.toBe('1')

    // 戻すで slot へ復帰
    fireEvent.click(screen.getByTestId('graph-expansion-exit'))
    await waitFor(() => {
      expect(screen.queryByTestId('graph-expansion-bar')).not.toBeInTheDocument()
    })
    expect(host).toContainElement(svg)
    void container
  })

  it('StrictMode で host が重複登録されない', async () => {
    const { unmount } = setup()
    const host = screen.getByTestId('graph-host-test/graph')
    const svg = screen.getByTestId('test-svg')
    fireEvent.click(screen.getByTestId('graph-expand-test/graph'))
    await waitFor(() => {
      expect(screen.getByTestId('graph-expansion-zoom-label')).toBeInTheDocument()
    })
    // 同一 host・同一 svg が dialog 受け口へ移動し、重複生成なし
    expect(screen.getAllByTestId('graph-host-test/graph')).toHaveLength(1)
    expect(screen.getByTestId('graph-expansion-dock')).toContainElement(host)
    expect(host).toContainElement(svg)
    fireEvent.click(screen.getByTestId('graph-expansion-exit'))
    await waitFor(() => {
      expect(screen.queryByTestId('graph-expansion-bar')).not.toBeInTheDocument()
    })
    expect(host).toContainElement(svg)
    unmount()
  })

  it('非表示対象の開始要求は失敗する', () => {
    render(
      <Provider store={store}>
        <GraphExpansionProvider>
          <GraphPanel graphId="hidden/graph" title="非表示図" available={false}>
            <div>hidden</div>
          </GraphPanel>
        </GraphExpansionProvider>
      </Provider>,
    )
    expect(screen.queryByTestId('graph-expand-hidden/graph')).not.toBeInTheDocument()
    expect(screen.queryByTestId('graph-expansion-bar')).not.toBeInTheDocument()
    void vi
  })
})


describe('Graph IDs containing raw dataset names', () => {
  it.each(['column_<tag>&"quoted"', "column_[bracket]\\backslash'", 'column_改行\n#.?=名前'])('opens and closes a literal graph ID: %s', async name => {
    const graphId = `distribution/${name}`
    render(<Provider store={store}><GraphExpansionProvider>
      <GraphPanel graphId={graphId} title={name} intrinsicSize={{ width: 400, height: 250 }}>
        <div data-testid="literal-graph-content">{name}</div>
      </GraphPanel>
    </GraphExpansionProvider></Provider>)
    const origin = screen.getByRole('button', { name: /を拡大表示$/ })
    fireEvent.click(origin)
    await waitFor(() => expect(screen.getByTestId('graph-expansion-dock')).toContainElement(screen.getByTestId('literal-graph-content')))
    fireEvent.click(screen.getByTestId('graph-expansion-exit'))
    await waitFor(() => expect(screen.queryByTestId('graph-expansion-bar')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: /を拡大表示$/ })).toHaveFocus())
  })
})
