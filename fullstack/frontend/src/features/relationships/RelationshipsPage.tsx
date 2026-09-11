import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Col, Dropdown, Row, Space, Spin, Typography } from 'antd'
import { Select as AntSelect } from 'antd'
import Select from '../common/ColumnSelect'
import { api } from '../../api/client'
import { deleteSelected, focusSelected, resetWorkingSet, selectEffectiveRowIds, selectOrdinaryVariables,
  selectVariableEntities, selectionCleared, type RootState } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import { useColumnarData } from '../pcp/useDatasetColumns'
import MaAxisPicker from '../pcp/MaAxisPicker'
import { useRowColorResolver } from '../../theme/useRowColor'
import { FocusEnterButton, FocusTarget } from '../common/FocusMode'
import WeightUnsupportedAlert from '../common/WeightUnsupportedAlert'
import RelationshipCanvas, { type RelationshipPoints } from './RelationshipCanvas'

interface MatrixResult {
  columns: string[]; matrix: (number | null)[][]; counts: number[][]
  weightStatus?: string; weightColumn?: string | null
}

function useRelationshipResult<T>(path: string, body: unknown | null) {
  const key = useMemo(() => body === null ? null : JSON.stringify(body), [body])
  const [state, setState] = useState<{ key: string; value?: T; error?: string } | null>(null)
  useEffect(() => {
    if (!key) return
    let current = true
    void api.post<T>(path, JSON.parse(key)).then(value => { if (current) setState({ key, value }) })
      .catch(error => { if (current) setState({ key, error: error.message || '取得に失敗しました。' }) })
    return () => { current = false }
  }, [path, key])
  return { value: state?.key === key ? state.value : undefined, error: state?.key === key ? state.error : undefined,
    loading: key !== null && state?.key !== key }
}

