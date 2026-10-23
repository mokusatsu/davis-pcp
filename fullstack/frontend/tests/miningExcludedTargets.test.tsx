import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import ModernSubgroupMiningView from '../src/features/mining/ModernSubgroupMiningView'

const targets = vi.hoisted(() => ({ attributes: ['seg'], questions: ['q3'], ready: true, control: null }))
vi.mock('../src/features/mining/useMiningTargets', () => ({ useMiningTargets: () => targets }))
vi.mock('../src/features/dataset/useCodebookColumn', () => ({ useCodebook: () => ({
  schemaRevision: 2, getColumn: (name: string) => ({ label: name === 'q3' ? '利用サービス' : name }),
  formatValueLabel: (_name: string, value: unknown) => String(value),
}) }))
const skipped = [{ column: 'q3', reason: 'unsupported_target_type',
  detail: '名義尺度の質問は、有効な値が2種類の場合、または二値化するカテゴリを指定した場合に評価できます。現在の有効な値は3種類です。' }]
function response(evaluated = 0, exclusions = skipped, insights: any[] = []) {
  return { run_id: 'm1', mode: 'auto', algorithmMode: 'auto', insights,
    summary: { questions_evaluated_count: evaluated, total_candidates_explored: 2,
      non_redundant_insights_count: insights.length, skippedTargets: exclusions } }
}
function mount() {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'd', allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'] },
  }) })
  render(<Provider store={local}><MemoryRouter><ModernSubgroupMiningView /></MemoryRouter></Provider>)
}
const run = () => fireEvent.click(screen.getByRole('button', { name: /指定対象で実行/ }))
function evaluatedCard() { return screen.getByText('評価した質問数').closest('.ant-card') as HTMLElement }
beforeEach(() => {
  targets.questions = ['q3']; targets.ready = true
  vi.spyOn(api, 'get').mockResolvedValue({ datasets: [] } as never)
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('shows nominal-only exclusion count, question name, label and reason, not no-findings', async () => {
  vi.spyOn(api, 'post').mockResolvedValue(response())
  mount(); run()
  expect(await screen.findByTestId('modern-skipped-targets')).toHaveTextContent('評価対象外の質問: 1問')
  expect(screen.getByTestId('modern-skipped-targets')).toHaveTextContent('q3（利用サービス）')
  expect(screen.getByTestId('modern-skipped-targets')).toHaveTextContent('現在の有効な値は3種類')
  expect(screen.getByText(/質問は評価されていません/)).toBeVisible()
  expect(screen.queryByText('条件に合致するインサイトはありませんでした。')).toBeNull()
  expect(within(evaluatedCard()).getByText('0')).toBeVisible()
})

it('preserves supported insights alongside mixed-target exclusions', async () => {
  targets.questions = ['score', 'q3']
  vi.spyOn(api, 'post').mockResolvedValue(response(1, skipped, [{ id: 'i1', target_question: 'score',
    rule: { conditions: [], complexity: 1, text: 'seg=A' }, coverage: { n: 1, ratio: 0.5, row_ids: ['r1'] },
    target_stats: { delta_mean: 2 }, ranking_reason: { primary_driver: 'delta_mean', description: '平均差' },
    score: 2, narrative: '有効な質問の発見' }]))
  mount(); run()
  expect(await screen.findByTestId('modern-skipped-targets')).toBeVisible()
  expect(screen.getAllByText('有効な質問の発見').length).toBeGreaterThan(0)
  expect(within(evaluatedCard()).getByText('1')).toBeVisible()
})

it('distinguishes evaluated no-findings from exclusion', async () => {
  targets.questions = ['score']
  vi.spyOn(api, 'post').mockResolvedValue(response(1, []))
  mount(); run()
  expect(await screen.findByText('条件に合致するインサイトはありませんでした。')).toBeVisible()
  expect(screen.queryByTestId('modern-skipped-targets')).toBeNull()
  expect(within(evaluatedCard()).getByText('1')).toBeVisible()
})

it('keeps empty selection validation separate and does not send a request', () => {
  targets.questions = []; targets.ready = false
  const post = vi.spyOn(api, 'post')
  mount(); run()
  expect(screen.getByRole('button', { name: /指定対象で実行/ })).toBeDisabled()
  expect(post).not.toHaveBeenCalled()
  expect(screen.queryByTestId('modern-skipped-targets')).toBeNull()
})

it('does not invent an evaluated count if the response omits it', async () => {
  const payload: any = response(0, [])
  delete payload.summary.questions_evaluated_count
  vi.spyOn(api, 'post').mockResolvedValue(payload)
  mount(); run()
  await screen.findByText('評価した質問数')
  expect(within(evaluatedCard()).getByText('—')).toBeVisible()
})

it('waits for the response and preserves backend errors without an exclusion warning', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(api, 'post').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mount(); run()
  expect(screen.queryByTestId('modern-skipped-targets')).toBeNull()
  expect(screen.queryByText(/質問は評価されていません/)).toBeNull()
  reject(new Error('バックエンド検証エラー'))
  await waitFor(() => expect(screen.getByText('バックエンド検証エラー')).toBeVisible())
  expect(screen.queryByTestId('modern-skipped-targets')).toBeNull()
})


it('clears obsolete exclusions on rerun, including when the next request fails', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(response())
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mount(); run()
  await screen.findByTestId('modern-skipped-targets')
  let reject!: (error: Error) => void
  post.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  run()
  expect(screen.queryByTestId('modern-skipped-targets')).toBeNull()
  expect(screen.queryByText('評価した質問数')).toBeNull()
  await act(async () => { reject(new Error('再実行エラー')) })
  expect(screen.getByText('再実行エラー')).toBeVisible()
  expect(screen.queryByTestId('modern-skipped-targets')).toBeNull()
  expect(screen.queryByText(/質問は評価されていません/)).toBeNull()
})
