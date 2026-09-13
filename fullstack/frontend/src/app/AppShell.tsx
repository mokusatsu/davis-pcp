import { useCallback, useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Badge, Button, Dropdown, Input, Layout, List, Modal, Segmented,
  Select, Space, Tag, Tooltip, Typography, Upload, notification,
} from 'antd'
import {
  BarChartOutlined, ClearOutlined, DownloadOutlined, FileTextOutlined, ImportOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SaveOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch, VariableMetaItem } from './store'
import { datasetLoaded, selectionCleared, focusSelected, deleteSelected, statsScopeSet, variablesInitialized } from './store'
import { api, downloadExport } from '../api/client'
import { FocusBar, useFocusMode } from '../features/common/FocusMode'
import GlobalHeaderControlBar from '../features/selection/GlobalHeaderControlBar'
import LicenseModal from '../features/common/LicenseModal'
import KeepAliveOutlet from './KeepAliveOutlet'
import CodebookEditorModal from '../features/dataset/CodebookEditorModal'
import * as codebookSlice from '../features/dataset/codebookSlice'
import { useL1Selection } from '../theme/useL1Selection'

interface DatasetListItem {
  datasetId: string
  name: string
  rowCount: number
  columnCount: number
}

export const VIS_NAV_ITEMS = [
  { key: '/pcp', label: 'PCP' },
  { key: '/table', label: 'Table' },
  { key: '/distribution', label: 'Distribution' },
  { key: '/likert', label: 'Likert' },
  { key: '/relationships', label: 'Relationships' },
  { key: '/associations', label: 'Surprise' },
  { key: '/touring', label: 'Touring' },
  { key: '/mosaic', label: 'Mosaic' },
  { key: '/crosstab', label: 'Crosstab' },
  { key: '/fedf', label: 'FEDF' },
  { key: '/barchart', label: 'Bar Chart' },
  { key: '/loess', label: 'Loess' },
]

export const ANALYSIS_NAV_ITEMS = [
  { key: '/ranking', label: 'Ranking' },
  { key: '/subgroups', label: 'Mining' },
  { key: '/robustness', label: 'Robustness' },
  { key: '/key-drivers', label: 'Key Drivers' },
  { key: '/penalty-reward', label: 'Penalty-Reward' },
  { key: '/clusters', label: 'Clusters' },
  { key: '/models', label: 'Models' },
  { key: '/logistic', label: 'Logistic' },
  { key: '/discriminant', label: 'Discriminant' },
  { key: '/models/ca', label: 'CA' },
  { key: '/models/mca', label: 'MCA' },
  { key: '/models/famd', label: 'FAMD' },
  { key: '/models/linear-regression', label: '重回帰' },
  { key: '/pca', label: 'PCA' },
  { key: '/covariance', label: 'Covariance' },
  { key: '/statistics', label: 'Statistics' },
  { key: '/overview', label: 'Overview' },
]

export const NAV_ITEMS = [...VIS_NAV_ITEMS, ...ANALYSIS_NAV_ITEMS]

type ExportFormat = 'csv' | 'parquet' | 'arrow' | 'xlsx'
type ExportScope = 'selected' | 'active' | 'all'

