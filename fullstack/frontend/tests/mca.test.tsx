import { describe, expect, it } from 'vitest'
import { axisLabel } from '../src/features/models/McaFigure'

describe('MCA figure helpers', () => {
  it('axis labels use 1-based IDs and full-inertia percent', () => {
    expect(axisLabel(2, [0.5, 0.25], 1)).toBe('第1軸 (50.0%)')
    expect(axisLabel(1, [1], 1)).toBe('第1軸 (100.0%)')
    expect(axisLabel(1, [1], 2)).toBe('第2軸')
  })
})
