import { Select as AntSelect } from 'antd'
import React from 'react'
import { Button, Dropdown, Space, Typography } from 'antd'
import { DownOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { deleteSelected, focusSelected, pcpStateChanged, resetWorkingSet, selectionCleared } from '../../app/store'
import { useBrushOp, type BrushOperation } from './SelectionMenu'

export interface PointerSelectionDropdownProps {
  buttonSize?: 'small' | 'middle'
  testId?: string
  /** GraphPanel 拡大時は native dialog 内の popup root を渡す。 */
  getPopupContainer?: () => HTMLElement
  /** グローバルヘッダと同じ選択操作をメニュー内へ追加する。 */
  includeSelectionActions?: boolean
  /** PCP 以外の図ではヒット判定を表示しない。 */
  showPcpHitMode?: boolean
  /** トリガーの左に現在の選択行数を表示する。 */
  showSelectionCount?: boolean
}

export const PointerSelectionDropdown: React.FC<PointerSelectionDropdownProps> = ({
  buttonSize = 'small',
  testId = 'pointer-selection-dropdown',
  getPopupContainer,
  includeSelectionActions = false,
  showPcpHitMode = true,
  showSelectionCount = false,
}) => {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const hitMode = useSelector((s: RootState) => s.pcp.hitMode)
  const [brushOp, setBrushOp] = useBrushOp()
  const popupContainer = getPopupContainer ?? (() => document.body)

  const handleBrushOpChange = (op: BrushOperation) => {
    setBrushOp(op)
    dispatch(pcpStateChanged({ brushOperation: op }))
  }

  const handleHitModeChange = (mode: 'legacyVertex' | 'segment') => {
    dispatch(pcpStateChanged({ hitMode: mode }))
  }

  const menu = (
    <div
      data-testid="pointer-selection-menu-content"
      style={{
        padding: 12,
        width: 240,
        background: '#fff',
        borderRadius: 8,
        boxShadow: '0 3px 12px rgba(0,0,0,.15)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div>
        <Typography.Text strong style={{ fontSize: 12 }}>
          集合演算
        </Typography.Text>
        <AntSelect
          data-testid="brush-operation-select"
          size="small"
          value={brushOp}
          style={{ width: '100%', marginTop: 4 }}
          onChange={handleBrushOpChange}
          getPopupContainer={popupContainer}
          options={[
            { value: 'replace', label: 'Replace（置換）' },
            { value: 'add', label: 'Add（追加）' },
            { value: 'subtract', label: 'Subtract（除去）' },
            { value: 'toggle', label: 'Toggle（反転）' },
          ]}
        />
      </div>

      {showPcpHitMode && <div>
        <Typography.Text strong style={{ fontSize: 12 }}>
          PCPヒット判定
        </Typography.Text>
        <AntSelect
          data-testid="pcp-hit-mode-select"
          size="small"
          value={hitMode}
          style={{ width: '100%', marginTop: 4 }}
          onChange={handleHitModeChange}
          getPopupContainer={popupContainer}
          options={[
            { value: 'legacyVertex', label: 'DAVIS頂点包含OR' },
            { value: 'segment', label: '線分交差' },
          ]}
        />
      </div>}

      {includeSelectionActions && <Space direction="vertical" size={4} style={{ width: '100%', paddingTop: 4, borderTop: '1px solid #f0f0f0' }}>
        <Button block size="small" data-testid={`${testId}-clear`} disabled={!selection.selectedRowIds.length}
          onClick={() => dispatch(selectionCleared())}>解除</Button>
        <Button block size="small" data-testid={`${testId}-focus`} disabled={!selection.selectedRowIds.length}
          onClick={() => dispatch(focusSelected())}>Focus</Button>
        <Button block size="small" danger data-testid={`${testId}-delete`} disabled={!selection.selectedRowIds.length}
          onClick={() => dispatch(deleteSelected())}>Delete</Button>
        <Button block size="small" data-testid={`${testId}-reset`} onClick={() => dispatch(resetWorkingSet())}>全復帰 (Reset)</Button>
      </Space>}
    </div>
  )

  return (
    <Space size={4} wrap>
      {showSelectionCount && <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid={`${testId}-count`}>
        選択: {selection.selectedRowIds.length}行
      </Typography.Text>}
      <Dropdown popupRender={() => menu} trigger={['click']} getPopupContainer={popupContainer}>
        <Button size={buttonSize} data-testid={testId}>
          ポインター選択 <DownOutlined />
        </Button>
      </Dropdown>
    </Space>
  )
}

export default PointerSelectionDropdown
