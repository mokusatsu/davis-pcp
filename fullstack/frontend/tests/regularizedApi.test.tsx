import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/api/client'
import { exportRegularizedPredict, fetchRegularizedPredictions, fetchRegularizedRows, predictRegularizedRegression, runRegularizedRegression } from '../src/features/models/rrApi'
import type { RRContext, RRRequest } from '../src/features/models/rrTypes'
afterEach(() => vi.restoreAllMocks())
const context: RRContext = { datasetId: 'd', expectedDataRevision: 1, expectedSchemaRevision: 2, scope: 'active', activeRowIds: ['a'], weightMode: 'none', missingPolicy: 'exclude' }
it('posts the strict regularized request without OLS fields', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({})
  const request: RRRequest = { context, target: 'y', predictors: [{ columnId: 'x', kind: 'numeric' }], algorithm: 'ridge', intercept: true,
    standardize: true, lambdaValue: .1, l1Ratio: .5, selection: 'manual', cv: null, tolerance: 1e-8, maxIterations: 10000 }
  await runRegularizedRegression(request)
  expect(post).toHaveBeenCalledWith('/models/regularized-regression', request)
})
it('uses point-only prediction and immutable export identity instead of draft fields', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({})
  await predictRegularizedRegression('rr/1', context, false)
  expect(post).toHaveBeenLastCalledWith('/analysis-results/rr%2F1/predict', { context, options: { interval: 'none', evaluate: false } })
  for (const language of ['python', 'javascript', 'typescript'] as const) {
    for (const artifact of ['model', 'code', 'schema', 'readme', 'test_vectors', 'bundle'] as const) {
      await exportRegularizedPredict('rr/1', language, artifact, '1')
      expect(post).toHaveBeenLastCalledWith('/analysis-results/rr%2F1/export-predict', { language, artifact, expectedModelVersion: '1' })
    }
  }
})
it('keeps fit and prediction paging in distinct encoded result paths', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({})
  await fetchRegularizedRows('rr/1', 50, 50)
  expect(get).toHaveBeenLastCalledWith('/analysis-results/rr%2F1/rows?offset=50&limit=50')
  await fetchRegularizedPredictions('rr/1', 'p/1', 100, 50)
  expect(get).toHaveBeenLastCalledWith('/analysis-results/rr%2F1/predictions/p%2F1/rows?offset=100&limit=50')
})
