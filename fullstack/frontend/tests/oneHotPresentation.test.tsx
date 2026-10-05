import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notification } from 'antd'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import OneHotModal from '../src/features/dataset/OneHotModal'

type TransformResult = { createdColumns: string[] }

beforeEach(() => {
  vi.spyOn(notification, 'success').mockImplementation(() => {})
  vi.spyOn(notification, 'error').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function wrap(ui: ReactNode) { return <Provider store={store}>{ui}</Provider> }
function setup(overrides: Partial<ComponentProps<typeof OneHotModal>> = {}) {
  const props = {
    open: true, datasetId: 'd', columnName: 'category', categories: ['A', 'B'],
    onClose: vi.fn(), onSuccess: vi.fn(), ...overrides,
  }
  const view = render(wrap(<OneHotModal {...props} />))
  return { props, view }
}
function candidateNames() {
  const section = screen.getByText('二値列名の候補 (プレビュー):').closest('div')!
  return Array.from(section.querySelectorAll('.ant-tag'), tag => tag.textContent)
}
function categoryRow(value: string) {
  return within(screen.getByRole('table')).getByText(value).closest('tr')!
}
function submit() { fireEvent.click(screen.getByRole('button', { name: /0\/1二値列を生成/ })) }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

describe('one-hot presentation and completion', () => {
  it('retains the singleton with Drop First off and on without changing the submitted option', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ createdColumns: ['category_A'] })
    const { props } = setup({ categories: ['A'] })
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).not.toBeChecked()
    expect(candidateNames()).toEqual(['category_A'])
    expect(categoryRow('A')).toHaveTextContent('0/1列として生成')

    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(candidateNames()).toEqual(['category_A'])
    expect(categoryRow('A')).toHaveTextContent('0/1列として生成')
    expect(screen.queryByText('除外 (Base)')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('水準が1つの場合は除外せず、0/1列を生成します。')).toBeVisible())

    fireEvent.click(checkbox)
    expect(candidateNames()).toEqual(['category_A'])
    expect(categoryRow('A')).toHaveTextContent('0/1列として生成')
    fireEvent.click(checkbox)
    submit()
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('d'))
    expect(post).toHaveBeenCalledWith('/datasets/d/transform', {
      type: 'nominal_to_binary', source_column: 'category',
      options: { drop_first: true, prefix: 'category' },
    })
    expect(notification.success).toHaveBeenCalledWith({
      message: '二値化完了', description: '1個の0/1列を生成しました。',
    })
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('excludes the first of two levels only while the real Drop First control is checked', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ createdColumns: ['category_B'] })
    const { props } = setup()
    const checkbox = screen.getByRole('checkbox')
    expect(candidateNames()).toEqual(['category_A', 'category_B'])
    expect(screen.queryByText('除外 (Base)')).not.toBeInTheDocument()
    fireEvent.click(checkbox)
    expect(candidateNames()).toEqual(['category_B'])
    expect(categoryRow('A')).toHaveTextContent('除外 (Base)')
    expect(categoryRow('B')).toHaveTextContent('0/1列として生成')
    fireEvent.click(checkbox)
    expect(candidateNames()).toEqual(['category_A', 'category_B'])
    expect(screen.queryByText('除外 (Base)')).not.toBeInTheDocument()
    fireEvent.click(checkbox)
    submit()
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('d'))
    expect(post).toHaveBeenCalledWith('/datasets/d/transform', expect.objectContaining({
      options: { drop_first: true, prefix: 'category' },
    }))
  })

  it.each([
    ['  custom  ', 'custom'],
    [' \t ', 'category'],
    ['', 'category'],
  ])('uses the same effective prefix for candidates and the request: %j', async (input, effective) => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ createdColumns: [`${effective}_A`] })
    const { props } = setup({ categories: ['A'] })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: input } })
    expect(screen.getByRole('textbox')).toHaveValue(input)
    expect(candidateNames()).toEqual([`${effective}_A`])
    submit()
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('d'))
    expect(post).toHaveBeenCalledWith('/datasets/d/transform', {
      type: 'nominal_to_binary', source_column: 'category',
      options: { drop_first: false, prefix: effective },
    })
  })

  it('matches literal-space and slash normalization without collapsing spaces or tabs', () => {
    setup({ categories: ['a  b', 'a\tb', 'a/b'] })
    expect(candidateNames()).toEqual(['category_a__b', 'category_a\tb', 'category_a_b'])
  })

  it('shows both colliding candidates with unique keys and explains final-name suffixing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ categories: ['a b', 'a/b'] })
    expect(candidateNames()).toEqual(['category_a_b', 'category_a_b'])
    expect(categoryRow('a b')).toHaveTextContent('0/1列として生成')
    expect(categoryRow('a/b')).toHaveTextContent('0/1列として生成')
    await waitFor(() => expect(screen.getByText('既存の列名や候補同士で重複する場合は、末尾に _1、_2 などを付けて生成します。実際の列名と列数は実行時に確定します。')).toBeVisible())
    const keyWarnings = errors.mock.calls.filter(args => /same key|unique.*key/i.test(args.join(' ')))
    expect(keyWarnings).toEqual([])
  })

  it.each([
    { createdColumns: [] },
    { createdColumns: ['category_A_2'] },
    { createdColumns: ['category_A_2', 'category_B_1', 'category_C'] },
  ])('reports the authoritative response count instead of its two local candidates: $createdColumns', async result => {
    vi.spyOn(api, 'post').mockResolvedValue(result)
    const { props } = setup()
    expect(candidateNames()).toHaveLength(2)
    submit()
    await waitFor(() => expect(notification.success).toHaveBeenCalledWith({
      message: '二値化完了', description: `${result.createdColumns.length}個の0/1列を生成しました。`,
    }))
    expect(props.onSuccess).toHaveBeenCalledOnce()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('locks real controls and dismissal while pending, then permits retry after failure', async () => {
    const pending = deferred<TransformResult>()
    const post = vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ createdColumns: ['category_A', 'category_B'] })
    const { props } = setup()
    submit(); submit()
    expect(post).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: /0\/1二値列を生成/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 })
    const mask = document.querySelector('.ant-modal-wrap')!
    fireEvent.mouseDown(mask); fireEvent.mouseUp(mask); fireEvent.click(mask)
    expect(props.onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('データを更新しています。処理中は編集・キャンセルできません。')).toBeVisible())
    await act(async () => { pending.reject(new Error('SAVE_FAILED')); await pending.promise.catch(() => {}) })
    expect(notification.error).toHaveBeenCalledWith({ message: '二値化エラー', description: 'SAVE_FAILED' })
    expect(props.onSuccess).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toBeEnabled()
    expect(screen.getByRole('checkbox')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeEnabled()
    submit()
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith('d'))
    expect(post).toHaveBeenCalledTimes(2)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it.each(['dataset switch', 'unmount'] as const)('reports a late commit for its original dataset after %s without closing another dialog', async change => {
    const pending = deferred<TransformResult>()
    const post = vi.spyOn(api, 'post').mockReturnValue(pending.promise)
    const { props, view } = setup({ datasetId: 'old' })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' custom ' } })
    submit()
    if (change === 'dataset switch') {
      view.rerender(wrap(<OneHotModal {...props} datasetId="new" />))
      expect(screen.getByRole('textbox')).toHaveValue('category')
      expect(screen.getByRole('checkbox')).not.toBeChecked()
      expect(screen.getByRole('button', { name: /0\/1二値列を生成/ })).toBeDisabled()
    } else view.unmount()
    await act(async () => { pending.resolve({ createdColumns: ['custom_B_1'] }); await pending.promise })
    expect(post).toHaveBeenCalledWith('/datasets/old/transform', {
      type: 'nominal_to_binary', source_column: 'category', options: { drop_first: true, prefix: 'custom' },
    })
    expect(notification.success).toHaveBeenCalledWith({
      message: '二値化完了', description: '1個の0/1列を生成しました。',
    })
    expect(props.onSuccess).toHaveBeenCalledOnce()
    expect(props.onSuccess).toHaveBeenCalledWith('old')
    expect(props.onClose).not.toHaveBeenCalled()
    if (change === 'dataset switch') expect(screen.getByRole('button', { name: /0\/1二値列を生成/ })).toBeEnabled()
  })
})
