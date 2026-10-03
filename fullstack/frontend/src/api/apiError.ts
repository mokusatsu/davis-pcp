import type { ApiError } from './client'

/** Preserve business errors; translate FastAPI validation errors without copying
 * request values, validator context, or free-form messages into UI/log state. */
export function apiErrorFromResponse(body: unknown, status: number): ApiError {
  const fallback: ApiError = { code: 'HTTP_ERROR', message: `HTTP ${status}`, details: {}, recoverable: true, suggestedActions: [] }
  if (!body || typeof body !== 'object') return fallback
  const response = body as { error?: ApiError; detail?: unknown }
  if (response.error) return response.error
  if (!Array.isArray(response.detail)) return fallback
  const fieldErrors: Record<string, string> = Object.create(null)
  for (const detail of response.detail) {
    if (!detail || typeof detail !== 'object') continue
    const item = detail as { loc?: unknown; type?: unknown }
    if (!Array.isArray(item.loc)) continue
    const path = item.loc.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      .filter(part => part !== 'body' && part !== 'query' && part !== 'path')
    const field = path.join('.') || '入力'
    const reason = typeof item.type === 'string' && item.type.startsWith('int_') ? '整数で入力してください。'
      : item.type === 'greater_than_equal' ? '指定可能な下限以上の値を入力してください。'
        : item.type === 'less_than_equal' ? '指定可能な上限以下の値を入力してください。'
          : item.type === 'missing' ? '入力が必要です。'
            : '入力形式または許容範囲を確認してください。'
    fieldErrors[field] = reason
  }
  if (!Object.keys(fieldErrors).length) return fallback
  return { code: 'VALIDATION_ERROR', message: Object.entries(fieldErrors).map(([field, reason]) => `${field}: ${reason}`).join(' '),
    details: { fieldErrors }, recoverable: true, suggestedActions: ['該当する入力欄を修正して再試行してください。'] }
}
