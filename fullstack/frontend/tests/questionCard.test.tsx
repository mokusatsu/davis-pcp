import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import QuestionCard from '../src/features/distribution/QuestionCard'

afterEach(cleanup)

describe('QuestionCard', () => {
  it('switches denominator and selects raw category including null', () => {
    const select = vi.fn()
    render(<QuestionCard summary={{ columnId: 'Q', denominators: { total: 10, target: 9, valid: 5, missing: 4, notApplicable: 1 },
      distribution: [
        { code: '1', label: '満足', count: 3, percentageValid: 60, percentageTotal: 30 },
        { code: '5', label: '未観測', count: 0, percentageValid: 0, percentageTotal: 0 },
        { code: null, label: '無回答', count: 4, percentageValid: 0, percentageTotal: 40, isMissing: true },
      ], auxiliaryStats: { mean: 2, meanNote: '等間隔得点として計算', median: 2, top2Box: { pct: 60, n: 3 }, bottom2Box: { pct: 40, n: 2 } },
    }} onSelectCategory={select} selectedCountByCode={{ '1': 2 }} />)
    expect(screen.getByText('60.0% (3)')).toBeInTheDocument()
    expect(screen.getByText(/等間隔得点として計算/)).toBeInTheDocument()
    expect(screen.getByText('2選択中')).toBeInTheDocument()
    const first = within(screen.getByTestId('category-Q-1'))
    fireEvent.click(first.getByRole('button', { name: /PCP/ }))
    expect(select).toHaveBeenCalledWith('1', '満足')
    expect(within(screen.getByTestId('category-Q-5')).getByRole('button', { name: /PCP/ })).toBeDisabled()
    fireEvent.click(screen.getByText('全対象者ベース'))
    expect(screen.getByText('30.0% (3)')).toBeInTheDocument()
    expect(screen.getByText('40.0% (4)')).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('category-Q-__null__')).getByRole('button', { name: /PCP/ }))
    expect(select).toHaveBeenCalledWith(null, '無回答')
  })
})
