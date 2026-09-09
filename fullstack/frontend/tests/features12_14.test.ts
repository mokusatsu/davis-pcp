import { describe, it, expect, beforeEach } from 'vitest'
import {
  store,
  datasetLoaded,
  variablesInitialized,
  activeVariablesSet,
  selectionApplied,
  selectionCleared,
} from '../src/app/store'
import type { LogisticSamplePoint } from '../src/features/models/LogisticRegressionPage'
import type { DiscriminantSamplePoint, StepwiseTraceStep } from '../src/features/models/DiscriminantAnalysisPage'

describe('Feature 12: Logistic Regression Client Logic', () => {
  const mockSamples: LogisticSamplePoint[] = [
    { rowId: 'r1', actual: 1, predictedProb: 0.85, predictedClass: 1, residual: 0.15, isMisclassified: false },
    { rowId: 'r2', actual: 1, predictedProb: 0.45, predictedClass: 0, residual: 0.55, isMisclassified: true },
    { rowId: 'r3', actual: 0, predictedProb: 0.65, predictedClass: 1, residual: -0.65, isMisclassified: true },
    { rowId: 'r4', actual: 0, predictedProb: 0.20, predictedClass: 0, residual: -0.20, isMisclassified: false },
    { rowId: 'r5', actual: 0, predictedProb: 0.10, predictedClass: 0, residual: -0.10, isMisclassified: false },
  ]

  beforeEach(() => {
    store.dispatch(
      datasetLoaded({
        datasetId: 'ds-test',
        name: 'test',
        rowIds: ['r1', 'r2', 'r3', 'r4', 'r5'],
      })
    )
    store.dispatch(
      variablesInitialized({
        variables: ['x1', 'x2', 'target'],
      })
    )
  })

  it('dynamically computes confusion matrix at various cutoffs', () => {
    function computeMetrics(samples: LogisticSamplePoint[], cutoff: number) {
      let tp = 0
      let tn = 0
      let fp = 0
      let fn = 0
      const misclassified: string[] = []
      for (const s of samples) {
        const pred = s.predictedProb >= cutoff ? 1 : 0
        if (s.actual === 1 && pred === 1) tp++
        else if (s.actual === 0 && pred === 0) tn++
        else if (s.actual === 0 && pred === 1) {
          fp++
          misclassified.push(s.rowId)
        } else if (s.actual === 1 && pred === 0) {
          fn++
          misclassified.push(s.rowId)
        }
      }
      const acc = (tp + tn) / samples.length
      return { tp, tn, fp, fn, acc, misclassified }
    }

    // Cutoff = 0.5
    const at05 = computeMetrics(mockSamples, 0.5)
    expect(at05.tp).toBe(1)
    expect(at05.tn).toBe(2)
    expect(at05.fp).toBe(1) // r3 (prob 0.65 >= 0.5)
    expect(at05.fn).toBe(1) // r2 (prob 0.45 < 0.5)
    expect(at05.acc).toBe(0.6)
    expect(at05.misclassified).toEqual(['r2', 'r3'])

    // Cutoff = 0.4 (more positive predictions)
    const at04 = computeMetrics(mockSamples, 0.4)
    expect(at04.tp).toBe(2) // r1, r2
    expect(at04.tn).toBe(2) // r4, r5
    expect(at04.fp).toBe(1) // r3
    expect(at04.fn).toBe(0)
    expect(at04.acc).toBe(0.8)

    // Cutoff = 0.7 (more conservative positive predictions)
    const at07 = computeMetrics(mockSamples, 0.7)
    expect(at07.tp).toBe(1) // r1
    expect(at07.tn).toBe(3) // r3, r4, r5
    expect(at07.fp).toBe(0)
    expect(at07.fn).toBe(1) // r2
    expect(at07.acc).toBe(0.8)
  })

  it('selects misclassified rows into Redux selection state', () => {
    store.dispatch(selectionCleared())
    const misclassifiedIds = ['r2', 'r3']
    store.dispatch(selectionApplied({
      rowIds: misclassifiedIds,
      operation: 'replace',
      label: 'ロジスティック回帰誤分類選択',
    }))

    const selected = store.getState().selection.selectedRowIds
    expect(selected).toEqual(['r2', 'r3'])
  })
})

