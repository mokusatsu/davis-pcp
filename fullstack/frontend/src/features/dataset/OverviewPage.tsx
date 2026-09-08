import Table from '../common/ColumnTable'
import ColumnQuestionTooltip, { ColumnQuestionText } from '../common/ColumnQuestionTooltip'
import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Button, Descriptions, Popconfirm, Space, Tag, Typography, notification } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetLoaded } from '../../app/store'
import { api, fetchArrowView } from '../../api/client'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import BinningModal from './BinningModal'
import OneHotModal from './OneHotModal'
import ImputationModal from './ImputationModal'
import AddVariableModal from './AddVariableModal'
import { editorModalOpened } from './codebookSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'

interface SummaryColumn {
  count: number
  missing: number
  min?: number
  max?: number
  mean?: number
  median?: number
  std?: number
  q1?: number
  q3?: number
  iqr?: number
  uniqueCount?: number
  frequencies?: Record<string, number>
}

interface SummaryResponse {
  rowCount: number
  columns: Record<string, SummaryColumn>
}

interface ColumnSchemaItem {
  columnId: string
  name: string
  physicalType: string
  semanticType: string
  role: string
  missingCount: number
  uniqueCount: number
  min?: number
  max?: number
  categories?: string[]
}

interface DatasetMeta {
  datasetId: string
  name: string
  format: string
  rowCount: number
  columnCount: number
  fingerprint: string
  rowIdentity: string
  createdAt: string
  schema?: ColumnSchemaItem[]
}

