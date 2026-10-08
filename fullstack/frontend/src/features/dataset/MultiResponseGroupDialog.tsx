import { useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Modal, Space, Typography } from 'antd'
import { Select as AntSelect } from 'antd'
import Select from '../common/ColumnSelect'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import type { MultiResponseGroup } from '../../api/client'
import { draftColumnUpdated, draftMultiResponseGroupRemoved, draftMultiResponseGroupUpdated } from './codebookSlice'

export default function MultiResponseGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dispatch = useDispatch()
  const { draftColumns: columns, draftMultiResponseGroups: groups } = useSelector((s: RootState) => s.codebook)
  const [form] = Form.useForm()
  const memberIds: string[] = Form.useWatch('columnIds', form) ?? []
  const [editing, setEditing] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [error, setError] = useState<string | null>(null)
  const choose = (id: string | null) => {
    setEditing(id)
    setError(null)
    const group = groups.find(g => g.groupId === id)
    form.setFieldsValue({ groupId: id ?? '', label: group?.label ?? '',
      selectedCodes: (group?.selectedCodes ?? ['1']).join(','),
      unselectedCodes: (group?.unselectedCodes ?? ['0']).join(','),
      allUnselectedMeaning: group?.allUnselectedMeaning ?? 'valid', maxSelections: group?.maxSelections ?? null,
      columnIds: id ? (group?.optionOrder?.length ? group.optionOrder : columns.filter(c => c.multiResponseGroup === id).map(c => c.columnId)) : [],
      optionLabels: Object.fromEntries(columns.map(c => [c.columnId, c.multiResponseOptionLabel ?? ''])),
    })
  }
  const apply = async () => {
    try {
      const values = await form.validateFields()
      const members = columns.filter(c => values.columnIds.includes(c.columnId))
      if (members.some(c => c.multiResponseGroup && c.multiResponseGroup !== editing)) throw new Error('ほかのMA設問に所属する列は先に所属を解除してください。')
      if (new Set(members.map(c => c.role)).size !== 1) throw new Error('同じ役割の列を選択してください。')
      if (members.some(c => c.isReversed)) throw new Error('逆転項目はMAに指定できません。')
      if (!editing && groups.some(g => g.groupId === values.groupId)) throw new Error('この設問IDは使用されています。')
      const selectedCodes = values.selectedCodes.split(',').map((v: string) => v.trim())
      const unselectedCodes = values.unselectedCodes.split(',').map((v: string) => v.trim())
      const codes = [...selectedCodes, ...unselectedCodes]
      if (codes.some(c => !c) || new Set(codes).size !== codes.length) throw new Error('選択・非選択コードは空欄や重複を含められません。')
      if (members.some(c => c.missingCodes.some(code => codes.includes(code)))) throw new Error('欠損コードを選択・非選択コードに指定できません。')
      const group: MultiResponseGroup = {
        groupId: values.groupId, label: values.label, selectedCodes, unselectedCodes,
        allUnselectedMeaning: values.allUnselectedMeaning, maxSelections: values.maxSelections ?? null,
        optionOrder: values.columnIds,
      }
      dispatch(draftMultiResponseGroupUpdated({ group, columnIds: values.columnIds }))
      for (const columnId of values.columnIds) {
        dispatch(draftColumnUpdated({ columnId, patch: { multiResponseOptionLabel: values.optionLabels?.[columnId]?.trim() || null } }))
      }
      onClose()
    } catch (e) { setError((e as Error).message ?? '入力内容を確認してください。') }
  }
  return <Modal title="MA設問の設定" open={open} width={680} onCancel={onClose} onOk={() => void apply()}
    okText="適用" cancelText="キャンセル" afterOpenChange={visible => { if (visible) choose(null) }}>
    <Space direction="vertical" style={{ width: '100%' }}>
      <Select aria-label="編集するMA設問" style={{ width: '100%' }} value={editing ?? ''}
        options={[{ value: '', label: '新しいMA設問' }, ...groups.map(g => ({ value: g.groupId, label: `${g.label} (${g.groupId})` }))]}
        onChange={v => choose(v || null)} />
      {error && <Alert type="error" message={error} showIcon />}
      <Form form={form} layout="vertical" initialValues={{ allUnselectedMeaning: 'valid', selectedCodes: '1', unselectedCodes: '0', columnIds: [] }}>
        <Space align="start">
          <Form.Item name="groupId" label="設問ID" rules={[{ required: true, whitespace: true }]}><Input disabled={!!editing} /></Form.Item>
          <Form.Item name="label" label="設問名" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
        </Space>
        <Form.Item label="列名の先頭文字で候補を選ぶ">
          <Space.Compact style={{ width: '100%' }}><Input value={prefix} onChange={e => setPrefix(e.target.value)} />
            <Button disabled={!prefix} onClick={() => form.setFieldValue('columnIds', columns.filter(c =>
              c.name.startsWith(prefix) && (!c.multiResponseGroup || c.multiResponseGroup === editing)).map(c => c.columnId))}>候補を表示</Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="columnIds" label="選択肢の列（表示順）" rules={[{ required: true, type: 'array', min: 1 }]}>
          <Select mode="multiple" style={{ width: '100%' }} optionFilterProp="label" options={columns.map(c => ({ value: c.columnId,
            label: `${c.name}: ${c.multiResponseOptionLabel || c.label}`, disabled: !!c.multiResponseGroup && c.multiResponseGroup !== editing }))} />
        </Form.Item>
        {memberIds.map(id => <Form.Item key={id} name={['optionLabels', id]} label={`${columns.find(c => c.columnId === id)?.name} の選択肢名`}>
          <Input placeholder="未指定の場合は列のラベルを使用" />
        </Form.Item>)}
        <Space align="start">
          <Form.Item name="selectedCodes" label="選択コード（カンマ区切り）" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="unselectedCodes" label="非選択コード（カンマ区切り）" rules={[{ required: true }]}><Input /></Form.Item>
        </Space>
        <Form.Item name="allUnselectedMeaning" label="すべて非選択だった回答の扱い">
          <AntSelect options={[{ value: 'valid', label: '有効回答（選択なし）' }, { value: 'missing', label: '無回答' }, { value: 'notApplicable', label: '非該当' }]} />
        </Form.Item>
        <Form.Item name="maxSelections" label="選択数の上限（未指定は制限なし）"><InputNumber min={1} precision={0} /></Form.Item>
        <Typography.Text type="secondary">欠損・非該当コードは各列の設定を使用します。設定を適用後、コードブックの「保存」で確定します。</Typography.Text>
      </Form>
      {editing && <Button danger onClick={() => { dispatch(draftMultiResponseGroupRemoved(editing)); onClose() }}>設問のグループ化を解除</Button>}
    </Space>
  </Modal>
}
