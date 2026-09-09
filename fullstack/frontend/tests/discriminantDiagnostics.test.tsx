import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import DiscriminantDiagnostics from '../src/features/models/DiscriminantDiagnostics'

afterEach(cleanup)
const valid = { inputDimensions: 4, usedDimensions: 2, sampleCount: 50, classCounts: { F: 20, M: 30 },
  totalRank: 2, withinClassRank: 2, collinear: false, singularWithinClassCovariance: false, qdaSmallClasses: [] }
it('shows actual used dimensions and class counts without warning for full rank', () => {
  const view = render(<DiscriminantDiagnostics value={valid} />)
  expect(view.container).toHaveTextContent('使用行: 50 ・ 入力次元: 4 ・ 使用次元: 2')
  expect(view.container).toHaveTextContent('F: 20 / M: 30')
  expect(view.queryByRole('alert')).toBeNull()
})
it('distinguishes collinearity, within-class rank and QDA sample shortages', () => {
  const view = render(<DiscriminantDiagnostics value={{ ...valid, totalRank: 1, withinClassRank: 1,
    collinear: true, singularWithinClassCovariance: true, qdaSmallClasses: ['F'] }} />)
  expect(view.getAllByRole('alert')).toHaveLength(3)
  expect(view.container).toHaveTextContent('使用2次元に対して独立な次元は1')
  expect(view.container).toHaveTextContent('クラス内の独立な次元は1/2')
  expect(view.container).toHaveTextContent('対象クラス: F')
})