describe('Feature 13: Discriminant Analysis Client Logic', () => {
  beforeEach(() => {
    store.dispatch(
      datasetLoaded({
        datasetId: 'ds-iris',
        name: 'iris',
        rowIds: ['row_50', 'row_51'],
      })
    )
    store.dispatch(
      variablesInitialized({
        variables: ['sepal_length', 'sepal_width', 'petal_length', 'petal_width', 'species'],
      })
    )
  })

  it('applies stepwise selected variables to global active variables', () => {
    const traceStep: StepwiseTraceStep = {
      step: 3,
      action: 'entered',
      variable: 'petal_width',
      wilksLambda: 0.025,
      partialF: 34.57,
      pValue: 0.00001,
      activeVariables: ['petal_length', 'sepal_width', 'petal_width'],
    }

    store.dispatch(activeVariablesSet(traceStep.activeVariables))
    expect(store.getState().globalVariables.activeEntities?.map(entity => entity.kind === 'column' ? entity.columnId : entity.groupId)).toEqual([
      'petal_length',
      'sepal_width',
      'petal_width',
    ])
  })

  it('dispatches misclassified discriminant samples selection', () => {
    store.dispatch(selectionCleared())
    const discSamples: DiscriminantSamplePoint[] = [
      { rowId: 'row_50', actualClass: 'versicolor', predictedClass: 'virginica', isMisclassified: true, ld1: 1.2, ld2: -0.4, posteriorProbabilities: {}, mahalanobisDistance: 1.1 },
      { rowId: 'row_51', actualClass: 'versicolor', predictedClass: 'versicolor', isMisclassified: false, ld1: 0.8, ld2: 0.5, posteriorProbabilities: {}, mahalanobisDistance: 0.6 },
    ]

    const misclassified = discSamples.filter((s) => s.isMisclassified).map((s) => s.rowId)
    store.dispatch(selectionApplied({
      rowIds: misclassified,
      operation: 'replace',
      label: '判別分析誤分類選択',
    }))

    expect(store.getState().selection.selectedRowIds).toEqual(['row_50'])
  })
})

describe('Feature 14: Feature Ranking Dynamic mRMR Redundancy', () => {
  it('computes dynamic redundancy against selected top-K variables', () => {
    // Pearson correlation mock data
    const corrMap = new Map<string, number>([
      ['petal_length:::petal_width', 0.96],
      ['petal_width:::petal_length', 0.96],
      ['sepal_length:::petal_length', 0.87],
      ['petal_length:::sepal_length', 0.87],
      ['sepal_length:::petal_width', 0.82],
      ['petal_width:::sepal_length', 0.82],
      ['sepal_width:::petal_length', 0.43],
      ['petal_length:::sepal_width', 0.43],
      ['sepal_width:::petal_width', 0.37],
      ['petal_width:::sepal_width', 0.37],
      ['sepal_width:::sepal_length', 0.12],
      ['sepal_length:::sepal_width', 0.12],
    ])

    function getDynamicRedundancy(
      variable: string,
      topK: string[],
      pairwise: Map<string, number>,
      fallback: number
    ): number {
      if (!pairwise.size || topK.length === 0) return fallback
      const targetSet = topK.includes(variable) ? topK.filter((v) => v !== variable) : topK
      if (targetSet.length === 0) return fallback
      let sumCorr = 0
      let count = 0
      for (const other of targetSet) {
        const c = pairwise.get(`${variable}:::${other}`)
        if (c !== undefined) {
          sumCorr += c
          count++
        }
      }
      return count > 0 ? sumCorr / count : fallback
    }

    // Top-K = ['petal_length', 'petal_width']
    const top2 = ['petal_length', 'petal_width']

    // For petal_length in top-2, its redundancy is with petal_width (0.96)
    expect(getDynamicRedundancy('petal_length', top2, corrMap, 0.5)).toBeCloseTo(0.96, 2)

    // For sepal_width outside top-2, its redundancy against top-2 is avg(0.43, 0.37) = 0.40
    expect(getDynamicRedundancy('sepal_width', top2, corrMap, 0.5)).toBeCloseTo(0.40, 2)

    // For sepal_length outside top-2, its redundancy against top-2 is avg(0.87, 0.82) = 0.845
    expect(getDynamicRedundancy('sepal_length', top2, corrMap, 0.5)).toBeCloseTo(0.845, 2)
  })
})

