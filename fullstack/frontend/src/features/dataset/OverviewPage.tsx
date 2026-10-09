import { notifyDatasetMutationCommitted, onDatasetMutationCommitted } from './datasetMutationEvents'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip, { ColumnQuestionText } from '../common/ColumnQuestionTooltip'
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector, useStore } from 'react-redux'
import { Alert, Button, Descriptions, Popconfirm, Space, Tag, Typography, notification } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetValuesUpdated } from '../../app/store'
import { api } from '../../api/client'
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

interface CodebookRefreshTarget {
  datasetId: string
  installationRevision: number
  dataRevision: number
  schemaRevision: number
}

interface CodebookRefresh {
  target: CodebookRefreshTarget
  columnsBeforeRead: RootState['codebook']['columns']
  phase: 'pending' | 'failed' | 'superseded' | 'mismatched'
  message?: string
}

function sameRefreshTarget(left: CodebookRefreshTarget, right: CodebookRefreshTarget) {
  return left.datasetId === right.datasetId && left.installationRevision === right.installationRevision
    && left.dataRevision === right.dataRevision && left.schemaRevision === right.schemaRevision
}

export default function OverviewPage() {
  const dispatch = useDispatch<AppDispatch>()
  const datasetStore = useStore<RootState>()
  const selection = useSelector((s: RootState) => s.selection)
  const { columns: definitions, schemaRevision } = useCodebook()
  const groups = useSelector((s: RootState) => s.codebook.datasetId === s.selection.datasetId ? s.codebook.multiResponseGroups : null)
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [codebookRefresh, setCodebookRefresh] = useState<CodebookRefresh | null>(null)
  const codebookRefreshRef = useRef<CodebookRefresh | null>(null)
  const codebookTargetRef = useRef<CodebookRefreshTarget | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const datasetRef = useRef(selection.datasetId)
  datasetRef.current = selection.datasetId
  const context = JSON.stringify([selection.datasetId, selection.revision, selection.dataRevision, schemaRevision])
  const contextRef = useRef(context)
  contextRef.current = context
  const loadVersion = useRef(0)

  // Transformation Modals state
  const [binModalTarget, setBinModalTarget] = useState<string | null>(null)
  const [oneHotModalTarget, setOneHotModalTarget] = useState<{ col: string; categories: string[]; categoriesComplete: boolean } | null>(null)
  const [imputeModalOpen, setImputeModalOpen] = useState<boolean>(false)
  const [imputeTargetCol, setImputeTargetCol] = useState<string | null>(null)
  const [addVarModalOpen, setAddVarModalOpen] = useState<boolean>(false)

  const updateCodebookRefresh = (next: CodebookRefresh | null) => {
    codebookRefreshRef.current = next
    setCodebookRefresh(next)
  }
  const currentCodebookTarget = (target: CodebookRefreshTarget) => {
    const live = datasetStore.getState().selection
    return mountedRef.current && live.datasetId === target.datasetId
      && live.revision === target.installationRevision && live.dataRevision === target.dataRevision
      && !!codebookTargetRef.current && sameRefreshTarget(codebookTargetRef.current, target)
  }
  const refreshCodebook = async (target: CodebookRefreshTarget) => {
    if (!currentCodebookTarget(target)) return
    const previous = codebookRefreshRef.current
    if (previous?.phase === 'pending' && sameRefreshTarget(previous.target, target)) return
    const request: CodebookRefresh = {
      target, phase: 'pending', columnsBeforeRead: datasetStore.getState().codebook.columns,
    }
    updateCodebookRefresh(request)
    const result = await dispatch(fetchCodebookThunk(target.datasetId))
    if (codebookRefreshRef.current !== request || !currentCodebookTarget(target)) return
    if (fetchCodebookThunk.fulfilled.match(result)) {
      const saved = datasetStore.getState().codebook
      updateCodebookRefresh(saved.datasetId === target.datasetId && saved.schemaRevision === target.schemaRevision
        ? null : { ...request, phase: 'mismatched' })
    } else if (result.payload === 'CODEBOOK_FETCH_SUPERSEDED' || result.meta.condition) {
      // Supersession is not a transport failure. Another accepted read may have
      // already supplied the target; otherwise keep a read-only recovery path.
      const saved = datasetStore.getState().codebook
      updateCodebookRefresh(saved.datasetId === target.datasetId && saved.schemaRevision === target.schemaRevision
        && saved.columns !== request.columnsBeforeRead ? null : { ...request, phase: 'superseded' })
    } else {
      updateCodebookRefresh({ ...request, phase: 'failed', message: result.error.message || 'データの取得に失敗しました。' })
    }
  }

  // An accepted read from another current consumer can satisfy this target.
  // Do not clear a failure just because a metadata-only reload has completed.
  useEffect(() => {
    const pending = codebookRefreshRef.current
    if (!pending) return
    if (!currentCodebookTarget(pending.target)
      || (schemaRevision === pending.target.schemaRevision && definitions !== pending.columnsBeforeRead)) {
      updateCodebookRefresh(null)
    }
  }, [selection.datasetId, selection.revision, selection.dataRevision, schemaRevision, definitions])

  const reloadDataset = async () => {
    const datasetId = selection.datasetId
    if (!datasetId || datasetRef.current !== datasetId) return
    const version = ++loadVersion.current
    const current = () => {
      const live = datasetStore.getState()
      return mountedRef.current && contextRef.current === context && loadVersion.current === version
        && live.selection.datasetId === datasetId && live.selection.revision === selection.revision
        && live.selection.dataRevision === selection.dataRevision && live.codebook.schemaRevision === schemaRevision
    }
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
    const dataChanged = updatedMeta.dataRevision !== selection.dataRevision
    if (dataChanged) {
      invalidateColumnarCache()
      dispatch(datasetValuesUpdated({
        datasetId,
        dataRevision: updatedMeta.dataRevision,
      }))
    }
    // This target belongs to the installed dataset after its data revision was
    // advanced, not to the metadata request's obsolete pre-update context.
    const target: CodebookRefreshTarget = {
      datasetId, installationRevision: selection.revision,
      dataRevision: updatedMeta.dataRevision, schemaRevision: updatedMeta.schemaRevision,
    }
    codebookTargetRef.current = target
    const previous = codebookRefreshRef.current
    if (previous && sameRefreshTarget(previous.target, target)) return
    const saved = datasetStore.getState().codebook
    if (dataChanged || saved.datasetId !== datasetId || saved.schemaRevision !== updatedMeta.schemaRevision) {
      void refreshCodebook(target)
    } else if (previous) {
      updateCodebookRefresh(null)
    }
  }

  // A committed request keeps running after its dialog closes. Reconcile the
  // captured dataset through the latest page callback, never a stale dataset.
  const reloadDatasetRef = useRef<(() => Promise<void>) | null>(reloadDataset)
  reloadDatasetRef.current = reloadDataset
  useEffect(() => onDatasetMutationCommitted(committedDatasetId => {
    if (datasetRef.current === committedDatasetId) void reloadDatasetRef.current?.()
  }), [])

  useEffect(() => {
    setMeta(null)
    setSummary(null)
    void reloadDataset()
    return () => { loadVersion.current++ }
  }, [selection.datasetId, selection.revision, selection.dataRevision, schemaRevision])

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
      style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}
    >
      {codebookRefresh && currentCodebookTarget(codebookRefresh.target) && <Alert
        type={codebookRefresh.phase === 'pending' ? 'info' : 'warning'} showIcon
        message={codebookRefresh.phase === 'pending' ? 'コードブックを再読み込み中です'
          : codebookRefresh.phase === 'failed' ? 'コードブックを再読み込みできませんでした' : 'コードブックの再読み込みが必要です'}
        description={<Space direction="vertical" style={{ width: '100%' }}>
          {codebookRefresh.phase === 'failed' && <span>{codebookRefresh.message}</span>}
          {codebookRefresh.phase === 'superseded' && <span>別の更新により読み込みが中断されました。最新のコードブックを再読み込みしてください。</span>}
          {codebookRefresh.phase === 'mismatched' && <span>読み込んだコードブックと概要の更新状態が一致しません。再読み込みしてください。</span>}
          <Button aria-label="コードブックを再読み込み" loading={codebookRefresh.phase === 'pending'} disabled={codebookRefresh.phase === 'pending'}
            style={{ maxWidth: '100%', height: 'auto', minHeight: 32, whiteSpace: 'normal' }}
            onClick={() => void refreshCodebook(codebookRefresh.target)}>コードブックを再読み込み</Button>
        </Space>}
      />}
      <ProvenanceHistoryPanel />

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

        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#ffffff',
            padding: 14,
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
            </Space>
          </div>
          <Table
            size="small"
            pagination={false}
            scroll={{ x: 1045 }}
            dataSource={rows}
            columns={[
              {
                title: '列名',
                dataIndex: 'name',
                key: 'name',
                width: 280,
                render: (name: string, record) => {
                  if (record.isMaParent) return <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}><Typography.Text strong>{name}</Typography.Text><Tag color="blue">MA・{record.children.length}選択肢</Tag></Space>
                  const isNumeric = record.schema?.semanticType === 'numeric' || typeof record.min === 'number'
                  return (
                    <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}>
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
                  const observedCategories = record.schema?.categories || Object.keys(record.frequencies || {})
                  const categoriesComplete = Number.isFinite(record.schema?.uniqueCount)
                    && record.schema.uniqueCount === observedCategories.length
                  const missingCodes = new Set(definitionMap.get(record.name)?.missingCodes ?? [])
                  const categories = observedCategories
                    .filter((category: string) => !missingCodes.has(category))

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
                          onClick={() => setOneHotModalTarget({ col: record.name, categories, categoriesComplete })}
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

      {/* Modals */}
      {binModalTarget && (
        <BinningModal
          open={Boolean(binModalTarget)}
          datasetId={selection.datasetId}
          dataRevision={selection.dataRevision}
          columnName={binModalTarget}
          onClose={() => setBinModalTarget(null)}
          onSuccess={notifyDatasetMutationCommitted}
        />
      )}

      {oneHotModalTarget && (
        <OneHotModal
          open={Boolean(oneHotModalTarget)}
          datasetId={selection.datasetId}
          columnName={oneHotModalTarget.col}
          categories={oneHotModalTarget.categories}
          categoriesComplete={oneHotModalTarget.categoriesComplete}
          onClose={() => setOneHotModalTarget(null)}
          onSuccess={notifyDatasetMutationCommitted}
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
          onSuccess={notifyDatasetMutationCommitted}
        />
      )}

      {addVarModalOpen && (
        <AddVariableModal
          open={addVarModalOpen}
          datasetId={selection.datasetId}
          dataRevision={selection.dataRevision}
          schemaRevision={schemaRevision}
          datasetName={meta?.name ?? selection.datasetId}
          columns={Object.keys(summary?.columns ?? {})}
          onClose={() => setAddVarModalOpen(false)}
          onSuccess={notifyDatasetMutationCommitted}
        />
      )}
    </div>
  )
}
