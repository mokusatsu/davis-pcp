import { useState } from 'react'
import { useSelector } from 'react-redux'
import { Select, Space, Typography } from 'antd'
import { selectOrdinaryVariables, selectVariableEntities, type RootState } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import MaAxisPicker from '../pcp/MaAxisPicker'

export function useMiningTargets() {
  const datasetId = useSelector((state: RootState) => state.selection.datasetId)
  const global = useSelector(selectOrdinaryVariables)
  const entities = useSelector(selectVariableEntities)
  const { columns } = useCodebook()
  const [state, setState] = useState<{ datasetId: string; attributes: string[]; questions: string[]; children: string[] } | null>(null)
  const current = state?.datasetId === datasetId ? state : null
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key)
    && ['attribute', 'question'].includes(item.role)).map(item => ({ groupId: item.name, label: item.label }))
  const candidates = columns.filter(column => ['attribute', 'question'].includes(column.role)
    && (column.multiResponseGroup ? current?.children.includes(column.name) && groups.some(group => group.groupId === column.multiResponseGroup)
      : global.activeVariableIds.includes(column.name)))
  const attributes = (current?.attributes ?? []).filter(name => candidates.some(column => column.name === name && column.role === 'attribute'))
  const questions = (current?.questions ?? []).filter(name => candidates.some(column => column.name === name && column.role === 'question'))
  const control = <Space wrap style={{ marginBottom: 12 }}>
    {(['attribute', 'question'] as const).map(role => <Space direction="vertical" size={2} key={role}>
      <Typography.Text strong>{role === 'attribute' ? '属性変数' : '質問変数'}</Typography.Text>
      <Select mode="multiple" aria-label={role === 'attribute' ? 'Miningの属性変数' : 'Miningの質問変数'}
        style={{ minWidth: 260 }} maxTagCount={2} allowClear optionFilterProp="label"
        value={role === 'attribute' ? attributes : questions} placeholder="対象を選択"
        options={candidates.filter(column => column.role === role).map(column => ({ value: column.name, label: `${column.name}: ${column.multiResponseOptionLabel || column.label || column.name}` }))}
        onChange={values => setState({ datasetId: datasetId!, attributes, questions, children: current?.children ?? [], [role === 'attribute' ? 'attributes' : 'questions']: values })} />
    </Space>)}
    <MaAxisPicker allowCount={false} groups={groups} columns={columns} onAdd={axes => {
      const added = columns.filter(column => axes.some(axis => axis.columnId === column.columnId))
      setState({ datasetId: datasetId!, children: [...new Set([...(current?.children ?? []), ...added.map(column => column.name)])],
        attributes: [...new Set([...attributes, ...added.filter(column => column.role === 'attribute').map(column => column.name)])],
        questions: [...new Set([...questions, ...added.filter(column => column.role === 'question').map(column => column.name)])] })
    }} />
  </Space>
  return { attributes, questions, control, ready: attributes.length > 0 && questions.length > 0 }
}
