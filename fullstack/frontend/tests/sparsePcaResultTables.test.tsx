import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import SparsePcaResultTables from '../src/features/pca/SparsePcaResultTables'
import { makeSparsePcaResult } from './sparsePcaFixture'

afterEach(cleanup)

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

describe('SparsePCA frozen result tables', () => {
  it('shows saved complete cases, exclusions, imputation, constants and configuration', () => {
    const result = freeze(makeSparsePcaResult())
    const before = JSON.stringify(result)
    const view = render(<SparsePcaResultTables result={result} />)
    const summary = within(view.getByTestId('sparse-pca-summary'))
    expect(summary.getByText('学習行数（complete case）').nextElementSibling).toHaveTextContent('8')
    expect(summary.getByText('対象scope / 対象行数').nextElementSibling).toHaveTextContent('選択行 / 10')
    expect(summary.getByText('除外行数').nextElementSibling).toHaveTextContent('2')
    expect(summary.getByText('利用した補完値').nextElementSibling).toHaveTextContent('2 行 / 3 セル')
    expect(summary.getByText('除外内訳: 欠損: 2')).toBeInTheDocument()
    expect(summary.getByText('保存時の定数列 (constant)')).toBeInTheDocument()
    expect(summary.getByText('非加重')).toBeInTheDocument()
    expect(summary.getByText('定数列を学習から除外しました（SPCA_CONSTANT_EXCLUDED）')).toBeInTheDocument()
    const diagnostics = within(view.getByTestId('sparse-pca-diagnostics'))
    expect(diagnostics.getByText('seed / solver').nextElementSibling).toHaveTextContent('42 / lars')
    expect(diagnostics.getByText('反復数 / 最大反復数').nextElementSibling).toHaveTextContent('3 / 1000')
    expect(JSON.stringify(result)).toBe(before)
  })

  it('renders B transposed separately from W and directly computed variable correlations', () => {
    const view = render(<SparsePcaResultTables result={makeSparsePcaResult()} />)
    const b = within(view.getByRole('table', { name: '疎な再構成係数 B' }))
    const w = within(view.getByRole('table', { name: '得点計算係数 W' }))
    const correlations = within(view.getByRole('table', { name: '変数–得点の直接相関' }))
    const bX = b.getByRole('row', { name: /保存ラベル1 \(x\)/ })
    expect(within(bX).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['0（exactZero: 厳密な0）', '1.000000e-12'])
    expect(within(w.getByRole('row', { name: /保存ラベル1 \(x\)/ })).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['0.375', '-1.000000e-14'])
    expect(within(correlations.getByRole('row', { name: /保存ラベル1 \(x\)/ })).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['0.625', '0.4'])
    expect(view.getByText(/B = 0 でも、Wや変数–得点相関が0になるとは限りません/)).toBeInTheDocument()
    expect(view.getByText(/直接Pearson相関/)).toBeInTheDocument()
  })

  it('does not round a tiny nonzero value to zero or count W zeros as B sparsity', () => {
    const result = makeSparsePcaResult()
    result.details.components[1][0] = Number.MIN_VALUE
    const view = render(<SparsePcaResultTables result={result} />)
    const b = view.getByRole('table', { name: '疎な再構成係数 B' })
    expect(b.querySelectorAll('[data-exact-zero="true"]')).toHaveLength(3)
    const tiny = within(b).getByText('4.940656e-324')
    expect(tiny).toHaveAttribute('title', String(Number.MIN_VALUE))
    expect(tiny.closest('td')).toHaveAttribute('data-exact-zero', 'false')
    expect(tiny.closest('td')).not.toHaveTextContent('exactZero')
    const sparsity = within(view.getByRole('table', { name: '成分別の疎性と得点分散' }))
    expect(sparsity.getByText('1 / 3')).toBeInTheDocument()
    expect(sparsity.getByText('2 / 3')).toBeInTheDocument()
    expect(view.getByText('Bの厳密なゼロ比率（疎性）').nextElementSibling).toHaveTextContent('50%')
  })

  it('preserves null correlation reasons, including an undefined diagonal', () => {
    const result = makeSparsePcaResult()
    result.details.variableScoreCorrelations[0][1] = null
    result.details.variableScoreCorrelationReasons[0][1] = 'constant_score'
    result.details.scoreCorrelations[1][1] = null
    result.details.scoreCorrelationReasons[1][1] = 'zero_score_variance'
    result.details.scoreVariances[1] = null
    result.details.scoreVarianceReasons[1] = 'variance_out_of_range'
    const view = render(<SparsePcaResultTables result={result} />)
    expect(within(view.getByRole('table', { name: '変数–得点の直接相関' })).getByText('定義不可（constant_score）')).toBeInTheDocument()
    const scoreTable = within(view.getByRole('table', { name: '得点の成分間相関' }))
    expect(within(scoreTable.getByRole('row', { name: /^SP2 / })).getAllByRole('cell')[1]).toHaveTextContent('定義不可（zero_score_variance）')
    expect(view.getByText('定義不可（variance_out_of_range）')).toBeInTheDocument()
    expect(view.getByText(/対角も含め0や1で補いません/)).toBeInTheDocument()
  })

  it('shows the saved preprocessing and runtime, including unrepresentable raw scales', () => {
    const result = makeSparsePcaResult()
    result.details.preprocessing.columns[0].rawSampleSd = null
    result.details.preprocessing.columns[0].rawSampleSdReason = 'raw_scale_out_of_range'
    result.details.variables[2].scaleType = 'ordinal'
    result.details.variables[2].score = 'ordered_rank'
    result.details.variables[2].ordinalAsNumericAcknowledged = true
    result.details.variables[2].categoryOrder = ['low', 'high']
    result.details.variables[2].valueLabels = { low: '保存された低' }
    const view = render(<SparsePcaResultTables result={result} />)
    fireEvent.click(view.getByText('凍結された結果・前処理・実行環境の詳細'))
    expect(view.getByText('saved-spca-result')).toBeVisible()
    expect(view.getByText('saved-model-fingerprint')).toBeVisible()
    expect(view.getByText('data / schema / mask revision').nextElementSibling).toHaveTextContent('7 / 9 / 2')
    expect(view.getByText('runtime: sklearn').nextElementSibling).toHaveTextContent('1.9.0')
    expect(view.getByText('runtime: numpy').nextElementSibling).toHaveTextContent('2.4.6')
    expect(view.getByText('定義不可（raw_scale_out_of_range）')).toBeVisible()
    expect(view.getByText('ordinal / 固定順序の順位得点（承認済み） / 逆転なし')).toBeVisible()
    expect(view.getByText('-99 / low (保存された低), high')).toBeVisible()
    expect(view.getByText(/現在のコードブック編集には追随しません/)).toBeVisible()
  })

  it('names the reconstruction space and retains negative fractions instead of clamping', () => {
    const result = makeSparsePcaResult()
    const view = render(<SparsePcaResultTables result={result} />)
    expect(view.getByText('標準化空間（標本標準偏差・ddof=1）')).toBeInTheDocument()
    expect(view.getByText('実変換再構成率').nextElementSibling).toHaveTextContent('93.75%')
    result.summary.reconstructionSpace = 'centered_analysis_values'
    result.summary.reconstructionFraction = -0.0125
    result.config.preprocessing = 'covariance'
    result.details.preprocessing.mode = 'covariance'
    view.rerender(<SparsePcaResultTables result={result} />)
    expect(view.getByText('中心化した元分析値空間（標準化なし）')).toBeInTheDocument()
    expect(view.getByText('実変換再構成率').nextElementSibling).toHaveTextContent('-1.25%')
    expect(view.getByText('中心化のみ（covariance）')).toBeInTheDocument()
  })

  it('distinguishes convergence statuses from global optimality and displays the internal objective history', () => {
    const result = makeSparsePcaResult()
    const view = render(<SparsePcaResultTables result={result} />)
    expect(view.getByRole('status')).toHaveTextContent('許容誤差の停止条件に到達')
    expect(view.getByText(/停止条件の到達は大域最適解を保証しません/)).toBeInTheDocument()
    fireEvent.click(view.getByText('学習目的関数の履歴（3 件）'))
    expect(view.getByText('15')).toBeVisible()
    expect(view.getByText(/返却済みBと得点Tから再計算した値や実変換再構成率とは異なります/)).toBeInTheDocument()
    result.summary.convergence.status = 'iteration_limit'
    result.summary.convergence.finalImprovement = null
    view.rerender(<SparsePcaResultTables result={result} />)
    expect(view.getByRole('alert')).toHaveTextContent('反復上限に到達（未収束の探索結果）')
    expect(view.getByText('定義不可（比較する前の反復なし）')).toBeInTheDocument()
    result.summary.convergence.status = 'objective_increase'
    view.rerender(<SparsePcaResultTables result={result} />)
    expect(view.getByRole('alert')).toHaveTextContent('学習目的関数が増加（収束成功ではありません）')
  })

  it('explains alpha zero without presenting ordinary PCA diagnostics', () => {
    const result = makeSparsePcaResult()
    result.config.alpha = 0
    const view = render(<SparsePcaResultTables result={result} />)
    expect(view.getByTestId('sparse-pca-alpha-zero')).toHaveTextContent('alpha = 0 でも通常PCAへの切替ではありません')
    expect(view.getByTestId('sparse-pca-alpha-zero')).toHaveTextContent('ridgeAlphaが正なら得点は縮小')
    expect(view.getByText(/成分順は推定器の返却順で、分散順ではありません/)).toBeInTheDocument()
    expect(view.container.textContent).not.toMatch(/固有値|累積寄与率|Kaiser|相関円|explainedVarianceRatio/)
  })

  it('renders a single zero component without inventing SP2 or defined score correlations', () => {
    const result = makeSparsePcaResult()
    result.config.nComponents = 1
    Object.assign(result.summary, { nComponents: 1, basisRank: 0, nonzeroPerComponent: [0], zeroFraction: 1, reconstructionFraction: 0 })
    Object.assign(result.details, { componentOrder: ['SP1'], components: [[0, 0, 0]], scoreCoefficients: [[0], [0], [0]],
      variableScoreCorrelations: [[null], [null], [null]], variableScoreCorrelationReasons: [['constant_score'], ['constant_score'], ['constant_score']],
      scoreCorrelations: [[null]], scoreCorrelationReasons: [['constant_score']], componentGram: [[0]], scoreVariances: [0], scoreVarianceReasons: [null] })
    const view = render(<SparsePcaResultTables result={result} />)
    expect(view.queryByText('SP2')).not.toBeInTheDocument()
    expect(view.getByText('再構成係数Bのランク').nextElementSibling).toHaveTextContent('0 / 1')
    expect(within(view.getByRole('table', { name: '得点の成分間相関' })).getByText('定義不可（constant_score）')).toBeInTheDocument()
    expect(view.getByText('Bの厳密なゼロ比率（疎性）').nextElementSibling).toHaveTextContent('100%')
  })
})
