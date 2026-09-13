import { describe, expect, it } from 'vitest'
import { displayCoords, axisLabel } from '../src/features/models/caMap'
import type { CACategory } from '../src/features/models/caTypes'

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
