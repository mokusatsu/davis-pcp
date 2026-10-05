import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AnalysisField, AnalysisRunRow, AnalysisSettings } from '../src/features/common/AnalysisSetup'
afterEach(cleanup)
it('starts settings closed, preserving edited mounted inputs across toggles', () => {
  const view = render(<AnalysisSettings title="詳細設定" summary="既定値"><input aria-label="値" defaultValue="0.1" /></AnalysisSettings>)
  const details = view.container.querySelector('details')!
  const input = screen.getByLabelText('値')
  expect(details.open).toBe(false)
  details.open = true
  fireEvent.change(input, { target: { value: '0.5' } })
  details.open = false
  expect(input).toHaveValue('0.5')
  expect(details.querySelector('input')).toBe(input)
  details.open = true
  expect(screen.getByLabelText('値')).toHaveValue('0.5')
})
it('opens invalid settings and retains summary warning after closing again', () => {
  const view = render(<AnalysisSettings title="詳細設定" summary="現在の設定"><input /></AnalysisSettings>)
  view.rerender(<AnalysisSettings title="詳細設定" summary="現在の設定" attention><input /></AnalysisSettings>)
  const details = view.container.querySelector('details')!
  expect(details.open).toBe(true)
  details.open = false
  expect(details.querySelector('summary')).toHaveTextContent('設定を確認してください')
})
it('connects field labels/help and keeps the run footer separate', () => {
  const view = render(<><AnalysisField label="目的変数" htmlFor="target" help="予測する値"><input id="target" aria-describedby="target-help" /></AnalysisField><AnalysisRunRow><button>実行</button></AnalysisRunRow></>)
  expect(screen.getByLabelText('目的変数')).toHaveAccessibleDescription('予測する値')
  expect(view.container.querySelector('.analysis-run-row')).toContainElement(screen.getByRole('button', { name: '実行' }))
})
