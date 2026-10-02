import { composedColor, vizTheme } from '../../theme/viz'
import { SELECTION_LABELS } from './selectionLabels'
import { selectEffectiveRowIds, selectVariableManagerState, weightColumnCleared, weightColumnSet } from '../../app/store'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { useCodebook } from '../dataset/useCodebookColumn'
import React, { useState } from 'react'
import {
  Button,
  Popover,
  Input,
  Checkbox,
  Space,
  Radio,
  Typography,
  Tooltip,
  Divider,
  notification,
} from 'antd'
import {
  AppstoreOutlined,
  DownOutlined,
  FilterOutlined,
  DeploymentUnitOutlined,
  ClearOutlined,
  AimOutlined,
  DeleteOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import type { RootState, AppDispatch } from '../../app/store'
import {
  activeEntitiesSet,
  observationScopeChanged,
  selectionCleared,
  focusSelected,
  deleteSelected,
  resetWorkingSet,
  pcpStateChanged,
  l2ColorToggled,
} from '../../app/store'
import Select from '../common/ColumnSelect'
import L1Legend from '../common/L1Legend'
import { useDatasetL1ColorDomains } from '../../theme/useL1ColorDomain'
import VariableSelectionModal from './VariableSelectionModal'
import ObservationModal from './ObservationModal'
import PointerSelectionDropdown from './PointerSelectionDropdown'

export const GlobalHeaderControlBar: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector(selectVariableManagerState)
  const applyVariables = (keys: string[]) => dispatch(activeEntitiesSet(keys.flatMap(key => globalVars.variableMeta[key] ? [globalVars.variableMeta[key].entity] : [])))
  const obs = useSelector((s: RootState) => s.globalObservations)

  const [varPopoverOpen, setVarPopoverOpen] = useState(false)
  const [varSearch, setVarSearch] = useState('')
  const [varModalOpen, setVarModalOpen] = useState(false)
  const [obsModalOpen, setObsModalOpen] = useState(false)
  const [obsModalTab, setObsModalTab] = useState<'sampling' | 'range'>('sampling')
  const { columns: codebookColumns } = useCodebook()
  const weightCandidates = codebookColumns.filter(
    (c) => c.role === 'weight' && (c.scaleType === 'interval' || c.scaleType === 'ratio') && !c.multiResponseGroup
  )
  const weightColumnId = useSelector((s: RootState) => s.globalVariables.weightColumnId)
  const l2Active = selection.l2ColorEnabled && selection.groups.length > 0
  const colorBy = useSelector((s: RootState) => s.pcp.colorBy)
  const l1Candidates = useDatasetL1ColorDomains(selection.datasetId)
  const colorOptions = (l1Candidates ?? []).map((domain) => {
    const column = codebookColumns.find((candidate) => candidate.name === domain.key)
    const label = column?.label?.trim() || column?.name || domain.key
    return { value: domain.key, label: `${label}（${domain.codes.length}種類）` }
  })
  const colorSelectionDisabled = !selection.datasetId || l1Candidates === null || colorOptions.length === 0
  const colorStatus = !selection.datasetId
    ? 'データセットを選択してください。'
    : l1Candidates === null
      ? '色分け候補を読み込んでいます。'
      : colorOptions.length === 0
        ? '色分けに使える列がありません。'
        : '欠損を除く1〜20種類の値を持つ列を使用します。'

  const totalVarCount = globalVars.allVariables.length
  const activeVarCount = globalVars.activeVariableIds.length

  const totalRowCount = selection.allRowIds.length
  const activeRowCount = selection.activeRowIds.length
  const selectedRowCount = selection.selectedRowIds.length
  const sampledRowCount = obs?.sampling?.sampledRowIds?.length || 0

  const currentScope = obs?.scopeMode || 'active'
  const effectiveRows = useSelector(selectEffectiveRowIds)
  const activeSet = new Set(selection.activeRowIds)
  const outsideActiveCount = effectiveRows.reduce((n, id) => n + (activeSet.has(id) ? 0 : 1), 0)

  const numericVars = globalVars.allVariables.filter(
    (id) => globalVars.variableMeta[id]?.semanticType === 'numeric'
  )
  const nominalVars = globalVars.allVariables.filter((id) => {
    const t = globalVars.variableMeta[id]?.semanticType
    return t === 'nominal' || t === 'ordinal' || t === 'text' || t === 'categorical'
  })

  const filteredVars = globalVars.allVariables.filter((id) =>
    `${globalVars.variableMeta[id]?.name} ${globalVars.variableMeta[id]?.label}`.toLowerCase().includes(varSearch.toLowerCase())
  )

  const varPopoverContent = (
    <div style={{ width: 280, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="var-popover">
      <Input.Search
        placeholder="変数を検索..."
        size="small"
        value={varSearch}
        onChange={(e) => setVarSearch(e.target.value)}
        allowClear
        data-testid="var-popover-search"
      />
      <Space size={4} wrap>
        <Button
          size="small"
          onClick={() => applyVariables(globalVars.allVariables)}
          data-testid="var-quick-all"
        >
          全選択
        </Button>
        <Button
          size="small"
          onClick={() => {
            if (numericVars.length > 0) {
              applyVariables(numericVars)
            } else {
              notification.info({
                message: '数値変数がありません',
                description: '現在のデータセットに数値型変数は見つかりませんでした。',
              })
            }
          }}
          data-testid="var-quick-numeric"
        >
          数値のみ
        </Button>
        <Button
          size="small"
          onClick={() => {
            if (nominalVars.length > 0) {
              applyVariables(nominalVars)
            } else {
              notification.info({
                message: 'カテゴリ変数がありません',
                description: '現在のデータセットにカテゴリ/名義型変数は見つかりませんでした。',
              })
            }
          }}
          data-testid="var-quick-nominal"
        >
          カテゴリのみ
        </Button>
        <Button
          size="small"
          onClick={() => {
            setVarPopoverOpen(false)
            navigate('/ranking')
          }}
          data-testid="var-quick-ranking"
        >
          重要度上位K列
        </Button>
      </Space>
      <Divider style={{ margin: '4px 0' }} />
      <div style={{ maxHeight: 220, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filteredVars.map((varName) => {
          const isChecked = globalVars.activeVariableIds.includes(varName)
          const meta = globalVars.variableMeta[varName]
          return (
            <Checkbox
              key={varName}
              checked={isChecked}
              onChange={() => applyVariables(isChecked ? globalVars.activeVariableIds.filter(key => key !== varName) : [...globalVars.activeVariableIds, varName])}
              data-testid={`var-checkbox-${varName}`}
            >
              <span style={{ fontSize: 12 }}>
                <ColumnQuestionTooltip nameOrId={meta?.name}>{meta?.label} ({meta?.name})</ColumnQuestionTooltip>{' '}
                <span style={{ color: '#888', fontSize: 11 }}>
                  ({meta?.entity.kind === 'ma' ? 'MA' : meta?.semanticType ?? 'var'})
                </span>
              </span>
            </Checkbox>
          )
        })}
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <Button
        type="link"
        size="small"
        icon={<AppstoreOutlined />}
        onClick={() => {
          setVarPopoverOpen(false)
          setVarModalOpen(true)
        }}
        data-testid="open-var-manager-btn"
        style={{ padding: 0, textAlign: 'left' }}
      >
        変数マネージャを開く (Variable Manager)...
      </Button>
    </div>
  )

  const activeVarPreview = globalVars.activeVariableIds.slice(0, 2).map(key => globalVars.variableMeta[key]?.name)

  const colorPopoverContent = (
    <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="global-color-popover">
      <Typography.Text strong style={{ fontSize: 12 }}>L1色分け</Typography.Text>
      <Select
        size="small"
        style={{ width: '100%' }}
        placeholder="色分けしない"
        allowClear
        disabled={colorSelectionDisabled}
        value={colorBy ?? undefined}
        onChange={(value) => dispatch(pcpStateChanged({ colorBy: value ?? null }))}
        options={colorOptions}
        data-testid="global-color-by"
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{colorStatus}</Typography.Text>
      <L1Legend />
      <Divider style={{ margin: '4px 0' }} />
      <Typography.Text strong style={{ fontSize: 12 }}>L2色分け（解析グループの明暗）</Typography.Text>
      <Typography.Text data-testid="global-l2-status">
        {l2Active ? `有効（${selection.groups.length}グループ）` : '無効'}
      </Typography.Text>
      {l2Active && <div aria-label="L2色分け凡例" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', maxHeight: 160, overflowY: 'auto' }}>
        {selection.groups.map((group, index) => <span key={group.groupId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, overflowWrap: 'anywhere' }}>
          <i aria-hidden style={{ width: 10, height: 10, flexShrink: 0, background: composedColor(vizTheme(false), { l2Group: index }) }} />
          {group.name}
        </span>)}
      </div>}
      {l2Active && colorBy && <Typography.Text type="secondary" style={{ fontSize: 12 }}>凡例は明暗の例です。L1併用時は各色相にこの明暗を合成します。</Typography.Text>}
      {selection.l2ColorEnabled && <Button size="small" data-testid="global-l2-disable"
        onClick={() => dispatch(l2ColorToggled(false))}>L2色分けを解除</Button>}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>解析でグループを作成すると有効になります。</Typography.Text>
    </div>
  )

  return (
    <div
      data-testid="global-header-control-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 10,
        background: '#f8fafc',
        borderBottom: '1px solid #e2e8f0',
        padding: '6px 16px',
        fontSize: 13,
      }}
    >
      {/* Left: Global Variables */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Popover
          content={varPopoverContent}
          title="共通アクティブ変数選択"
          trigger="click"
          open={varPopoverOpen}
          onOpenChange={setVarPopoverOpen}
          placement="bottomLeft"
          getPopupContainer={() => document.body}
        >
          <Button
            size="small"
            data-testid="global-var-btn"
            style={{ fontWeight: 500 }}
          >
            <AppstoreOutlined /> Variables: [ {activeVarCount} / {totalVarCount} 項目選択中 {activeVarPreview.length > 0 && <span>({activeVarPreview.map((name, index) => <span key={name}>{index > 0 ? ', ' : ''}<ColumnQuestionTooltip nameOrId={name} tabIndex={-1} /></span>)}{activeVarCount > 2 ? '...' : ''})</span>} <DownOutlined style={{ fontSize: 10 }} /> ]
          </Button>
        </Popover>
        <Space size={4} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>ウェイト:</Typography.Text>
          <Select
            size="small"
            style={{ minWidth: 140 }}
            placeholder="未選択"
            allowClear
            value={weightColumnId ?? undefined}
            onChange={(value) => {
              if (!value) dispatch(weightColumnCleared())
              else dispatch(weightColumnSet({ columnId: value as string, datasetId: selection.datasetId ?? undefined }))
            }}
            options={weightCandidates.map((c) => ({
              value: c.columnId,
              label: `${c.label || c.name} (${c.name})`,
            }))}
            data-testid="global-weight-select"
          />
          <Popover
            content={colorPopoverContent}
            title="色分け"
            trigger="click"
            placement="bottomLeft"
            getPopupContainer={() => document.body}
          >
            <Button size="small" data-testid="global-color-btn">
              色分け（{colorBy ? 'L1' : ''}{colorBy && l2Active ? '＋' : ''}{l2Active ? 'L2' : ''}{!colorBy && !l2Active ? 'なし' : ''}） <DownOutlined style={{ fontSize: 10 }} />
            </Button>
          </Popover>
        </Space>
      </div>

      {/* Center/Right: Global Observations & Scopes */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>
            表示・次回分析対象:
          </Typography.Text>
          <Radio.Group
            size="small"
            value={currentScope}
            onChange={(e) => dispatch(observationScopeChanged(e.target.value))}
            data-testid="observation-scope-group"
          >
            <Radio.Button value="active" data-testid="scope-active">
              Active ({activeRowCount})
            </Radio.Button>
            <Tooltip title={selectedRowCount === 0 ? '選択中の行がありません' : undefined}>
              <Radio.Button
                value="selected"
                disabled={selectedRowCount === 0}
                data-testid="scope-selected"
              >
                Selected ({selectedRowCount})
              </Radio.Button>
            </Tooltip>
            <Tooltip title={sampledRowCount === 0 ? 'サンプリング未実行です' : undefined}>
              <Radio.Button
                value="sampled"
                disabled={sampledRowCount === 0}
                data-testid="scope-sampled"
              >
                Sampled ({sampledRowCount})
              </Radio.Button>
            </Tooltip>
            <Radio.Button value="all" data-testid="scope-all">
              All ({totalRowCount})
            </Radio.Button>
          </Radio.Group>
          {outsideActiveCount > 0 && <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Active外{outsideActiveCount}行は表示のみ。選択するには全復帰
          </Typography.Text>}
          {currentScope === 'sampled' && <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            seed {obs.sampling.seed ?? '未記録'} / 抽出元 {obs.sampling.sourceRowCount ?? '未記録'}行
          </Typography.Text>}
        </Space>

        <Space size={4} wrap>
          <Button
            size="small"
            icon={<FilterOutlined />}
            onClick={() => {
              setObsModalTab('range')
              setObsModalOpen(true)
            }}
            data-testid="open-obs-range-btn"
          >
            行範囲 (Range)
          </Button>
          <Button
            size="small"
            icon={<DeploymentUnitOutlined />}
            onClick={() => {
              setObsModalTab('sampling')
              setObsModalOpen(true)
            }}
            data-testid="open-obs-sampling-btn"
          >
            サンプリング (Sampling)
          </Button>
        </Space>

        {/* Selection actions */}
        <Space size={4} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            選択: {selectedRowCount}行
          </Typography.Text>
          <PointerSelectionDropdown buttonSize="small" testId="header-pointer-selection" />
          <Button
            size="small"
            icon={<ClearOutlined />}
            disabled={selectedRowCount === 0}
            onClick={() => dispatch(selectionCleared())}
            title={SELECTION_LABELS.clear}
            data-testid="header-clear-selection"
          >
            {SELECTION_LABELS.clear}
          </Button>
          <Button
            size="small"
            icon={<AimOutlined />}
            disabled={selectedRowCount === 0}
            onClick={() => dispatch(focusSelected())}
            title={SELECTION_LABELS.focus}
            data-testid="header-focus-selection"
          >
            {SELECTION_LABELS.focus}
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={selectedRowCount === 0}
            onClick={() => dispatch(deleteSelected())}
            title={SELECTION_LABELS.excludeHelp}
            data-testid="header-delete-selection"
          >
            {SELECTION_LABELS.exclude}
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => dispatch(resetWorkingSet())}
            title={SELECTION_LABELS.reset}
            data-testid="header-reset-selection"
          >
            {SELECTION_LABELS.reset}
          </Button>
        </Space>
      </div>

      {/* Modals */}
      <VariableSelectionModal open={varModalOpen} onClose={() => setVarModalOpen(false)} />
      <ObservationModal
        open={obsModalOpen}
        defaultTab={obsModalTab}
        onClose={() => setObsModalOpen(false)}
      />
    </div>
  )
}

export default GlobalHeaderControlBar
