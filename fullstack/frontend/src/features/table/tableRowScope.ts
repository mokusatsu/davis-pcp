/** Intersect shared rows without changing their order or hidden selections. */
export function projectTableRowIds(
  effectiveRowIds: string[],
  selectedRowIds: ReadonlySet<string>,
  scopeFilter: 'all' | 'selected',
  imputedRowIds: ReadonlySet<string>,
  maskFilter: 'all' | 'hasImputed' | 'noImputed',
): string[] {
  const scopedRows = scopeFilter === 'selected'
    ? effectiveRowIds.filter(id => selectedRowIds.has(id)) : effectiveRowIds
  return maskFilter === 'all' ? scopedRows : scopedRows.filter(id =>
    maskFilter === 'hasImputed' ? imputedRowIds.has(id) : !imputedRowIds.has(id))
}
