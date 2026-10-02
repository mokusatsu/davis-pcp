import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import QuestionCard from '../src/features/distribution/QuestionCard'
import { LoadingTable } from '../src/features/pca/LoadingTable'
import { BiplotView } from '../src/features/pca/BiplotView'
import { vifDisplay } from '../src/features/models/kda/vifDisplay'
import RoundedStatistic, { formatFixed } from '../src/features/common/RoundedStatistic'
import { asymmetryVerdict } from '../src/features/pra/asymmetryDisplay'
import type { PcaResponse } from '../src/features/pca/types'

const chart = vi.hoisted(() => ({ bars: [] as any[], scatter: null as any }))
vi.mock('../src/features/charts/CategoryBars', () => ({ default: (props: any) => { chart.bars = props.items; return null } }))
vi.mock('../src/features/charts/RowScatter', () => ({ default: (props: any) => { chart.scatter = props; return null } }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: (props: any) => <section>{props.controls}{props.children}</section>, useGraphPopupContainer: () => undefined }))
vi.mock('../src/features/common/ColumnQuestionTooltip', () => ({ QuestionTooltip: (props: any) => <>{props.children}</> }))
vi.mock('../src/features/common/ColumnTable', () => ({ default: (props: any) => <table><tbody>{props.dataSource.map((row: any) => <tr key={row.key}>{props.columns.map((col: any) => <td key={col.key}>{col.render?.(row[col.dataIndex]) ?? row[col.dataIndex]}</td>)}</tr>)}</tbody></table> }))

afterEach(cleanup)

const pca = (useCorrelation: boolean): PcaResponse => ({
  columns: ['x', 'y'], nSamples: 3, nComponents: 2, useCorrelation,
  eigenvalues: [4, 1], explainedVarianceRatio: [.8, .2], cumulativeVarianceRatio: [.8, 1],
  kaiserThreshold: 1, kaiserThresholdComponents: 1, eigenvectors: [[1, 0], [0, 1]],
  loadings: { x: [2, .5], y: [1, 1] }, scores: [{ rowId: '1', pc: [-2, -2] }, { rowId: '2', pc: [2, 2] }], evidenceClass: 'test',
})

it('D02 excludes invalid values from valid percentages and discloses invalid counts and reasons', () => {
  render(<QuestionCard summary={{ columnId: 'Q', denominators: { total: 4, target: 3, valid: 1, missing: 1, notApplicable: 1, invalid: 1 }, distribution: [
    { code: 'A', count: 1, percentageValid: 100, percentageTotal: 25 },
    { code: 'X', count: 1, percentageValid: 0, percentageTotal: 25, isInvalid: true, missingReason: 'invalid_value' },
    { code: null, count: 1, percentageValid: 0, percentageTotal: 25, isMissing: true },
    { code: 'skip', count: 1, percentageValid: 0, percentageTotal: 25, isMissing: true, missingReason: '非該当' },
  ] }} />)
  expect(screen.getByTestId('denominators-bar')).toHaveTextContent('無効: 1')
  const row = within(screen.getByTestId('category-Q-X'))
  expect(row.getByText('対象外 (1)')).toBeInTheDocument()
  expect(row.getByText(/無効値/)).toBeInTheDocument()
  expect(chart.bars.find(x => x.id === 'X').value).toBeNull()
  fireEvent.click(screen.getByText('全対象者ベース'))
  expect(row.getByText('25.0% (1)')).toBeInTheDocument()
  expect(chart.bars.find(x => x.id === 'X').value).toBe(25)
})

it.each([0.049, 0.0565, 0.1473, 0.149999, 0.15, 0.151])('D04 discloses exploratory threshold without claiming symmetry at p=%s', p => {
  expect(asymmetryVerdict(p, .15)).toContain(p < .15 ? '15% で非対称性を検出' : '非対称性の証拠を検出せず')
})

it('D05 rounds Statistics like table cells and handles missing and range values', () => {
  render(<RoundedStatistic title="VIF" value={7.56} precision={1} />)
  expect(screen.getByText('7.6')).toBeInTheDocument()
  expect(formatFixed(null, 1)).toBe('—')
  expect(formatFixed(Infinity, 1)).toBe('範囲外')
  expect(vifDisplay(7.56).text).toBe('7.6')
  expect(vifDisplay(5).label).toBe('VIF ≤ 5')
  expect(vifDisplay(5.001).color).toBe(vifDisplay(10).color)
  expect(vifDisplay(10.001).color).not.toBe(vifDisplay(10).color)
  expect(vifDisplay(null).text).toBe('—')
  expect(vifDisplay(Infinity).text).toBe('範囲外')
  expect(vifDisplay(.5).text).toBe('範囲外')
})

it('D06 describes covariance loadings in original units with bars retaining magnitude differences', () => {
  const view = render(<LoadingTable pcaData={pca(false)} loading={false} />)
  expect(screen.getByText('2. 共分散PCA負荷量（元変数の単位）')).toBeInTheDocument()
  expect(screen.getByText(/相関係数ではありません/)).toBeInTheDocument()
  const twoCell = screen.getByText('+2.000').closest('td')!
  const oneCell = screen.getAllByText('+1.000')[0].closest('td')!
  expect(twoCell.querySelector('div > div > div')).toHaveStyle({ width: '45px' })
  expect(oneCell.querySelector('div > div > div')).toHaveStyle({ width: '22.5px' })
  view.rerender(<LoadingTable pcaData={{ ...pca(true), loadings: {x: [.8,.5], y: [.6,.4]} }} loading={false} />)
  expect(screen.getByText(/相関負荷量（変数と主成分得点の相関）/)).toBeInTheDocument()
})

it('D06 fits actual covariance loading extent while retaining a common vector multiplier', () => {
  render(<Provider store={store}><BiplotView pcaData={pca(false)} selectedX={0} selectedY={1} onSelectX={vi.fn()} onSelectY={vi.fn()} /></Provider>)
  const vectors = chart.scatter.option.series
  const first = vectors[0].markLine.data[0][1].coord
  const second = vectors[1].markLine.data[0][1].coord
  expect(first[0] / second[0]).toBe(2)
  expect(first[0]).toBeLessThan(chart.scatter.option.xAxis.max)
  expect(screen.getByText(/単位付き負荷量ベクトル表示/)).toBeInTheDocument()
})

it('D06 bar normalization retains proportions for tiny physical units', () => {
  const data = pca(false)
  data.loadings = { x: [2e-100, 5e-101], y: [1e-100, 1e-100] }
  const view = render(<LoadingTable pcaData={data} loading={false} />)
  const bars = view.container.querySelectorAll('td div > div > div')
  expect(bars[0]).toHaveStyle({ width: '45px' })
  expect(bars[2]).toHaveStyle({ width: '22.5px' })
})
