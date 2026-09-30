import { act, cleanup, render } from '@testing-library/react'
import { getInstanceByDom, type ECharts } from 'echarts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MatrixHeatmap from '../src/features/charts/MatrixHeatmap'

const irisLabels = ['sepal_length', 'sepal_width', 'petal_length', 'petal_width']
const irisMatrix = [
  [1, -.12, .87, .82],
  [-.12, 1, -.43, -.37],
  [.87, -.43, 1, .96],
  [.82, -.37, .96, 1],
]

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(388)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(252)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function cellSize(chart: ECharts): [number, number] {
  const first = chart.convertToPixel({ gridIndex: 0 }, [0, 0]) as number[]
  const next = chart.convertToPixel({ gridIndex: 0 }, [1, 1]) as number[]
  return [Math.abs(next[0] - first[0]), Math.abs(next[1] - first[1])]
}

it('keeps real ECharts matrix cells readable in the normal-size Relationships panel', () => {
  const view = render(<MatrixHeatmap labels={irisLabels} matrix={irisMatrix} bound={1}
    height={252} title="Pearson相関行列" testId="matrix" />)
  const host = view.getByTestId('matrix'), chart = getInstanceByDom(host)!
  const [width, height] = cellSize(chart)
  expect(width, `cell size: ${width} × ${height}`).toBeGreaterThanOrEqual(50)
  expect(height).toBeGreaterThanOrEqual(28)
  expect(host.querySelector('svg')).not.toBeNull()
  for (const label of irisLabels) expect(host.textContent).toContain(label)
  expect(host.textContent).toContain('-0.12')
  const axisLabels = chart.getZr().storage.getDisplayList().filter(item =>
    item.type === 'tspan' && irisLabels.includes((item as any).style.text))
  expect(axisLabels).toHaveLength(8)
  for (const label of axisLabels) {
    const rect = label.getBoundingRect().clone()
    if (label.transform) rect.applyTransform(label.transform)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(388)
    expect(rect.y + rect.height).toBeLessThanOrEqual(252)
  }
  const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [3, 3]) as number[]
  expect(x + width / 2).toBeLessThanOrEqual(388)
  expect(y + height / 2).toBeLessThanOrEqual(252 - 40)
})

it.each([
  ['two-column Relationships', 320, 200, 2],
  ['long-label Relationships', 388, 252, 4],
  ['Covariance', 560, 400, 4],
  ['Surprise associations', 400, 300, 4],
  ['many-column Relationships', 884, 636, 12],
] as const)('preserves usable cells for %s with truncated long axis labels', (_name, width, height, count) => {
  const labels = Array.from({ length: count }, (_, index) => `Question ${index}: a long survey question label requiring truncation`)
  const matrix = labels.map((_, row) => labels.map((_, col) => row === col ? 1 : .5))
  const view = render(<MatrixHeatmap labels={labels} matrix={matrix} height={height} title="Matrix" testId="matrix" />)
  const host = view.getByTestId('matrix'), chart = getInstanceByDom(host)!
  act(() => { chart.resize({ width, height }) })
  const [cellWidth, cellHeight] = cellSize(chart)
  expect(cellWidth).toBeGreaterThanOrEqual(45)
  expect(cellHeight).toBeGreaterThanOrEqual(28)
  expect(host.innerHTML).not.toMatch(/NaN|Infinity/)
  expect(host.textContent).toContain('...')
  expect((chart.getOption().visualMap as any[])[0]).toMatchObject({ min: -1, max: 1, orient: 'horizontal', bottom: 0 })
})

it('keeps null cells, escaped tooltips, pair clicks and selection highlighting after resize', () => {
  const labels = ['<row>', 'column & label'], matrix = [[1, null], [null, 1]], counts = [[12, 0], [0, 12]]
  const onSelect = vi.fn()
  const draw = (selected: [number, number]) => <MatrixHeatmap labels={labels} matrix={matrix} counts={counts}
    selected={selected} onSelect={onSelect} decimals={3} height={252} title="Matrix" testId="matrix" />
  const view = render(draw([0, 1])), host = view.getByTestId('matrix'), chart = getInstanceByDom(host)!
  const series = chart.getOption().series as any[]
  expect(series[0].data).toHaveLength(2)
  expect(series[0].label.formatter({ data: series[0].data[0] })).toBe('1.000')
  expect(series[1].data).toHaveLength(2)
  expect(series[1].label.formatter).toBe('—')
  const selected = series[1].data.find((cell: any) => cell.row === 0 && cell.col === 1)
  expect(selected).toMatchObject({ raw: null, itemStyle: { borderWidth: 3, borderColor: '#1677ff' } })
  expect((chart.getOption().tooltip as any[])[0].formatter({ data: selected }))
    .toBe('&lt;row&gt; × column &amp; label<br/>計算不可<br/>n=0')
  act(() => {
    chart.resize({ width: 776, height: 504 })
    // Native event contract; real-pointer interaction is covered by browser QA.
    ;(chart as ECharts & { trigger: (name: string, payload: unknown) => void }).trigger('click', { data: selected })
  })
  expect(onSelect).toHaveBeenCalledWith(0, 1)
  view.rerender(draw([1, 0]))
  expect(getInstanceByDom(host)).toBe(chart)
  const next = (chart.getOption().series as any[])[1].data
  expect(next.find((cell: any) => cell.row === 0 && cell.col === 1).itemStyle.borderWidth).toBe(1)
  expect(next.find((cell: any) => cell.row === 1 && cell.col === 0).itemStyle.borderWidth).toBe(3)
  expect(host.querySelector('row')).toBeNull()
})
