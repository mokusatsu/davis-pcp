import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, expect, it, vi } from 'vitest'
import { store } from '../src/app/store'
import GraphPanel from '../src/features/common/GraphPanel'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['intrinsic', 'responsive'] as const)('fits %s charts inside fractional dialog dimensions without creating a scrollbar loop', sizing => {
  let width = 1132.796875, height = 598.59375
  let measure: (() => void) | undefined
  class TestResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe = () => { measure = () => this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve = () => {}
    disconnect = () => {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const view = render(<Provider store={store}><GraphExpansionProvider>
    <GraphPanel graphId="fractional-fit" title="Fractional fit" sizing={sizing} intrinsicSize={{ width: 600, height: 420 }}><div>Chart</div></GraphPanel>
  </GraphExpansionProvider></Provider>)
  fireEvent.click(view.getByTestId('graph-expand-fractional-fit'))
  act(() => measure?.())
  const extent = view.getByTestId('graph-extent-fractional-fit')
  const surface = view.getByTestId('graph-surface-fractional-fit')
  const scale = Number(surface.dataset.graphScale)
  // A 599px extent in a 598.59px viewport adds a vertical scrollbar. Its stale
  // full width then adds a horizontal scrollbar, which changes fit/coord-gen,
  // cancels a physical drag, and repeats as those scrollbars disappear again.
  expect(parseFloat(extent.style.width)).toBeLessThanOrEqual(Math.floor(width))
  expect(parseFloat(extent.style.height)).toBeLessThanOrEqual(Math.floor(height))
  expect(parseFloat(surface.style.width) * scale).toBeLessThanOrEqual(width)
  expect(parseFloat(surface.style.height) * scale).toBeLessThanOrEqual(height)
  const generation = view.getByTestId('graph-viewport-fractional-fit').dataset.coordGen
  act(() => measure?.())
  expect(view.getByTestId('graph-viewport-fractional-fit').dataset.coordGen).toBe(generation)

  // Deliberate magnification still creates scrollable content; returning to fit
  // removes it instead of disabling overflow or the stale-gesture safety check.
  fireEvent.click(view.getByTestId('graph-expansion-zoom-in'))
  expect(parseFloat(extent.style.height)).toBeGreaterThan(height)
  fireEvent.click(view.getByTestId('graph-expansion-fit'))
  expect(parseFloat(extent.style.height)).toBeLessThanOrEqual(Math.floor(height))
  expect(view.getByTestId('graph-viewport-fractional-fit').dataset.coordGen).toBe(generation)

  // Even a sub-half-pixel change matters when it crosses the next usable pixel.
  // Ignoring that change would leave the old surface slightly too large again.
  width = 1133.1; height = 599.1
  act(() => measure?.())
  width = 1132.9; height = 598.9
  act(() => measure?.())
  expect(parseFloat(extent.style.width)).toBeLessThanOrEqual(Math.floor(width))
  expect(parseFloat(extent.style.height)).toBeLessThanOrEqual(Math.floor(height))
})
