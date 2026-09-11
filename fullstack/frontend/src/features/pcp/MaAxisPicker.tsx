import { useState } from 'react'
import { Button, Modal, Space, Typography } from 'antd'
import Select from '../common/ColumnSelect'
import type { CodebookColumn, MaDisplayAxis } from '../../api/client'

export default function MaAxisPicker({ groups, columns, onAdd, allowCount = true }: {
  groups: { groupId: string; label: string }[]
  columns: CodebookColumn[]
  onAdd: (axes: MaDisplayAxis[]) => void
  allowCount?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [groupId, setGroupId] = useState<string>()
  const [choices, setChoices] = useState<string[]>([])
  const options: MaDisplayAxis[] = groupId ? [
    ...(allowCount ? [{ key: JSON.stringify(['maCount', groupId]), kind: 'maCount' as const, groupId }] : []),
    ...columns.filter(column => column.multiResponseGroup === groupId).map(column => ({
      key: JSON.stringify(['maOption', groupId, column.columnId]), kind: 'maOption' as const, groupId, columnId: column.columnId,
    })),
  ] : []
  return <>
    <Button disabled={!groups.length} onClick={() => setOpen(true)}>MA軸を追加</Button>
    <Modal title="MA軸を追加" open={open} onCancel={() => setOpen(false)} okText="追加" cancelText="閉じる"
      okButtonProps={{ disabled: !groups.some(group => group.groupId === groupId) || !choices.length }}
      onOk={() => { onAdd(options.filter(axis => choices.includes(axis.key))); setOpen(false); setChoices([]) }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text>共通変数で選択した設問から、表示する軸を指定してください。</Typography.Text>
        <Select aria-label="MA軸の設問" placeholder="設問を選択" style={{ width: '100%' }} value={groupId}
          options={groups.map(group => ({ value: group.groupId, label: group.label }))}
          onChange={value => { setGroupId(value); setChoices([]) }} />
        <Select mode="multiple" aria-label="追加するMA軸" placeholder="選択肢・選択数を選択" style={{ width: '100%' }}
          value={choices} onChange={setChoices} disabled={!groupId} optionFilterProp="label"
          options={options.map(axis => {
            const column = columns.find(column => column.columnId === axis.columnId)
            return { value: axis.key, label: axis.kind === 'maCount' ? '選択数' : column?.multiResponseOptionLabel || column?.label || column?.name }
          })} />
        <Typography.Text type="secondary">有効回答のみを0/1または選択数で表示します。部分回答・無回答・非該当・無効回答は欠損になります。</Typography.Text>
      </Space>
    </Modal>
  </>
}
