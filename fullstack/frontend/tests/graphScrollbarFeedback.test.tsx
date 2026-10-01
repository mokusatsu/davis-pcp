import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, expect, it, vi } from 'vitest'
import { store } from '../src/app/store'
import GraphPanel from '../src/features/common/GraphPanel'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup(sizing: 'intrinsic' | 'responsive' = 'intrinsic', collapsedMargin = false) {
  const observedBoxes: ResizeObserverBoxOptions[] = []
  let deliver: ((width: number, height: number, outerWidth: number, outerHeight: number) => void) | undefined
  class TestResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe = (target: Element, options?: ResizeObserverOptions) => { observedBoxes.push(options?.box ?? 'content-box'); deliver = (width, height, outerWidth, outerHeight) => this.callback([{
      target, contentRect: { width, height }, borderBoxSize: [{ inlineSize: outerWidth, blockSize: outerHeight }],
    } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve = () => {}
    disconnect = () => {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const view = render(<Provider store={store}><GraphExpansionProvider>
    <GraphPanel graphId="overflow-fit" title="Overflow fit" sizing={sizing} intrinsicSize={{ width: 560, height: 420 }}>
      {/* A caption, margin or larger font can exceed a caller's estimated height. */}
      <div data-testid="actual-chart" style={{ width: 560, height: collapsedMargin ? 420 : 428, marginTop: collapsedMargin ? 8 : 0 }}>Chart and caption</div>
    </GraphPanel>
  </GraphExpansionProvider></Provider>)
  fireEvent.click(view.getByTestId('graph-expand-overflow-fit'))
  const viewport = view.getByTestId('graph-viewport-overflow-fit')
  const extent = view.getByTestId('graph-extent-overflow-fit')
  const surface = view.getByTestId('graph-surface-overflow-fit')
  const chart = view.getByTestId('actual-chart')
  const measure = (width: number, height: number, outerWidth: number, outerHeight: number) => act(() => deliver!(width, height, outerWidth, outerHeight))
  // Model native scrollbars from actual rendered child/extent dimensions. Unlike
  // jsdom, a browser feeds their reduced content box back to ResizeObserver.
  const settle = (outerWidth: number, outerHeight: number, scrollbar = 15) => {
    let width = outerWidth, height = outerHeight
    const samples: string[] = []
    for (let frame = 0; frame < 12; frame++) {
      measure(width, height, outerWidth, outerHeight)
      const scale = Number(surface.dataset.graphScale)
      const scrollWidth = Math.max(parseFloat(extent.style.width), parseFloat(chart.style.width) * scale)
      const scrollHeight = Math.max(parseFloat(extent.style.height), parseFloat(chart.style.height) * scale) + parseFloat(chart.style.marginTop || '0')
      let vertical = false, horizontal = false
      for (let layout = 0; layout < 3; layout++) {
        vertical ||= scrollHeight > outerHeight - (horizontal ? scrollbar : 0)
        horizontal ||= scrollWidth > outerWidth - (vertical ? scrollbar : 0)
      }
      const nextWidth = outerWidth - (vertical ? scrollbar : 0)
      const nextHeight = outerHeight - (horizontal ? scrollbar : 0)
      samples.push(`${width}x${height}@${scale}`)
      if (width === nextWidth && height === nextHeight) return { settled: true, samples, width, height }
      width = nextWidth; height = nextHeight
    }
    return { settled: false, samples, width, height }
  }
  return { view, viewport, extent, surface, chart, measure, settle, observedBoxes }
}

it('converges instead of toggling 740↔725px when intrinsic children overflow the estimated height', () => {
  const { view, viewport, extent, surface, measure, settle, observedBoxes } = setup()
  expect(observedBoxes[0]).toBe('content-box')
  expect(observedBoxes.at(-1)).toBe('border-box')
  const result = settle(740, 560)
  // Previously all 12 frames alternated 740x560@1.32143 and 725x545@1.29464.
  expect(result.settled, result.samples.join('\n')).toBe(true)
  expect(result.samples.length).toBeLessThanOrEqual(3)
  expect(result.width).toBe(725)
  expect(result.height).toBe(545)
  expect(Number(surface.dataset.graphScale)).toBeCloseTo(740 / 560)
  // Preserve overflowing content and its real scrollbar range; do not clip it
  // or turn off ResizeObserver to conceal the feedback cycle.
  expect(extent.style.overflow).not.toMatch(/hidden|clip/)
  expect(parseFloat(extent.style.width)).toBeGreaterThan(result.width)
  const generation = viewport.dataset.coordGen
  measure(result.width, result.height, 740, 560)
  expect(viewport.dataset.coordGen).toBe(generation)
  fireEvent.click(view.getByTestId('graph-expansion-exit'))
  expect(observedBoxes.at(-1)).toBe('content-box')
})

it.each([0, 12, 15, 20])('stays converged across window/font changes and manual zoom with %ipx scrollbars', scrollbar => {
  const { view, viewport, surface, chart, settle } = setup()
  for (const [width, height, contentHeight] of [[740.8, 560.8, 428], [980.6, 680.6, 450], [520.9, 430.9, 480]]) {
    chart.style.height = `${contentHeight}px`
    const result = settle(width, height, scrollbar)
    expect(result.settled, result.samples.join('\n')).toBe(true)
    expect(Number(surface.dataset.graphScale)).toBeCloseTo(Math.min(Math.floor(width) / 560, Math.floor(height) / 420))
  }
  const before = viewport.dataset.coordGen
  const fitScale = Number(surface.dataset.graphScale)
  fireEvent.click(view.getByTestId('graph-expansion-zoom-in'))
  expect(settle(520.9, 430.9, scrollbar).settled).toBe(true)
  expect(Number(surface.dataset.graphScale)).toBeCloseTo(fitScale * 1.25)
  expect(viewport.dataset.coordGen).not.toBe(before)
  fireEvent.click(view.getByTestId('graph-expansion-fit'))
  expect(settle(520.9, 430.9, scrollbar).settled).toBe(true)
  expect(Number(surface.dataset.graphScale)).toBeCloseTo(fitScale)
  const oldGeneration = viewport.dataset.coordGen
  expect(settle(820.7, 510.7, scrollbar).settled).toBe(true)
  expect(viewport.dataset.coordGen).not.toBe(oldGeneration)
})

it('keeps responsive charts tied to the usable content box instead of the stable Fit allocation', () => {
  const { surface, measure, observedBoxes } = setup('responsive')
  expect(observedBoxes.every(box => box === 'content-box')).toBe(true)
  measure(725.8, 545.8, 740.8, 560.8)
  expect(surface.style.width).toBe('725px')
  expect(surface.style.height).toBe('545px')
  expect(Number(surface.dataset.graphScale)).toBe(1)
  measure(740.8, 560.8, 740.8, 560.8)
  expect(surface.style.width).toBe('740px')
  expect(surface.style.height).toBe('560px')
})

it('retains valid dimensions while hidden, but recomputes Fit after a real parent resize', () => {
  const { viewport, surface, measure, settle } = setup()
  const initial = settle(740.8, 560.8)
  const generation = viewport.dataset.coordGen
  const scale = surface.dataset.graphScale
  measure(0, 0, 0, 0)
  expect(surface.dataset.graphScale).toBe(scale)
  expect(viewport.dataset.coordGen).toBe(generation)
  measure(initial.width, initial.height, 740.8, 560.8)
  expect(viewport.dataset.coordGen).toBe(generation)
  const resized = settle(900.8, 720.8)
  expect(resized.settled).toBe(true)
  expect(surface.dataset.graphScale).not.toBe(scale)
  expect(viewport.dataset.coordGen).not.toBe(generation)
})

it.each([560.265625, 569.265625])('also converges with a collapsed child margin at the reproduced %spx graph height', height => {
  const { extent, settle } = setup('intrinsic', true)
  const result = settle(740.15625, height)
  // A stable Fit scale is not sufficient if the extent itself keeps a minimum
  // equal to the scrollbar-reduced content height: 569+8 → bars → 555+8 → no bars.
  expect(result.settled, result.samples.join('\n')).toBe(true)
  expect(result.samples.length).toBeLessThanOrEqual(3)
  expect(parseFloat(extent.style.height)).toBe(555)
})
