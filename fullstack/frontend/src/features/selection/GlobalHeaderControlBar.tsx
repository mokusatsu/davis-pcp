import { selectVariableManagerState } from '../../app/store'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
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
} from '../../app/store'
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

  const totalVarCount = globalVars.allVariables.length
  const activeVarCount = globalVars.activeVariableIds.length

  const totalRowCount = obs?.totalRowIds?.length || selection.allRowIds.length
  const activeRowCount = obs?.activeRowIds?.length || selection.activeRowIds.length
  const selectedRowCount = obs?.selectedRowIds?.length ?? selection.selectedRowIds.length
  const sampledRowCount = obs?.sampling?.sampledRowIds?.length || 0

  const currentScope = obs?.scopeMode || 'active'

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
      </div>

      {/* Center/Right: Global Observations & Scopes */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>
            Rows Scope:
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
        </Space>

        <Space size={4}>
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
        <Space size={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            選択: {selectedRowCount}行
          </Typography.Text>
          <PointerSelectionDropdown buttonSize="small" testId="header-pointer-selection" />
          <Button
            size="small"
            icon={<ClearOutlined />}
            disabled={selectedRowCount === 0}
            onClick={() => dispatch(selectionCleared())}
            title="選択解除"
            data-testid="header-clear-selection"
          >
            解除
          </Button>
          <Button
            size="small"
            icon={<AimOutlined />}
            disabled={selectedRowCount === 0}
            onClick={() => dispatch(focusSelected())}
            title="選択行のみに絞り込み"
            data-testid="header-focus-selection"
          >
            Focus
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={selectedRowCount === 0}
            onClick={() => dispatch(deleteSelected())}
            title="選択行を一時除外"
            data-testid="header-delete-selection"
          >
            Delete
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => dispatch(resetWorkingSet())}
            title="初期ベースデータに全復帰"
            data-testid="header-reset-selection"
          >
            全復帰(Reset)
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
