import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { message } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import AddVariableModal from '../src/features/dataset/AddVariableModal'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

vi.mock('../src/features/charts/CategoryBars', () => ({ default: () => <div>chart</div> }))
const columns = ['x', 'y', 'new_feature', 'new_feature_2']
function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (error: any) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function result(body: any, extra = {}) {
  return { valid: true, error: null, column: body.columnName, mode: body.mode,
    targetExists: body.mode === 'replace', columnId: body.mode === 'replace' ? 'stable-x' : null,
    dataRevision: 1, schemaRevision: 1, rowCount: 101, previewScope: 'first_rows',
    previewRowCount: 100, previewRowLimit: 100,
    previewValues: [2, 3], stats: { count: 100 }, histogram: [], ...extra }
}
const close = vi.fn(), success = vi.fn()
function ui(extra: Record<string, any> = {}, active = true) {
  return <Provider store={store}><AnalysisViewActivityContext.Provider value={active}>
    <AddVariableModal open datasetId="a" datasetName="Dataset A" dataRevision={1} schemaRevision={1}
      columns={columns} onClose={close} onSuccess={success} {...extra} />
  </AnalysisViewActivityContext.Provider></Provider>
}
const submit = () => screen.getByTestId('btn-add-variable-submit')
const name = () => screen.getByTestId('input-new-variable-name')
const formula = () => screen.getByTestId('input-variable-expression')
const calls = () => vi.mocked(api.post).mock.calls.filter(([path]) => path.endsWith('/calculate'))
async function verify() {
  fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
  await waitFor(() => expect(submit()).toBeEnabled())
}
async function confirmReplacement() {
  fireEvent.change(name(), { target: { value: ' x ' } })
  fireEvent.click(screen.getByTestId('replace-calculated-column'))
  await verify()
  fireEvent.click(submit())
  return screen.findByTestId('confirm-replace-calculated-column')
}
// Keep the real button's old callback to exercise a delayed confirmation even
// after React has removed it. A click on a detached DOM node alone proves less.
function retainClick(button: HTMLElement) {
  const key = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
  const callback = (button as any)[key].onClick
  return () => callback({ preventDefault() {}, stopPropagation() {} })
}
beforeEach(() => {
  close.mockReset(); success.mockReset()
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as any)
  vi.spyOn(api, 'post').mockImplementation(async (path, body: any) =>
    (path.endsWith('/preview') ? result(body) : { column: body.columnName, operation: body.mode === 'replace' ? 'replaced' : 'created' }) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('calculated-column intent and preview authority', () => {
  it('chooses unused exact-case defaults on each open and blocks silent collisions', async () => {
    const view = render(ui())
    expect(name()).toHaveValue('new_feature_3')
    for (const column of ['x', ' x ', 'new_feature', '__rowId__', ' __rowId__ ', '   ']) {
      fireEvent.change(name(), { target: { value: column } })
      expect(screen.getByRole('button', { name: 'プレビュー検証' })).toBeDisabled()
      fireEvent.click(submit())
    }
    expect(api.post).not.toHaveBeenCalled()
    view.rerender(ui({ open: false }))
    view.rerender(ui({ columns: [...columns, 'new_feature_3', 'New_feature_4'] }))
    expect(name()).toHaveValue('new_feature_4')
  })

  it.each([' X ', '__rowid__', 'a b', 'log'])('preserves trim-only case-sensitive creation for %s', async column => {
    render(ui())
    fireEvent.change(name(), { target: { value: column } })
    await verify()
    expect(api.post).toHaveBeenLastCalledWith('/datasets/a/calculate/preview', {
      expression: 'x / (y + 1e-6)', columnName: column.trim(), mode: 'create',
    })
    fireEvent.click(submit())
    await waitFor(() => expect(success).toHaveBeenCalledWith('a'))
    expect(calls()[0][1]).toEqual({ expression: 'x / (y + 1e-6)', columnName: column.trim(), mode: 'create',
      expectedDataRevision: 1, expectedSchemaRevision: 1 })
  })

  it('replacement requires explicit intent, names the dataset/column/all rows, and cancel writes nothing', async () => {
    render(ui())
    const confirm = await confirmReplacement()
    const canceledClick = retainClick(confirm)
    expect(within(confirm.closest('.ant-modal-content')!).getByText(/Dataset A.*'x'.*101.*置換します/)).toBeInTheDocument()
    expect(calls()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '置換をキャンセル' }))
    act(canceledClick)
    expect(calls()).toHaveLength(0)
    fireEvent.click(submit())
    fireEvent.click(await screen.findByTestId('confirm-replace-calculated-column'))
    await waitFor(() => expect(success).toHaveBeenCalledWith('a'))
    expect(calls()).toHaveLength(1)
    expect(calls()[0][1]).toMatchObject({ columnName: 'x', mode: 'replace', expectedDataRevision: 1, expectedSchemaRevision: 1 })
    expect(message.success).toHaveBeenCalledWith("変数 'x' を置換しました。")
  })

  it('discloses sample scope and pins server-observed revisions even when props lag', async () => {
    vi.mocked(api.post).mockImplementation(async (path, body: any) =>
      (path.endsWith('/preview') ? result(body, { dataRevision: 7, schemaRevision: 9 }) : { column: body.columnName, operation: 'created' }) as any)
    render(ui())
    await verify()
    expect(screen.getByText(/検証時のデータ世代: 7.*スキーマ世代: 9/)).toHaveTextContent('先頭 100 行（最大 100 行）')
    expect(screen.getByText(/検証時のデータ世代/)).toHaveTextContent('全 101 行')
    expect(screen.getByText(/検証時のデータ世代/)).toHaveTextContent('異なる場合があります')
    fireEvent.click(submit())
    expect(calls()[0][1]).toMatchObject({ expectedDataRevision: 7, expectedSchemaRevision: 9 })
  })

  it('equivalent arrays preserve verified draft; changed column contents invalidate it without erasing edits', async () => {
    const view = render(ui())
    fireEvent.change(name(), { target: { value: 'custom' } })
    fireEvent.change(formula(), { target: { value: 'x + 10' } })
    await verify()
    view.rerender(ui({ columns: [...columns] }))
    expect(submit()).toBeEnabled()
    expect(formula()).toHaveValue('x + 10')
    view.rerender(ui({ columns: [...columns, 'custom'] }))
    expect(submit()).toBeDisabled()
    expect(name()).toHaveValue('custom')
    expect(formula()).toHaveValue('x + 10')
    expect(screen.getByRole('button', { name: 'プレビュー検証' })).toBeDisabled()
  })

  it.each(['name', 'formula', 'mode', 'data', 'schema', 'columns', 'dataset', 'open', 'active'])(
    'invalidates pending replacement and its old callback across %s changes and A→B→A', async change => {
      const view = render(ui())
      const oldClick = retainClick(await confirmReplacement())
      if (change === 'name') {
        fireEvent.change(name(), { target: { value: 'other' } })
        fireEvent.change(name(), { target: { value: ' x ' } })
        fireEvent.click(screen.getByTestId('replace-calculated-column'))
      } else if (change === 'formula') {
        fireEvent.change(formula(), { target: { value: 'x + 1' } })
        fireEvent.change(formula(), { target: { value: 'x / (y + 1e-6)' } })
      } else if (change === 'mode') {
        fireEvent.click(screen.getByTestId('replace-calculated-column'))
        fireEvent.click(screen.getByTestId('replace-calculated-column'))
      } else {
        const changed = change === 'data' ? { dataRevision: 2 } : change === 'schema' ? { schemaRevision: 2 }
          : change === 'columns' ? { columns: [...columns, 'other'] } : change === 'dataset' ? { datasetId: 'b' }
          : change === 'open' ? { open: false } : {}
        view.rerender(ui(changed, change !== 'active'))
        view.rerender(ui())
      }
      act(oldClick)
      expect(calls()).toHaveLength(0)
      expect(submit()).toBeDisabled()
      expect(screen.queryByRole('button', { name: '全行の値を置換' })).not.toBeInTheDocument()
    })

  it('keeps an explicit recovery control when the replacement target disappears', async () => {
    const view = render(ui())
    await confirmReplacement()
    view.rerender(ui({ columns: columns.filter(column => column !== 'x') }))
    expect(submit()).toBeDisabled()
    expect(screen.getByText(/存在しなくなりました/)).toBeInTheDocument()
    expect(screen.getByTestId('replace-calculated-column')).toBeChecked()
    fireEvent.click(screen.getByTestId('replace-calculated-column'))
    fireEvent.change(formula(), { target: { value: 'y + 1' } })
    await verify()
    expect(api.post).toHaveBeenLastCalledWith('/datasets/a/calculate/preview', {
      expression: 'y + 1', columnName: 'x', mode: 'create',
    })
    expect(submit()).toHaveTextContent('変数をデータセットに追加')
    expect(calls()).toHaveLength(0)
  })

  it.each(['preview', 'apply'])('recovers server-only creation from %s conflict without switching intent or replaying', async stage => {
    let exists = false
    vi.mocked(api.post).mockImplementation(async (path, body: any) => {
      if (body.mode === 'create' && exists) throw { code: 'CALCULATION_TARGET_CONFLICT',
        message: 'Already exists', details: { column: body.columnName, mode: body.mode, targetExists: true } }
      if (path.endsWith('/preview')) return result(body) as any
      return { column: body.columnName, operation: 'replaced' } as any
    })
    render(ui())
    fireEvent.change(name(), { target: { value: 'fresh' } })
    if (stage === 'apply') {
      await verify()
      exists = true
      fireEvent.click(submit())
    } else {
      exists = true
      fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
    }
    const control = await screen.findByTestId('replace-calculated-column')
    expect(control).not.toBeChecked()
    expect(name()).toHaveValue('fresh')
    expect(submit()).toBeDisabled()
    const priorCalls = calls().length
    fireEvent.click(control)
    expect(calls()).toHaveLength(priorCalls)
    await verify()
    expect(api.post).toHaveBeenLastCalledWith('/datasets/a/calculate/preview', {
      expression: 'x / (y + 1e-6)', columnName: 'fresh', mode: 'replace',
    })
    fireEvent.click(submit())
    expect(calls()).toHaveLength(priorCalls)
    fireEvent.click(await screen.findByTestId('confirm-replace-calculated-column'))
    await waitFor(() => expect(success).toHaveBeenCalledWith('a'))
    expect(calls()).toHaveLength(priorCalls + 1)
  })

  it('recovers server-only deletion while stale parent columns still contain the target', async () => {
    vi.mocked(api.post).mockImplementation(async (path, body: any) => {
      if (body.mode === 'replace') throw { code: 'CALCULATION_TARGET_CONFLICT',
        message: 'Missing target', details: { column: 'x', mode: 'replace', targetExists: false } }
      if (path.endsWith('/preview')) return result(body) as any
      return { column: body.columnName, operation: 'created' } as any
    })
    render(ui())
    fireEvent.change(name(), { target: { value: 'x' } })
    fireEvent.change(formula(), { target: { value: 'y + 1' } })
    fireEvent.click(screen.getByTestId('replace-calculated-column'))
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
    await screen.findByText(/存在しなくなりました/)
    expect(screen.getByTestId('replace-calculated-column')).toBeChecked()
    expect(submit()).toBeDisabled()
    expect(calls()).toHaveLength(0)
    fireEvent.click(screen.getByTestId('replace-calculated-column'))
    await verify()
    expect(api.post).toHaveBeenLastCalledWith('/datasets/a/calculate/preview', {
      expression: 'y + 1', columnName: 'x', mode: 'create',
    })
    fireEvent.click(submit())
    await waitFor(() => expect(success).toHaveBeenCalledWith('a'))
    expect(calls()).toHaveLength(1)
  })

  it.each([{ column: 'other' }, { mode: 'replace' }, { targetExists: 'true' }])(
    'ignores conflict hints whose target, intent or presence is invalid: %j', async extra => {
      vi.mocked(api.post).mockRejectedValue({ code: 'CALCULATION_TARGET_CONFLICT', message: 'Untrusted hint',
        details: { column: 'fresh', mode: 'create', targetExists: true, ...extra } })
      render(ui())
      fireEvent.change(name(), { target: { value: 'fresh' } })
      fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
      await screen.findByText('Untrusted hint')
      expect(screen.queryByTestId('replace-calculated-column')).not.toBeInTheDocument()
      expect(submit()).toBeDisabled()
      expect(calls()).toHaveLength(0)
    })

  it.each(['name', 'dataset', 'schema', 'data', 'columns', 'open', 'active'])(
    'ignores a late conflict hint across %s changes and return', async change => {
      const pending = deferred()
      vi.mocked(api.post).mockReturnValue(pending.promise)
      const view = render(ui())
      fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
      if (change === 'name') {
        fireEvent.change(name(), { target: { value: 'other' } })
        fireEvent.change(name(), { target: { value: 'new_feature_3' } })
      } else {
        const changed = change === 'dataset' ? { datasetId: 'b' } : change === 'schema' ? { schemaRevision: 2 }
          : change === 'data' ? { dataRevision: 2 } : change === 'columns' ? { columns: [...columns, 'other'] }
          : change === 'open' ? { open: false } : {}
        view.rerender(ui(changed, change !== 'active'))
        view.rerender(ui())
      }
      await act(async () => {
        pending.reject({ code: 'CALCULATION_TARGET_CONFLICT', message: 'Late hint',
          details: { column: 'new_feature_3', mode: 'create', targetExists: true } })
        try { await pending.promise } catch { /* expected */ }
      })
      expect(screen.queryByTestId('replace-calculated-column')).not.toBeInTheDocument()
      expect(screen.queryByText('Late hint')).not.toBeInTheDocument()
      expect(submit()).toBeDisabled()
      expect(calls()).toHaveLength(0)
    })

  it('clears an accepted target hint across revision A→B→A without erasing the draft', async () => {
    vi.mocked(api.post).mockRejectedValue({ code: 'CALCULATION_TARGET_CONFLICT', message: 'Target exists',
      details: { column: 'fresh', mode: 'create', targetExists: true } })
    const view = render(ui())
    fireEvent.change(name(), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
    await screen.findByTestId('replace-calculated-column')
    view.rerender(ui({ dataRevision: 2 }))
    expect(screen.queryByTestId('replace-calculated-column')).not.toBeInTheDocument()
    view.rerender(ui())
    expect(screen.queryByTestId('replace-calculated-column')).not.toBeInTheDocument()
    expect(name()).toHaveValue('fresh')
    expect(submit()).toBeDisabled()
  })

  it('late preview cannot revive authority after schema changes or unmount', async () => {
    const pending = deferred()
    vi.mocked(api.post).mockReturnValue(pending.promise)
    const view = render(ui())
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
    view.rerender(ui({ schemaRevision: 2 }))
    view.rerender(ui())
    await act(async () => { pending.resolve(result({ columnName: 'new_feature_3', mode: 'create' })); await pending.promise })
    expect(submit()).toBeDisabled()
    view.unmount()
    expect(calls()).toHaveLength(0)
  })

  it.each(['ANALYSIS_INPUT_STALE', 'CALCULATION_TARGET_CONFLICT'])('requires re-preview after %s and never replays the mutation', async code => {
    vi.mocked(api.post).mockImplementation(async (path, body: any) => {
      if (path.endsWith('/preview')) return result(body) as any
      throw { code, message: 'Snapshot changed' }
    })
    render(ui())
    fireEvent.click(await confirmReplacement())
    await screen.findByText(/Snapshot changed.*再度プレビュー/)
    expect(submit()).toBeDisabled()
    expect(calls()).toHaveLength(1)
    fireEvent.click(submit())
    expect(calls()).toHaveLength(1)
    expect(success).not.toHaveBeenCalled()
    await verify()
    expect(calls()).toHaveLength(1)
  })

  it.each([
    { column: 'wrong' }, { mode: 'replace' }, { targetExists: true },
    { dataRevision: 0 }, { schemaRevision: -1 }, { dataRevision: '1' }, { schemaRevision: undefined },
  ])('rejects mismatched or incomplete preview authority %j', async extra => {
    vi.mocked(api.post).mockImplementation(async (_path, body: any) => result(body, extra) as any)
    render(ui())
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
    await screen.findByText(/数式検証成功/)
    expect(submit()).toBeDisabled()
    expect(calls()).toHaveLength(0)
  })

  it.each(['dataset', 'unmount'])('double-confirm commits once and late completion reconciles captured dataset after %s', async change => {
    const pending = deferred()
    vi.mocked(api.post).mockImplementation(async (path, body: any) => path.endsWith('/preview') ? result(body) as any : pending.promise)
    const view = render(ui())
    const confirm = await confirmReplacement()
    const oldClick = retainClick(confirm)
    act(() => { oldClick(); oldClick() })
    expect(calls()).toHaveLength(1)
    expect(formula()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled()
    if (change === 'dataset') view.rerender(ui({ datasetId: 'b', datasetName: 'Dataset B' }))
    else view.unmount()
    await act(async () => { pending.resolve({ column: 'x', operation: 'replaced' }); await pending.promise })
    expect(success).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith('a')
    expect(close).not.toHaveBeenCalled()
    expect(message.success).toHaveBeenCalledWith("変数 'x' を置換しました。")
  })
})
