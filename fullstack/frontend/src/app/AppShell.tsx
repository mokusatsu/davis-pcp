import { SELECTION_LABELS } from '../features/selection/selectionLabels'
import { useWorkspacePersistence } from './useWorkspacePersistence'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Alert, Badge, Button, ConfigProvider, Drawer, Dropdown, Grid, Input, Layout, List, Menu, Modal,
  Select, Space, Tooltip, Typography, Upload, notification,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  BarChartOutlined, ClearOutlined, DownloadOutlined, FileTextOutlined, ImportOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SaveOutlined, SafetyCertificateOutlined, UnorderedListOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from './store'
import { selectionCleared, focusSelected, deleteSelected, observationScopeChanged } from './store'
import { api, downloadExport } from '../api/client'
import { normalizePageKey, useGraphExpansion } from '../features/common/GraphExpansion'
import GlobalHeaderControlBar from '../features/selection/GlobalHeaderControlBar'
import LicenseModal from '../features/common/LicenseModal'
import KeepAliveOutlet from './KeepAliveOutlet'
import CodebookEditorModal from '../features/dataset/CodebookEditorModal'
import DatasetLicenseNotice from '../features/dataset/DatasetLicenseNotice'
import * as codebookSlice from '../features/dataset/codebookSlice'
import { useL1Selection } from '../theme/useL1Selection'

