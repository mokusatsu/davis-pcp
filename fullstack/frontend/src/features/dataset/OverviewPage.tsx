import Table from '../common/ColumnTable'
import ColumnQuestionTooltip, { ColumnQuestionText } from '../common/ColumnQuestionTooltip'
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Descriptions, Popconfirm, Space, Tag, Typography, notification } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetValuesUpdated } from '../../app/store'
import { api } from '../../api/client'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import BinningModal from './BinningModal'
import OneHotModal from './OneHotModal'
import ImputationModal from './ImputationModal'
import AddVariableModal from './AddVariableModal'
import ProvenanceHistoryPanel from './ProvenanceHistoryPanel'
import { editorModalOpened, fetchCodebookThunk } from './codebookSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'
import { useCodebook } from './useCodebookColumn'

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
  dataRevision: number
  schemaRevision: number
  rowIdentity: string
  createdAt: string
  schema?: ColumnSchemaItem[]
}

export default function OverviewPage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const { columns: definitions, schemaRevision } = useCodebook()
  const groups = useSelector((s: RootState) => s.codebook.datasetId === s.selection.datasetId ? s.codebook.multiResponseGroups : null)
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const datasetRef = useRef(selection.datasetId)
  datasetRef.current = selection.datasetId
  const context = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision])
  const contextRef = useRef(context)
  contextRef.current = context
  const loadVersion = useRef(0)

  // Transformation Modals state
  const [binModalTarget, setBinModalTarget] = useState<string | null>(null)
  const [oneHotModalTarget, setOneHotModalTarget] = useState<{ col: string; categories: string[] } | null>(null)
  const [imputeModalOpen, setImputeModalOpen] = useState<boolean>(false)
  const [imputeTargetCol, setImputeTargetCol] = useState<string | null>(null)
  const [addVarModalOpen, setAddVarModalOpen] = useState<boolean>(false)

  const reloadDataset = async () => {
    const datasetId = selection.datasetId
    if (!datasetId || datasetRef.current !== datasetId) return
    const version = ++loadVersion.current
    const current = () => contextRef.current === context && datasetRef.current === datasetId && loadVersion.current === version
    setLoadError(null)
    let updatedMeta: DatasetMeta
    let updatedSummary: SummaryResponse
    try {
      updatedMeta = await api.get<DatasetMeta>(`/datasets/${datasetId}`)
      if (!current()) return
      updatedSummary = await api.post<SummaryResponse>('/summaries', {
        datasetId, expectedDataRevision: updatedMeta.dataRevision, expectedSchemaRevision: updatedMeta.schemaRevision,
      })
    } catch (error) {
      if (current()) {
        setMeta(null)
        setSummary(null)
        setLoadError(error instanceof Error ? error.message : 'データの取得に失敗しました。')
      }
      return
    }
    if (!current()) return
    setMeta(updatedMeta)
    setSummary(updatedSummary)

    // Column transformations retain row identity and the current working set.
    if (updatedMeta && updatedMeta.dataRevision !== selection.dataRevision) {
      invalidateColumnarCache()
      dispatch(datasetValuesUpdated({
        datasetId,
        dataRevision: updatedMeta.dataRevision,
      }))
      void dispatch(fetchCodebookThunk(datasetId))
    }
  }

  useEffect(() => {
    setMeta(null)
    setSummary(null)
    void reloadDataset()
    return () => { loadVersion.current++ }
  }, [selection.datasetId, selection.dataRevision, schemaRevision])

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

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>
  if (loadError) return <Alert type="error" showIcon message="概要を読み込めませんでした" description={loadError}
    action={<Button onClick={() => void reloadDataset()}>再試行</Button>} />
  if (!meta || meta.datasetId !== selection.datasetId) return <Typography.Text>概要を読み込み中です。</Typography.Text>

  const schemaMap = new Map((meta.schema || []).map((s) => [s.name, s]))
  const definitionMap = new Map(definitions.map(column => [column.name, column]))
  const questionCount = new Set(definitions.filter(column => column.role === 'question')
    .map(column => column.multiResponseGroup ? `ma:${column.multiResponseGroup}` : `column:${column.columnId}`)).size
  const rows: any[] = []
  const parents = new Map<string, any>()
  for (const schema of meta.schema ?? []) {
    const spec = definitionMap.get(schema.name)
    const child = { key: schema.columnId, name: schema.name, schema, ...summary?.columns[schema.name] }
    if (!spec?.multiResponseGroup) { rows.push(child); continue }
    let parent = parents.get(spec.multiResponseGroup)
    if (!parent) {
      parent = { key: `ma:${spec.multiResponseGroup}`, name: groups?.find(group => group.groupId === spec.multiResponseGroup)?.label || spec.multiResponseGroup,
        isMaParent: true, children: [] }
      parents.set(spec.multiResponseGroup, parent)
      rows.push(parent)
    }
    parent.children.push(child)
  }
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
      {!focused && <ProvenanceHistoryPanel />}

      {!focused && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14 }}>
          <Descriptions title="データセット概要" size="small" bordered column={2}>
            <Descriptions.Item label="名前">{meta.name}</Descriptions.Item>
            <Descriptions.Item label="形式">{meta.format}</Descriptions.Item>
            <Descriptions.Item label="行数">{meta.rowCount}</Descriptions.Item>
            <Descriptions.Item label="物理列数">{meta.columnCount}</Descriptions.Item>
            <Descriptions.Item label="設問数（question）">{questionCount}</Descriptions.Item>
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
                欠損値補完 (実験的条件付き補完 / 補完)
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
            dataSource={rows}
            columns={[
              {
                title: '列名',
                dataIndex: 'name',
                key: 'name',
                render: (name: string, record) => {
                  if (record.isMaParent) return <Space><Typography.Text strong>{name}</Typography.Text><Tag color="blue">MA・{record.children.length}選択肢</Tag></Space>
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
                render: (v?: number) => v === undefined ? '—' : (v > 0 ? <Tag color="error">{v}</Tag> : '0'),
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
                  if (record.isMaParent) return null
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
