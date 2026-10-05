import { useId, useState } from 'react'
import { AnalysisField } from '../common/AnalysisSetup'
import { useDispatch, useSelector } from 'react-redux'
import { Space, Typography } from 'antd'
import Select from '../common/ColumnSelect'
import { editorModalOpened } from '../dataset/codebookSlice'
import { selectOrdinaryVariables, selectVariableEntities, type RootState } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import MaAxisPicker from '../pcp/MaAxisPicker'

export function useMiningTargets() {
  const dispatch = useDispatch()
  const controlId = useId()
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
  const control = <div className="analysis-form-stack">
    <div className="analysis-variable-grid">
      {(['attribute', 'question'] as const).map(role => {
        const label = role === 'attribute' ? '属性変数' : '質問変数'
        const id = `${controlId}-${role}`
        return <AnalysisField key={role} label={label} htmlFor={id}
          help={role === 'attribute' ? 'サブグループを分ける条件に使う変数を1つ以上選びます。' : 'グループ間で比較する質問を1つ以上選びます。'}>
          <Select id={id} mode="multiple" aria-label={`Miningの${label}`} aria-describedby={`${id}-help`} roleName={`マイニングの${label}`}
            style={{ width: '100%' }} maxTagCount={2} allowClear optionFilterProp="label"
            value={role === 'attribute' ? attributes : questions} placeholder={`${label}を選択`}
            options={candidates.filter(column => column.role === role).map(column => ({ value: column.name, label: `${column.name}: ${column.multiResponseOptionLabel || column.label || column.name}` }))}
            emptyHint={{ roleLabel: role === 'attribute' ? '属性' : '質問', reason: `${label}の候補がありません。`,
              guidance: `共通の有効変数とコードブックの${role === 'attribute' ? '属性' : '質問'}の役割を確認してください。MA選択肢は下の追加ボタンから追加できます。`,
              onOpenCodebook: () => dispatch(editorModalOpened()) }}
            onChange={values => setState({ datasetId: datasetId!, attributes, questions, children: current?.children ?? [], [role === 'attribute' ? 'attributes' : 'questions']: values })} />
        </AnalysisField>
      })}
    </div>
    <Space wrap>
      <MaAxisPicker allowCount={false} groups={groups} columns={columns} onAdd={axes => {
        const added = columns.filter(column => axes.some(axis => axis.columnId === column.columnId))
        setState({ datasetId: datasetId!, children: [...new Set([...(current?.children ?? []), ...added.map(column => column.name)])],
          attributes: [...new Set([...attributes, ...added.filter(column => column.role === 'attribute').map(column => column.name)])],
          questions: [...new Set([...questions, ...added.filter(column => column.role === 'question').map(column => column.name)])] })
      }} />
      <Typography.Text type="secondary">追加したMA選択肢はコードブックの役割に応じて対象に加わります。</Typography.Text>
    </Space>
  </div>
  return { attributes, questions, control, ready: attributes.length > 0 && questions.length > 0 }
}
