import { describe, expect, it } from 'vitest'
import { lrExtent } from '../src/features/models/LinearRegressionFigure'

describe('linear regression figure extent', () => {
  it('pads finite ranges', () => {
    const [lo, hi] = lrExtent([1, 2, 3])
    expect(lo).toBeLessThan(1)
    expect(hi).toBeGreaterThan(3)
  })
  it('falls back for empty input', () => {
    expect(lrExtent([])).toEqual([0, 1])
  })
})
