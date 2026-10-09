import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { getInstanceByDom } from 'echarts'
import { displayCoords, axisLabel } from '../src/features/models/caMap'
import type { CACategory } from '../src/features/models/caTypes'
import CaFigure from '../src/features/models/caFigure'
import { chartSvg } from '../src/features/charts/chartExport'

function cat(side: 'row' | 'column'): CACategory {
  return {
    categoryId: side,
    side,
    variableId: 'v',
    code: side,
    kind: 'value',
    label: side,
    mass: 0.25,
    physicalCount: 10,
    principalCoordinates: [0.5],
    standardCoordinates: [1.0],
    contributions: [1],
    cos2: [1],
    distanceSquared: 0.25,
  }
}

describe('CA display transform', () => {
  it('switches scaling without re-estimation', () => {
    const row = cat('row')
    const col = cat('column')
    expect(displayCoords(row, 'symmetric')).toEqual([0.5])
    expect(displayCoords(col, 'symmetric')).toEqual([0.5])
    expect(displayCoords(row, 'row_principal')).toEqual([0.5])
    expect(displayCoords(col, 'row_principal')).toEqual([1.0])
    expect(displayCoords(row, 'column_principal')).toEqual([1.0])
    expect(displayCoords(col, 'column_principal')).toEqual([0.5])
  })

  it('labels axes with full-inertia ratio', () => {
    expect(axisLabel(2, [0.2, 0.05], 1)).toContain('20.00%')
  })
})

describe('CA rank-aware chart presentation', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(560)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it.each([1, 2])('renders rank %i with truthful axes, exports and category identity', rank => {
    const row = { ...cat('row'), categoryId: 'opaque-row-category-17', principalCoordinates: rank === 1 ? [0.5] : [0.5, -0.25] }
    const col = { ...cat('column'), categoryId: 'opaque-column-category-23', principalCoordinates: rank === 1 ? [0.5] : [0.5, 0.25] }
    const onToggle = vi.fn()
    const view = render(<CaFigure rows={[row]} cols={[col]} rank={rank} ratio={rank === 1 ? [1] : [0.8, 0.2]}
      scaling="symmetric" selected={new Set([row.categoryId])} highlighted={new Set()}
      onToggle={onToggle} svgRef={createRef<SVGSVGElement>()} />)
    const element = view.getByTestId('ca-map-svg')
    const chart = getInstanceByDom(element)!
    const option = chart.getOption() as any
    const data = option.series.find((series: any) => series.id === 'model-points').data
    const label = rank === 1 ? '第1軸 (100.00%)（1次元）' : '第1軸 (80.00%) / 第2軸 (20.00%)'
    expect(element).toHaveAttribute('role', 'group')
    expect(element.getAttribute('aria-label')).toContain(label)
    for (const format of ['SVG', 'PNG']) expect(view.getByRole('button', { name: `${label}：${format}を保存` })).toBeVisible()
    expect(option.yAxis[0].show).toBe(rank === 2)
    const svg = chartSvg(chart)
    if (rank === 1) {
      for (const line of ['1次元表示：上下の配置は見やすさのためのものです。', '上下の位置に分析上の意味はありません。']) {
        expect(view.getByText(line)).toBeVisible()
        expect(svg).toContain(line)
      }
      expect(element.getAttribute('aria-label')).not.toContain('第2軸')
      expect(svg).not.toContain('第2軸')
    } else {
      expect(view.queryByText(/上下の配置|分析上の意味はありません/)).not.toBeInTheDocument()
      expect(svg).not.toContain('1次元表示')
      expect(svg).toContain('第2軸 (20.00%)')
    }
    expect(data.map((point: any) => point.id)).toEqual([row.categoryId, col.categoryId])
    expect(data.map((point: any) => point.value)).toEqual(rank === 1 ? [[0.5, -5.5 / 9], [0.5, -4.5 / 9]] : [[0.5, -0.25], [0.5, 0.25]])
    expect(data[0].title).toContain(`座標=(${row.principalCoordinates.join(', ')})`)
    expect(data[1].title).toContain(`座標=(${col.principalCoordinates.join(', ')})`)
    fireEvent.focus(element)
    fireEvent.keyDown(element, { key: 'ArrowRight' })
    fireEvent.keyDown(element, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith(col.categoryId)
  })
})
