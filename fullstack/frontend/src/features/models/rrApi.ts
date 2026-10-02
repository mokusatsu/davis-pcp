import { api } from '../../api/client'
import type { RRArtifact, RRContext, RRExportResponse, RRFitRow, RRLanguage, RRPage, RRPredictResponse, RRPredictRow, RRRequest, RRResponse } from './rrTypes'

export function runRegularizedRegression(request: RRRequest): Promise<RRResponse> {
  return api.post<RRResponse>('/models/regularized-regression', request)
}
export function fetchRegularizedRows(resultId: string, offset: number, limit: number): Promise<RRPage<RRFitRow>> {
  return api.get(`/analysis-results/${encodeURIComponent(resultId)}/rows?${new URLSearchParams({ offset: String(offset), limit: String(limit) })}`)
}
export function predictRegularizedRegression(resultId: string, context: RRContext, evaluate: boolean): Promise<RRPredictResponse> {
  return api.post(`/analysis-results/${encodeURIComponent(resultId)}/predict`, { context, options: { interval: 'none', evaluate } })
}
export function fetchRegularizedPredictions(resultId: string, predictionId: string, offset: number, limit: number): Promise<RRPage<RRPredictRow>> {
  return api.get(`/analysis-results/${encodeURIComponent(resultId)}/predictions/${encodeURIComponent(predictionId)}/rows?${new URLSearchParams({ offset: String(offset), limit: String(limit) })}`)
}
/** Only the persisted identity is accepted; draft fit settings never enter an export request. */
export function exportRegularizedPredict(resultId: string, language: RRLanguage, artifact: RRArtifact, expectedModelVersion: '1'): Promise<RRExportResponse> {
  return api.post(`/analysis-results/${encodeURIComponent(resultId)}/export-predict`, { language, artifact, expectedModelVersion })
}
/** Call only after checking that the result is still the requested export source. */
export function downloadRegularizedArtifact(artifact: RRExportResponse): void {
  let body: BlobPart
  if (artifact.encoding === 'base64') {
    body = Uint8Array.from(atob(artifact.payload), character => character.charCodeAt(0))
  } else if (artifact.encoding === 'utf-8') {
    body = artifact.payload
  } else {
    throw new Error('未対応のエクスポート形式です。')
  }
  const url = URL.createObjectURL(new Blob([body], { type: artifact.mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = artifact.fileName
  document.body.appendChild(anchor)
  try { anchor.click() } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}
