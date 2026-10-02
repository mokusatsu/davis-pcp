import { useCallback, useEffect, useMemo, useState } from 'react'

/** Defaults are applied once per dataset. An explicit empty choice stays empty. */
export function useDatasetColumnSelection(
  datasetId: string | null,
  candidates: string[],
  defaultCount: number,
  ready: boolean,
) {
  const [choice, setChoice] = useState<{ datasetId: string | null; names: string[] } | null>(null)
  const names = choice?.datasetId === datasetId ? choice.names : candidates.slice(0, defaultCount)
  const selectedKey = JSON.stringify(ready ? names.filter(name => candidates.includes(name)) : [])
  // Identity follows membership, not the initialization/pruning bookkeeping below.
  // Otherwise an identical default choice would issue the initial request twice.
  const selected = useMemo(() => JSON.parse(selectedKey) as string[], [selectedKey])

  useEffect(() => {
    if (!ready) return
    setChoice(previous => {
      if (previous?.datasetId !== datasetId) return { datasetId, names: selected }
      if (previous.names.length === selected.length && previous.names.every((name, i) => name === selected[i])) return previous
      return { datasetId, names: selected }
    })
  }, [datasetId, ready, selected])

  const setSelected = useCallback((names: string[]) => {
    setChoice({ datasetId, names: names.filter(name => candidates.includes(name)) })
  }, [datasetId, candidates])
  return [selected, setSelected] as const
}
