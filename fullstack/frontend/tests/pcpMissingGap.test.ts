import { expect, it, vi } from 'vitest'
import { tracePcpRow } from '../src/engine/pcpRenderer'

it('does not connect across masked MA answers or send nonfinite coordinates to Canvas', () => {
  const calls: unknown[] = []
  const ctx = { moveTo: vi.fn((...xy) => calls.push(['move', ...xy])), lineTo: vi.fn((...xy) => calls.push(['line', ...xy])) }
  tracePcpRow(ctx, new Float64Array([0, 1, 1, 2, NaN, NaN, 3, 4, 4, 5]), 0, 5)
  expect(calls).toEqual([['move', 0, 1], ['line', 1, 2], ['move', 3, 4], ['line', 4, 5]])
})
