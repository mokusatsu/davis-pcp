import { apiErrorFromResponse } from '../api/apiError'
/**
 * Client RPC bridge to the Pyodide Web Worker.
 * Provides transparent replacements for HTTP fetch / upload / Arrow streaming.
 */
import type { ApiError } from '../api/client'

export interface WasmStatus {
  stage: 'idle' | 'loading_runtime' | 'mounting_fs' | 'loading_packages' | 'loading_pure_wheels' | 'loading_backend' | 'starting_app' | 'ready' | 'error'
  progress: number
  message: string
}

type StatusListener = (status: WasmStatus) => void

class PyodideClient {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>()
  private statusListeners = new Set<StatusListener>()
  private currentStatus: WasmStatus = { stage: 'idle', progress: 0, message: '初期化待機中' }
  private initPromise: Promise<void> | null = null
  private runtimeError: Error | null = null

  constructor() {
    // Worker is lazily created on init() or first request
  }

  public getStatus(): WasmStatus {
    return this.currentStatus
  }

  public onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    listener(this.currentStatus)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  private notifyStatus(status: WasmStatus) {
    this.currentStatus = status
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch (e) {
        console.error('Status listener error:', e)
      }
    }
  }

  private failRuntime(error: Error) {
    this.runtimeError = error
    const worker = this.worker
    this.worker = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    this.notifyStatus({ stage: 'error', progress: 0, message: error.message })
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  public init(): Promise<void> {
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        // Instantiate Pyodide worker
        this.worker = new Worker(
          new URL('./pyodide.worker.ts', import.meta.url),
          { type: 'module' },
        )

        this.worker.onmessage = (e: MessageEvent) => {
          const msg = e.data
          if (msg.type === 'STATUS') {
            this.notifyStatus({
              stage: msg.stage,
              progress: msg.progress,
              message: msg.message,
            })
            if (msg.stage === 'ready') {
              resolve()
            } else if (msg.stage === 'error') {
              const error = new Error(msg.message)
              this.failRuntime(error)
              reject(error)
            }
          } else if (msg.type === 'RESPONSE') {
            const p = this.pending.get(msg.id)
            if (!p) return
            this.pending.delete(msg.id)

            if (msg.status >= 200 && msg.status < 300) {
              p.resolve(msg.data)
            } else {
              const err: ApiError = msg.error || apiErrorFromResponse(msg.data, msg.status)
              p.reject(err)
            }
          }
        }

        this.worker.onerror = (err) => {
          console.error('Pyodide Worker uncaught error:', err)
          const error = new Error(`Workerエラー: ${err.message}`)
          this.failRuntime(error)
          reject(error)
        }

        this.worker.onmessageerror = () => {
          const error = new Error('Worker応答を読み取れませんでした')
          this.failRuntime(error)
          reject(error)
        }

        // Determine base URL for pyodide assets (relative to page)
        const baseUrl = new URL('./pyodide/', window.location.href).href
        this.worker.postMessage({
          type: 'INIT',
          pyodideBaseUrl: baseUrl,
        })
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.failRuntime(error)
        reject(error)
      }
    })

    return this.initPromise
  }

  public async waitForReady(): Promise<void> {
    if (!this.initPromise) {
      await this.init()
    } else {
      await this.initPromise
    }
    if (this.runtimeError) throw this.runtimeError
  }

  private send<T>(id: number, message: unknown, transfer: Transferable[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.runtimeError || !this.worker) {
        reject(this.runtimeError ?? new Error('Pyodide worker unavailable'))
        return
      }
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage(message, transfer)
      } catch (error) {
        // A failed clone/send owns no live worker request. Do not retain its
        // callbacks, and do not kill unrelated queued analyses for bad input.
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  public async request<T>(path: string, init?: RequestInit): Promise<T> {
    await this.waitForReady()

    const id = this.nextId++
    const method = init?.method || 'GET'
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers as any
      if (typeof h.entries === 'function') {
        for (const [k, v] of h.entries()) headers[k] = v
      } else if (typeof h === 'object') {
        Object.assign(headers, h)
      }
    }

    let body: string | ArrayBuffer | undefined
    if (init?.body) {
      if (typeof init.body === 'string') {
        body = init.body
      } else if (init.body instanceof ArrayBuffer) {
        body = init.body
      } else if (init.body instanceof Uint8Array) {
        body = init.body.buffer as ArrayBuffer
      }
    }

    return this.send<T>(id, { type: 'REQUEST', id, method, path, headers, body })
  }

  public async upload<T>(path: string, file: File, extra: Record<string, string> = {}): Promise<T> {
    await this.waitForReady()

    const id = this.nextId++
    const arrayBuffer = await file.arrayBuffer()
    if (this.runtimeError) throw this.runtimeError

    return this.send<T>(id, {
      type: 'REQUEST', id, method: 'POST', path,
      filePayload: { filename: file.name, data: arrayBuffer, extra },
    }, [arrayBuffer])
  }

  public async fetchArrowView(
    datasetId: string,
    columns?: string[],
    rowIds?: string[],
    options?: { maAxes?: { key: string; kind: 'maOption' | 'maCount'; groupId: string; columnId?: string }[]; expectedSchemaRevision?: number; expectedDataRevision?: number },
  ): Promise<Record<string, unknown[]>> {
    await this.waitForReady()

    const rawBuffer = await this.request<ArrayBuffer>(`/datasets/${datasetId}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns, rowIds, ...options }),
    })

    const { tableFromIPC } = await import('apache-arrow')
    const table = tableFromIPC(rawBuffer)
    const result: Record<string, unknown[]> = {}
    for (const column of table.schema.fields) {
      result[column.name] = Array.from(table.getChild(column.name) ?? [])
    }
    return result
  }

  public async downloadExport(
    datasetId: string,
    scope: 'selected' | 'active' | 'all',
    format: 'csv' | 'parquet' | 'arrow' | 'xlsx',
    rowIds?: string[],
    useValueLabels = false,
  ) {
    await this.waitForReady()

    const data = await this.request<any>('/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasetId, scope, format, rowIds, useValueLabels }),
    })

    let blob: Blob
    if (data instanceof ArrayBuffer) {
      blob = new Blob([data], { type: 'application/octet-stream' })
    } else if (typeof data === 'string') {
      blob = new Blob([data], { type: 'text/csv;charset=utf-8;' })
    } else {
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    }

    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `export.${format}`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export const pyodideClient = new PyodideClient()
