/// <reference lib="webworker" />
import { hitRows, type Rect, type HitMode } from '../features/pcp/brush'

interface BrushRequest {
  type: 'brush'
  requestId: number
  rect: Rect
  mode: HitMode
  activeIds: string[]
  points: Record<string, { x: number; y: number }[]>
}

export interface BrushResponse {
  type: 'brushResult'
  requestId: number
  hits: string[]
}

self.onmessage = (event: MessageEvent<BrushRequest>) => {
  const message = event.data
  if (message.type !== 'brush') return
  const pointsById = new Map(Object.entries(message.points))
  const hits = hitRows(pointsById, message.activeIds, message.rect, message.mode)
  const response: BrushResponse = { type: 'brushResult', requestId: message.requestId, hits }
  self.postMessage(response)
}

export {}
