import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Button, Dropdown, Popconfirm, Select, Space, Typography } from 'antd'
import { DownOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'

export type BrushOperation = 'add' | 'replace' | 'subtract' | 'toggle'

/* Shared set-operation registry: the "選択" menu is the single place users pick
 * Add/Replace/Subtract/Toggle; group/leaf/bin handlers read the same choice. */
let currentBrushOp: BrushOperation = 'replace'
const listeners = new Set<(op: BrushOperation) => void>()

export function getBrushOp(): BrushOperation {
  return currentBrushOp
}

export function useBrushOp(): [BrushOperation, (op: BrushOperation) => void] {
  const [op, setOp] = useState(currentBrushOp)
  useEffect(() => {
    listeners.add(setOp)
    return () => { listeners.delete(setOp) }
  }, [])
  const set = (next: BrushOperation) => {
    currentBrushOp = next
    listeners.forEach((listener) => listener(next))
  }
  return [op, set]
}

/** AGENTS.md rule 5.1: the shared "選択" dropdown for every graph panel.
 *  Panels with their own local brush op can pass `op`/`onOpChange` to bind the
 *  menu to their state; otherwise the shared registry is used. */
export default function SelectionMenu({ testId = 'selection-menu', op, onOpChange, extraContent, buttonSize = 'small' }: {
  testId?: string
  op?: BrushOperation
  onOpChange?: (op: BrushOperation) => void
  extraContent?: React.ReactNode
  buttonSize?: 'small' | 'middle'
}) {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const [registryOp, setRegistryOp] = useState(currentBrushOp)
  useEffect(() => {
    listeners.add(setRegistryOp)
    return () => { listeners.delete(setRegistryOp) }
  }, [])
  const value = op ?? registryOp
  const change = (next: BrushOperation) => {
    onOpChange?.(next)
    currentBrushOp = next
    listeners.forEach((listener) => listener(next))
  }

  const menu = (
    <div style={{ padding: 12, width: 250, background: '#fff', borderRadius: 8, boxShadow: '0 3px 12px rgba(0,0,0,.15)', display: 'flex', flexDirection: 'column', gap: 8 }} onClick={(e) => e.stopPropagation()}>
      {extraContent}
      <div>
        <Typography.Text strong style={{ fontSize: 12 }}>集合演算</Typography.Text>
        <Select
          data-testid="brush-operation"
          size="small"
          style={{ width: '100%', marginTop: 4 }}
          value={value}
          onChange={change}
          options={[
            { value: 'replace', label: 'Replace（置換）' },
            { value: 'add', label: 'Add（追加）' },
            { value: 'subtract', label: 'Subtract（除去）' },
            { value: 'toggle', label: 'Toggle（反転）' },
          ]}
        />
      </div>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Button block data-testid="clear-selection" onClick={() => dispatch(selectionCleared())}>選択解除</Button>
        <Button block data-testid="focus-selection" disabled={!selection.selectedRowIds.length} onClick={() => dispatch(focusSelected())}>Focus</Button>
        <Popconfirm title="選択行を作業集合から除外しますか？" onConfirm={() => dispatch(deleteSelected())}>
          <Button block danger data-testid="delete-selection" disabled={!selection.selectedRowIds.length}>Delete</Button>
        </Popconfirm>
        <Button block data-testid="reset-working-set" onClick={() => dispatch(resetWorkingSet())}>Reset to Base Data</Button>
      </Space>
    </div>
  )

  return (
    <Dropdown popupRender={() => menu} trigger={['click']}>
      <Button size={buttonSize} data-testid={testId}>選択 <DownOutlined /></Button>
    </Dropdown>
  )
}
