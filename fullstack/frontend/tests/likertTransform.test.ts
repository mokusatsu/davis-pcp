import { expect, it } from 'vitest'
import { neutralIndex, sortLikertRows, toLikertRow } from '../src/features/distribution/likertTransform'

const cats = (counts: number[]) => counts.map((count, i) => ({
  code: String(i + 1), label: `L${i + 1}`, count, pct: count * 10,
}))

it('detects the middle index only for odd counts (positional, not label-based)', () => {
  expect(neutralIndex(5)).toBe(2)
  expect(neutralIndex(7)).toBe(3)
  expect(neutralIndex(4)).toBeNull()
  expect(neutralIndex(2)).toBeNull()
  expect(neutralIndex(0)).toBeNull()
})

it('maps odd categories to negative/neutral/positive with widths summing to 100', () => {
  const row = toLikertRow({
    columnId: 'Q', title: 'Q', categories: cats([1, 2, 1, 2, 4]), validN: 10, top2Pct: 60, mean: 3.0,
  })
  expect(row.negative.map((s) => s.code)).toEqual(['1', '2'])
  expect(row.neutral?.code).toBe('3')
  expect(row.positive.map((s) => s.code)).toEqual(['4', '5'])
  expect(row.negativePct + row.neutralPct + row.positivePct).toBeCloseTo(100, 4)
  expect(row.negative[0].widthPct).toBe(10)
})

it('uses a center boundary with no neutral for even counts and keeps zero slots', () => {
  const row = toLikertRow({
    columnId: 'Q', title: 'Q', categories: cats([0, 3, 0, 7]), validN: 10, top2Pct: 70, mean: 3.0,
  })
  expect(row.neutral).toBeNull()
  expect(row.negative.map((s) => s.code)).toEqual(['1', '2'])
  expect(row.positive.map((s) => s.code)).toEqual(['3', '4'])
  expect(row.positive[0].widthPct).toBe(0)
  expect(row.negativePct + row.positivePct).toBeCloseTo(100, 4)
})

it('sorts deterministically with categoryOrder tie-breaks', () => {
  const mk = (id: string, top2: number | null, mean: number | null) => toLikertRow({
    columnId: id, title: id, categories: cats([2, 2, 2, 2, 2]), validN: 10, top2Pct: top2, mean,
  })
  const rows = [mk('b', 50, 3), mk('a', 50, 3), mk('c', 60, 1)]
  expect(sortLikertRows(rows, 'top2-desc', ['b', 'a', 'c']).map((r) => r.columnId)).toEqual(['c', 'b', 'a'])
  expect(sortLikertRows(rows, 'mean-desc', ['b', 'a', 'c']).map((r) => r.columnId)).toEqual(['b', 'a', 'c'])
  expect(sortLikertRows(rows, 'original', ['c', 'b', 'a']).map((r) => r.columnId)).toEqual(['c', 'b', 'a'])
})