export default function OverviewPage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const [summary, setSummary] = useState<SummaryResponse | null>(null)

  // Transformation Modals state
  const [binModalTarget, setBinModalTarget] = useState<string | null>(null)
  const [oneHotModalTarget, setOneHotModalTarget] = useState<{ col: string; categories: string[] } | null>(null)
  const [imputeModalOpen, setImputeModalOpen] = useState<boolean>(false)
  const [imputeTargetCol, setImputeTargetCol] = useState<string | null>(null)
  const [addVarModalOpen, setAddVarModalOpen] = useState<boolean>(false)

  const reloadDataset = async () => {
    if (!selection.datasetId) return
    invalidateColumnarCache()
    const updatedMeta = await api.get<DatasetMeta>(`/datasets/${selection.datasetId}`).catch(() => null)
    if (updatedMeta) setMeta(updatedMeta)
    const updatedSummary = await api.post<SummaryResponse>('/summaries', { datasetId: selection.datasetId }).catch(() => null)
    if (updatedSummary) setSummary(updatedSummary)

    // Also refresh arrow view in store
    const view = await fetchArrowView(selection.datasetId).catch(() => null)
    if (view && updatedMeta) {
      dispatch(datasetLoaded({
        datasetId: selection.datasetId,
        name: updatedMeta.name,
        rowIds: (view.__rowId__ as string[]) || selection.activeRowIds,
      }))
    }
  }

  useEffect(() => {
    if (!selection.datasetId) return
    void reloadDataset()
  }, [selection.datasetId])

  const handleDeleteColumn = async (colName: string) => {
    if (!selection.datasetId) return
    try {
      await api.delete(`/datasets/${selection.datasetId}/columns/${colName}`)
      notification.success({ message: '列削除完了', description: `列 '${colName}' を削除しました。` })
      await reloadDataset()
    } catch (err) {
      const error = err as { message: string }
      notification.error({ message: '削除失敗', description: error.message || '列の削除に失敗しました。' })
    }
  }

  if (!selection.datasetId || !meta) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  const schemaMap = new Map((meta.schema || []).map((s) => [s.name, s]))
  const columnsWithMissing = Object.entries(summary?.columns ?? {})
    .filter(([_, stats]) => stats.missing > 0)
    .map(([name, stats]) => ({
      name,
      missing: stats.missing,
      total: stats.count + stats.missing,
      semanticType: schemaMap.get(name)?.semanticType,
    }))

  return (
    <div
      data-testid="overview-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: focused ? 0 : 14,
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : undefined,
        minHeight: 0,
      }}
    >
      {!focused && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14 }}>
          <Descriptions title="データセット概要" size="small" bordered column={2}>
            <Descriptions.Item label="名前">{meta.name}</Descriptions.Item>
            <Descriptions.Item label="形式">{meta.format}</Descriptions.Item>
            <Descriptions.Item label="行数">{meta.rowCount}</Descriptions.Item>
            <Descriptions.Item label="列数">{meta.columnCount}</Descriptions.Item>
            <Descriptions.Item label="row identity">{meta.rowIdentity}</Descriptions.Item>
            <Descriptions.Item label="fingerprint"><code style={{ fontSize: 10 }}>{meta.fingerprint.slice(0, 24)}…</code></Descriptions.Item>
            <Descriptions.Item label="作成日時">{meta.createdAt}</Descriptions.Item>
          </Descriptions>
        </div>
      )}

      <FocusTarget id="overview-table" title="変数一覧 & 前処理変換">
        <div
          style={{
            border: focused ? 'none' : '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#ffffff',
            padding: focused ? 4 : 14,
            height: focused ? '100%' : undefined,
            flex: focused ? 1 : undefined,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>変数一覧 &amp; 前処理変換</Typography.Title>
            <Space wrap align="center">
              <Button
                type="primary"
                style={{ background: '#7c3aed', borderColor: '#7c3aed' }}
                data-testid="btn-open-codebook"
                onClick={() => dispatch(editorModalOpened())}
              >
                📋 コードブック編集
              </Button>
              <Button
                type="primary"
                data-testid="btn-open-imputation"
                onClick={() => {
                  setImputeTargetCol(null)
                  setImputeModalOpen(true)
                }}
              >
                欠損値補完 (TabDiff / 補完)
                {columnsWithMissing.length > 0 && ` (${columnsWithMissing.length}列に欠損あり)`}
              </Button>
              <Button
                data-testid="btn-open-add-variable"
                onClick={() => setAddVarModalOpen(true)}
              >
                変数の動的追加 (計算式)
              </Button>
              <FocusEnterButton targetId="overview-table" title="変数一覧 & 前処理変換" />
            </Space>
          </div>
          <Table
            size="small"
            pagination={false}
            scroll={{ x: true, y: focused ? 'calc(100vh - 120px)' : undefined }}
            dataSource={Object.entries(summary?.columns ?? {}).map(([name, stats]) => ({
              key: name,
              name,
              schema: schemaMap.get(name),
              ...stats,
            }))}
            columns={[
              {
                title: '列名',
                dataIndex: 'name',
                key: 'name',
                render: (name: string, record) => {
                  const isNumeric = record.schema?.semanticType === 'numeric' || typeof record.min === 'number'
                  return (
                    <Space>
                      <Typography.Text strong><ColumnQuestionTooltip nameOrId={name}>{name}</ColumnQuestionTooltip></Typography.Text>
                      {record.schema && (
                        <Tag color={isNumeric ? 'blue' : 'green'} style={{ fontSize: 10 }}>
                          {record.schema.semanticType}
                        </Tag>
                      )}
                    </Space>
                  )
                },
              },
              { title: 'count', dataIndex: 'count', key: 'count', width: 65 },
              {
                title: 'missing',
                dataIndex: 'missing',
                key: 'missing',
                width: 75,
                render: (v: number) => (v > 0 ? <Tag color="error">{v}</Tag> : '0'),
              },
              { title: 'min', dataIndex: 'min', key: 'min', width: 75, render: (v) => (typeof v === 'number' ? v.toFixed(2) : '—') },
              { title: 'max', dataIndex: 'max', key: 'max', width: 75, render: (v) => (typeof v === 'number' ? v.toFixed(2) : '—') },
              { title: 'mean', dataIndex: 'mean', key: 'mean', width: 75, render: (v) => (typeof v === 'number' ? v.toFixed(2) : '—') },
              { title: 'std', dataIndex: 'std', key: 'std', width: 75, render: (v) => (typeof v === 'number' ? v.toFixed(2) : '—') },
              { title: 'unique', dataIndex: 'uniqueCount', key: 'uniqueCount', width: 65, render: (v) => v ?? '—' },
              {
                title: '前処理・変換',
                key: 'actions',
                width: 260,
                render: (_, record) => {
                  const isNumeric = record.schema?.semanticType === 'numeric' || typeof record.min === 'number'
                  const isCategorical = record.schema?.semanticType === 'categorical' || (!isNumeric && record.uniqueCount)
                  const categories = record.schema?.categories || Object.keys(record.frequencies || {})

                  return (
                    <Space direction="horizontal" size="small" wrap>
                      {record.missing > 0 && (
                        <Button
                          size="small"
                          style={{ borderColor: '#f97316', color: '#ea580c' }}
                          data-testid={`btn-impute-${record.name}`}
                          onClick={() => {
                            setImputeTargetCol(record.name)
                            setImputeModalOpen(true)
                          }}
                        >
                          補完
                        </Button>
                      )}
                      {isNumeric && (
                        <Button
                          size="small"
                          type="primary"
                          ghost
                          data-testid={`btn-bin-${record.name}`}
                          onClick={() => setBinModalTarget(record.name)}
                        >
                          ビン分割
                        </Button>
                      )}
                      {isCategorical && (
                        <Button
                          size="small"
                          type="primary"
                          ghost
                          data-testid={`btn-onehot-${record.name}`}
                          onClick={() => setOneHotModalTarget({ col: record.name, categories })}
                        >
                          One-Hot二値化
                        </Button>
                      )}
                      <Popconfirm
                        title={<>列「<ColumnQuestionText nameOrId={record.name} />」を削除しますか？</>}
                        okText="削除"
                        cancelText="キャンセル"
                        onConfirm={() => handleDeleteColumn(record.name)}
                      >
                        <Button size="small" danger type="text" data-testid={`btn-delete-${record.name}`}>
                          削除
                        </Button>
                      </Popconfirm>
                    </Space>
                  )
                },
              },
            ]}
          />
        </div>
      </FocusTarget>

      {/* Modals */}
      {binModalTarget && (
        <BinningModal
          open={Boolean(binModalTarget)}
          datasetId={selection.datasetId}
          columnName={binModalTarget}
          onClose={() => setBinModalTarget(null)}
          onSuccess={reloadDataset}
        />
      )}

      {oneHotModalTarget && (
        <OneHotModal
          open={Boolean(oneHotModalTarget)}
          datasetId={selection.datasetId}
          columnName={oneHotModalTarget.col}
          categories={oneHotModalTarget.categories}
          onClose={() => setOneHotModalTarget(null)}
          onSuccess={reloadDataset}
        />
      )}

      {imputeModalOpen && (
        <ImputationModal
          open={imputeModalOpen}
          datasetId={selection.datasetId}
          targetColumn={imputeTargetCol}
          columnsWithMissing={columnsWithMissing}
          onClose={() => {
            setImputeModalOpen(false)
            setImputeTargetCol(null)
          }}
          onSuccess={reloadDataset}
        />
      )}

      {addVarModalOpen && (
        <AddVariableModal
          open={addVarModalOpen}
          datasetId={selection.datasetId}
          columns={Object.keys(summary?.columns ?? {})}
          onClose={() => setAddVarModalOpen(false)}
          onSuccess={reloadDataset}
        />
      )}
    </div>
  )
}