export default function AppShell() {
  useL1Selection()
  const [notificationApi, notificationHolder] = notification.useNotification()
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const location = useLocation()
  // KeepAlive keeps inactive tabs mounted with display:none, so a body-level
  // dropdown left open would linger above the next tab. Column tooltips close
  // via event; antd Select/Popover close when their trigger loses focus.
  useEffect(() => {
    window.dispatchEvent(new Event('davis:close-column-questions'))
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }, [location.pathname])
  const selection = useSelector((s: RootState) => s.selection)
  const focused = useFocusMode().focused
  const [datasets, setDatasets] = useState<DatasetListItem[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [saveModal, setSaveModal] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [licenseModalOpen, setLicenseModalOpen] = useState(false)

  const refreshDatasets = useCallback(async () => {
    const result = await api.get<{ datasets: DatasetListItem[] }>('/datasets').catch(() => ({ datasets: [] }))
    setDatasets(result.datasets)
    return result.datasets
  }, [])

  const loadDataset = useCallback(async (datasetId: string, name?: string) => {
    const meta = await api.get<{
      name: string
      dataRevision: number
      schema: Array<{
        columnId: string
        name: string
        semanticType: string
        physicalType?: string
        missingCount?: number
      }>
    }>(`/datasets/${datasetId}`)
    const { fetchArrowView } = await import('../api/client')
    const data = await fetchArrowView(datasetId, [])
    dispatch(datasetLoaded({ datasetId, name: name || meta.name, rowIds: data.__rowId__ as string[], dataRevision: meta.dataRevision }))

    const colNames = meta.schema.map((c) => c.name)
    const varMeta: Record<string, VariableMetaItem> = {}
    meta.schema.forEach((c) => {
      varMeta[c.name] = {
        columnId: c.columnId,
        name: c.name,
        semanticType: (c.semanticType as any) || 'numeric',
        physicalType: c.physicalType || 'Float64',
        missingCount: c.missingCount || 0,
        isTargetCandidate: c.semanticType === 'nominal' || c.semanticType === 'ordinal' || c.semanticType === 'categorical',
      }
    })
    dispatch(variablesInitialized({ variables: colNames, meta: varMeta, datasetId }))
    // Codebook fetch reconciles MA children into parent entities via
    // globalVariablesSlice extraReducers (reconcileEntities).
    await dispatch(codebookSlice.fetchCodebookThunk(datasetId))
  }, [dispatch])

  // Bootstrap: auto-load built-in Iris sample on first launch.
  useEffect(() => {
    if (selection.datasetId) return
    let cancelled = false
    void (async () => {
      const list = await refreshDatasets()
      if (cancelled) return
      if (list.length === 0) {
        const created = await api.post<{ datasetId: string; name: string }>('/datasets/import/sample', { name: 'Iris (built-in sample)' })
        if (cancelled) return
        await loadDataset(created.datasetId, created.name)
        await refreshDatasets()
      } else {
        const iris = list.find((d) => d.name === 'Iris (built-in sample)') ?? list.find((d) => d.name.toLowerCase().includes('iris'))
        const first = iris ?? list[0]
        await loadDataset(first.datasetId, first.name)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selection.datasetId, refreshDatasets, loadDataset])

  const onDatasetSelected = async (datasetId: string) => {
    await loadDataset(datasetId)
  }

  const onImport = async (file: File) => {
    try {
      const meta = await api.upload<{ datasetId: string; name: string }>('/datasets/import', file)
      await refreshDatasets()
      await onDatasetSelected(meta.datasetId)
      notificationApi.success({ message: 'import完了', description: `${meta.name} を取り込みました。` })
    } catch (error) {
      const err = error as { message: string; suggestedActions?: string[] }
      notificationApi.error({ message: 'import失敗', description: err.message, duration: 0 })
    }
  }

  const saveSession = async () => {
    if (!selection.datasetId) return
    const state = {
      selectedRowIds: selection.selectedRowIds,
      activeRowIds: selection.activeRowIds,
      groups: selection.groups,
      savedAt: new Date().toISOString(),
    }
    if (currentSessionId) {
      try {
        const updated = await api.put<{ revision: number }>(`/sessions/${currentSessionId}`, { state })
        setRevision(updated.revision)
        notificationApi.success({ message: `保存済み (revision ${updated.revision})` })
      } catch (error) {
        const err = error as { code: string; message: string; details?: { state?: unknown } }
        if (err.code === 'SESSION_CONFLICT') {
          Modal.confirm({
            title: 'セッション競合',
            content: '他のクライアントが保存しています。再読込しますか？',
            okText: '再読込',
            cancelText: 'コピーとして保存',
            onOk: async () => {
              const server = await api.get<{ state: unknown }>(`/sessions/${currentSessionId}`)
              notificationApi.info({ message: 'サーバー状態を再読込しました。' })
              return server
            },
            onCancel: () => { void saveAsCopy() },
          })
        }
      }
    } else {
      const created = await api.post<{ sessionId: string; revision: number }>('/sessions', {
        name: sessionName || `Session ${new Date().toLocaleString('ja-JP')}`,
        datasetId: selection.datasetId,
        state,
      })
      setCurrentSessionId(created.sessionId)
      setRevision(created.revision)
      notificationApi.success({ message: `セッション保存 (revision ${created.revision})` })
    }
    setSaveModal(false)
  }

  const saveAsCopy = async () => {
    const created = await api.post<{ sessionId: string; revision: number }>('/sessions', {
      name: `${sessionName || 'Session'} (copy)`,
      datasetId: selection.datasetId,
      state: { selectedRowIds: selection.selectedRowIds, activeRowIds: selection.activeRowIds, groups: selection.groups },
    })
    setCurrentSessionId(created.sessionId)
    setRevision(created.revision)
  }

  const selectedCount = selection.selectedRowIds.length
  const activeCount = selection.activeRowIds.length
  const totalCount = selection.allRowIds.length

  const selectedIdsPreview = selection.selectedRowIds.slice(0, 500)

  useEffect(() => {
    if (!selection.datasetId) {
      dispatch(codebookSlice.codebookReset())
      return
    }
    void dispatch(codebookSlice.fetchCodebookThunk(selection.datasetId))
  }, [selection.datasetId, selection.revision, dispatch])

  const exportData = useCallback(async (
    datasetId: string,
    scope: ExportScope,
    format: ExportFormat,
    rowIds?: string[],
    useValueLabels = false,
  ) => {
    return downloadExport(datasetId, scope, format, rowIds, useValueLabels)
  }, [])

  const handleExport = useCallback((
    scope: ExportScope,
    format: ExportFormat,
    rowIds?: string[],
    useValueLabels = false,
  ) => {
    if (!selection.datasetId) return
    void exportData(selection.datasetId, scope, format, rowIds, useValueLabels).catch(error => notificationApi.error({ message: 'エクスポートに失敗しました', description: String(error) }))
  }, [selection.datasetId, exportData])

  const sidebarContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <Typography.Text strong>選択行 {selectedCount} / active {activeCount} / 全{totalCount}</Typography.Text>
      <Space.Compact style={{ width: '100%' }}>
        <Button size="small" onClick={() => dispatch(selectionCleared())} icon={<ClearOutlined />} disabled={!selectedCount}>解除</Button>
        <Button size="small" onClick={() => dispatch(focusSelected())} disabled={!selectedCount}>Focus</Button>
        <Button size="small" danger onClick={() => dispatch(deleteSelected())} disabled={!selectedCount}>Delete</Button>
      </Space.Compact>
      <Button
        size="small"
        icon={<BarChartOutlined />}
        disabled={!selectedCount}
        onClick={() => {
          dispatch(statsScopeSet('selected'))
          navigate('/statistics')
        }}
        data-testid="sidebar-stats-button"
      >
        記述統計
      </Button>
      <Button
        size="small"
        icon={<DownloadOutlined />}
        disabled={!selectedCount}
        onClick={() => selection.datasetId && handleExport('selected', 'csv', selection.selectedRowIds)}
      >
        選択行CSV
      </Button>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <List
          size="small"
          dataSource={selectedIdsPreview}
          renderItem={(id) => (
            <List.Item style={{ padding: '2px 8px' }}>
              <Typography.Text style={{ fontSize: 12 }}>{id}</Typography.Text>
            </List.Item>
          )}
          footer={selectedCount > 500 ? `…ほか${selectedCount - 500}行` : undefined}
        />
      </div>
    </div>
  )

  return (
    <Layout style={{ height: '100vh', minHeight: '100vh', display: 'flex', flexDirection: 'column' }} data-testid="app-shell">
      {notificationHolder}
      {!focused && (
      <Layout.Header style={{
        background: '#fff',
        borderBottom: '1px solid #e5e7eb',
        padding: '10px 16px',
        height: 'auto',
        minHeight: 'auto',
        lineHeight: 'normal',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        flexShrink: 0,
        position: 'relative',
        zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', width: '100%' }}>
          <Typography.Title level={4} style={{ margin: 0, whiteSpace: 'nowrap' }}>DAVIS-PCP</Typography.Title>
          <Select
            data-testid="dataset-selector"
            showSearch
            placeholder="データセット"
            style={{ minWidth: 200 }}
            optionFilterProp="label"
            value={selection.datasetId ?? undefined}
            options={datasets.map((d) => ({ value: d.datasetId, label: `${d.name} (${d.rowCount}行)` }))}
            onChange={(value) => void onDatasetSelected(value)}
            onOpenChange={(visible) => { if (visible) void refreshDatasets() }}
            getPopupContainer={() => document.body}
          />
          <Upload
            accept=".csv,.tsv,.parquet,.arff,.arrow,.feather,.db,.sqlite"
            showUploadList={false}
            beforeUpload={(file) => {
              // Upload.Dragger-less inline upload: bypass antd's post pipeline and
              // call the API directly (headless file-chooser audit #12).
              void onImport(file as unknown as File)
              return false
            }}
          >
            <Button data-testid="import-button" icon={<ImportOutlined />}>Import</Button>
          </Upload>
          <Button data-testid="save-button" icon={<SaveOutlined />} onClick={() => setSaveModal(true)} disabled={!selection.datasetId}>Save</Button>
          <Tooltip title="Save As Copy">
            <Button icon={<DownloadOutlined />} onClick={() => void saveAsCopy()} disabled={!selection.datasetId}>Save As</Button>
          </Tooltip>
          <Dropdown
            getPopupContainer={() => document.body}
            menu={{
              items: [
                {
                  key: 'export-csv-all',
                  label: '全行 CSV',
                  icon: <DownloadOutlined />,
                  onClick: () => handleExport('all', 'csv'),
                },
                {
                  key: 'export-csv-selected',
                  label: `選択行 CSV (${selection.selectedRowIds.length}行)`,
                  icon: <DownloadOutlined />,
                  disabled: selection.selectedRowIds.length === 0,
                  onClick: () => handleExport('selected', 'csv', selection.selectedRowIds),
                },
                {
                  key: 'export-csv-selected-value-label',
                  label: `選択行 CSV (値ラベル付き) (${selection.selectedRowIds.length}行)`,
                  icon: <DownloadOutlined />,
                  disabled: selection.selectedRowIds.length === 0,
                  onClick: () => handleExport('selected', 'csv', selection.selectedRowIds, true),
                },
                {
                  key: 'export-csv-all-value-label',
                  label: '全行 CSV (値ラベル付き)',
                  icon: <DownloadOutlined />,
                  onClick: () => handleExport('all', 'csv', undefined, true),
                },
                {
                  key: 'export-xlsx-all-value-label',
                  label: '全行 Excel (値ラベル付き)',
                  icon: <DownloadOutlined />,
                  onClick: () => handleExport('all', 'xlsx', undefined, true),
                },
                { type: 'divider' },
                {
                  key: 'export-parquet',
                  label: '全行 Parquet',
                  onClick: () => handleExport('all', 'parquet'),
                },
                {
                  key: 'export-arrow',
                  label: '全行 Arrow IPC',
                  onClick: () => handleExport('all', 'arrow'),
                },
              ],
            }}
          >
            <Button data-testid="export-button" icon={<DownloadOutlined />} disabled={!selection.datasetId}>Export</Button>
          </Dropdown>
          <Button
            data-testid="codebook-button"
            icon={<FileTextOutlined />}
            style={{ borderColor: '#8b5cf6', color: '#7c3aed' }}
            disabled={!selection.datasetId}
            onClick={() => dispatch(codebookSlice.editorModalOpened())}
          >
            コードブック
          </Button>
          {currentSessionId && <Badge count={`r${revision}`} style={{ backgroundColor: '#52c41a' }} />}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            <Button
              data-testid="license-button"
              icon={<SafetyCertificateOutlined />}
              onClick={() => setLicenseModalOpen(true)}
            >
              License
            </Button>
          </div>
        </div>
        {selection.datasetId && <GlobalHeaderControlBar />}
        <div data-testid="main-nav" style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflowX: 'auto' }}>
            <Tag color="blue" style={{ margin: 0, minWidth: 70, textAlign: 'center', fontSize: 11, fontWeight: 500 }}>可視化・探索</Tag>
            <Segmented
              size="small"
              options={VIS_NAV_ITEMS.map((item) => ({ label: item.label, value: item.key }))}
              value={VIS_NAV_ITEMS.some((i) => i.key === location.pathname) ? location.pathname : ''}
              onChange={(value) => navigate(String(value))}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflowX: 'auto' }}>
            <Tag color="purple" style={{ margin: 0, minWidth: 70, textAlign: 'center', fontSize: 11, fontWeight: 500 }}>分析・統計</Tag>
            <Segmented
              size="small"
              options={ANALYSIS_NAV_ITEMS.map((item) => ({ label: item.label, value: item.key }))}
              value={ANALYSIS_NAV_ITEMS.some((i) => i.key === location.pathname) ? location.pathname : ''}
              onChange={(value) => navigate(String(value))}
            />
          </div>
        </div>
      </Layout.Header>
      )}
      <Layout.Content style={{
        padding: focused ? 4 : 12,
        display: 'flex', gap: 4,
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}>
        <div style={{ flex: 1, minWidth: 0, overflowX: 'hidden', overflowY: focused ? 'hidden' : 'auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <KeepAliveOutlet />
        </div>
        {!focused && (
        <>
        {/* Collapse button rides on the sidebar's left edge, on every page. */}
        <Button
          data-testid="toggle-sidebar"
          size="small"
          icon={sidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
          onClick={() => setSidebarOpen((open) => !open)}
          aria-label="選択行サイドバーの切替"
          style={{ alignSelf: 'flex-start', flexShrink: 0, marginTop: 2 }}
        />
        {sidebarOpen ? (
          <aside data-testid="selected-sidebar" style={{ width: 240, border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, overflow: 'auto', flexShrink: 0 }}>
            {sidebarContent}
          </aside>
        ) : null}
        </>
        )}
        <FocusBar />
      </Layout.Content>
      <Modal
        title="セッション保存"
        open={saveModal}
        onOk={() => void saveSession()}
        onCancel={() => setSaveModal(false)}
        okText="保存"
      >
        <Input data-testid="session-name" placeholder="セッション名" value={sessionName} onChange={(e) => setSessionName(e.target.value)} />
      </Modal>
      <LicenseModal open={licenseModalOpen} onClose={() => setLicenseModalOpen(false)} />
      <CodebookEditorModal />
    </Layout>
  )
}
