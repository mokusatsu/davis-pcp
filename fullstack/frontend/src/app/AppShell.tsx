import { createAnalysisWorkspaceSnapshot, readAnalysisWorkspaceSnapshot } from '../features/selection/workspaceSession'
import { analysisWorkspaceRestored } from './store'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDispatch, useSelector, useStore } from 'react-redux'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Badge, Button, ConfigProvider, Dropdown, Grid, Input, Layout, List, Menu, Modal,
  Select, Space, Tooltip, Typography, Upload, notification,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  BarChartOutlined, ClearOutlined, DownloadOutlined, FileTextOutlined, ImportOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SaveOutlined, SafetyCertificateOutlined, UnorderedListOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch, VariableMetaItem } from './store'
import { datasetLoaded, selectionCleared, focusSelected, deleteSelected, observationScopeChanged, variablesInitialized } from './store'
import { api, downloadExport } from '../api/client'
import { normalizePageKey, useGraphExpansion } from '../features/common/GraphExpansion'
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

export const NAV_GROUPS = [
  { key: 'group:data', label: 'データ・概要', children: [
    { key: '/table', label: 'データ表（Table）' },
    { key: '/overview', label: 'データ概要（Overview）' },
    { key: '/statistics', label: '記述統計（Statistics）' },
    { key: '/covariance', label: '共分散（Covariance）' },
  ] },
  { key: 'group:visual', label: '可視化', children: [
    { key: '/pcp', label: '平行座標（PCP）' },
    { key: '/distribution', label: '分布（Distribution）' },
    { key: '/likert', label: 'Likert' },
    { key: '/touring', label: 'Touring' },
    { key: '/fedf', label: 'FEDF' },
    { key: '/barchart', label: '棒グラフ（Bar Chart）' },
    { key: '/loess', label: 'Loess' },
  ] },
  { key: 'group:relations', label: '関係・集計', children: [
    { key: '/relationships', label: '変数間の関係（Relationships）' },
    { key: '/associations', label: 'Surprise' },
    { key: '/mosaic', label: 'Mosaic' },
    { key: '/crosstab', label: 'クロス集計（Crosstab）' },
  ] },
  { key: 'group:patterns', label: 'パターン探索', children: [
    { key: '/ranking', label: '変数ランキング（Ranking）' },
    { key: '/subgroups', label: 'Mining' },
    { key: '/clusters', label: 'クラスタリング（Clusters）' },
    { key: '/robustness', label: '頑健性（Robustness）' },
  ] },
  { key: 'group:prediction', label: '予測・要因分析', children: [
    { key: '/models', label: '決定木・ランダムフォレスト（Models）' },
    { key: '/logistic', label: 'ロジスティック回帰（Logistic）' },
    { key: '/discriminant', label: '判別分析（Discriminant）' },
    { key: '/models/linear-regression', label: '重回帰' },
    { key: '/key-drivers', label: 'Key Drivers' },
    { key: '/penalty-reward', label: 'Penalty-Reward' },
    { key: '/models/conjoint', label: 'コンジョイント' },
  ] },
  { key: 'group:dimensions', label: '次元削減・因子分析', children: [
    { key: '/pca', label: '主成分分析（PCA）' },
    { key: '/models/ca', label: '対応分析（CA）' },
    { key: '/models/mca', label: '多重対応分析（MCA）' },
    { key: '/models/famd', label: '混合データ因子分析（FAMD）' },
    { key: '/models/factor-analysis', label: '因子分析' },
  ] },
] satisfies MenuProps['items']

export const NAV_ITEMS = NAV_GROUPS.flatMap(group => group.children)

interface FeatureNavigationProps {
  datasetId: string | null
  expanded: boolean
  onKeyboardNavigate: () => void
}

export function FeatureNavigation(props: FeatureNavigationProps) {
  return (
    <ConfigProvider theme={{ token: { screenLG: 1024, screenLGMin: 1024, screenMDMax: 1023 } }}>
      <FeatureNavigationMenu {...props} />
    </ConfigProvider>
  )
}

