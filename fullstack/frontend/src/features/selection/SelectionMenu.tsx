import { useGraphPopupContainer } from '../common/GraphPanel'
import { Select as AntSelect } from 'antd'
import { useDispatch, useSelector } from 'react-redux'
import { Button, Dropdown, Space, Typography } from 'antd'
import { DownOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { SELECTION_LABELS } from './selectionLabels'
import { store, pcpStateChanged, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'

export type BrushOperation = 'add' | 'replace' | 'subtract' | 'toggle'

/** Redux is the single source of truth, including restored sessions and PCP. */
export function getBrushOp(): BrushOperation {
  return store.getState().pcp.brushOperation
}

export function useBrushOp(): [BrushOperation, (op: BrushOperation) => void] {
  const op = useSelector((state: RootState) => state.pcp.brushOperation)
  const dispatch = useDispatch()
  return [op, next => { dispatch(pcpStateChanged({ brushOperation: next })) }]
}

/** AGENTS.md rule 5.1: the shared "選択" dropdown for every graph panel.
 *  Every entry changes the same Redux operation. */
export default function SelectionMenu({ testId = 'selection-menu', onOpChange, extraContent, buttonSize = 'small' }: {
  testId?: string
  op?: BrushOperation
  onOpChange?: (op: BrushOperation) => void
  extraContent?: React.ReactNode
  buttonSize?: 'small' | 'middle'
}) {
  const getPopupContainer=useGraphPopupContainer()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const [value, setOperation] = useBrushOp()
  const change = (next: BrushOperation) => {
    setOperation(next)
    onOpChange?.(next)
  }

  const menu = (
    <div style={{ padding: 12, width: 250, background: '#fff', borderRadius: 8, boxShadow: '0 3px 12px rgba(0,0,0,.15)', display: 'flex', flexDirection: 'column', gap: 8 }} onClick={(e) => e.stopPropagation()}>
      {extraContent}
      <div>
        <Typography.Text strong style={{ fontSize: 12 }}>集合演算</Typography.Text>
        <AntSelect getPopupContainer={getPopupContainer}
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
        <Button block data-testid="clear-selection" onClick={() => dispatch(selectionCleared())}>{SELECTION_LABELS.clear}</Button>
        <Button block data-testid="focus-selection" disabled={!selection.selectedRowIds.length} onClick={() => dispatch(focusSelected())}>{SELECTION_LABELS.focus}</Button>
        <Button block danger data-testid="delete-selection" title={SELECTION_LABELS.excludeHelp}
          onClick={() => dispatch(deleteSelected())} disabled={!selection.selectedRowIds.length}>{SELECTION_LABELS.exclude}</Button>
        <Button block data-testid="reset-working-set" onClick={() => dispatch(resetWorkingSet())}>{SELECTION_LABELS.reset}</Button>
      </Space>
    </div>
  )

  return (
    <Dropdown getPopupContainer={getPopupContainer} popupRender={() => menu} trigger={['click']}>
      <Button size={buttonSize} data-testid={testId}>{SELECTION_LABELS.menu} <DownOutlined /></Button>
    </Dropdown>
  )
}
