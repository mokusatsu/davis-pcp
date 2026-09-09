import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../app/store'
import { api } from '../api/client'
import type { CodebookColumn } from '../api/client'
import type { ColumnarData } from '../features/pcp/useDatasetColumns'
import { normalizeCode, useCodebook } from '../features/dataset/useCodebookColumn'

export interface L1ColorDomain {
  key: string
  codes: string[]
  indexByCode: Map<string, number>
  entropy?: number
}

export function buildL1Domains(data: ColumnarData, columns: CodebookColumn[] = []): L1ColorDomain[] {
  const specs = new Map(columns.map(c => [c.name, c]))
  const result: L1ColorDomain[] = []
  for (const column of data.schema) {
    const spec = specs.get(column.name)
    const missing = new Set(spec?.missingCodes ?? [])
    const observed = new Set<string>()
    for (const raw of data.columns[column.name] ?? []) {
      const code = normalizeCode(raw)
      if (code === null || missing.has(code)) continue
      observed.add(code)
      if (observed.size > 20) break
    }
    if (!observed.size || observed.size > 20) continue
    const sorted = [...observed].sort((a, b) => {
      const delta = column.semanticType === 'numeric' ? Number(a) - Number(b) : 0
      return (Number.isFinite(delta) && delta !== 0 ? delta : a.localeCompare(b, 'en', { numeric: true })) || (a < b ? -1 : a > b ? 1 : 0)
    })
    const codes = [...new Set([...(spec?.categoryOrder ?? []).filter(c => observed.has(c)), ...sorted])]
    result.push({ key: column.name, codes, indexByCode: new Map(codes.map((c, i) => [c, i])) })
  }
  return result
}

export function useL1ColorDomains(data: ColumnarData | null): L1ColorDomain[] {
  const { columns } = useCodebook()
  return useMemo(() => {
    if (!data) return []
    const cached = domainCache.get(data)
    if (cached?.columns === columns) return cached.domains
    const domains = buildL1Domains(data, columns)
    domainCache.set(data, { columns, domains })
    return domains
  }, [data, columns])
}

const domainCache = new WeakMap<ColumnarData, { columns: CodebookColumn[]; domains: L1ColorDomain[] }>()

const datasetDomains = new Map<string, Promise<L1ColorDomain[]>>()

/** Full-dataset color levels stay available even when the plot projects only a few axes. */
export function useDatasetL1ColorDomains(datasetId: string | null): L1ColorDomain[] | null {
  const { schemaRevision, columns } = useCodebook()
  const dataRevision = useSelector((state: RootState) => state.selection.dataRevision)
  const key = JSON.stringify([datasetId, dataRevision, schemaRevision])
  const [state, setState] = useState<{ key: string; domains: L1ColorDomain[] } | null>(null)
  useEffect(() => {
    if (!datasetId || !columns.length) return
    let current = true
    let request = datasetDomains.get(key)
    if (!request) {
      request = api.post<{ domains: { key: string; codes: string[]; counts: number[]; numeric: boolean }[] }>(`/datasets/${datasetId}/color-domains`, {
        expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision,
      }).then(result => result.domains.map(domain => {
        const observed = new Set(domain.codes)
        const sorted = [...domain.codes].sort((a, b) => {
          const delta = domain.numeric ? Number(a) - Number(b) : 0
          return (Number.isFinite(delta) && delta !== 0 ? delta : a.localeCompare(b, 'en', { numeric: true })) || (a < b ? -1 : a > b ? 1 : 0)
        })
        const codes = [...new Set([...(columns.find(column => column.name === domain.key)?.categoryOrder ?? []).filter(code => observed.has(code)), ...sorted])]
        const total = domain.counts.reduce((sum, count) => sum + count, 0)
        const entropy = codes.length > 1 && total > 0
          ? -domain.counts.reduce((sum, count) => count ? sum + count / total * Math.log2(count / total) : sum, 0) / Math.log2(codes.length)
          : Infinity
        return { key: domain.key, codes, entropy, indexByCode: new Map(codes.map((code, index) => [code, index])) }
      }))
      datasetDomains.set(key, request)
      void request.catch(() => { datasetDomains.delete(key) })
    }
    void request.then(domains => { if (current) setState({ key, domains }) }).catch(() => undefined)
    return () => { current = false }
  }, [key, columns.length])
  return state?.key === key ? state.domains : null
}

export function l1Index(domain: L1ColorDomain | undefined, raw: unknown): number | null {
  const code = normalizeCode(raw)
  return code === null ? null : domain?.indexByCode.get(code) ?? null
}

export function defaultL1Column(data: ColumnarData, domains: L1ColorDomain[]): string | null {
  let best = domains[0]?.key ?? null
  let score = Infinity
  for (const domain of domains) {
    if (domain.codes.length < 2) continue
    const counts = domain.codes.map(() => 0)
    let total = 0
    for (const raw of data.columns[domain.key] ?? []) {
      const index = l1Index(domain, raw)
      if (index !== null) { counts[index]++; total++ }
    }
    if (!total) continue
    const entropy = -counts.reduce((sum, count) => count ? sum + count / total * Math.log2(count / total) : sum, 0) / Math.log2(counts.length)
    if (entropy < score) { score = entropy; best = domain.key }
  }
  return best
}
