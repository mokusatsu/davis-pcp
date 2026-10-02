import { afterEach, expect, it, vi } from 'vitest'
import { api, type CodebookColumn } from '../src/api/client'
import { fetchSparsePcaRows, isSparsePcaFitPending, prepareSparsePcaExport, runSparsePca, subscribeSparsePcaFit } from '../src/features/pca/sparsePcaApi'
import { DEFAULT_SPARSE_PCA_SETTINGS, sparsePcaColumnEligible, sparsePcaHasWeight, sparsePcaSettingsError } from '../src/features/pca/sparsePcaSettings'
import type { SparsePcaRequest } from '../src/features/pca/sparsePcaTypes'
import { makeSparsePcaResult } from './sparsePcaFixture'

afterEach(() => vi.restoreAllMocks())
const request = { context: { datasetId: 'd', expectedDataRevision: 1, expectedSchemaRevision: 1, scope: 'all', weightMode: 'dataset', missingPolicy: 'exclude', imputationPolicy: 'use_current_values' },
  variables: ['x', 'y'].map(columnId => ({ columnId, kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null })),
  preprocessing: 'correlation', ...DEFAULT_SPARSE_PCA_SETTINGS } as SparsePcaRequest

it('keeps one fit lane until underlying completion, even if consumers leave', async () => {
  let finish!: (value: unknown) => void
  const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const changes = vi.fn(), stop = subscribeSparsePcaFit(changes), first = runSparsePca(request)
  expect(isSparsePcaFitPending()).toBe(true)
  await expect(runSparsePca(request)).rejects.toThrow('前のSparsePCA計算')
  expect(post).toHaveBeenCalledTimes(1)
  stop(); finish(makeSparsePcaResult()); await first
  expect(isSparsePcaFitPending()).toBe(false)
  expect(changes).toHaveBeenCalledTimes(1)
  post.mockRejectedValueOnce(new Error('failed'))
  await expect(runSparsePca(request)).rejects.toThrow('failed')
  expect(isSparsePcaFitPending()).toBe(false)
})
it('uses one-dimensional SP axes without a synthetic second axis', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ rows: [] })
  await fetchSparsePcaRows('a/b', 5000, 5000, [1])
  expect(get).toHaveBeenCalledWith('/analysis-results/a%2Fb/rows?offset=5000&limit=5000&axes=1')
})
it('combines JSON pages and preserves diagnostics metadata and precision', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ fileName: 'd.json', mime: 'application/json',
    payload: JSON.stringify({ columns: ['x'], rows: [[null]], summary: { rank: 1 } }), nextOffset: 1 })
    .mockResolvedValueOnce({ fileName: 'd.json', mime: 'application/json', payload: JSON.stringify({ columns: ['x'], rows: [[.12345678901234567]] }), nextOffset: null })
  expect(JSON.parse((await prepareSparsePcaExport('r', 'diagnostics', 'json'))!.payload)).toEqual({ columns: ['x'], rows: [[null], [.12345678901234567]], summary: { rank: 1 } })
  expect(post).toHaveBeenLastCalledWith('/analysis-results/r/export', { format: 'json', table: 'diagnostics', offset: 1, limit: 5000 })
})
it('preserves quoted multiline CSV and formula escaping while removing repeated headers', async () => {
  vi.spyOn(api, 'post').mockResolvedValueOnce({ fileName: 'r.csv', mime: 'text/csv', payload: 'rowId,SP1\r\n"two\nlines",1\r\n', nextOffset: 1 })
    .mockResolvedValueOnce({ fileName: 'r.csv', mime: 'text/csv', payload: 'rowId,SP1\r\n\'=formula,2\r\n', nextOffset: null })
  expect((await prepareSparsePcaExport('r', 'rows', 'csv'))!.payload).toBe('rowId,SP1\r\n"two\nlines",1\r\n\'=formula,2\r\n')
})
it('suppresses canceled exports and additional page requests', async () => {
  let current = true
  vi.spyOn(api, 'post').mockImplementation(async () => { current = false; return { payload: '{}', nextOffset: 5000 } as any })
  expect(await prepareSparsePcaExport('r', 'manifest', 'json', () => current)).toBeNull()
  expect(api.post).toHaveBeenCalledTimes(1)
})
it('rejects nonadvancing export offsets', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({ fileName: 'x', mime: 'text/csv', payload: 'rowId\n', nextOffset: 0 })
  await expect(prepareSparsePcaExport('r', 'rows', 'csv')).rejects.toThrow('ページ位置')
})
it.each([['nComponents', 0], ['nComponents', 1.5], ['nComponents', 21], ['alpha', NaN], ['alpha', -1], ['ridgeAlpha', Infinity],
  ['tolerance', 0], ['tolerance', .11], ['maxIterations', 5001], ['maxIterations', 1.1], ['seed', -1], ['seed', 4294967296], ['seed', null]] as const)
  ('rejects %s=%s', (field, value) => expect(sparsePcaSettingsError({ ...DEFAULT_SPARSE_PCA_SETTINGS, [field]: value })).not.toBeNull())
it('accepts k1, alpha0/ridge0 without changing the method', () => {
  expect(sparsePcaSettingsError({ ...DEFAULT_SPARSE_PCA_SETTINGS, nComponents: 1, alpha: 0, ridgeAlpha: 0, maxIterations: 1 })).toBeNull()
})
it('rejects all configured weight types and excludes unsupported variables', () => {
  expect(sparsePcaHasWeight({ weightColumnId: 'w', weightType: 'frequency' }, null)).toBe(true)
  expect(sparsePcaHasWeight({ weightColumnId: 'w', weightType: 'survey' }, null)).toBe(true)
  expect(sparsePcaHasWeight(null, { weightColumnId: 'w' })).toBe(true)
  expect(sparsePcaHasWeight(null, { strataColumnId: 's' })).toBe(false)
  const column = { role: 'question', scaleType: 'ratio', multiResponseGroup: null } as CodebookColumn
  expect(sparsePcaColumnEligible(column)).toBe(true)
  expect(sparsePcaColumnEligible({ ...column, scaleType: 'ordinal' })).toBe(true)
  expect(sparsePcaColumnEligible({ ...column, role: 'weight' })).toBe(false)
  expect(sparsePcaColumnEligible({ ...column, multiResponseGroup: 'ma' })).toBe(false)
  expect(sparsePcaColumnEligible({ ...column, scaleType: 'nominal' })).toBe(false)
})
