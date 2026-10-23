import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'

export interface LogisticTargetRequest {
  datasetId: string | null
  targetColumns: string[]
  featureColumns: string[]
  activeRowIds: string[]
  expectedDataRevision: number
  expectedSchemaRevision: number
}
export interface LogisticTargetEligibility {
  name: string
  classCount: number | null
  eligible: boolean
  reason?: string | null
}

/** Class counts use the model's server-side preparation, not display/raw values. */
export function useLogisticTargetEligibility(request: LogisticTargetRequest) {
  const key = JSON.stringify(request)
  const currentKey = useRef(key)
  currentKey.current = key
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    key: string; attempt: number; targets: LogisticTargetEligibility[]; error: string | null
  } | null>(null)
  const needed = !!request.datasetId && request.targetColumns.length > 0
  useEffect(() => {
    if (!needed) return
    let cancelled = false
    const body = JSON.parse(key) as LogisticTargetRequest
    api.post<{ targets: LogisticTargetEligibility[] }>('/models/logistic/targets', body).then(response => {
      if (!cancelled && currentKey.current === key) setResult({ key, attempt, targets: response.targets, error: null })
    }).catch((error: unknown) => {
      if (!cancelled && currentKey.current === key) setResult({ key, attempt, targets: [],
        error: error instanceof Error ? error.message : (error as { message?: string })?.message ?? 'クラス数の確認に失敗しました。' })
    })
    return () => { cancelled = true }
  }, [key, needed, attempt])
  const current = result?.key === key && result.attempt === attempt ? result : null
  return {
    targets: current?.targets ?? [],
    loading: needed && !current,
    ready: !needed || (!!current && !current.error),
    error: current?.error ?? null,
    retry: () => setAttempt(value => value + 1),
  }
}
