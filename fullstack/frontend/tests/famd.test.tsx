import { describe, expect, it } from 'vitest'
import { famdAxisLabel } from '../src/features/models/FamdFigure'

describe('FAMD figure helpers', () => {
  it('axis labels use 1-based IDs and full-inertia percent', () => {
    expect(famdAxisLabel(2, [0.5, 0.25], 1)).toBe('第1軸 (50.0%)')
    expect(famdAxisLabel(1, [1], 1)).toBe('第1軸 (100.0%)')
    expect(famdAxisLabel(1, [1], 2)).toBe('第2軸')
  })
})
