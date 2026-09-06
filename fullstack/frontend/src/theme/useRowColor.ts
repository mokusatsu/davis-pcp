import { useMemo } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../app/store'
import { useColumnarData } from '../features/pcp/useDatasetColumns'
import { composedColor, entityColor, vizTheme, SELECTION, CONTEXT_LINE } from './viz'

export interface RowColorResolver {
  selectedSet: Set<string>
  colorBy: string | null
  getColor: (rowId: string, rowIndex?: number) => string
  isSelected: (rowId: string) => boolean
  selectionColor: string
  contextColor: string
}

/**
 * Shared hook that resolves row colors based on L1 (nominal scale colorBy)
 * and L2 (analytical cluster groups) per AGENTS.md rule 4.
 */
export function useRowColorResolver(): RowColorResolver {
  const selection = useSelector((s: RootState) => s.selection)
  const pcp = useSelector((s: RootState) => s.pcp)
  const data = useColumnarData(selection.datasetId)
  const theme = vizTheme(false)

  const colorKey = pcp.colorBy
  const l2Enabled = selection.l2ColorEnabled

  return useMemo(() => {
    const l2GroupOfId = new Map<string, number>()
    if (l2Enabled && selection.groups.length > 0) {
      selection.groups.forEach((group, index) => {
        group.rowIds.forEach((id) => {
          if (!l2GroupOfId.has(id)) l2GroupOfId.set(id, index)
        })
      })
    }

    const catMap = new Map<string, number>()
    const values = colorKey && data ? data.columns[colorKey] ?? [] : []
    if (colorKey && data) {
      const categories = data.categories[colorKey] ?? []
      categories.forEach((cat, i) => catMap.set(cat, i))
    }

    const selectedSet = new Set(selection.selectedRowIds)

    const getColor = (rowId: string, rowIndex?: number): string => {
      let rIndex = rowIndex
      if (rIndex === undefined && data) {
        rIndex = data.rowIndex.get(rowId)
      }

      let l1: string | null = null
      if (colorKey && data && rIndex !== undefined) {
        const val = String(values[rIndex] ?? '')
        const catIndex = catMap.get(val) ?? -1
        if (catIndex >= 0) {
          l1 = entityColor(theme, catIndex)
        }
      }

      const l2Group = l2GroupOfId.get(rowId)
      const hasL2 = l2Enabled && l2Group !== undefined

      return composedColor(theme, { l1, l2Group: hasL2 ? l2Group : null })
    }

    return {
      selectedSet,
      colorBy: colorKey,
      getColor,
      isSelected: (rowId: string) => selectedSet.has(rowId),
      selectionColor: SELECTION,
      contextColor: CONTEXT_LINE,
    }
  }, [selection.datasetId, selection.selectedRowIds, selection.groups, selection.l2ColorEnabled, pcp.colorBy, data, colorKey, l2Enabled, theme])
}