function FeatureNavigationMenu({ datasetId, expanded, onKeyboardNavigate }: FeatureNavigationProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [openKeys, setOpenKeys] = useState<string[]>([])
  const [listOpen, setListOpen] = useState(false)
  const listButtonRef = useRef<HTMLButtonElement>(null)
  const screens = Grid.useBreakpoint()
  const isWide = screens.lg !== false
  const pathname = normalizePageKey(location.pathname)
  const current = NAV_ITEMS.find(item => item.key === pathname)
  const currentGroup = NAV_GROUPS.find(item => item.children.some(child => child.key === pathname))
  const currentLabel = current && currentGroup ? `${currentGroup.label} › ${current.label}` : '未登録の画面'

  // URL・dataset・拡大表示・幅の変更で開いた popup／展開領域を閉じる。
  useEffect(() => {
    setOpenKeys([])
    setListOpen(false)
  }, [location.key, datasetId, expanded, isWide])

  // 狭幅では現在地の分類を初期展開し、同時に開けるのは 1 分類だけ。
  const toggleList = (open: boolean) => {
    setListOpen(open)
    if (open) {
      setOpenKeys(currentGroup ? [currentGroup.key] : [])
    } else if (document.activeElement && document.activeElement !== listButtonRef.current) {
      listButtonRef.current?.focus()
    }
  }

  const onInlineOpenChange = (keys: string[]) => {
    if (keys.length === 0) { setOpenKeys([]); return }
    setOpenKeys([keys[keys.length - 1]])
  }

  return (
    <nav data-testid="main-nav" aria-label="機能ナビゲーション" className="feature-navigation">
      {isWide ? (
        <div
          className="feature-navigation-row"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && openKeys.length > 0) setOpenKeys([])
            // 葉のonClick後にrc-menuのEnter処理が走るため、その後で閉じる。
            if (event.key === 'Enter' && event.target instanceof Element && event.target.closest('.ant-menu-item')) {
              setOpenKeys([])
            }
          }}
        >
          <Menu
            mode="horizontal"
            className="feature-navigation-menu"
            items={NAV_GROUPS.map(item => ({ ...item, popupClassName: 'feature-navigation-popup' }))}
            selectedKeys={current ? [current.key] : []}
            openKeys={openKeys}
            onOpenChange={setOpenKeys}
            triggerSubMenuAction="click"
            overflowedIndicator="その他の分類"
            overflowedIndicatorPopupClassName="feature-navigation-popup"
            getPopupContainer={() => document.body}
            onClick={({ key, domEvent }) => {
              if (!NAV_ITEMS.some(item => item.key === key)) return
              setOpenKeys([])
              if (domEvent.type === 'keydown') onKeyboardNavigate()
              if (key !== pathname) navigate(key)
            }}
          />
          <span className="feature-navigation-current" title={currentLabel} aria-label={currentLabel} data-testid="navigation-current">
            {currentLabel}
          </span>
        </div>
      ) : (
        <div className="feature-navigation-compact">
          <Button
            ref={listButtonRef}
            data-testid="feature-list-button"
            icon={<UnorderedListOutlined />}
            aria-expanded={listOpen}
            aria-controls="feature-list-panel"
            onClick={() => toggleList(!listOpen)}
          >
            機能一覧
          </Button>
          <span className="feature-navigation-current" title={currentLabel} aria-label={currentLabel} data-testid="navigation-current">
            {currentLabel}
          </span>
          {listOpen && (
            <div
              id="feature-list-panel"
              className="feature-navigation-panel"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  toggleList(false)
                }
              }}
            >
              <Menu
                mode="inline"
                items={NAV_GROUPS}
                selectedKeys={current ? [current.key] : []}
                openKeys={openKeys}
                onOpenChange={onInlineOpenChange}
                triggerSubMenuAction="click"
                getPopupContainer={(node) => node.parentElement ?? document.body}
                onClick={({ key, domEvent }) => {
                  if (!NAV_ITEMS.some(item => item.key === key)) return
                  setListOpen(false)
                  if (domEvent.type === 'keydown') onKeyboardNavigate()
                  if (key !== pathname) navigate(key)
                }}
              />
            </div>
          )}
        </div>
      )}
    </nav>
  )
}

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
  const workspaceStore = useStore<RootState>()
  const mainContentRef = useRef<HTMLDivElement>(null)
  const { notifyRoute, session: graphSession } = useGraphExpansion()
  // Router 内の AppShell から正規化 pageKey と datasetId を共通部へ通知する
  // （Provider 自身は RouterProvider の外にあるため useLocation を呼ばない）。
  useLayoutEffect(() => {
    notifyRoute(normalizePageKey(location.pathname), selection.datasetId ?? null)
  }, [location.pathname, selection.datasetId, notifyRoute])
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
    const state = { ...createAnalysisWorkspaceSnapshot(workspaceStore.getState()), savedAt: new Date().toISOString() }
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
              try {
                const restored = readAnalysisWorkspaceSnapshot(server.state, workspaceStore.getState())
                dispatch(analysisWorkspaceRestored(restored))
                notificationApi.info({ message: '共通分析対象を再読込しました。' })
              } catch (error) { notificationApi.warning({ message: String(error) }) }
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
      state: createAnalysisWorkspaceSnapshot(workspaceStore.getState()),
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
          dispatch(observationScopeChanged('selected'))
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
        <FeatureNavigation
          datasetId={selection.datasetId ?? null}
          expanded={Boolean(graphSession)}
          onKeyboardNavigate={() => {
            window.setTimeout(() => mainContentRef.current?.focus(), 0)
          }}
        />
        {selection.datasetId && <GlobalHeaderControlBar />}
      </Layout.Header>
      <Layout.Content style={{
        padding: 12,
        display: 'flex', gap: 4,
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}>
        <div ref={mainContentRef} role="main" aria-label="分析画面" tabIndex={-1} style={{ flex: 1, minWidth: 0, overflowX: 'hidden', overflowY: 'auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <KeepAliveOutlet />
        </div>
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
