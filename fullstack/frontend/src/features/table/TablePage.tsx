import { selectVariableEntities } from '../../app/store'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Checkbox, Dropdown, Input, Pagination, Popover, Segmented, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, hovered as hoverAction, selectEffectiveRowIds } from '../../app/store'
import { maskFilterChanged } from '../dataset/provenanceSlice'
import { api } from '../../api/client'
import { useCodebook } from '../dataset/useCodebookColumn'

type Entity = { kind: 'column' | 'ma' | 'maOption' | 'maCount'; columnId?: string; groupId?: string }
type Cell = { value?: unknown; text?: string; isMissing?: boolean; status?: string; selectedCount?: number; labels?: string[] }
type TableResult = { rows: { rowId: string; cells: Cell[] }[]; total: number; entities: (Entity & { label: string; sortable: boolean })[] }

export default function TablePage() {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const obs = useSelector((s: RootState) => s.globalObservations)
  const entitySelection = useSelector(selectVariableEntities)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const [search, setSearch] = useState('')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'selected'>('all')
  const [valueDisplayMode, setValueDisplayMode] = useState<'labels' | 'raw'>('labels')

  const { columns, schemaRevision } = useCodebook()
  const provenance = useSelector((s: RootState) => s.provenance)
  const maskFilter = provenance.maskFilter
  const groups = useSelector((s: RootState) => s.codebook.multiResponseGroups)
  const [maskEntries, setMaskEntries] = useState<{ rowId: string; columnId: string; methodLabel: string }[]>([])
  const [entityPage, setEntityPage] = useState(1)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  const [expanded, setExpanded] = useState<string[]>([])
  const [sort, setSort] = useState<{ entityIndex: number; order: 'ascend' | 'descend' }>()
  const [result, setResult] = useState<TableResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entities = useMemo(() => {
    const list: Entity[] = []
    for (const item of entitySelection.items) {
      if (!entitySelection.selected.has(item.key)) continue
      if (item.entity.kind === 'column') { list.push(item.entity); continue }
      const groupId = item.entity.groupId
      list.push({ kind: 'ma', groupId })
      if (expanded.includes(groupId)) {
        const members = columns.filter(c => c.multiResponseGroup === groupId)
        const order = groups.find(g => g.groupId === groupId)?.optionOrder
        const ids = order?.length ? order : members.map(c => c.columnId)
        list.push({ kind: 'maCount', groupId }, ...ids.map(columnId => ({ kind: 'maOption' as const, groupId, columnId })))
      }
    }
    return list
  }, [columns, groups, entitySelection, expanded])
  const currentEntityPage = Math.min(entityPage, Math.max(1, Math.ceil(entities.length / 12)))
  const visibleEntities = entities.slice((currentEntityPage - 1) * 12, currentEntityPage * 12)
  const scopedRows = scopeFilter === 'selected'
    ? effectiveRowIds.filter(id => selection.selectedRowIds.includes(id)) : effectiveRowIds
  const scopeKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, scopedRows, search, valueDisplayMode, visibleEntities])
  const [pageScope, setPageScope] = useState(scopeKey)
  const currentPage = pageScope === scopeKey ? page : 1
  const currentSort = pageScope === scopeKey ? sort : undefined
  const requestKey = JSON.stringify([scopeKey, currentPage, pageSize, currentSort, currentSort?.entityIndex === -1 ? obs.sampling.sampledRowWeights : null])
  useEffect(() => {
    if (!selection.datasetId) return
    let current = true
    api.get<{ maskRevision: number; entries: { rowId: string; columnId: string; methodLabel: string }[] }>(
      `/datasets/${selection.datasetId}/imputation-mask?expectedDataRevision=${selection.dataRevision}`,
    ).then((mask) => { if (current) setMaskEntries(mask.entries) })
      .catch(() => { if (current) setMaskEntries([]) })
    return () => { current = false }
  }, [selection.datasetId, selection.dataRevision])
  const imputedByCell = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of maskEntries) map.set(`${entry.rowId}::${entry.columnId}`, entry.methodLabel)
    return map
  }, [maskEntries])
  const imputedRowIds = useMemo(() => new Set(maskEntries.map((e) => e.rowId)), [maskEntries])
  const displayRows = useMemo(() => {
    const base = (result?.rows ?? []).map(row => ({ key: row.rowId, __rowId__: row.rowId, cells: row.cells }))
    if (maskFilter === 'all') return base
    return base.filter((row) =>
      maskFilter === 'hasImputed' ? imputedRowIds.has(row.__rowId__ as string) : !imputedRowIds.has(row.__rowId__ as string))
  }, [result, maskFilter, imputedRowIds])
  useEffect(() => {
    if (!selection.datasetId || !columns.length) return
    let current = true
    setLoading(true)
    setError(null)
    setResult(null)
    api.post<TableResult>(`/datasets/${selection.datasetId}/table-view`, {
      entityIds: visibleEntities, rowIds: scopedRows, offset: (currentPage - 1) * pageSize,
      limit: pageSize, displayMode: valueDisplayMode, search, sort: currentSort,
      expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
      rowWeights: currentSort?.entityIndex === -1 ? obs.sampling.sampledRowWeights : undefined,
    }).then(value => { if (current) setResult(value) })
      .catch(reason => { if (current) setError(reason.message || '表を取得できませんでした。') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [requestKey, columns.length])
  const rows = displayRows

  const contextMenuItems = [
    {
      key: 'focus',
      label: 'Focus Selected (選択行のみに絞り込み)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: 'Delete Selected (選択行を一時除外)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: 'Clear Selection (選択解除)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      key: 'reset',
      label: 'Reset to Base Data (全データ復帰)',
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]

  const statusLabels: Record<string, string> = { valid: '有効', partial: '部分回答', missing: '無回答', notApplicable: '非該当', invalid: '不正値' }
  const columnsData = (result?.entities ?? []).map((entity, index) => {
    const column = columns.find(c => c.columnId === entity.columnId)
    const columnLabel = (entity.kind === 'maOption' ? column?.multiResponseOptionLabel : undefined) || column?.label || column?.name
    return {
      key: String(index), width: entity.kind === 'ma' ? 260 : 160,
      title: entity.kind === 'ma' ? <Space size={4}>
        <span>{entity.label}</span><Tag>複数回答</Tag>
        <Button size="small" type="text" onClick={() => setExpanded(prev => prev.includes(entity.groupId!) ? prev.filter(id => id !== entity.groupId) : [...prev, entity.groupId!])}>
          {expanded.includes(entity.groupId!) ? '折りたたむ' : '選択肢'}
        </Button>
      </Space> : column ? <ColumnQuestionTooltip nameOrId={column.columnId}>{valueDisplayMode === 'raw' ? column.name : `${columnLabel} (${column.name})`}</ColumnQuestionTooltip> : `${entity.label}・選択数`,
      sorter: entity.sortable,
      sortOrder: currentSort?.entityIndex === index ? currentSort.order : null,
      render: (_: unknown, row: Record<string, unknown>) => {
        const cell = (row.cells as Cell[])[index]
        const columnId = entity.columnId ?? (result?.entities[index] as unknown as { columnId?: string } | undefined)?.columnId
        const imputedLabel = columnId ? imputedByCell.get(`${row.__rowId__ as string}::${columnId}`) : undefined
        const imputedBadge = imputedLabel ? (
          <Tag color="purple" aria-label={`補完値 (${imputedLabel})`} title={`補完値 (${imputedLabel})`} style={{ marginLeft: 4 }}>
            補完
          </Tag>
        ) : null
        if (entity.kind === 'ma') return <Space size={4} wrap>
          {valueDisplayMode === 'raw' ? <Typography.Text ellipsis style={{ maxWidth: 240 }} title={cell.text}>{cell.text}</Typography.Text>
            : <>{cell.labels?.slice(0, 3).map((label, i) => <Tag key={i} title={label}>{label}</Tag>)}
              {(cell.labels?.length ?? 0) > 3 && <Popover title="選択項目" content={<div style={{ maxWidth: 360, maxHeight: 300, overflow: 'auto' }}>{cell.labels?.map((label, i) => <div key={i}>{label}</div>)}</div>}>
                <Button size="small" type="link">ほか{cell.labels!.length - 3}件</Button>
              </Popover>}</>}
          {cell.selectedCount === 0 && cell.status === 'valid' && <span>選択なし</span>}
          {cell.status !== 'valid' && <Tag color="orange">{statusLabels[cell.status!]}</Tag>}
        </Space>
        const text = valueDisplayMode === 'labels' && !cell.isMissing && cell.value != null && cell.text !== String(cell.value)
          ? `${cell.text} (${cell.value})` : cell.text
        return <span title={`生コード: ${cell.value ?? '無回答'}`}>
          {cell.isMissing && valueDisplayMode === 'labels' ? <Tag color="orange">{text}</Tag> : text}
          {imputedBadge}
        </span>
      },
    }
  })

  const isBootstrapSampled = obs?.scopeMode === 'sampled' && obs?.sampling?.enabled && obs?.sampling?.method === 'with_replacement'

  const tableColumns: ColumnsType<Record<string, unknown>> = [
    {
      title: '選択',
      key: '__select__',
      width: 60,
      render: (_: unknown, row) => (
        <Checkbox
          data-testid={`select-${row.__rowId__}`}
          aria-label={`${row.__rowId__}を選択`}
          checked={selection.selectedRowIds.includes(row.__rowId__ as string)}
          onChange={(e) => dispatch(selectionApplied({
            rowIds: [row.__rowId__ as string],
            operation: e.target.checked ? 'add' : 'subtract',
            label: '表から選択',
          }))}
        />
      ),
    },
    ...(isBootstrapSampled ? [{
      title: 'Weight',
      key: '__weight__',
      width: 80,
      sorter: true,
      sortOrder: currentSort?.entityIndex === -1 ? currentSort.order : null,
      render: (_: unknown, row: Record<string, unknown>) => {
        const w = obs.sampling.sampledRowWeights[row.__rowId__ as string] ?? 1
        return w > 1 ? (
          <Tag color="orange" style={{ fontWeight: 600 }}>×{w}</Tag>
        ) : (
          <span style={{ color: '#888' }}>×{w}</span>
        )
      },
    }] : []),
    ...columnsData,
  ]

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div
      data-testid="table-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}
    >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, flexShrink: 0 }}>
          <Space wrap align="center">
            <Input.Search
              data-testid="table-search"
              placeholder="検索"
              style={{ width: 260 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
            />
            <Segmented
              data-testid="table-value-display"
              options={[{ label: 'ラベル', value: 'labels' }, { label: '生値', value: 'raw' }]}
              value={valueDisplayMode}
              onChange={(v) => setValueDisplayMode(v as 'labels' | 'raw')}
            />
            <Segmented
              data-testid="scope-filter"
              options={[{ label: '全active行', value: 'all' }, { label: `選択のみ (${selection.selectedRowIds.length})`, value: 'selected' }]}
              value={scopeFilter}
              onChange={(v) => setScopeFilter(v as 'all' | 'selected')}
            />
            <Segmented
              data-testid="mask-filter"
              options={[
                { label: '全行', value: 'all' },
                { label: `補完あり (${imputedRowIds.size})`, value: 'hasImputed' },
                { label: '補完なし', value: 'noImputed' },
              ]}
              value={maskFilter}
              onChange={(v) => dispatch(maskFilterChanged(v as 'all' | 'hasImputed' | 'noImputed'))}
            />
          </Space>
          <Space wrap align="center">
            {selection.selectedRowIds.length > 0 && (
              <Tag color="blue" style={{ fontSize: 12, padding: '2px 8px' }}>
                選択中: {selection.selectedRowIds.length} 行
              </Tag>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              表示 {result?.total ?? 0} / 総 {effectiveRowIds.length} 行 · 右クリックで操作
            </Typography.Text>
          </Space>
        </div>
      {error && <Alert type="error" message={error} />}
      {entities.length > 12 && <Space><Typography.Text>表示項目</Typography.Text><Pagination size="small" current={currentEntityPage} pageSize={12} total={entities.length} showSizeChanger={false} onChange={setEntityPage} /></Space>}
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              background: '#ffffff',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <Table
              data-testid="data-table"
              size="small"
              columns={tableColumns}
              dataSource={rows}
              loading={loading}
              pagination={{ current: currentPage, total: result?.total ?? 0, pageSize, pageSizeOptions: [25, 50, 100, 200], showSizeChanger: true }}
              onChange={(pagination, _filters, sorter, extra) => {
                setPageScope(scopeKey)
                setPage(extra.action === 'sort' ? 1 : pagination.current ?? 1)
                setPageSize(pagination.pageSize ?? 100)
                const item = Array.isArray(sorter) ? sorter[0] : sorter
                setSort(item.order ? { entityIndex: item.columnKey === '__weight__' ? -1 : Number(item.columnKey), order: item.order } : undefined)
              }}
              scroll={{ x: true }}
              rowClassName={(row) => (selection.selectedRowIds.includes(row.__rowId__ as string) ? 'ant-table-row-selected' : '')}
              onRow={(row) => ({
                onMouseEnter: () => dispatch(hoverAction(row.__rowId__ as string)),
                onMouseLeave: () => dispatch(hoverAction(null)),
              })}
            />
          </div>
        </Dropdown>
    </div>
  )
}