interface BuiltinSampleItem { id: string; name: string; rowCount: number; datasetId?: string | null }

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
  const workspaceCodebookId = useSelector((s: RootState) => s.codebook.datasetId)
  const mainContentRef = useRef<HTMLDivElement>(null)
  const { notifyRoute, session: graphSession } = useGraphExpansion()
  // Router 内の AppShell から正規化 pageKey と datasetId を共通部へ通知する
  // （Provider 自身は RouterProvider の外にあるため useLocation を呼ばない）。
  useLayoutEffect(() => {
    notifyRoute(normalizePageKey(location.pathname), selection.datasetId ?? null)
  }, [location.pathname, selection.datasetId, notifyRoute])
  const [datasets, setDatasets] = useState<DatasetListItem[]>([])
  const [builtinSamples, setBuiltinSamples] = useState<BuiltinSampleItem[]>([])
  const builtinSamplesRef = useRef<BuiltinSampleItem[]>([])
  const [datasetListError, setDatasetListError] = useState<string | null>(null)
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)
  const screens = Grid.useBreakpoint()
  const isMobileSidebar = screens.md !== true
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const desktopSidebarHasFocus = useRef(false)
  // Mobile overlays are transient; resizing must not overwrite the user's
  // desktop sidebar preference (or squeeze a narrow analysis into 240px less).
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const sidebarOpen = isMobileSidebar ? mobileSidebarOpen : desktopSidebarOpen
  useEffect(() => {
    setMobileSidebarOpen(false)
  }, [isMobileSidebar, location.key, selection.datasetId, Boolean(graphSession)])
  useLayoutEffect(() => {
    if (isMobileSidebar && desktopSidebarHasFocus.current) {
      sidebarToggleRef.current?.focus()
      desktopSidebarHasFocus.current = false
    }
  }, [isMobileSidebar])
  const notifySaved = useCallback((message: string) => notificationApi.success({ message }), [notificationApi])
  const persistence = useWorkspacePersistence(notifySaved)
  const { loadDataset } = persistence
  const [licenseModalOpen, setLicenseModalOpen] = useState(false)

  const refreshDatasets = useCallback(async () => {
    try {
      let catalogError: unknown = null
      const [result, catalog] = await Promise.all([
        api.get<{ datasets: DatasetListItem[] }>('/datasets'),
        api.get<{ samples: BuiltinSampleItem[] }>('/datasets/samples').catch(error => { catalogError = error; return null }),
      ])
      if (catalog) { builtinSamplesRef.current = catalog.samples ?? []; setBuiltinSamples(builtinSamplesRef.current) }
      setDatasets(result.datasets); setDatasetListError(catalogError ? `組込みサンプル一覧を読み込めませんでした: ${(catalogError as { message?: string }).message || String(catalogError)}` : null)
      return result.datasets
    } catch (error) {
      setDatasetListError(`データセット一覧を読み込めませんでした: ${(error as { message?: string }).message || String(error)}`)
      return null
    }
  }, [])

  // Bootstrap: auto-load built-in Iris sample on first launch.
  useEffect(() => {
    if (selection.datasetId) return
    let cancelled = false
    const intent = persistence.beginDatasetIntent()
    void (async () => {
      const list = await refreshDatasets()
      if (cancelled || !list || intent === null || !persistence.isCurrentDatasetIntent(intent)) return
      if (list.length === 0) {
        const created = await api.post<{ datasetId: string; name: string }>('/datasets/import/sample', { name: 'Iris (built-in sample)' })
        if (cancelled || !persistence.isCurrentDatasetIntent(intent)) return
        await loadDataset(created.datasetId, created.name)
        await refreshDatasets()
      } else {
        const officialIrisId = builtinSamplesRef.current.find(sample => sample.id === 'iris')?.datasetId
        const iris = list.find(dataset => dataset.datasetId === officialIrisId)
        const first = iris ?? list[0]
        if (iris) {
          const created = await api.post<{ datasetId: string; name: string }>('/datasets/import/sample', { sampleId: 'iris' })
          if (cancelled || !persistence.isCurrentDatasetIntent(intent)) return
          await loadDataset(created.datasetId, created.name)
        } else await loadDataset(first.datasetId, first.name)
      }
    })().catch(error => { if (!cancelled) setDatasetListError(`初期データセットを読み込めませんでした: ${error.message || String(error)}`) })
      .finally(() => { if (intent !== null) persistence.finishDatasetIntent(intent) })
    return () => {
      cancelled = true
    }
  }, [selection.datasetId, refreshDatasets, loadDataset, bootstrapAttempt])

  const onDatasetSelected = async (datasetId: string) => {
    const sampleId = datasetId.startsWith('builtin:') ? datasetId.slice(8)
      : builtinSamples.find(sample => sample.datasetId === datasetId)?.id
    if (sampleId) {
      await persistence.loadBuiltinSample(sampleId, true, datasetId)
      await refreshDatasets()
    } else await loadDataset(datasetId, undefined, true)
  }

  const onImport = async (file: File) => {
    // Import is a dataset intent from the moment the user submits the file,
    // not from when its slower upload finishes. A later selection must win.
    const intent = persistence.beginDatasetIntent()
    if (intent === null) return
    try {
      const meta = await api.upload<{ datasetId: string; name: string }>('/datasets/import', file)
      await refreshDatasets()
      if (persistence.isCurrentDatasetIntent(intent)) {
        const loaded = await loadDataset(meta.datasetId)
        if (!loaded) return
      }
      notificationApi.success({ message: 'import完了', description: `${meta.name} を取り込みました。` })
    } catch (error) {
      const err = error as { message: string; suggestedActions?: string[] }
      notificationApi.error({ message: 'import失敗', description: err.message, duration: 0 })
    } finally {
      persistence.finishDatasetIntent(intent)
    }
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
    if (workspaceCodebookId !== selection.datasetId) void dispatch(codebookSlice.fetchCodebookThunk(selection.datasetId))
  }, [selection.datasetId, selection.revision, workspaceCodebookId, dispatch])

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
      <Space wrap style={{ width: '100%' }}>
        <Button size="small" onClick={() => dispatch(selectionCleared())} icon={<ClearOutlined />} disabled={!selectedCount}>{SELECTION_LABELS.clear}</Button>
        <Button size="small" onClick={() => dispatch(focusSelected())} disabled={!selectedCount}>{SELECTION_LABELS.focus}</Button>
        <Button size="small" danger onClick={() => dispatch(deleteSelected())} disabled={!selectedCount}>{SELECTION_LABELS.exclude}</Button>
      </Space>
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
    <Layout style={{ height: '100dvh', minHeight: 0, display: 'flex', flexDirection: 'column', overflowX: 'hidden', overflowY: 'auto' }} data-testid="app-shell">
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
            value={persistence.pendingDataset ?? selection.datasetId ?? undefined}
            loading={persistence.loadBusy}
            disabled={persistence.saveBusy || Boolean(persistence.openingSession)}
            options={[...datasets.map((d) => ({ value: d.datasetId, label: `${d.name} (${d.rowCount}行)` })),
              ...builtinSamples.filter(sample => !sample.datasetId).map(sample => ({ value: `builtin:${sample.id}`,
                label: `${sample.name} (${sample.rowCount}行・組込み)` }))]}
            onChange={(value) => void onDatasetSelected(value)}
            onOpenChange={(visible) => { if (visible) void refreshDatasets() }}
            getPopupContainer={() => document.body}
          />
          <Upload disabled={persistence.saveBusy || persistence.loadBusy}
            accept=".csv,.tsv,.parquet,.arff,.arrow,.feather,.db,.sqlite"
            showUploadList={false}
            beforeUpload={(file) => {
              // Upload.Dragger-less inline upload: bypass antd's post pipeline and
              // call the API directly (headless file-chooser audit #12).
              void onImport(file as unknown as File)
              return false
            }}
          >
            <Button disabled={persistence.saveBusy || persistence.loadBusy} data-testid="import-button" icon={<ImportOutlined />}>インポート</Button>
          </Upload>
          <Button data-testid="save-button" icon={<SaveOutlined />} onClick={() => persistence.beginSave()} disabled={!selection.datasetId || persistence.loadBusy || persistence.saveBusy}>Save</Button>
          <Button data-testid="open-session-button" onClick={persistence.showSessions} disabled={persistence.saveBusy || persistence.loadBusy}>セッションを開く</Button>
          <Tooltip title="Save As Copy">
            <Button icon={<DownloadOutlined />} onClick={() => persistence.beginSave(true)} disabled={!selection.datasetId || persistence.loadBusy || persistence.saveBusy}>Save As</Button>
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
            <Button data-testid="export-button" icon={<DownloadOutlined />} disabled={!selection.datasetId}>エクスポート</Button>
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
          {persistence.identity?.datasetId === selection.datasetId && <Badge count={`r${persistence.identity?.revision}`} style={{ backgroundColor: '#52c41a' }} />}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            <Button
              data-testid="license-button"
              icon={<SafetyCertificateOutlined />}
              onClick={() => setLicenseModalOpen(true)}
            >
              ライセンス
            </Button>
          </div>
        </div>
        {datasetListError && <Alert type="error" showIcon message={datasetListError} action={<Button onClick={() => { if (selection.datasetId) void refreshDatasets(); else setBootstrapAttempt(value => value + 1) }}>一覧を再試行</Button>} />}
        {persistence.loadBusy && <Typography.Text role="status">{persistence.openingSession ? 'セッションとデータセットを読み込んでいます…' : 'データセットを読み込んでいます…'}</Typography.Text>}
        {persistence.loadError && <Alert type="error" showIcon message={persistence.loadError} action={<Button disabled={persistence.loadBusy} onClick={() => void persistence.retryLoad()}>再試行</Button>} />}
        <FeatureNavigation
          datasetId={selection.datasetId ?? null}
          expanded={Boolean(graphSession)}
          onKeyboardNavigate={() => {
            window.setTimeout(() => mainContentRef.current?.focus(), 0)
          }}
        />
        {selection.datasetId && <GlobalHeaderControlBar />}
      </Layout.Header>
      <Layout.Content data-testid="analysis-workspace" style={{
        padding: 12,
        display: 'flex', gap: 4,
        flex: 1,
        // Keep the usual single analysis scroller when the header fits. At
        // browser zoom / short window heights the shell can scroll the header
        // away instead of shrinking the analysis viewport to zero.
        minHeight: 'min(320px, 100dvh)',
        minWidth: 0,
        overflow: 'hidden',
      }}>
        <div ref={mainContentRef} role="main" aria-label="分析画面" tabIndex={-1} style={{ flex: 1, minWidth: 0, overflowX: 'hidden', overflowY: 'auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <KeepAliveOutlet />
        </div>
        {/* Collapse button rides on the sidebar's left edge, on every page. */}
        <Button
          ref={sidebarToggleRef}
          data-testid="toggle-sidebar"
          size="small"
          icon={sidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
          onClick={(event) => {
            if (isMobileSidebar) {
              // Drawer restores focus to its opener after Escape/mask/close.
              event.currentTarget.focus()
              setMobileSidebarOpen((open) => !open)
            } else setDesktopSidebarOpen((open) => !open)
          }}
          aria-label="選択行サイドバーの切替"
          aria-expanded={sidebarOpen}
          aria-controls={isMobileSidebar ? 'selected-rows-drawer' : 'selected-rows-sidebar'}
          aria-haspopup={isMobileSidebar ? 'dialog' : undefined}
          style={{ alignSelf: 'flex-start', flexShrink: 0, marginTop: 2 }}
        />
        {!isMobileSidebar && desktopSidebarOpen ? (
          <aside
            id="selected-rows-sidebar"
            aria-label="選択行"
            data-testid="selected-sidebar"
            onFocusCapture={() => { desktopSidebarHasFocus.current = true }}
            onBlurCapture={(event) => { desktopSidebarHasFocus.current = event.currentTarget.contains(event.relatedTarget) }}
            style={{ width: 240, border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, overflow: 'auto', flexShrink: 0 }}
          >
            {sidebarContent}
          </aside>
        ) : null}
      </Layout.Content>
      <Drawer
        id="selected-rows-drawer"
        title="選択行"
        placement="right"
        width="min(320px, calc(100vw - 24px))"
        open={isMobileSidebar && mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
        closable={{ 'aria-label': '選択行サイドバーを閉じる' }}
        destroyOnHidden
        styles={{ body: { padding: 12 } }}
      >
        {sidebarContent}
      </Drawer>
      <Modal
        title="セッション保存"
        destroyOnClose
        open={persistence.saveModal}
        onOk={() => void persistence.saveSession()}
        onCancel={persistence.closeSave}
        confirmLoading={persistence.saveBusy}
        okButtonProps={{ disabled: persistence.saveBusy || persistence.loadBusy }}
        cancelButtonProps={{ disabled: persistence.saveBusy || persistence.loadBusy }}
        closable={!persistence.saveBusy && !persistence.loadBusy}
        maskClosable={!persistence.saveBusy && !persistence.loadBusy}
        keyboard={!persistence.saveBusy && !persistence.loadBusy}
        okText="保存"
      >
        <Typography.Paragraph>共通分析対象（対象行・選択行・標本・使用変数・グループ）を保存します。各分析画面の計算結果や個別設定は含みません。</Typography.Paragraph>
        <Input data-testid="session-name" aria-label="セッション名" placeholder="セッション名" value={persistence.sessionName} disabled={persistence.saveBusy || persistence.loadBusy} onChange={(e) => persistence.setSessionName(e.target.value)} />
        {persistence.saveBusy && <Typography.Paragraph role="status">保存処理中は閉じられません。完了までお待ちください。</Typography.Paragraph>}
        {persistence.saveError && <Alert type="error" showIcon message={persistence.saveError} />}
        {persistence.conflict && <Space wrap>
          <Button disabled={persistence.saveBusy || persistence.loadBusy} onClick={() => persistence.identity && void persistence.openSession(persistence.identity.sessionId)}>保存済みを開き直す</Button>
          <Button disabled={persistence.saveBusy || persistence.loadBusy} onClick={() => void persistence.saveSession(true)}>コピーとして保存</Button>
        </Space>}
      </Modal>
      <Modal title="保存済みセッションを開く" destroyOnClose open={persistence.sessionsModal} onCancel={persistence.closeSessions} footer={null}
        closable={!persistence.loadBusy} maskClosable={!persistence.loadBusy} keyboard={!persistence.loadBusy}>
        <Typography.Paragraph>保存時と同じデータセット・データ世代の共通分析対象を復元します。現在の共通設定は置き換わります。世代が異なるセッションは開けません。</Typography.Paragraph>
        <Button loading={persistence.listBusy} disabled={persistence.loadBusy} onClick={() => void persistence.refreshSessions()}>一覧を再読込</Button>
        {persistence.listError && <Alert type="error" showIcon message={persistence.listError} />}
        <List loading={persistence.listBusy} locale={{ emptyText: '保存済みセッションがありません。' }} dataSource={persistence.sessions}
          renderItem={item => <List.Item actions={[<Button key="open" aria-label={`${item.name} を開く`} loading={persistence.openingSession === item.sessionId}
            disabled={persistence.loadBusy} onClick={() => void persistence.openSession(item.sessionId)}>開く</Button>]}>
            <List.Item.Meta title={item.name} description={`データセット: ${item.datasetId} / revision ${item.revision}${item.updatedAt ? ` / ${item.updatedAt}` : ''}`} />
          </List.Item>} />
      </Modal>
      <LicenseModal open={licenseModalOpen} onClose={() => setLicenseModalOpen(false)} />
      <CodebookEditorModal />
      <DatasetLicenseNotice license={persistence.datasetLicense} onClose={persistence.dismissDatasetLicense} />
    </Layout>
  )
}
