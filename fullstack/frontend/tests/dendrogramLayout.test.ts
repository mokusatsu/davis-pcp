import { expect, it } from 'vitest'
import { dendrogramLeafOrder } from '../src/features/clustering/dendrogramLayout'

// Original row order interleaves every pair and both higher-level subtrees.
const linkage = [
  [0, 4, 1, 2], [1, 5, 1.2, 2], [2, 6, 1.3, 2], [3, 7, 1.4, 2],
  [8, 9, 3, 4], [10, 11, 4, 4], [12, 13, 7, 8],
]

it('keeps original leaf identity while placing every subtree contiguously', () => {
  const before = JSON.stringify(linkage)
  const order = dendrogramLeafOrder(linkage)
  expect(order).toEqual([0, 4, 1, 5, 2, 6, 3, 7])
  expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  const leaves = (node: number): number[] => node < 8 ? [node]
    : [...leaves(linkage[node - 8][0]), ...leaves(linkage[node - 8][1])]
  linkage.forEach((_, i) => {
    const positions = leaves(8 + i).map(leaf => order.indexOf(leaf)).sort((a, b) => a - b)
    expect(positions).toEqual(Array.from({ length: positions.length }, (_, j) => positions[0] + j))
  })
  expect(JSON.stringify(linkage)).toBe(before)
})

it('has no proper horizontal/vertical branch intersections on an interleaved hierarchy', () => {
  const order = dendrogramLeafOrder(linkage)
  const x = new Map(order.map((leaf, position) => [leaf, position]))
  const y = (node: number) => node < 8 ? 0 : linkage[node - 8][2]
  const horizontals: { x1: number; x2: number; y: number }[] = []
  const verticals: { x: number; y1: number; y2: number }[] = []
  linkage.forEach(([left, right, distance], i) => {
    const x1 = x.get(left)!, x2 = x.get(right)!
    x.set(8 + i, (x1 + x2) / 2)
    horizontals.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: distance })
    verticals.push({ x: x1, y1: y(left), y2: distance }, { x: x2, y1: y(right), y2: distance })
  })
  const crossings = horizontals.flatMap(h => verticals.filter(v =>
    v.x > h.x1 && v.x < h.x2 && h.y > v.y1 && h.y < v.y2))
  expect(crossings).toEqual([])
})

it('handles one leaf and a deeply unbalanced hierarchy without recursive traversal', () => {
  expect(dendrogramLeafOrder([])).toEqual([0])
  const n = 20_000
  const chain = Array.from({ length: n - 1 }, (_, i) => [i === 0 ? 0 : n + i - 1, i + 1, i + 1, i + 2])
  const order = dendrogramLeafOrder(chain)
  expect(order).toHaveLength(n)
  expect(order[0]).toBe(0)
  expect(order[n - 1]).toBe(n - 1)
})
