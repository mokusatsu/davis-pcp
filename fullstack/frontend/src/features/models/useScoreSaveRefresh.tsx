import { useEffect, useRef, useState } from 'react'
import { useSelector, useStore } from 'react-redux'
import { Alert, Button, message } from 'antd'
import { datasetValuesUpdated, type AppDispatch, type RootState } from '../../app/store'
import { fetchCodebookThunk } from '../dataset/codebookSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'

export interface ScoreSaveReceipt {
  createdColumns: { name: string }[]
  writtenRowCount?: number
  dataRevision: number
  schemaRevision: number
}

const savedRows = (receipt: ScoreSaveReceipt): string => receipt.writtenRowCount === undefined
  ? '' : `（${receipt.writtenRowCount}行）`

type SaveOperation = {
  owner: object
  datasetId: string
  installation: number
  dataRevision: number
  schemaRevision: number
  name: string
  receipt?: ScoreSaveReceipt
}
type Progress = {
  operation: SaveOperation
  phase: 'saving' | 'refreshing' | 'failed' | 'superseded'
  error?: string
}

/** A materialization receipt proves the write; only an accepted read proves canonical column availability. */
export function useScoreSaveRefresh(owner: object | null) {
  const store = useStore<RootState>()
  const dispatch = store.dispatch as AppDispatch
  const selection = useSelector((state: RootState) => state.selection)
  const codebook = useSelector((state: RootState) => state.codebook)
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const mounted = useRef(true)
  const active = useRef<SaveOperation | null>(null)
  const refreshing = useRef<SaveOperation | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current = null }
  }, [])

  const ownsInstallation = (operation: SaveOperation): boolean => {
    const live = store.getState()
    return mounted.current && live.selection.datasetId === operation.datasetId
      && live.codebook.datasetId === operation.datasetId && live.selection.revision === operation.installation
  }
  const ownsWorkspace = (operation: SaveOperation): boolean => {
    const live = store.getState()
    return ownsInstallation(operation)
      && live.selection.dataRevision === (operation.receipt?.dataRevision ?? operation.dataRevision)
      && (live.codebook.schemaRevision === operation.schemaRevision
        || live.codebook.schemaRevision === operation.receipt?.schemaRevision)
  }
  const ownsOperation = (operation: SaveOperation): boolean => ownsInstallation(operation)
    && active.current === operation
  const isCurrent = (operation: SaveOperation): boolean => ownsOperation(operation) && ownsWorkspace(operation)
  const isRefreshed = (operation: SaveOperation): boolean => {
    const live = store.getState().codebook
    return Boolean(operation.receipt && live.schemaRevision === operation.receipt.schemaRevision
      && operation.receipt.createdColumns.every(saved => live.columns.some(column => column.name === saved.name)))
  }
  const retire = (operation: SaveOperation): void => {
    if (active.current !== operation) return
    active.current = null
    if (mounted.current) setProgress(null)
  }
  const finish = (operation: SaveOperation): void => {
    if (!isCurrent(operation) || !isRefreshed(operation)) return
    const reportSuccess = currentOwner.current === operation.owner
    retire(operation)
    if (reportSuccess) message.success(`${operation.name}を保存しました${savedRows(operation.receipt!)}。新列は利用可能です。Tableに表示するには、Variablesで新列を選択してください。`)
  }

  // The receipt belongs to the installed workspace even after a new fit.
  // Replaced installations and unrelated revision changes retire recovery.
  // Result identity only owns transient save/error notices, not a committed write.
  useEffect(() => {
    if (!progress) return
    if (!ownsOperation(progress.operation) || (progress.phase !== 'saving' && !ownsWorkspace(progress.operation))) {
      retire(progress.operation)
    } else if (progress.phase !== 'saving' && isRefreshed(progress.operation)) {
      finish(progress.operation)
    }
  }, [owner, selection.datasetId, selection.revision, selection.dataRevision, codebook, progress])

  const refresh = async (operation: SaveOperation): Promise<void> => {
    if (!isCurrent(operation) || refreshing.current === operation) return
    // Lock synchronously, before React disables the button, so rapid clicks
    // cannot displace this read with a second request.
    refreshing.current = operation
    setProgress({ operation, phase: 'refreshing' })
    try {
      const outcome = await dispatch(fetchCodebookThunk(operation.datasetId))
      if (!isCurrent(operation)) return
      if (isRefreshed(operation)) { finish(operation); return }
      if (fetchCodebookThunk.rejected.match(outcome)
        && outcome.payload !== 'CODEBOOK_FETCH_SUPERSEDED' && !outcome.meta.condition && !outcome.meta.aborted) {
        setProgress({ operation, phase: 'failed', error: outcome.error.message })
      } else {
        // A displaced read is not a transport failure. Keep the committed
        // receipt until a current canonical read establishes availability.
        setProgress({ operation, phase: 'superseded' })
      }
    } finally {
      if (refreshing.current === operation) refreshing.current = null
    }
  }

  const save = async (name: string, materialize: () => Promise<ScoreSaveReceipt>, formatError: (error: unknown) => string): Promise<void> => {
    if (!owner || active.current) return
    const started = store.getState()
    if (!started.selection.datasetId) return
    const operation: SaveOperation = { owner, datasetId: started.selection.datasetId,
      installation: started.selection.revision, dataRevision: started.selection.dataRevision,
      schemaRevision: started.codebook.schemaRevision, name }
    active.current = operation
    setProgress({ operation, phase: 'saving' })
    let receipt: ScoreSaveReceipt
    try { receipt = await materialize() }
    catch (error) {
      const reportError = isCurrent(operation) && currentOwner.current === operation.owner
      retire(operation)
      if (!reportError) return
      message.error(formatError(error))
      return
    }
    const live = store.getState()
    // Another canonical read may acknowledge this exact commit before the POST
    // response arrives. Accept either the submission baseline or its receipt,
    // while rejecting a replacement installation or unrelated newer revision.
    if (!ownsInstallation(operation)
      || ![operation.dataRevision, receipt.dataRevision].includes(live.selection.dataRevision)
      || ![operation.schemaRevision, receipt.schemaRevision].includes(live.codebook.schemaRevision)) {
      retire(operation)
      return
    }
    // A replay receipt older than this workspace cannot own its refresh.
    if (receipt.dataRevision < operation.dataRevision || receipt.schemaRevision < operation.schemaRevision) {
      retire(operation)
      return
    }
    operation.receipt = receipt
    invalidateColumnarCache()
    dispatch(datasetValuesUpdated({ datasetId: operation.datasetId, dataRevision: receipt.dataRevision }))
    if (isCurrent(operation)) {
      if (isRefreshed(operation)) finish(operation)
      else await refresh(operation)
    }
  }

  const current = progress && ownsOperation(progress.operation)
    && (progress.phase === 'saving' || ownsWorkspace(progress.operation)) ? progress : null
  const receipt = current?.operation.receipt
  const notice = receipt && current ? <Alert
    type={current.phase === 'failed' ? 'warning' : 'info'} showIcon
    style={{ marginTop: 8, minWidth: 0, overflowWrap: 'anywhere' }}
    message={`${current.operation.name}は保存済みです${savedRows(receipt)}。`}
    description={<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
      <div>{current.phase === 'failed'
        ? `列情報の更新に失敗しました。保存済みの列を利用するには、コードブックを再取得してください。${current.error ? `（${current.error}）` : ''}`
        : current.phase === 'refreshing'
          ? '保存済みの列情報を取得しています。'
          : '列情報の更新を確認できませんでした。コードブックを再取得してください。'}</div>
      <Button aria-label="コードブックを再取得" loading={current.phase === 'refreshing'} disabled={current.phase === 'refreshing'}
        style={{ maxWidth: '100%', height: 'auto', minHeight: 32, whiteSpace: 'normal' }}
        onClick={() => { void refresh(current.operation) }}>コードブックを再取得</Button>
    </div>}
  /> : null
  return { save, notice, saving: current?.phase === 'saving' || current?.phase === 'refreshing' }
}
