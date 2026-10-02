import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api/client'
import { createSerialQueue } from '../src/engine/serialQueue'
import { useAnalysisResultLifecycle } from '../src/features/models/useAnalysisResultLifecycle'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const model = (resultId = 'fit-1', datasetId = 'd') => ({ resultId, meta: { datasetId } })
const revisions = (dataRevision = 1, schemaRevision = 1) => ({ dataRevision, schemaRevision })
const members = (rows: string[][] = [['a', 'r1'], ['b', 'r2']], nextOffset: number | null = null) => ({ payload: JSON.stringify({ rows }), nextOffset })
let visibility: DocumentVisibilityState
function setVisibility(next: DocumentVisibilityState) {
  act(() => { visibility = next; document.dispatchEvent(new Event('visibilitychange')) })
}
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function mount(overrides: Partial<{ result: ReturnType<typeof model> | null; datasetId: string | null; selected: string[]; data: number; schema: number }> = {}, active = true, strict = false) {
  let props = { result: model() as ReturnType<typeof model> | null, datasetId: 'd' as string | null, selected: [] as string[], data: 1, schema: 1, ...overrides }
  const wrapper = ({ children }: { children: ReactNode }) => <AnalysisViewActivityContext.Provider value={active}>
    {strict ? <StrictMode>{children}</StrictMode> : children}
  </AnalysisViewActivityContext.Provider>
  const view = renderHook(p => useAnalysisResultLifecycle(p.result, p.datasetId, p.selected, p.data, p.schema), { initialProps: props, wrapper })
  return { ...view, update: (patch: Partial<typeof props> = {}, nextActive = active) => {
    props = { ...props, ...patch }; active = nextActive; view.rerender(props)
  } }
}
beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(api, 'get').mockResolvedValue(revisions())
  vi.spyOn(api, 'post').mockResolvedValue(members())
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('analysis background lifecycle', () => {
  it('starts only for a fitted current dataset and visible active route', async () => {
    const view = mount({ result: null }, false)
    await tick(60000)
    expect(api.get).not.toHaveBeenCalled()
    view.update({ result: model() })
    await tick(60000)
    expect(api.get).not.toHaveBeenCalled()
    setVisibility('hidden')
    view.update({}, true)
    await tick(60000)
    expect(api.get).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(api.get).toHaveBeenCalledTimes(1)
    await tick()
    expect(view.result.current.liveRevisions).toEqual({ data: 1, schema: 1 })
    view.update({ datasetId: 'next' })
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(view.result.current.liveRevisions).toBeNull()
  })

  it('cancels delayed checks while hidden and immediately refreshes each re-entry', async () => {
    const view = mount()
    await tick()
    view.update({}, false)
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(1)
    view.update({}, true)
    expect(api.get).toHaveBeenCalledTimes(2)
    await tick()
    setVisibility('hidden')
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(2)
    setVisibility('visible')
    expect(api.get).toHaveBeenCalledTimes(3)
    await tick(9999)
    expect(api.get).toHaveBeenCalledTimes(3)
    await tick(1)
    expect(api.get).toHaveBeenCalledTimes(4)
  })

  it('keeps one pending poll through repeated hide/re-entry and starts its delay after settlement', async () => {
    const pending = deferred()
    vi.mocked(api.get).mockReturnValueOnce(pending.promise)
    const view = mount()
    await tick(60000)
    for (let i = 0; i < 10; i++) { view.update({}, false); view.update({}, true) }
    expect(api.get).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(revisions(99)) })
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(view.result.current.liveRevisions).toEqual({ data: 1, schema: 1 })
    await tick(9999)
    expect(api.get).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(api.get).toHaveBeenCalledTimes(3)
  })

  it('ignores a hidden completion and waits for re-entry before refreshing', async () => {
    const pending = deferred()
    vi.mocked(api.get).mockReturnValueOnce(pending.promise)
    const view = mount()
    setVisibility('hidden')
    await act(async () => { pending.resolve(revisions(99)) })
    expect(view.result.current.liveRevisions).toBeNull()
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    await tick()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(view.result.current.liveRevisions).toEqual({ data: 1, schema: 1 })
  })

  it.each(['dataset', 'result', 'data revision', 'schema revision'])('coalesces %s changes and discards superseded responses', async change => {
    const pending = deferred(), current = deferred()
    vi.mocked(api.get).mockReturnValueOnce(pending.promise).mockReturnValueOnce(current.promise)
    const view = mount()
    if (change === 'dataset') {
      view.update({ datasetId: 'next', result: model('fit-2', 'next') })
      view.update({ datasetId: 'last', result: model('fit-3', 'last') })
    } else if (change === 'result') {
      view.update({ result: model('fit-2') }); view.update({ result: model('fit-3') })
    } else if (change === 'data revision') view.update({ data: 2 })
    else view.update({ schema: 2 })
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(revisions(99)) })
    expect(view.result.current.liveRevisions).toBeNull()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.get).toHaveBeenLastCalledWith(`/datasets/${change === 'dataset' ? 'last' : 'd'}`)
    await act(async () => { current.resolve(revisions(2, 2)) })
    expect(view.result.current.liveRevisions).toEqual({ data: 2, schema: 2 })
  })

  it('recovers from synchronous and async failures without changing the last confirmed revisions', async () => {
    vi.mocked(api.get).mockImplementationOnce(() => { throw new Error('send failed') })
      .mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce(revisions(3, 2))
    const view = mount()
    await tick(9999)
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(view.result.current.liveRevisions).toBeNull()
    await tick(10001)
    expect(api.get).toHaveBeenCalledTimes(3)
    expect(view.result.current.liveRevisions).toEqual({ data: 3, schema: 2 })
    vi.mocked(api.get).mockRejectedValueOnce(new Error('later failure'))
    await tick(10000)
    expect(view.result.current.liveRevisions).toEqual({ data: 3, schema: 2 })
  })

  it('releases timers/listeners and ignores late resolution on unmount, including StrictMode replay', async () => {
    const pending = deferred()
    vi.mocked(api.get).mockReturnValueOnce(pending.promise)
    const remove = vi.spyOn(document, 'removeEventListener')
    const view = mount({}, true, true)
    expect(api.get).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(async () => { pending.resolve(revisions(99)) })
    setVisibility('hidden'); setVisibility('visible')
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })

  it('defers and coalesces hidden selection changes without mutating source selection', async () => {
    const selected = ['r1']
    const view = mount({ selected }, false)
    view.update({ selected: ['r1', 'r2'] })
    const latest = ['r2']
    view.update({ selected: latest })
    await tick(60000)
    expect(api.post).not.toHaveBeenCalled()
    view.update({}, true)
    await tick()
    expect(api.post).toHaveBeenCalledTimes(1)
    expect([...view.result.current.linkedCategoryIds]).toEqual(['b'])
    expect(selected).toEqual(['r1']); expect(latest).toEqual(['r2'])
    view.update({ selected: [] }, false)
    expect(view.result.current.linkedCategoryIds.size).toBe(0)
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid visible selection updates while an export is pending', async () => {
    const pending = deferred()
    vi.mocked(api.post).mockReturnValueOnce(pending.promise)
    const view = mount({ selected: ['r1'] })
    for (let i = 0; i < 30; i++) view.update({ selected: i % 2 ? ['r2'] : ['r1', 'r2'] })
    expect(api.post).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(members([['old', 'r1']], 5000)) })
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.post).mock.calls.map(([, body]) => (body as any).offset)).toEqual([0, 0])
    expect([...view.result.current.linkedCategoryIds]).toEqual(['b'])
  })

  it.each(['hide', 'result', 'dataset', 'clear', 'unmount'])('stops membership pagination after %s and ignores its stale completion', async change => {
    const pending = deferred()
    vi.mocked(api.post).mockReturnValueOnce(pending.promise)
    const view = mount({ selected: ['r1'] })
    if (change === 'hide') view.update({}, false)
    else if (change === 'result') view.update({ result: model('fit-2'), selected: ['r2'] })
    else if (change === 'dataset') view.update({ datasetId: 'next', result: model('fit-2', 'next'), selected: ['r2'] })
    else if (change === 'clear') view.update({ selected: [] })
    else view.unmount()
    await act(async () => { pending.resolve(members([['old', 'r1']], 5000)) })
    expect(vi.mocked(api.post).mock.calls.every(([, body]) => (body as any).offset === 0)).toBe(true)
    const refreshed = change === 'result' || change === 'dataset'
    expect(api.post).toHaveBeenCalledTimes(refreshed ? 2 : 1)
    expect([...view.result.current.linkedCategoryIds]).toEqual(refreshed ? ['b'] : [])
  })

  it('combines export pages and recovers from failure on the next activation', async () => {
    vi.mocked(api.post).mockResolvedValueOnce(members([['a', 'r1']], 5000)).mockResolvedValueOnce(members([['b', 'r1']]))
    const view = mount({ selected: ['r1'] })
    await tick()
    expect([...view.result.current.linkedCategoryIds]).toEqual(['a', 'b'])
    view.update({}, false)
    vi.mocked(api.post).mockRejectedValueOnce(new Error('export failed'))
    view.update({}, true)
    await tick()
    expect(view.result.current.linkedCategoryIds.size).toBe(0)
    view.update({}, false); view.update({}, true)
    await tick()
    expect([...view.result.current.linkedCategoryIds]).toEqual(['a'])
  })

  it('cannot build a polling backlog behind a long fit in the real serialized worker queue', async () => {
    const enqueue = createSerialQueue()
    const fit = deferred()
    const finishedFit = enqueue(() => fit.promise)
    const handled = vi.fn(async () => revisions())
    vi.mocked(api.get).mockImplementation(() => enqueue(handled) as any)
    const ca = mount(), mca = mount(), famd = mount()
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(3)
    expect(handled).not.toHaveBeenCalled()
    ca.update({}, false); mca.update({}, false); famd.update({}, false)
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(3)
    await act(async () => { fit.resolve(undefined); await finishedFit })
    expect(handled).toHaveBeenCalledTimes(3)
    await tick(60000)
    expect(api.get).toHaveBeenCalledTimes(3)
    expect(ca.result.current.liveRevisions).toBeNull()
    ca.update({}, true)
    await tick()
    expect(api.get).toHaveBeenCalledTimes(4)
    expect(ca.result.current.liveRevisions).toEqual({ data: 1, schema: 1 })
  })
})
