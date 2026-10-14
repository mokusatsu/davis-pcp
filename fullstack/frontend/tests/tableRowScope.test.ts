import { describe, expect, it } from 'vitest'
import { projectTableRowIds } from '../src/features/table/tableRowScope'

const empty = new Set<string>()

describe('Table row scope projection', () => {
  it('reuses the shared scope when neither display filter narrows it', () => {
    const rows = ['c', 'a', 'b']
    expect(projectTableRowIds(rows, new Set(['outside']), 'all', empty, 'all')).toBe(rows)
  })

  it('preserves effective order and duplicates rather than selection order', () => {
    const rows = ['z', 'a', 'z', '雪', '__proto__', 'a::b']
    const selected = new Set(['outside', '__proto__', 'a', 'z'])
    expect(projectTableRowIds(rows, selected, 'selected', empty, 'all')).toEqual(['z', 'a', 'z', '__proto__'])
    expect([...selected]).toEqual(['outside', '__proto__', 'a', 'z'])
    expect(rows).toEqual(['z', 'a', 'z', '雪', '__proto__', 'a::b'])
  })

  it.each(['all', 'hasImputed', 'noImputed'] as const)('keeps empty selected/effective scopes empty with %s', mask => {
    expect(projectTableRowIds(['a'], empty, 'selected', new Set(['a']), mask)).toEqual([])
    expect(projectTableRowIds([], new Set(['a']), 'all', new Set(['a']), mask)).toEqual([])
    expect(projectTableRowIds(['a'], new Set(['outside']), 'selected', new Set(['a']), mask)).toEqual([])
  })

  it('intersects selected and imputation membership without changing either set', () => {
    const selected = new Set(['hidden', 'b', 'a'])
    const imputed = new Set(['a', 'c'])
    const rows = ['c', 'b', 'a']
    const args = [rows, selected, 'selected', imputed] as const
    expect(projectTableRowIds(...args, 'hasImputed')).toEqual(['a'])
    expect(projectTableRowIds(...args, 'noImputed')).toEqual(['b'])
    expect(projectTableRowIds(...args, 'all')).toEqual(['b', 'a'])
    expect([...selected]).toEqual(['hidden', 'b', 'a'])
    expect([...imputed]).toEqual(['a', 'c'])
  })

  it('matches the previous array-membership projection on deterministic varied scopes', () => {
    let seed = 20261014
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    const universe = ['__proto__', '雪', 'a::b', ...Array.from({ length: 37 }, (_, i) => `ROW-${i}`)]
    for (let trial = 0; trial < 120; trial++) {
      const rows = Array.from({ length: Math.floor(random() * 80) }, () => universe[Math.floor(random() * universe.length)])
      const selected = universe.filter(() => random() < 0.5).reverse()
      const imputed = new Set(universe.filter(() => random() < 0.3))
      for (const scope of ['all', 'selected'] as const) {
        for (const mask of ['all', 'hasImputed', 'noImputed'] as const) {
          const scoped = scope === 'selected' ? rows.filter(id => selected.includes(id)) : rows
          const expected = mask === 'all' ? scoped : scoped.filter(id => mask === 'hasImputed' ? imputed.has(id) : !imputed.has(id))
          expect(projectTableRowIds(rows, new Set(selected), scope, imputed, mask)).toEqual(expected)
        }
      }
    }
  })
})
