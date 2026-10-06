import { useEffect, useRef, useState } from 'react'
import { nanoid } from '@reduxjs/toolkit'
import { useDispatch, useSelector, useStore } from 'react-redux'
import { Alert, Button, Card, List, Popconfirm, Space, Tag, Tooltip, Typography, message } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetValuesUpdated } from '../../app/store'
import { api, getCodebook } from '../../api/client'
import { fetchCodebookThunk, codebookReadAccepted } from './codebookSlice'
import { fetchProvenanceThunk, isProvenanceReady, provenanceReset, selectRestoreRefresh,
  restoreRefreshStarted, restoreRefreshRevisionReceived, restoreRefreshFailed, restoreRefreshFinished } from './provenanceSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'

interface RestoreResponse {
  currentDataRevision: number
  maskRevision: number
  restoreWarnings?: string[]
}

const RESTORE_WARNING_LABELS: Record<string, string> = {
  REVISION_STATE_BACKFILLED: 'この時点の状態スナップショットが無いため、値・スキーマから復元しました。',
  REVISION_CODEBOOK_BACKFILLED: 'この時点のコードブックが無いため、現在の定義から作り直しました。',
  MASK_RESTORE_APPROXIMATED: '補完マスクは近似復元です（列と時点から推定）。',
  REVISION_FINGERPRINT_DIVERGED: '復元後の指紋が記録と一致しません。内容を確認してください。',
}

function operationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback
  const detail = error as { message?: unknown; code?: unknown } | null
  if (typeof detail?.message !== 'string' || !detail.message) return fallback
  return typeof detail.code === 'string' && detail.code
    ? `${detail.message}（${detail.code}）` : detail.message
}

interface PendingOperation {
  key: string
  datasetId: string
  datasetRevision: number
}

