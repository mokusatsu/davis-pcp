/** Bounded manual benchmark. No timing threshold is enforced in CI. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'

const helper = new URL('../src/features/table/tableRowScope.ts', import.meta.url)
const source = await readFile(helper, 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } })
const { projectTableRowIds } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

// Previous TablePage projection at 3e6d2ef8. Keep the same array-membership,
// effective-row order and mask operations; only the candidate calls the helper.
function previous(effectiveRowIds, selectedRowIds, scopeFilter, imputedRowIds, maskFilter) {
  const scopedRows = scopeFilter === 'selected'
    ? effectiveRowIds.filter(id => selectedRowIds.includes(id)) : effectiveRowIds
  return maskFilter === 'all' ? scopedRows : scopedRows.filter(id =>
    maskFilter === 'hasImputed' ? imputedRowIds.has(id) : !imputedRowIds.has(id))
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const results = []
for (const count of [1000, 10000, 50000]) {
  const rows = Array.from({ length: count }, (_, i) => `ROW-${String(i + 1).padStart(6, '0')}`)
  for (const step of [100, 2]) {
    const selected = rows.filter((_, i) => i % step === 0)
    const imputed = new Set(rows.filter((_, i) => i % 5 === 0))
    for (const mask of ['all', 'hasImputed']) {
      const args = [rows, selected, 'selected', imputed, mask]
      const candidate = () => projectTableRowIds(rows, new Set(selected), 'selected', imputed, mask)
      const expected = previous(...args)
      assert.deepEqual(candidate(), expected)
      const before = [], after = []
      for (let repeat = 0; repeat < 3; repeat++) {
        const operations = [[() => previous(...args), before], [candidate, after]]
        if (repeat % 2) operations.reverse()
        for (const [fn, times] of operations) {
          const start = performance.now()
          const output = fn()
          times.push(performance.now() - start)
          assert.deepEqual(output, expected)
        }
      }
      results.push({ rows: count, selected: selected.length, mask,
        previousMs: median(before), candidateIncludingSetMs: median(after),
        speedup: median(before) / median(after), exactOutput: true,
        previousSamplesMs: before, candidateSamplesMs: after })
    }
  }
}
console.log(JSON.stringify({ node: process.version, helper: helper.pathname,
  scope: 'Pure projection only; no browser rendering, API or memoization cache benefit included', results }, null, 2))
