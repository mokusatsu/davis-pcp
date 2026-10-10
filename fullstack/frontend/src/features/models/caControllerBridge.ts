import type { AnalysisScopeSnapshot } from '../selection/analysisScope'
import type { CAContext } from './caApi'
import type { MapScaling } from './caMap'
import type { CAResponse } from './caTypes'

/** These are the ordinary page's column names. The bridge resolves stable IDs first. */
export interface CorrespondenceSetup {
  inputKind: 'respondents' | 'contingency'
  rowVar: string | null
  colVar: string | null
  rowLabelCol: string | null
  valueCols: string[]
  cellSemantics: 'frequency' | 'mass'
  ack: boolean
  mapScaling: MapScaling
  missingPolicy: 'exclude' | 'include_missing' | 'separate_not_applicable'
  weightChoice: 'dataset' | 'none'
}

export type CorrespondenceConfiguration = Partial<Omit<CorrespondenceSetup, 'ack'>>
export interface CorrespondenceCompleted {
  result: CAResponse
  context: CAContext
  snapshot: AnalysisScopeSnapshot
}
export interface CorrespondenceInspection {
  datasetId: string | null
  dataRevision: number
  schemaRevision: number
  /** Internal only: contains row membership. */
  scopeKey: string
  setup: CorrespondenceSetup
  ready: boolean
  canRun: boolean
  loading: boolean
  error: string | null
  completed: CorrespondenceCompleted | null
  draftKey: string
  /** Internal source identity. Contains row membership; never send it to an LLM. */
  inputContextKey: string
}
export interface CorrespondenceRunOptions {
  signal?: AbortSignal
  /** Synchronous final ownership check, immediately before normal-page publication. */
  beforeCommit?: (completed: CorrespondenceCompleted) => boolean
}
export interface CorrespondenceController {
  inspect(): CorrespondenceInspection
  configure(patch: CorrespondenceConfiguration): CorrespondenceInspection
  run(options?: CorrespondenceRunOptions): Promise<CorrespondenceCompleted>
  subscribe(listener: () => void): () => void
}

let current: CorrespondenceController | null = null
const listeners = new Set<() => void>()
const changed = () => { for (const listener of [...listeners]) listener() }

export function getCaController(): CorrespondenceController | null { return current }
/** Receives mount/unmount and ordinary page-controller changes. */
export function subscribeCaController(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Owned by the normal page, including its KeepAlive lifetime. */
export function registerCaController(controller: CorrespondenceController): () => void {
  current = controller
  const unsubscribe = controller.subscribe(() => { if (current === controller) changed() })
  changed()
  return () => {
    unsubscribe()
    if (current === controller) { current = null; changed() }
  }
}

export function waitForCaController(signal?: AbortSignal): Promise<CorrespondenceController> {
  const cancelled = () => Object.assign(new Error('CA controller wait cancelled'), { code: 'CANCELLED' })
  if (signal?.aborted) return Promise.reject(cancelled())
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const finish = () => { unsubscribe(); signal?.removeEventListener('abort', abort) }
    const abort = () => { finish(); reject(cancelled()) }
    const unsubscribe = subscribeCaController(() => {
      if (current) { const controller = current; finish(); resolve(controller) }
    })
    signal?.addEventListener('abort', abort, { once: true })
  })
}
