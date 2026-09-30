import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import FamdFigure from '../src/features/models/FamdFigure'
import McaFigure from '../src/features/models/McaFigure'

const figures = vi.hoisted(() => new Map<string, any>())
vi.mock('../src/features/models/ModelScatter', () => ({ default: (props: any) => {
  figures.set(props.testId, props)
  return <div data-testid={props.testId} />
} }))
afterEach(() => { cleanup(); figures.clear() })

it.each([['FAMD', FamdFigure], ['MCA', McaFigure]] as const)('%s passes display-axis identifiers once for X=2/Y=3', (name, Figure) => {
  const onBrush = vi.fn()
  render(<Figure points={[{ id: 'row', label: 'Row', x: -4, y: 6, title: 'Row' }]}
    rank={4} dispRank={2} xAxis={2} yAxis={3} ratio={[.4, .3, .2, .1]}
    selected={new Set()} highlighted={new Set()} onToggle={vi.fn()} onBrush={onBrush}
    svgRef={{ current: null }} testId={name} />)
  const props = figures.get(name)
  expect(props.xLabel).toContain('第2軸 (30.0%)')
  expect(props.yLabel).toContain('第3軸 (20.0%)')
  const bounds = { x: [-7, -2] as [number, number], y: [2, 9] as [number, number] }
  props.onBrush(bounds)
  expect(onBrush).toHaveBeenCalledWith([1, 2], [bounds.x, bounds.y])
  // Both parent pages map display IDs to the currently selected real axes.
  const actualAxes = onBrush.mock.calls[0][0].map((axis: number) => axis === 1 ? 2 : 3)
  expect(actualAxes).toEqual([2, 3])
})

it.each([['FAMD', FamdFigure], ['MCA', McaFigure]] as const)('%s preserves a one-dimensional brush on a non-first selected axis', (name, Figure) => {
  const onBrush = vi.fn()
  render(<Figure points={[{ id: 'row', label: 'Row', x: -4, y: null, title: 'Row' }]}
    rank={3} dispRank={1} xAxis={3} yAxis={2} ratio={[.5, .3, .2]}
    selected={new Set()} highlighted={new Set()} onToggle={vi.fn()} onBrush={onBrush}
    svgRef={{ current: null }} testId={name} />)
  const props = figures.get(name)
  expect(props.oneDimensional).toBe(true)
  props.onBrush({ x: [-8, 1], y: null })
  expect(onBrush).toHaveBeenCalledWith([1], [[-8, 1]])
})

it.each([['FAMD', FamdFigure], ['MCA', McaFigure]] as const)('%s retains category brush bounds without individual-axis remapping', (name, Figure) => {
  const onBrush = vi.fn(), onCategoryBrush = vi.fn()
  render(<Figure points={[{ id: 'category', label: 'Category', x: -4, y: 6, title: 'Category' }]}
    rank={3} dispRank={2} xAxis={2} yAxis={3} ratio={[.5, .3, .2]}
    selected={new Set()} highlighted={new Set()} onToggle={vi.fn()} onBrush={onBrush} onCategoryBrush={onCategoryBrush}
    svgRef={{ current: null }} testId={name} />)
  const bounds = { x: [-7, -2] as [number, number], y: [2, 9] as [number, number] }
  figures.get(name).onBrush(bounds)
  expect(onCategoryBrush).toHaveBeenCalledWith(bounds)
  expect(onBrush).not.toHaveBeenCalled()
})
