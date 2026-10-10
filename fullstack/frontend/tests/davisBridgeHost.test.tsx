// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://davis.example.test/"}
import { webcrypto } from 'node:crypto'
import { StrictMode } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { store, datasetLoaded, variablesInitialized } from '../src/app/store'
import { codebookReceived } from '../src/features/dataset/codebookSlice'
import type { CodebookColumn } from '../src/api/client'
import * as caBridge from '../src/features/models/caControllerBridge'
import DavisBridgeHost, { installDavisBridge } from '../src/integrations/siwc/DavisBridgeHost'
import { CHANNEL } from '../src/integrations/siwc/sdk/page-bridge.js'

const disposers: Array<() => void> = []
const storeListeners = new Set<() => void>(), controllerListeners = new Set<() => void>()
function routerPort() {
  let path = '/pcp'
  const listeners = new Set<() => void>()
  return { listeners, getPath: () => path,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    navigate: vi.fn((next: string) => { path = next; for (const listener of [...listeners]) listener() }) }
}
function send(id: string, method = 'snapshot', payload?: unknown) {
  window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin,
    data: { channel: CHANNEL, direction: 'to-page', id, method, payload } }))
}
const meta = () => document.querySelectorAll('meta[name="siwc-bridge"]')

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  const columns: CodebookColumn[] = ['A', 'B'].map((name, index) => ({ columnId: `id-${index}`, name, label: name,
    scaleType: 'nominal', role: 'question', valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null }))
  store.dispatch(datasetLoaded({ datasetId: 'dataset', name: 'Dataset', rowIds: ['PRIVATE_ROW'], dataRevision: 1 }))
  store.dispatch(variablesInitialized({ datasetId: 'dataset', variables: ['A', 'B'], meta: Object.fromEntries(columns.map(c => [c.name,
    { name: c.name, columnId: c.columnId, semanticType: 'nominal', physicalType: 'string', missingCount: 0, isTargetCandidate: true }])) }))
  store.dispatch(codebookReceived({ datasetId: 'dataset', schemaRevision: 1, columns }))
  const subscribeStore = store.subscribe.bind(store)
  vi.spyOn(store, 'subscribe').mockImplementation(listener => {
    const unsubscribe = subscribeStore(listener)
    storeListeners.add(listener)
    return () => { storeListeners.delete(listener); unsubscribe() }
  })
  const subscribeController = caBridge.subscribeCaController
  vi.spyOn(caBridge, 'subscribeCaController').mockImplementation(listener => {
    const unsubscribe = subscribeController(listener)
    controllerListeners.add(listener)
    return () => { controllerListeners.delete(listener); unsubscribe() }
  })
})
afterEach(() => {
  cleanup()
  disposers.splice(0).reverse().forEach(dispose => dispose())
  expect(storeListeners.size).toBe(0)
  expect(controllerListeners.size).toBe(0)
  document.querySelectorAll('meta[name="siwc-bridge"],meta[name="siwc-bridge-app"]').forEach(node => node.remove())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('DAVIS bridge app lifecycle', () => {
  it('registers only after readiness and cleans up when readiness is removed', async () => {
    const router = routerPort(), post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const view = render(<DavisBridgeHost store={store} router={router} enabled={false} />)
    expect(meta()).toHaveLength(0)
    expect(storeListeners.size).toBe(0)
    send('before-ready')
    expect(post).not.toHaveBeenCalled()
    view.rerender(<DavisBridgeHost store={store} router={router} enabled />)
    expect(meta()).toHaveLength(1)
    expect(storeListeners.size).toBe(1)
    expect(controllerListeners.size).toBe(1)
    expect(router.listeners.size).toBe(1)
    send('ready')
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][0]).toMatchObject({ id: 'ready', ok: true, value: { protocol: 1, contractRevision: 2, workflow: null } })
    expect(post.mock.calls[0][0].value.context).not.toHaveProperty('pendingAnalysis')
    expect(post.mock.calls[0][0].value.commands.filter((command: { workflowRole?: string }) => command.workflowRole)
      .map((command: { workflowRole: string }) => command.workflowRole)).toEqual(['prepare', 'resume', 'run', 'cancel'])
    view.rerender(<DavisBridgeHost store={store} router={router} enabled={false} />)
    expect(meta()).toHaveLength(0)
    expect(storeListeners.size).toBe(0)
    expect(controllerListeners.size).toBe(0)
    expect(router.listeners.size).toBe(0)
    send('after-disabled')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps local HTTP usable without registering the HTTPS-only transport', () => {
    vi.stubGlobal('location', { protocol: 'http:', origin: 'http://davis.example.test' })
    const router = routerPort()
    render(<DavisBridgeHost store={store} router={router} enabled />)
    expect(meta()).toHaveLength(0)
    expect(storeListeners.size).toBe(0)
    expect(controllerListeners.size).toBe(0)
    expect(router.listeners.size).toBe(0)
  })

  it('has one live registration under StrictMode and removes it on unmount', async () => {
    const router = routerPort(), post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const view = render(<StrictMode><DavisBridgeHost store={store} router={router} enabled /></StrictMode>)
    expect(store.subscribe).toHaveBeenCalledTimes(2)
    expect(storeListeners.size).toBe(1)
    expect(controllerListeners.size).toBe(1)
    expect(router.listeners.size).toBe(1)
    expect(meta()).toHaveLength(1)
    send('strict-snapshot')
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(meta()).toHaveLength(0)
    expect(storeListeners.size).toBe(0)
    expect(router.listeners.size).toBe(0)
    act(() => { window.dispatchEvent(new Event('pageshow')) })
    expect(meta()).toHaveLength(0)
    send('after-unmount')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('tears down on pagehide and creates one fresh bridge on repeated pageshow', async () => {
    const router = routerPort(), post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    render(<DavisBridgeHost store={store} router={router} enabled />)
    send('first')
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const firstRevision = post.mock.calls[0][0].value.revision
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(meta()).toHaveLength(0)
    expect(storeListeners.size).toBe(0)
    expect(controllerListeners.size).toBe(0)
    expect(router.listeners.size).toBe(0)
    send('hidden')
    expect(post).toHaveBeenCalledTimes(1)
    act(() => { window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('pageshow')) })
    expect(meta()).toHaveLength(1)
    expect(storeListeners.size).toBe(1)
    expect(controllerListeners.size).toBe(1)
    expect(router.listeners.size).toBe(1)
    send('fresh')
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1][0].value.revision).not.toBe(firstRevision)
  })

  it('pagehide aborts a pending page-readiness wait and suppresses its late wire reply', async () => {
    const router = routerPort(), post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    render(<DavisBridgeHost store={store} router={router} enabled />)
    send('snapshot')
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const snapshot = post.mock.calls[0][0].value
    send('pending-prepare', 'execute', { snapshotId: snapshot.snapshotId, schemaHash: snapshot.schemaHash, revision: snapshot.revision,
      planId: 'host_pending_plan_id', runId: 'host_pending_run_id', expiresAt: Date.now() + 10000,
      plan: { kind: 'commands', message: 'Prepare CA', commands: [{ op: 'analysis.prepare', args: { method: 'correspondence', answers: [] } }] } })
    await waitFor(() => expect(controllerListeners.size).toBe(2))
    await act(async () => { window.dispatchEvent(new Event('pagehide')); await Promise.resolve() })
    expect(controllerListeners.size).toBe(0)
    expect(storeListeners.size).toBe(0)
    expect(post).toHaveBeenCalledTimes(1)
    await act(async () => { window.dispatchEvent(new Event('pageshow')); await Promise.resolve() })
    send('fresh-snapshot')
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1][0]).toMatchObject({ id: 'fresh-snapshot', value: { contractRevision: 2, workflow: null } })
    expect(post.mock.calls[1][0].value.context).not.toHaveProperty('pendingAnalysis')
  })

  it('cleans subscriptions if protocol registration fails and allows a later clean install', () => {
    const router = routerPort()
    for (let index = 0; index < 2; index++) {
      const element = document.createElement('meta'); element.name = 'siwc-bridge'; document.head.append(element)
    }
    expect(() => installDavisBridge(store, router)).toThrow('DUPLICATE_META')
    expect(storeListeners.size).toBe(0)
    expect(controllerListeners.size).toBe(0)
    expect(router.listeners.size).toBe(0)
    meta().forEach(element => element.remove())
    const dispose = installDavisBridge(store, router)
    disposers.push(dispose)
    expect(meta()).toHaveLength(1)
    dispose(); dispose()
    expect(meta()).toHaveLength(0)
    expect(storeListeners.size).toBe(0)
    expect(controllerListeners.size).toBe(0)
    expect(router.listeners.size).toBe(0)
  })
})