export default function ProvenanceHistoryPanel() {
  const dispatch = useDispatch<AppDispatch>()
  const store = useStore<RootState>()
  const selection = useSelector((s: RootState) => s.selection)
  const datasetId = selection.datasetId
  const codebook = useSelector((s: RootState) => s.codebook)
  const provenance = useSelector((s: RootState) => s.provenance)
  const historyReady = useSelector(isProvenanceReady)
  const [pending, setPending] = useState<PendingOperation | null>(null)
  const pendingRef = useRef<PendingOperation | null>(null)
  const restoreRefresh = useSelector(selectRestoreRefresh)
  const mounted = useRef(false)
  const ownsDataset = (operation: PendingOperation) => {
    const current = store.getState().selection
    return current.datasetId === operation.datasetId && current.revision === operation.datasetRevision
  }
  const ownsOperation = (operation: PendingOperation) =>
    mounted.current && pendingRef.current === operation && ownsDataset(operation)
  const busy = pending && ownsDataset(pending) ? pending.key : null
  const restoreWarnings = restoreRefresh && selection.dataRevision <= restoreRefresh.committedRevision ? restoreRefresh.warnings : []
  const currentRefreshFailure = restoreRefresh?.error ? restoreRefresh : null

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pendingRef.current = null }
  }, [])

  const schemaRevision = codebook.datasetId === datasetId ? codebook.schemaRevision : null
  useEffect(() => {
    if (datasetId) void dispatch(fetchProvenanceThunk(datasetId))
    else dispatch(provenanceReset())
  }, [datasetId, selection.revision, selection.dataRevision, schemaRevision, dispatch])

  const beginOperation = (key: string) => {
    const current = store.getState().selection
    if (!datasetId || current.datasetId !== datasetId || current.revision !== selection.revision
      || (pendingRef.current && ownsDataset(pendingRef.current))) return null
    const operation = { key, datasetId, datasetRevision: current.revision }
    pendingRef.current = operation
    setPending(operation)
    return operation
  }
  const finishOperation = (operation: PendingOperation) => {
    if (!ownsOperation(operation)) return
    pendingRef.current = null
    setPending(null)
  }

  const refreshAfterChange = async (targetDatasetId: string, committedRevision: number,
    options: { expectedRevision?: number; warnings?: string[] } = {}) => {
    const expectedRevision = options.expectedRevision ?? committedRevision
    // The shared record survives Overview's ordinary revision-driven unmount.
    // A committed mutation also reconciles a new A instance after A → B → A.
    const started = store.getState()
    if (started.selection.datasetId !== targetDatasetId
      || started.selection.dataRevision > expectedRevision) return
    const requestId = nanoid()
    dispatch(restoreRefreshStarted({ requestId, datasetId: targetDatasetId,
      datasetRevision: started.selection.revision, committedRevision, warnings: options.warnings ?? [], dataRevision: expectedRevision,
      loading: true, error: null }))
    const ownsRefresh = () => {
      const current = store.getState()
      return current.provenance.restoreRefresh?.requestId === requestId
        && current.selection.datasetId === targetDatasetId
        && current.selection.revision === started.selection.revision
    }
    const sameInput = () => {
      const current = store.getState()
      return ownsRefresh() && current.selection.dataRevision === started.selection.dataRevision
        && current.codebook.datasetId === started.codebook.datasetId
        && current.codebook.schemaRevision === started.codebook.schemaRevision
    }
    try {
      let meta: { dataRevision: number }
      try { meta = await api.get<{ dataRevision: number }>(`/datasets/${targetDatasetId}`) }
      catch (error) { if (sameInput()) throw error; return }
      if (!sameInput()) return
      if (meta.dataRevision < expectedRevision) throw new Error('操作後のデータ世代をまだ取得できません。表示を再取得してください。')
      dispatch(restoreRefreshRevisionReceived({ requestId, dataRevision: meta.dataRevision }))
      invalidateColumnarCache()
      dispatch(datasetValuesUpdated({ datasetId: targetDatasetId, dataRevision: meta.dataRevision }))

      const refreshInput = store.getState()
      const currentRefresh = () => ownsRefresh() && store.getState().selection.dataRevision === meta.dataRevision
      if (!currentRefresh()) return
      const codebookRequestId = nanoid()
      dispatch(fetchCodebookThunk.pending(codebookRequestId, targetDatasetId))
      const currentRead = () => {
        const current = store.getState()
        return currentRefresh() && current.codebook.datasetId === targetDatasetId
          && current.codebook.fetchRequestId === codebookRequestId
          && current.codebook.schemaRevision === refreshInput.codebook.schemaRevision
      }
      const superseded = Symbol('restore refresh superseded')
      let cancel!: () => void
      const cancelled = new Promise<typeof superseded>(resolve => { cancel = () => resolve(superseded) })
      const unsubscribe = store.subscribe(() => { if (!currentRead()) cancel() })
      try {
        const response = await Promise.race([getCodebook(targetDatasetId), cancelled])
        if (response === superseded || !currentRead()) {
          dispatch(fetchCodebookThunk.rejected(null, codebookRequestId, targetDatasetId, 'CODEBOOK_FETCH_SUPERSEDED'))
          return
        }
        if (response.datasetId !== targetDatasetId) throw new Error('コードブックのデータセットが一致しません。')
        // Check and dispatch synchronously: RTK's automatic async-thunk
        // completion adds a microtask gap after its payload creator returns.
        // Never emit an obsolete fulfilled action to ANY consuming slice.
        dispatch(codebookReadAccepted(response, codebookRequestId))
      } catch (error) {
        const report = currentRead()
        dispatch(fetchCodebookThunk.rejected(error as Error, codebookRequestId, targetDatasetId))
        if (report) throw error
        return
      } finally { unsubscribe() }
      if (!currentRefresh()) return
      await dispatch(fetchProvenanceThunk(targetDatasetId))
    } catch (error) {
      if (ownsRefresh() && selectRestoreRefresh(store.getState()))
        dispatch(restoreRefreshFailed({ requestId, error: operationErrorMessage(error, '表示の更新に失敗しました。') }))
    } finally {
      // Failed records remain retryable. A superseded callback cannot clear
      // the status/error of a later request, even in the same dataset.
      const refresh = store.getState().provenance.restoreRefresh
      if (refresh?.requestId === requestId && refresh.loading) dispatch(restoreRefreshFinished(requestId))
    }
  }

  const runGuarded = async (key: string, action: () => Promise<RestoreResponse>) => {
    const current = store.getState()
    // Popconfirm may still hold a callback from an older history render.
    if (!isProvenanceReady(current) || current.provenance !== provenance || currentRefreshFailure) return
    const operation = beginOperation(key)
    if (!operation) return
    let committedRevision: number | undefined
    try {
      const res = await action()
      committedRevision = res.currentDataRevision
      await refreshAfterChange(operation.datasetId, committedRevision, { warnings: res.restoreWarnings })
    } catch (err) {
      if (ownsOperation(operation)
        && store.getState().selection.dataRevision <= (committedRevision ?? current.selection.dataRevision)) {
        message.error(operationErrorMessage(err, '操作に失敗しました。'))
      }
    } finally {
      finishOperation(operation)
    }
  }

  const retryRefresh = async () => {
    if (!currentRefreshFailure) return
    const operation = beginOperation('refresh')
    if (!operation) return
    try { await refreshAfterChange(operation.datasetId, currentRefreshFailure.committedRevision,
      { expectedRevision: currentRefreshFailure.dataRevision, warnings: currentRefreshFailure.warnings }) }
    finally { finishOperation(operation) }
  }

  const retryHistory = () => {
    const current = store.getState().selection
    if (datasetId && current.datasetId === datasetId && current.revision === selection.revision && !busy)
      void dispatch(fetchProvenanceThunk(datasetId))
  }

  const handleExport = async () => {
    const operation = beginOperation('export')
    if (!operation) return
    try {
      const blob = await api.downloadBlob(`/datasets/${operation.datasetId}/export_package`)
      if (!ownsOperation(operation)) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${operation.datasetId}-package.zip`
      anchor.click()
      URL.revokeObjectURL(url)
      message.success('再現パッケージを出力しました。')
    } catch (err) {
      if (ownsOperation(operation)) message.error(operationErrorMessage(err, '出力に失敗しました。'))
    } finally {
      finishOperation(operation)
    }
  }

  const handleImport = async (file: File) => {
    const operation = beginOperation('import')
    if (!operation) return
    try {
      const res = await api.upload<{ datasetId: string }>('/datasets/import_package', file)
      // Import creates an independent dataset even if the source panel closes.
      // Preserve its result ID, without navigating or changing the workspace.
      message.success(`新規データセット ${res.datasetId} として取り込みました。`)
    } catch (err) {
      if (ownsOperation(operation)) message.error(operationErrorMessage(err, '取り込みに失敗しました。'))
    } finally {
      finishOperation(operation)
    }
  }

  if (!datasetId) return null

  return (
    <Card
      size="small"
      title="データ来歴・操作履歴"
      data-testid="provenance-panel"
      extra={
        <Space>
          <Button size="small" disabled={!!busy} loading={busy === 'export'} onClick={() => void handleExport()}>
            再現パッケージ出力
          </Button>
          <label style={{ cursor: 'pointer' }}>
            <input
              type="file"
              accept=".zip"
              disabled={!!busy}
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleImport(file)
                event.target.value = ''
              }}
            />
            <Button size="small" disabled={!!busy} loading={busy === 'import'}>再現パッケージ取込</Button>
          </label>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 8 }}>
        <Popconfirm
          title="原データへ戻しますか？"
          disabled={!historyReady || !!currentRefreshFailure || !!busy || provenance.rawDataRevision == null}
          onConfirm={() => void runGuarded('revert-raw', async () => {
            return await api.post<RestoreResponse>(`/datasets/${datasetId}/revert`, {
              targetDataRevision: provenance.rawDataRevision,
              expectedDataRevision: provenance.dataRevision,
              expectedSchemaRevision: provenance.schemaRevision,
            })
          })}
        >
          <Button size="small" danger disabled={!historyReady || !!currentRefreshFailure || !!busy || provenance.rawDataRevision == null} loading={busy === 'revert-raw'}>Revert to Raw</Button>
        </Popconfirm>
        <Tooltip title={provenance.canUndo ? undefined : '取り消せる操作がありません'}>
          <Button
            size="small"
            disabled={!historyReady || !!currentRefreshFailure || !!busy || !provenance.canUndo}
            loading={busy === 'undo'}
            onClick={() => void runGuarded('undo', async () => {
              return await api.post<RestoreResponse>(`/datasets/${datasetId}/undo`, {
                expectedDataRevision: provenance.dataRevision,
                expectedSchemaRevision: provenance.schemaRevision,
              })
            })}
          >
            Undo
          </Button>
        </Tooltip>
        <Tooltip title={provenance.canRedo ? undefined : 'やり直せる操作がありません'}>
          <Button
            size="small"
            disabled={!historyReady || !!currentRefreshFailure || !!busy || !provenance.canRedo}
            loading={busy === 'redo'}
            onClick={() => void runGuarded('redo', async () => {
              return await api.post<RestoreResponse>(`/datasets/${datasetId}/redo`, {
                expectedDataRevision: provenance.dataRevision,
                expectedSchemaRevision: provenance.schemaRevision,
              })
            })}
          >
            Redo
          </Button>
        </Tooltip>
        <Tag>rev {provenance.datasetId === datasetId ? provenance.dataRevision ?? '-' : '-'} / schema {provenance.datasetId === datasetId ? provenance.schemaRevision ?? '-' : '-'}</Tag>
        <Tag>mask rev {provenance.datasetId === datasetId ? provenance.maskRevision : '-'}</Tag>
      </Space>
      {restoreRefresh?.loading && <Typography.Paragraph role="status" type="secondary">操作後の表示を更新しています…</Typography.Paragraph>}
      {provenance.datasetId === datasetId && provenance.error && <Alert type="error" message={provenance.error} style={{ marginBottom: 8 }}
        action={<Button size="small" disabled={!!busy || provenance.loading} onClick={retryHistory}>来歴を再取得</Button>} />}
      {currentRefreshFailure && <Alert type="error" style={{ marginBottom: 8 }}
        message="操作は完了しましたが、表示の更新に失敗しました。" description={currentRefreshFailure.error}
        action={<Button size="small" disabled={!!busy} loading={busy === 'refresh'} onClick={() => void retryRefresh()}>表示を再取得</Button>} />}

      {restoreWarnings.length > 0 && (
        <Alert
          type="warning"
          style={{ marginBottom: 8 }}
          message="復元時の注意"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {restoreWarnings.map((code) => (
                <li key={code}>{RESTORE_WARNING_LABELS[code] ?? code}</li>
              ))}
            </ul>
          }
        />
      )}
      <List
        size="small"
        dataSource={provenance.datasetId === datasetId ? provenance.steps : []}
        renderItem={(step, index) => (
          <List.Item
            actions={[
              <Popconfirm
                key="revert"
                title={`この操作 (rev ${step.outputDataRevision}) へ戻しますか？`}
                disabled={!historyReady || !!currentRefreshFailure || !!busy || step.operationId === provenance.cursorOperationId}
                onConfirm={() => void runGuarded(`revert-${step.operationId}`, async () => {
                  return await api.post<RestoreResponse>(`/datasets/${datasetId}/revert`, {
                    targetOperationId: step.operationId,
                    expectedDataRevision: provenance.dataRevision,
                    expectedSchemaRevision: provenance.schemaRevision,
                  })
                })}
              >
                <Button
                  size="small"
                  type="link"
                  disabled={!historyReady || !!currentRefreshFailure || !!busy || step.operationId === provenance.cursorOperationId}
                >
                  {step.operationId === provenance.cursorOperationId ? '現在の位置' : 'この履歴へ戻す'}
                </Button>
              </Popconfirm>,
            ]}
          >
            <Typography.Text delete={step.inEffect === false}>
              {index + 1}. {step.operation} (rev {step.outputDataRevision})
            </Typography.Text>
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 11 }}>
              {step.timestamp}
            </Typography.Text>
          </List.Item>
        )}
      />
    </Card>
  )
}
