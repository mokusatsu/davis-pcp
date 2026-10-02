import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Button,
  Dropdown,
  MenuProps,
  Modal,
  Segmented,
  Space,
  Tag,
  Typography,
  notification,
} from 'antd'
import {
  AppstoreOutlined,
  BarsOutlined,
  DownOutlined,
  DownloadOutlined,
  FileTextOutlined,
  FormOutlined,
  ImportOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import type { AppDispatch, RootState } from '../../app/store'
import {
  activeColumnSelected,
  bulkLabelModalToggled,
  bulkLabelsApplied,
  draftColumnUpdated,
  draftReverted,
  editorModalClosed,
  fetchCodebookThunk,
  filterChanged,
  importDialogToggled,
  presetAppliedToColumns,
  quickValueLabelsApplied,
  saveCodebookThunk,
  selectedColumnsChanged,
  viewModeChanged,
} from './codebookSlice'
import { downloadCodebookExport } from '../../api/client'
import { getAllPresets } from './codebookPresets'
import CodebookVariableList from './CodebookVariableList'
import CodebookDetailForm from './CodebookDetailForm'
import CodebookGridView from './CodebookGridView'
import BulkLabelPasteModal from './BulkLabelPasteModal'
import CodebookCsvImportDialog from './CodebookCsvImportDialog'
import MultiResponseGroupDialog from './MultiResponseGroupDialog'

export default function CodebookEditorModal() {
  const [notificationApi, notificationHolder] = notification.useNotification()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const codebook = useSelector((s: RootState) => s.codebook)
  const [maOpen, setMaOpen] = useState(false)

  const datasetId = selection.datasetId
  const currentDatasetId = useRef(datasetId)
  currentDatasetId.current = datasetId

  // Load codebook when modal opens
  useEffect(() => {
    if (codebook.isEditorOpen && datasetId && datasetId !== codebook.datasetId) {
      dispatch(fetchCodebookThunk(datasetId))
    }
  }, [codebook.isEditorOpen, datasetId, codebook.datasetId, dispatch])

  const activeColumn = useMemo(() => {
    return (
      codebook.draftColumns.find((c) => c.columnId === codebook.activeColumnId) ||
      codebook.draftColumns[0]
    )
  }, [codebook.draftColumns, codebook.activeColumnId])

  // Count changed columns
  const changedCount = useMemo(() => {
    let count = 0
    const origMap = new Map(codebook.columns.map((c) => [c.columnId, c]))
    for (const draft of codebook.draftColumns) {
      const orig = origMap.get(draft.columnId)
      if (!orig || JSON.stringify(orig) !== JSON.stringify(draft)) {
        count++
      }
    }
    return count
  }, [codebook.columns, codebook.draftColumns])

  const handleSave = async () => {
    try {
      const resultAction = await dispatch(saveCodebookThunk())
      if (saveCodebookThunk.fulfilled.match(resultAction)) {
        notificationApi.success({
          message: 'コードブック保存完了',
          description: `コードブックの変更を保存しました（リビジョン: ${resultAction.payload.schemaRevision}）。`,
        })
      } else {
        throw new Error(resultAction.error.message || '保存に失敗しました')
      }
    } catch (err: any) {
      notificationApi.error({
        message: '保存失敗',
        description: err.message || 'コードブックの保存に失敗しました。',
      })
    }
  }

  const exportMenuItems: MenuProps['items'] = [
    {
      key: 'csv',
      label: 'CSV形式でエクスポート (.csv)',
      onClick: () => {
        if (datasetId) void downloadCodebookExport(datasetId, 'csv')
      },
    },
    {
      key: 'json',
      label: 'JSON形式でエクスポート (.json)',
      onClick: () => {
        if (datasetId) void downloadCodebookExport(datasetId, 'json')
      },
    },
  ]

  const presetBulkMenuItems: MenuProps['items'] = useMemo(() => {
    const allPresets = getAllPresets()
    const applyToTargets = (preset: any) => {
      const targets =
        codebook.selectedColumnIds.length > 0
          ? codebook.selectedColumnIds
          : activeColumn
          ? [activeColumn.columnId]
          : []
      if (targets.length > 0) {
        dispatch(presetAppliedToColumns({ columnIds: targets, preset }))
        notificationApi.info({
          message: 'プリセット適用',
          description: `${targets.length}件の変数に '${preset.name}' を適用しました。`,
        })
      }
    }

    const items: MenuProps['items'] = []
    if (allPresets.custom.length > 0) {
      items.push({
        type: 'group',
        label: `カスタムプリセット (${allPresets.custom.length}件)`,
        children: allPresets.custom.map((preset) => ({
          key: preset.id,
          label: preset.name,
          onClick: () => applyToTargets(preset),
        })),
      })
      items.push({ type: 'divider' })
    }

    items.push({
      type: 'group',
      label: '標準プリセット',
      children: allPresets.builtIn.map((preset) => ({
        key: preset.id,
        label: preset.name,
        onClick: () => applyToTargets(preset),
      })),
    })

    return items
  }, [codebook.selectedColumnIds, activeColumn, dispatch])

  const handleNavigate = (direction: 'prev' | 'next') => {
    if (!activeColumn) return
    const idx = codebook.draftColumns.findIndex((c) => c.columnId === activeColumn.columnId)
    if (idx === -1) return
    const nextIdx = direction === 'prev' ? idx - 1 : idx + 1
    if (nextIdx >= 0 && nextIdx < codebook.draftColumns.length) {
      dispatch(activeColumnSelected(codebook.draftColumns[nextIdx].columnId))
    }
  }

  return (
    <>
      {notificationHolder}
      <Modal
        open={codebook.isEditorOpen}
        onCancel={() => dispatch(editorModalClosed())}
        width={1060}
        style={{ top: 20 }}
        styles={{
          body: {
            height: '75vh',
            display: 'flex',
            flexDirection: 'column',
            padding: 0,
            overflow: 'hidden',
          },
        }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 32 }}>
            <FileTextOutlined style={{ color: '#3b82f6', fontSize: 16 }} />
            <Typography.Text strong style={{ fontSize: 15 }}>
              コードブックエディタ
            </Typography.Text>
            <Tag color="cyan">
              {selection.datasetName || datasetId || ''} ({codebook.draftColumns.length}変数 / {selection.allRowIds.length}行)
            </Tag>
            <Tag color="purple">Rev: {codebook.schemaRevision}</Tag>
          </div>
        }
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div>
              {codebook.hasChanges ? (
                <Tag color="orange">
                  変更保留中: {changedCount}変数・設問設定
                </Tag>
              ) : (
                <Tag color="default">変更なし</Tag>
              )}
            </div>
            <Space>
              <Button
                icon={<UndoOutlined />}
                disabled={!codebook.hasChanges}
                onClick={() => dispatch(draftReverted())}
              >
                元に戻す
              </Button>
              <Button onClick={() => dispatch(editorModalClosed())}>
                キャンセル
              </Button>
              <Button
                type="primary"
                loading={codebook.isSaving}
                disabled={!codebook.hasChanges}
                onClick={handleSave}
              >
                保存
              </Button>
            </Space>
          </div>
        }
      >
        {/* Toolbar */}
        <div
          style={{
            padding: '8px 16px',
            borderBottom: '1px solid #e2e8f0',
            background: '#f8fafc',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <Space wrap size="small">
            <Button size="small" onClick={() => setMaOpen(true)}>MA設問</Button>
            <Button
              size="small"
              icon={<ImportOutlined />}
              onClick={() => dispatch(importDialogToggled(true))}
            >
              CSV辞書読込
            </Button>

            <Dropdown menu={{ items: exportMenuItems }} trigger={['click']}>
              <Button size="small" icon={<DownloadOutlined />}>
                エクスポート <DownOutlined style={{ fontSize: 10 }} />
              </Button>
            </Dropdown>

            <span style={{ color: '#cbd5e1' }}>|</span>

            <Button
              size="small"
              icon={<FormOutlined />}
              onClick={() => dispatch(bulkLabelModalToggled(true))}
            >
              質問文一括貼付
            </Button>

            <Dropdown menu={{ items: presetBulkMenuItems }} trigger={['click']}>
              <Button size="small" icon={<ThunderboltOutlined />}>
                プリセット一括適用
                {codebook.selectedColumnIds.length > 0 && ` (${codebook.selectedColumnIds.length}件)`} <DownOutlined style={{ fontSize: 10 }} />
              </Button>
            </Dropdown>
          </Space>

          <Segmented
            size="small"
            value={codebook.viewMode}
            onChange={(val) => dispatch(viewModeChanged(val as 'detail' | 'grid'))}
            options={[
              { value: 'detail', label: '詳細フォーム', icon: <BarsOutlined /> },
              { value: 'grid', label: 'グリッド', icon: <AppstoreOutlined /> },
            ]}
          />
        </div>

        {/* Content Area */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {codebook.viewMode === 'detail' ? (
            <>
              <div style={{ width: 300, minWidth: 260, height: '100%' }}>
                <CodebookVariableList
                  columns={codebook.draftColumns}
                  activeColumnId={codebook.activeColumnId}
                  selectedColumnIds={codebook.selectedColumnIds}
                  filter={codebook.filter}
                  onSelectActive={(id) => dispatch(activeColumnSelected(id))}
                  onToggleSelected={(ids) => dispatch(selectedColumnsChanged(ids))}
                  onFilterChange={(patch) => dispatch(filterChanged(patch))}
                />
              </div>

              <div style={{ flex: 1, height: '100%', minWidth: 0 }}>
                {activeColumn ? (
                  <CodebookDetailForm
                    column={activeColumn}
                    allColumns={codebook.draftColumns}
                    selectedCount={codebook.selectedColumnIds.length}
                    onUpdate={(patch) =>
                      dispatch(draftColumnUpdated({ columnId: activeColumn.columnId, patch }))
                    }
                    onNavigate={handleNavigate}
                    onApplyQuickLabels={(options, applyToSelected) => {
                      const targets =
                        applyToSelected && codebook.selectedColumnIds.length > 0
                          ? codebook.selectedColumnIds
                          : [activeColumn.columnId]
                      dispatch(quickValueLabelsApplied({ columnIds: targets, options }))
                    }}
                    onApplyPreset={(preset, applyToSelected) => {
                      const targets =
                        applyToSelected && codebook.selectedColumnIds.length > 0
                          ? codebook.selectedColumnIds
                          : [activeColumn.columnId]
                      dispatch(presetAppliedToColumns({ columnIds: targets, preset }))
                    }}
                  />
                ) : (
                  <div style={{ padding: 24, color: '#94a3b8' }}>変数を選択してください。</div>
                )}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, height: '100%', minWidth: 0 }}>
              <CodebookGridView
                columns={codebook.draftColumns}
                onUpdateColumn={(columnId, patch) =>
                  dispatch(draftColumnUpdated({ columnId, patch }))
                }
                onBulkUpdateLabels={(updates) => dispatch(bulkLabelsApplied(updates))}
              />
            </div>
          )}
        </div>
      </Modal>

      {/* Sub Modals */}
      <MultiResponseGroupDialog key={datasetId} open={maOpen && codebook.isEditorOpen} onClose={() => setMaOpen(false)} />
      <BulkLabelPasteModal
        open={codebook.isBulkLabelModalOpen}
        onClose={() => dispatch(bulkLabelModalToggled(false))}
        columns={codebook.draftColumns}
        onApply={(updates) => dispatch(bulkLabelsApplied(updates))}
      />

      {datasetId && (
        <CodebookCsvImportDialog
          open={codebook.isImportDialogOpen}
          onClose={() => dispatch(importDialogToggled(false))}
          datasetId={datasetId}
          onSuccess={(committedDatasetId) => {
            if (currentDatasetId.current === committedDatasetId) dispatch(fetchCodebookThunk(committedDatasetId))
          }}
        />
      )}
    </>
  )
}
