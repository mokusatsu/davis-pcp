import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, List, Popconfirm, Space, Tag, Typography, message } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetValuesUpdated } from '../../app/store'
import { api } from '../../api/client'
import { fetchCodebookThunk } from './codebookSlice'
import { fetchProvenanceThunk, provenanceReset } from './provenanceSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'

export default function ProvenanceHistoryPanel() {
  const dispatch = useDispatch<AppDispatch>()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const provenance = useSelector((s: RootState) => s.provenance)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (datasetId) {
      void dispatch(fetchProvenanceThunk(datasetId))
    } else {
      dispatch(provenanceReset())
    }
  }, [datasetId, dispatch])

  const refreshAfterChange = async (targetDatasetId: string) => {
    const meta = await api.get<{ dataRevision: number }>(`/datasets/${targetDatasetId}`)
    invalidateColumnarCache()
    dispatch(datasetValuesUpdated({ datasetId: targetDatasetId, dataRevision: meta.dataRevision }))
    await dispatch(fetchCodebookThunk(targetDatasetId))
    await dispatch(fetchProvenanceThunk(targetDatasetId))
  }

  const runGuarded = async (key: string, action: () => Promise<void>) => {
    if (!datasetId || busy) return
    const frozenDatasetId = datasetId
    setBusy(key)
    try {
      await action()
      await refreshAfterChange(frozenDatasetId)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作に失敗しました。')
    } finally {
      setBusy(null)
    }
  }

  const handleExport = async () => {
    if (!datasetId) return
    const frozenDatasetId = datasetId
    setBusy('export')
    try {
      const blob = await api.downloadBlob(`/datasets/${frozenDatasetId}/export_package`)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${frozenDatasetId}-package.zip`
      anchor.click()
      URL.revokeObjectURL(url)
      message.success('再現パッケージを出力しました。')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '出力に失敗しました。')
    } finally {
      setBusy(null)
    }
  }

  const handleImport = async (file: File) => {
    setBusy('import')
    try {
      const res = await api.upload<{ datasetId: string }>('/datasets/import_package', file)
      message.success(`新規データセット ${res.datasetId} として取り込みました。`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '取り込みに失敗しました。')
    } finally {
      setBusy(null)
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
          <Button size="small" loading={busy === 'export'} onClick={() => void handleExport()}>
            再現パッケージ出力
          </Button>
          <label style={{ cursor: 'pointer' }}>
            <input
              type="file"
              accept=".zip"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleImport(file)
                event.target.value = ''
              }}
            />
            <Button size="small" loading={busy === 'import'}>再現パッケージ取込</Button>
          </label>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 8 }}>
        <Popconfirm
          title="原データへ戻しますか？"
          onConfirm={() => void runGuarded('revert-raw', async () => {
            await api.post(`/datasets/${datasetId}/revert`, {
              targetDataRevision: provenance.rawDataRevision,
              expectedDataRevision: provenance.dataRevision,
              expectedSchemaRevision: provenance.schemaRevision,
            })
          })}
        >
          <Button size="small" danger loading={busy === 'revert-raw'}>Revert to Raw</Button>
        </Popconfirm>
        <Button
          size="small"
          loading={busy === 'undo'}
          onClick={() => void runGuarded('undo', async () => {
            await api.post(`/datasets/${datasetId}/undo`, {
              expectedDataRevision: provenance.dataRevision,
              expectedSchemaRevision: provenance.schemaRevision,
            })
          })}
        >
          Undo
        </Button>
        <Button
          size="small"
          loading={busy === 'redo'}
          onClick={() => void runGuarded('redo', async () => {
            await api.post(`/datasets/${datasetId}/redo`, {
              expectedDataRevision: provenance.dataRevision,
              expectedSchemaRevision: provenance.schemaRevision,
            })
          })}
        >
          Redo
        </Button>
        <Tag>rev {provenance.dataRevision ?? '-'} / schema {provenance.schemaRevision ?? '-'}</Tag>
        <Tag>mask rev {provenance.maskRevision}</Tag>
      </Space>
      {provenance.error && <Alert type="error" message={provenance.error} style={{ marginBottom: 8 }} />}
      <List
        size="small"
        dataSource={provenance.steps}
        renderItem={(step, index) => (
          <List.Item
            actions={[
              <Popconfirm
                key="revert"
                title={`この操作 (rev ${step.outputDataRevision}) へ戻しますか？`}
                onConfirm={() => void runGuarded(`revert-${step.operationId}`, async () => {
                  await api.post(`/datasets/${datasetId}/revert`, {
                    targetOperationId: step.operationId,
                    expectedDataRevision: provenance.dataRevision,
                    expectedSchemaRevision: provenance.schemaRevision,
                  })
                })}
              >
                <Button size="small" type="link">この履歴へ戻す</Button>
              </Popconfirm>,
            ]}
          >
            <Typography.Text>
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
