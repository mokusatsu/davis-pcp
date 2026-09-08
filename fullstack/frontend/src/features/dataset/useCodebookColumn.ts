import { useCallback, useMemo } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import type { CodebookColumn } from '../../api/client'

const EMPTY_COLUMNS: CodebookColumn[] = []

export function normalizeCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' && !Number.isFinite(raw)) return null
  if (typeof raw === 'string') return raw
  return String(raw)
}

export function useCodebook() {
  const codebook = useSelector((s: RootState) => s.codebook)
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  const columns = useMemo(() => {
    if (!datasetId || codebook.datasetId !== datasetId) return EMPTY_COLUMNS
    return codebook.columns
  }, [codebook.datasetId, codebook.columns, datasetId])

  const columnMap = useMemo(() => {
    const map = new Map<string, CodebookColumn>()
    for (const col of columns) {
      map.set(col.name, col)
      map.set(col.columnId, col)
    }
    return map
  }, [columns])

  const getColumn = useCallback(
    (nameOrId: string): CodebookColumn | undefined => {
      return columnMap.get(nameOrId)
    },
    [columnMap]
  )

  const formatValueLabel = useCallback(
    (nameOrId: string, rawVal: unknown): string => {
      const code = normalizeCode(rawVal)
      if (code === null) return '(欠損)'
      const col = columnMap.get(nameOrId)
      if (!col || !col.valueLabels) return code
      return col.valueLabels[code] ?? code
    },
    [columnMap]
  )

  const getOrderedCategories = useCallback(
    (nameOrId: string, observedCategories?: unknown[]): string[] => {
      const col = columnMap.get(nameOrId)
      const normalizedObserved = Array.from(
        new Set(
          (observedCategories ?? [])
            .map(normalizeCode)
            .filter((code): code is string => code !== null)
        )
      )

      if (!col) return normalizedObserved

      const missingSet = new Set(col.missingCodes ?? [])
      const ordered = [
        ...(col.categoryOrder?.length ? col.categoryOrder : Object.keys(col.valueLabels ?? {}))
          .map(normalizeCode)
          .filter((code): code is string => code !== null && !missingSet.has(code)),
        ...normalizedObserved.filter((code) => !missingSet.has(code)),
      ]

      const seen = new Set<string>()
      const result = ordered.filter((code) => {
        if (seen.has(code)) return false
        seen.add(code)
        return true
      })

      return col.isReversed ? [...result].reverse() : result
    },
    [columnMap]
  )

  return {
    columns,
    schemaRevision: codebook.schemaRevision,
    getColumn,
    formatValueLabel,
    getOrderedCategories,
    isLoading: codebook.isLoading,
  }
}

export function useCodebookColumn(nameOrId: string) {
  const { getColumn, getOrderedCategories, formatValueLabel } = useCodebook()
  const spec = getColumn(nameOrId)

  const getLabel = useCallback(
    (rawVal: unknown): string => {
      return formatValueLabel(nameOrId, rawVal)
    },
    [formatValueLabel, nameOrId]
  )

  const getTickLabels = useCallback(
    (observedCategories?: unknown[]) => {
      return getOrderedCategories(nameOrId, observedCategories).map((code) => ({ value: code, label: formatValueLabel(nameOrId, code) }))
    },
    [formatValueLabel, getOrderedCategories, nameOrId]
  )

  return useMemo(() => ({
    spec,
    getLabel,
    getTickLabels,
  }), [getLabel, getTickLabels, spec])
}
