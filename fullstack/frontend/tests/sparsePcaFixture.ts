import type { SparsePcaResponse } from '../src/features/pca/sparsePcaTypes'

export function makeSparsePcaResult(): SparsePcaResponse {
  const variables: SparsePcaResponse['details']['variables'] = ['x', 'y', 'z'].map((name, index) => ({
    columnId: `${name}-id`, name, label: `保存ラベル${index + 1}`, scaleType: 'ratio',
    missingCodes: ['-99'], valueLabels: {}, isReversed: index === 1, categoryOrder: [],
    ordinalAsNumericAcknowledged: false, score: null,
  }))
  return {
    status: 'success', method: 'sparse_pca', resultId: 'saved-spca-result',
    meta: {
      datasetId: 'dataset-1', dataRevision: 7, schemaRevision: 9, maskRevision: 2,
      resultState: 'current', scope: 'selected', scopeHash: 'saved-scope-hash', scopeCount: 10,
      fitCount: 8, excludedCount: 2, exclusionCounts: { missing: 2 }, imputedCellCount: 3, imputedRowCount: 2,
      weightApplied: false, algorithmVersion: 'sparse-pca/1.0', modelFingerprint: 'saved-model-fingerprint',
      snapshotFingerprint: 'saved-snapshot-fingerprint',
      numericalRuntime: { engine: 'native', python: '3.12.14', numpy: '2.4.6', scipy: '1.18.0', sklearn: '1.9.0', pyodide: null },
      warnings: [{ code: 'SPCA_CONSTANT_EXCLUDED', message: '定数列を学習から除外しました' }],
    },
    config: {
      variables: [...variables.map(({ columnId }) => ({ columnId, kind: 'numeric' as const, ordinalAsNumericAcknowledged: false, score: null })),
        { columnId: 'constant-id', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null }],
      preprocessing: 'correlation', nComponents: 2, alpha: 1, ridgeAlpha: 0.01,
      tolerance: 1e-8, maxIterations: 1000, seed: 42, solver: 'lars',
    },
    capabilities: { rows: true, projection: false, materialize: false, selectionKinds: ['row_ids', 'rectangle'],
      exportTables: ['manifest', 'coefficients', 'variables', 'diagnostics', 'rows'], predictionIntervals: [], exportPredict: false },
    summary: {
      nComponents: 2, nVariables: 3, basisRank: 2, nonzeroPerComponent: [1, 2], zeroFraction: 0.5,
      reconstructionFraction: 0.9375, reconstructionSpace: 'standardized',
      convergence: { status: 'tolerance_reached', nIterations: 3, maxIterations: 1000, tolerance: 1e-8,
        objectiveHistory: [15, 12.25, 12.2499999], finalObjective: 12.2499999, finalImprovement: 1e-7 },
    },
    details: {
      variables, excludedConstantColumns: [{ columnId: 'constant-id', name: 'constant', label: '保存時の定数列' }],
      preprocessing: {
        mode: 'correlation',
        columns: variables.map(({ columnId }) => ({ columnId, inputAnchor: 0, normalizedMeanOffset: 0, inputMagnitude: 5, normalizedMean: 0.4,
          normalizedSampleSd: 0.2, rawMean: 2, rawMeanReason: null, rawSampleSd: 1, rawSampleSdReason: null })),
        estimatorMean: [0, 1e-16, -1e-16],
      },
      componentOrder: ['SP1', 'SP2'], components: [[0, 1, 0], [1e-12, 0.5, 0]],
      scoreCoefficients: [[0.375, -1e-14], [0.9, 0.45], [0, 0]],
      variableScoreCorrelations: [[0.625, 0.4], [0.95, 0.8], [0.1, 0.15]],
      variableScoreCorrelationReasons: [[null, null], [null, null], [null, null]],
      scoreCorrelations: [[1, 0.3], [0.3, 1]], scoreCorrelationReasons: [[null, null], [null, null]],
      componentGram: [[1, 0.5], [0.5, 0.25]], scoreVariances: [1.5, 0.6], scoreVarianceReasons: [null, null], rankTolerance: 1e-14,
    },
    unavailableReasons: Object.fromEntries(['eigenvalues', 'explainedVarianceRatio', 'cumulativeVarianceRatio', 'kaiser'].map(key => [key,
      { code: 'NONORTHOGONAL_COMPONENTS', message: '非直交成分では使用しません', relatedFields: [key] }])),
  }
}
