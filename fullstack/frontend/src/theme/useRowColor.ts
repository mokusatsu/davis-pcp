import { l1Index, useL1ColorDomains } from './useL1ColorDomain'
import { useMemo } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../app/store'
import { useColumnarData, type ColumnarData } from '../features/pcp/useDatasetColumns'
import { composedColor, l1Color, vizTheme, SELECTION, CONTEXT_LINE } from './viz'

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
export function useRowColorResolver(source?: ColumnarData | null): RowColorResolver {
  const selection = useSelector((s: RootState) => s.selection)
  const pcp = useSelector((s: RootState) => s.pcp)
  const loaded = useColumnarData(source === undefined ? selection.datasetId : null, pcp.colorBy ? [pcp.colorBy] : [])
  const data = source === undefined ? loaded : source
  const theme = useMemo(() => vizTheme(false), [])

  const domains = useL1ColorDomains(data)
  const domain = domains.find(d => d.key === pcp.colorBy)
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

    const values = colorKey && data ? data.columns[colorKey] ?? [] : []

    const selectedSet = new Set(selection.selectedRowIds)

    const getColor = (rowId: string, rowIndex?: number): string => {
      let rIndex = rowIndex
      if (rIndex === undefined && data) {
        rIndex = data.rowIndex.get(rowId)
      }

      let l1: string | null = null
      if (colorKey && data && rIndex !== undefined) {
        const catIndex = l1Index(domain, values[rIndex])
        if (catIndex !== null) {
          l1 = l1Color(theme, catIndex)
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
  }, [selection.datasetId, selection.selectedRowIds, selection.groups, selection.l2ColorEnabled, pcp.colorBy, data, colorKey, l2Enabled, theme, domain])
}
