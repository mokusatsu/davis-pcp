import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import { api } from '../../../api/client'
import { selectOrdinaryVariables, type RootState } from '../../../app/store'

/** Refresh metadata for each dataset generation, including cached inactive
 * pages. Defaults apply once per dataset; revisions only prune invalid inputs. */
export function useNumericModelInputs() {
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const codebookDatasetId = useSelector((s: RootState) => s.codebook.datasetId)
  const globalVars = useSelector(selectOrdinaryVariables)
  const identity = JSON.stringify([datasetId, dataRevision, schemaRevision])
  const [metadata, setMetadata] = useState<{ identity: string; names: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState('')
  const [predictors, setPredictors] = useState<string[]>([])
  const initializedDataset = useRef<string | null>(null)
  const ready = metadata?.identity === identity && codebookDatasetId === datasetId && !!datasetId && !error
  const columns = useMemo(() => metadata?.identity === identity
    ? metadata.names.filter(name => globalVars.activeVariableIds.includes(name)) : [],
  [metadata, identity, globalVars.activeVariableIds])

  useEffect(() => {
    initializedDataset.current = null
    setOutcome('')
    setPredictors([])
  }, [datasetId])

  useEffect(() => {
    if (!datasetId) return
    let active = true
    setError(null)
    api.get<{ schema: Array<{ name: string; semanticType: string; physicalType: string }> }>(`/datasets/${datasetId}`)
      .then(meta => {
        if (!active) return
        setMetadata({ identity, names: meta.schema
          .filter(c => c.semanticType === 'numeric' || c.physicalType === 'float' || c.physicalType === 'int')
          .map(c => c.name) })
      })
      .catch(() => { if (active) setError('数値列の読込みに失敗しました。列を再読込みしてください。') })
    return () => { active = false }
  }, [datasetId, identity, attempt])

  useEffect(() => {
    if (!ready) return
    if (initializedDataset.current !== datasetId) {
      initializedDataset.current = datasetId
      setOutcome(columns.length >= 2 ? columns[columns.length - 1] : '')
      setPredictors(columns.length >= 2 ? columns.slice(0, -1) : [])
      return
    }
    setOutcome(previous => columns.includes(previous) ? previous : '')
    setPredictors(previous => {
      const next = previous.filter(name => columns.includes(name))
      return next.length === previous.length ? previous : next
    })
  }, [ready, columns, datasetId])

  return { columns, outcome, setOutcome, predictors, setPredictors, ready, error,
    retry: () => { setMetadata(null); setAttempt(previous => previous + 1) } }
}

export function numericModelInputError(datasetId: string | null, ready: boolean, columns: string[],
  outcome: string, predictors: string[], rowCount: number, predictorLabel: string): string | null {
  if (!datasetId) return 'データセットを選択してください。'
  if (!ready) return '数値列を読み込んでから実行してください。'
  if (!outcome || !columns.includes(outcome)) return '目的変数に有効な数値列を選択してください。'
  if (!predictors.length) return `${predictorLabel}を1つ以上選択してください。`
  if (predictors.some(name => name === outcome || !columns.includes(name))) return `${predictorLabel}には目的変数以外の有効な数値列を選択してください。`
  if (!rowCount) return '分析対象が0行です。上部の共通対象を変更するか、対象行を選択してください。'
  return null
}
