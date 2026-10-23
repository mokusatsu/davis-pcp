import { describe, expect, it } from 'vitest'
import { buildPcpLabelLayout, pcpAxisTickValues } from '../src/engine/pcpLabelLayout'

function layout(min: number, max: number, orientation: 'horizontal' | 'vertical' = 'horizontal', valueLabels?: Record<string, string>) {
  const axis = { key: 'iris', label: 'Iris', isCategorical: false, min, max, valueLabels }
  return { axis, labels: buildPcpLabelLayout({ orientation, axes: [axis], axisPos: [200],
    bounds: { left: 180, right: 1000, top: 20, bottom: 400 }, reversed: {} }).ticks }
}

describe('PCP display precision', () => {
  it.each(['horizontal', 'vertical'] as const)('cleans Iris interpolation in %s labels without changing tick values or keys', orientation => {
    for (const [min, max, index, raw, expected] of [
      [2, 4.4, 3, 3.8000000000000003, '3.8'],
      [1, 6.9, 3, 5.425000000000001, '5.425'],
    ] as const) {
      const { axis, labels } = layout(min, max, orientation)
      const original = pcpAxisTickValues(axis)
      expect(original[index]).toBe(raw)
      expect(labels[index].code).toBe(String(raw))
      expect(labels[index].fullText).toBe(expected)
      expect(labels[index].lines).toEqual([expected])
      expect(pcpAxisTickValues(axis)).toEqual(original)
    }
  })

  it.each([
    [0, '0'], [-0, '0'], [7, '7'], [-5.425000000000001, '-5.425'],
    [0.0123456789012345, '0.0123456789012345'], [1.23456789012345e-25, '1.23456789012345e-25'],
    [1.23456789012345e25, '1.23456789012345e+25'], [Number.MIN_VALUE, '5e-324'],
    [Number.MAX_VALUE, String(Number.MAX_VALUE)], [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
  ])('retains meaningful full-label digits for %s', (value, expected) => {
    const { labels } = layout(value, value)
    expect(labels).toHaveLength(1)
    expect(labels[0].fullText).toBe(expected)
    expect(Number.isFinite(Number(labels[0].fullText))).toBe(true)
    expect(labels[0].lines[0]).not.toMatch(/[\n…]/)
  })

  it('preserves raw numeric codebook lookup rather than looking up a rounded value', () => {
    const { labels } = layout(2, 4.4, 'horizontal', { '3.8000000000000003': 'Exact code', '3.8': 'Different code' })
    expect(labels[3].fullText).toBe('Exact code')
  })
})
