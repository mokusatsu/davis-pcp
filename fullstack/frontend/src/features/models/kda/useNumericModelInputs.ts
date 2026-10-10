import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import { api } from '../../../api/client'
import { selectOrdinaryVariables, type RootState } from '../../../app/store'

/** Refresh metadata for each dataset generation, including cached inactive
 * pages. Defaults apply once per dataset; revisions only prune invalid inputs. */
type ModelInputMode = 'numeric' | 'kda'

export function useNumericModelInputs(mode: ModelInputMode = 'numeric') {
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const codebookDatasetId = useSelector((s: RootState) => s.codebook.datasetId)
  const codebookColumns = useSelector((s: RootState) => s.codebook.columns)
  const globalVars = useSelector(selectOrdinaryVariables)
  const identity = JSON.stringify([datasetId, dataRevision, schemaRevision])
  const [metadata, setMetadata] = useState<{ identity: string; columns: Array<{ name: string; numeric: boolean }> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState('')
  const [predictors, setPredictors] = useState<string[]>([])
  const initializedDataset = useRef<string | null>(null)
  const ready = metadata?.identity === identity && codebookDatasetId === datasetId && !!datasetId && !error
  const { outcomeColumns, predictorColumns } = useMemo(() => {
    if (metadata?.identity !== identity || codebookDatasetId !== datasetId) {
      return { outcomeColumns: [], predictorColumns: [] }
    }
    // Saved codebook roles own eligibility, not numeric metadata or editor drafts.
    // An incomplete matched column may use the backend model's attribute default;
    // an absent column is never eligible, and no role is inferred from its name.
    const roles = new Map(codebookColumns.map(column => [column.name,
      column.role === undefined ? 'attribute' : column.role]))
    const scales = new Map(codebookColumns.map(column => [column.name, column.scaleType]))
    const orderedScore = (name: string) => ['interval', 'ratio', 'ordinal'].includes(scales.get(name) ?? '')
    const predictorColumns = metadata.columns.filter(column => mode === 'kda'
      ? orderedScore(column.name) || scales.get(column.name) === 'nominal'
      : column.numeric).map(column => column.name).filter(name => globalVars.activeVariableIds.includes(name)
      && (roles.get(name) === 'question' || roles.get(name) === 'attribute'))
    return { predictorColumns, outcomeColumns: predictorColumns.filter(name => roles.get(name) === 'question'
      && (mode !== 'kda' || orderedScore(name))) }
  }, [metadata, identity, codebookDatasetId, datasetId, codebookColumns, globalVars.activeVariableIds, mode])

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
        setMetadata({ identity, columns: meta.schema.map(c => ({ name: c.name,
          numeric: c.semanticType === 'numeric' || c.physicalType === 'float' || c.physicalType === 'int' })) })
      })
      .catch(() => { if (active) setError(`${mode === 'kda' ? '分析列' : '数値列'}の読込みに失敗しました。列を再読込みしてください。`) })
    return () => { active = false }
  }, [datasetId, identity, attempt, mode])

  useEffect(() => {
    if (!ready) return
    if (initializedDataset.current !== datasetId) {
      initializedDataset.current = datasetId
      const initialOutcome = outcomeColumns[outcomeColumns.length - 1] ?? ''
      setOutcome(initialOutcome)
      setPredictors(predictorColumns.filter(name => name !== initialOutcome))
      return
    }
    setOutcome(previous => outcomeColumns.includes(previous) ? previous : '')
    setPredictors(previous => {
      const next = previous.filter(name => predictorColumns.includes(name))
      return next.length === previous.length ? previous : next
    })
  }, [ready, outcomeColumns, predictorColumns, datasetId])

  return { outcomeColumns, predictorColumns, outcome, setOutcome, predictors, setPredictors, ready, error,
    retry: () => { setMetadata(null); setAttempt(previous => previous + 1) } }
}

export function numericModelInputError(datasetId: string | null, ready: boolean, outcomeColumns: string[], predictorColumns: string[],
  outcome: string, predictors: string[], rowCount: number, predictorLabel: string, mode: ModelInputMode = 'numeric'): string | null {
  const outcomeType = mode === 'kda' ? '数値列（数値・順序尺度）' : '数値列'
  const predictorType = mode === 'kda' ? '数値・順序尺度または名義尺度の列' : '数値列'
  if (!datasetId) return 'データセットを選択してください。'
  if (!ready) return `${mode === 'kda' ? '分析列' : '数値列'}を読み込んでから実行してください。`
  if (!outcomeColumns.length) return `目的変数に有効な${outcomeType}を選択してください。コードブックで役割を「質問」に設定し、共通の有効変数に含めてください。`
  if (!outcome || !outcomeColumns.includes(outcome)) return `目的変数に有効な${outcomeType}を選択してください。役割が「質問」の列が対象です。`
  if (!predictors.length) return `${predictorLabel}を1つ以上選択してください。`
  if (predictors.some(name => name === outcome || !predictorColumns.includes(name))) return `${predictorLabel}には目的変数以外の有効な${predictorType}を選択してください。役割が「質問」または「属性」の列が対象です。`
  if (!rowCount) return '分析対象が0行です。上部の共通対象を変更するか、対象行を選択してください。'
  return null
}
