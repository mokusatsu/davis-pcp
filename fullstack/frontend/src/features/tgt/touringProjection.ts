import type { CodebookColumn } from '../../api/client'

/** Match backend code keys without changing literal string identities. */
function normalizeTourCode(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (Number.isInteger(value)) return BigInt(value).toString()
  // Python uses scientific notation below 1e-4 and pads small exponents.
  return (Math.abs(value) < 1e-4 ? value.toExponential() : String(value))
    .replace(/e([+-])(\d+)$/, (_match, sign: string, digits: string) => `e${sign}${digits.padStart(2, '0')}`)
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const REVERSED_DECIMAL = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/

function numericValue(value: unknown, reversed = false): number {
  if (typeof value === 'number' || typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return reversed ? NaN : Number(value)
  if (typeof value !== 'string') return NaN
  // Ordinary scores use Polars' strict decimal cast. Reversed scores and
  // bounds follow the backend's Python-float parsing (including separators).
  const token = reversed ? value.trim() : value
  const valid = reversed ? REVERSED_DECIMAL.test(token) : DECIMAL.test(token)
  return valid ? Number(reversed ? token.replaceAll('_', '') : token) : NaN
}

/** Full-dataset scores: scope changes must not infer new ranks or reversal bounds. */
export function touringAnalysisValues(spec: CodebookColumn, raw: readonly unknown[]) {
  const missing = new Set(spec.missingCodes ?? [])
  const validCode = (value: unknown): string | null => {
    const code = normalizeTourCode(value)
    return code === null || code.trim() === '' || missing.has(code) ? null : code
  }
  const codes = raw.map(validCode)
  const declared = spec.categoryOrder ?? []
  const closed = declared.length > 0
  const order = [...new Set(declared.map(validCode).filter((code): code is string => code !== null))]
  const domain = new Set(order)
  const accepted = codes.map(code => code !== null && (!closed || domain.has(code)) ? code : null)
  if (spec.scaleType === 'ordinal') {
    const categories = closed ? order : [...new Set([
      ...Object.keys(spec.valueLabels ?? {}).map(validCode), ...codes,
    ].filter((code): code is string => code !== null))]
    const ordered = spec.isReversed ? [...categories].reverse() : categories
    const scores = new Map(ordered.map((code, index) => [code, index + 1]))
    return { values: accepted.map(code => code === null ? NaN : scores.get(code) ?? NaN), error: null }
  }
  const values = accepted.map((code, index) => code === null ? NaN : numericValue(raw[index], spec.isReversed))
  if (!spec.isReversed) return { values, error: null }
  const bounds = order.map(code => numericValue(code, true)).filter(Number.isFinite)
  if (!bounds.length) return { values: raw.map(() => NaN),
    error: `${spec.label || spec.name}: 逆転にはコードブックで固定の尺度範囲（categoryOrder）を指定してください。` }
  const minimum = Math.min(...bounds), maximum = Math.max(...bounds)
  const sum = minimum + maximum
  // Preserve ordinary backend arithmetic; avoid an overflowing sum when
  // both finite endpoints have the same sign and enormous magnitudes.
  return { values: values.map(value => Number.isFinite(value)
    ? Number.isFinite(sum) ? sum - value
      : minimum >= 0 ? maximum - (value - minimum) : minimum + (maximum - value)
    : NaN), error: null }
}