export default function RelationshipsPage() {
  const dispatch = useDispatch()
  const selection = useSelector((state: RootState) => state.selection)
  const colorBy = useSelector((state: RootState) => state.pcp.colorBy)
  const global = useSelector(selectOrdinaryVariables)
  const entities = useSelector(selectVariableEntities)
  const rowIds = useSelector(selectEffectiveRowIds)
  const { columns, schemaRevision } = useCodebook()
  const [settings, setSettings] = useState<{ datasetId: string; names: string[]; children: string[] } | null>(null)
  const [focusPair, setFocusPair] = useState<[string, string] | null>(null)
  const ordinary = columns.filter(column => !column.multiResponseGroup && global.activeVariableIds.includes(column.name)
    && ['question', 'attribute'].includes(column.role) && ['interval', 'ratio', 'ordinal'].includes(column.scaleType))
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key)
    && ['question', 'attribute'].includes(item.role)).map(item => ({ groupId: item.name, label: item.label }))
  const chosen = settings?.datasetId === selection.datasetId ? settings : null
  const childColumns = columns.filter(column => chosen?.children.includes(column.name)
    && groups.some(group => group.groupId === column.multiResponseGroup))
  const candidates = [...ordinary, ...childColumns]
  const names = (chosen?.names ?? ordinary.slice(0, 6).map(column => column.name))
    .filter(name => candidates.some(column => column.name === name))
  const pair = focusPair && focusPair.every(name => names.includes(name)) && focusPair[0] !== focusPair[1]
    ? focusPair : names.length >= 2 ? [names[0], names[1]] as [string, string] : null
  useEffect(() => { setFocusPair(null) }, [selection.datasetId])
  const namesKey = JSON.stringify(names)
  const weightColumnId = useSelector((state: RootState) => state.globalVariables.weightColumnId)
  const weightName = columns.find((c) => c.columnId === weightColumnId)?.name
  const request = useMemo(() => selection.datasetId && columns.length ? { datasetId: selection.datasetId, columns: names, rowIds,
    expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
    ...(weightName ? { weightColumn: weightName } : {}) } : null,
  [selection.datasetId, selection.dataRevision, columns.length, schemaRevision, namesKey, rowIds, weightName])
  const pairRequest = useMemo(() => request && pair ? { ...request, columns: pair } : null, [request, pair?.[0], pair?.[1]])
  const matrix = useRelationshipResult<MatrixResult>('/relationships/matrix', request)
  const points = useRelationshipResult<RelationshipPoints>('/relationships/pair', pairRequest)
  const colorData = useColumnarData(selection.datasetId, colorBy && columns.some(column => column.name === colorBy) ? [colorBy] : [])
  const { getColor } = useRowColorResolver(colorData)
  const title = (name: string) => {
    const column = columns.find(column => column.name === name)
    return column?.multiResponseOptionLabel || column?.label || name
  }
  const updateNames = (next: string[]) => setSettings({ datasetId: selection.datasetId!, names: next, children: chosen?.children ?? [] })
  const items = [
    { key: 'focus', label: 'Focus Selected', disabled: !selection.selectedRowIds.length, onClick: () => dispatch(focusSelected()) },
    { key: 'delete', label: 'Delete Selected', disabled: !selection.selectedRowIds.length, onClick: () => dispatch(deleteSelected()) },
    { key: 'clear', label: 'Clear Selection', disabled: !selection.selectedRowIds.length, onClick: () => dispatch(selectionCleared()) },
    { key: 'reset', label: 'Reset to Base Data', onClick: () => dispatch(resetWorkingSet()) },
  ]
  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>
  return <div data-testid="relationships-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Card size="small" style={{ background: '#fafafa' }}><Space wrap>
      <Select mode="multiple" aria-label="Relationshipsの対象変数" placeholder="対象変数を選択" maxTagCount={3}
        style={{ minWidth: 280, maxWidth: 560 }} value={names} allowClear optionFilterProp="label"
        options={candidates.map(column => ({ value: column.name, label: `${column.name}: ${title(column.name)}` }))} onChange={updateNames} />
      <MaAxisPicker allowCount={false} groups={groups} columns={columns} onAdd={axes => {
        const added = axes.map(axis => columns.find(column => column.columnId === axis.columnId)?.name).filter((name): name is string => Boolean(name))
        setSettings({ datasetId: selection.datasetId!, names: [...new Set([...names, ...added])], children: [...new Set([...(chosen?.children ?? []), ...added])] })
      }} />
      <Typography.Text type="secondary">初期6変数・対象は追加できます</Typography.Text>
    </Space></Card>
    {(matrix.error || points.error) && <Alert type="error" showIcon message={matrix.error || points.error} />}
    {names.length < 2 && <Alert type="info" message="通常変数またはMA選択肢を2つ以上選択してください。" />}
    <WeightUnsupportedAlert weightColumnName={matrix.value?.weightStatus === 'unsupported' ? matrix.value?.weightColumn : null} />
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={12}><FocusTarget id="relationships-heatmap" title="相関ヒートマップ">
        <Card size="small" title="相関ヒートマップ" extra={<FocusEnterButton targetId="relationships-heatmap" title="相関ヒートマップ" />}>
          <Spin spinning={matrix.loading}><div style={{ overflow: 'auto' }}>
            {matrix.value && <table aria-label="相関行列" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr><th />{matrix.value.columns.map(name => <th key={name} title={title(name)} style={{ maxWidth: 110, padding: 4 }}>{title(name)}</th>)}</tr></thead>
              <tbody>{matrix.value.columns.map((left, i) => <tr key={left}><th title={title(left)} style={{ maxWidth: 140, padding: 4 }}>{title(left)}</th>
                {matrix.value!.columns.map((right, j) => {
                  const value = matrix.value!.matrix[i][j]
                  return <td key={right}><Button size="small" type="text" aria-label={`${left}と${right}の関係`}
                    disabled={i === j} onClick={() => setFocusPair([left, right])}
                    title={`r=${value?.toFixed(3) ?? '計算不可'} / n=${matrix.value!.counts[i][j]}`}
                    style={{ minWidth: 54, height: 40, borderRadius: 0, background: value === null ? '#fafafa' : value >= 0 ? `rgba(22,119,255,${Math.abs(value) * .65})` : `rgba(245,34,45,${Math.abs(value) * .65})` }}>
                    {value?.toFixed(2) ?? '—'}
                  </Button></td>
                })}</tr>)}</tbody>
            </table>}
          </div></Spin>
          <Typography.Text type="secondary">Pearson相関・ペアごとに欠損を除外。セルを選ぶと焦点ペアを表示します。</Typography.Text>
        </Card>
      </FocusTarget></Col>
      <Col xs={24} xl={12}><FocusTarget id="relationships-facet" title="焦点ペア">
        <Card size="small" title="焦点ペア" extra={<FocusEnterButton targetId="relationships-facet" title="焦点ペア" />}>
          {pair && <Space wrap>{[0, 1].map(index => <AntSelect key={index} aria-label={index === 0 ? '焦点ペアX' : '焦点ペアY'} value={pair[index]}
            style={{ minWidth: 150 }} options={names.filter(name => name !== pair[1 - index]).map(name => ({ value: name, label: title(name) }))}
            onChange={value => setFocusPair(index === 0 ? [value, pair[1]] : [pair[0], value])} />)}</Space>}
          <Spin spinning={points.loading}><Dropdown menu={{ items }} trigger={['contextMenu']}>
            <div>{points.value && pair && <RelationshipCanvas data={points.value} labels={[title(pair[0]), title(pair[1])]} colorOf={getColor} />}</div>
          </Dropdown></Spin>
          <Typography.Text type="secondary">{points.value?.rowIds.length ?? 0}行。点クリック・矩形選択は全ページに連動します。</Typography.Text>
        </Card>
      </FocusTarget></Col>
    </Row>
  </div>
}
