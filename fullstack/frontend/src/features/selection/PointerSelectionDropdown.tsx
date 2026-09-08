import { Select as AntSelect } from 'antd'
import React from 'react'
import { Button, Dropdown, Typography } from 'antd'
import { DownOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { pcpStateChanged } from '../../app/store'
import { useBrushOp, type BrushOperation } from './SelectionMenu'

export interface PointerSelectionDropdownProps {
  buttonSize?: 'small' | 'middle'
  testId?: string
}

export const PointerSelectionDropdown: React.FC<PointerSelectionDropdownProps> = ({
  buttonSize = 'small',
  testId = 'pointer-selection-dropdown',
}) => {
  const dispatch = useDispatch()
  const hitMode = useSelector((s: RootState) => s.pcp.hitMode)
  const [brushOp, setBrushOp] = useBrushOp()

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
          getPopupContainer={() => document.body}
          options={[
            { value: 'replace', label: 'Replace（置換）' },
            { value: 'add', label: 'Add（追加）' },
            { value: 'subtract', label: 'Subtract（除去）' },
            { value: 'toggle', label: 'Toggle（反転）' },
          ]}
        />
      </div>

      <div>
        <Typography.Text strong style={{ fontSize: 12 }}>
          PCPヒット判定
        </Typography.Text>
        <AntSelect
          data-testid="pcp-hit-mode-select"
          size="small"
          value={hitMode}
          style={{ width: '100%', marginTop: 4 }}
          onChange={handleHitModeChange}
          getPopupContainer={() => document.body}
          options={[
            { value: 'legacyVertex', label: 'DAVIS頂点包含OR' },
            { value: 'segment', label: '線分交差' },
          ]}
        />
      </div>
    </div>
  )

  return (
    <Dropdown popupRender={() => menu} trigger={['click']} getPopupContainer={() => document.body}>
      <Button size={buttonSize} data-testid={testId}>
        ポインター選択 <DownOutlined />
      </Button>
    </Dropdown>
  )
}

export default PointerSelectionDropdown
