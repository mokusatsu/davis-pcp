import { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Checkbox, Dropdown, Input, Segmented, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, hovered as hoverAction, selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'

export default function TablePage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const obs = useSelector((s: RootState) => s.globalObservations)
  const globalVars = useSelector((s: RootState) => s.globalVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const data = useColumnarData(selection.datasetId)
  const [search, setSearch] = useState('')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'selected'>('all')

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

  const columnsData = useMemo(() => {
    if (!data) return []
    const activeVarSet = globalVars?.activeVariableIds?.length ? new Set(globalVars.activeVariableIds) : null
    const schema = activeVarSet ? data.schema.filter((c) => activeVarSet.has(c.name)) : data.schema
    return schema.map((column) => ({
      title: column.name,
      dataIndex: column.name,
      key: column.name,
      sorter: (a: Record<string, unknown>, b: Record<string, unknown>) => {
        const av = a[column.name]
        const bv = b[column.name]
        if (typeof av === 'number' && typeof bv === 'number') return av - bv
        return String(av).localeCompare(String(bv))
      },
      render: (value: unknown) => String(value ?? ''),
    }))
  }, [data, globalVars?.activeVariableIds])

  const rows = useMemo(() => {
    if (!data) return []
    const selectedSet = new Set(selection.selectedRowIds)
    let indexes = data.rowIds.map((id, index) => ({ id, index }))
    const effectiveSet = new Set(effectiveRowIds)
    indexes = indexes.filter((row) => effectiveSet.has(row.id))
    if (scopeFilter === 'selected') indexes = indexes.filter((row) => selectedSet.has(row.id))
    const query = search.trim().toLowerCase()
    if (query) {
      indexes = indexes.filter(({ id, index }) =>
        id.toLowerCase().includes(query)
        || data.schema.some((c) => String(data.columns[c.name]?.[index] ?? '').toLowerCase().includes(query)))
    }
    return indexes.map(({ id, index }) => ({
      key: id,
      __rowId__: id,
      ...Object.fromEntries(data.schema.map((c) => [c.name, data.columns[c.name]?.[index]])),
    }))
  }, [data, effectiveRowIds, selection.selectedRowIds, scopeFilter, search])

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
      sorter: (a: Record<string, unknown>, b: Record<string, unknown>) => {
        const wa = obs.sampling.sampledRowWeights[a.__rowId__ as string] ?? 1
        const wb = obs.sampling.sampledRowWeights[b.__rowId__ as string] ?? 1
        return wa - wb
      },
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: focused ? 0 : 12,
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : undefined,
        minHeight: 0,
      }}
    >
      {!focused && (
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
              data-testid="scope-filter"
              options={[{ label: '全active行', value: 'all' }, { label: `選択のみ (${selection.selectedRowIds.length})`, value: 'selected' }]}
              value={scopeFilter}
              onChange={(v) => setScopeFilter(v as 'all' | 'selected')}
            />
            <FocusEnterButton targetId="table" title="データテーブル" />
          </Space>
          <Space wrap align="center">
            {selection.selectedRowIds.length > 0 && (
              <Tag color="blue" style={{ fontSize: 12, padding: '2px 8px' }}>
                選択中: {selection.selectedRowIds.length} 行
              </Tag>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              表示 {rows.length} / 総 {data?.rowIds.length ?? 0} 行 · 右クリックで操作
            </Typography.Text>
          </Space>
        </div>
      )}
      <FocusTarget id="table" title="データテーブル">
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
          <div
            style={{
              border: focused ? 'none' : '1px solid #e5e7eb',
              borderRadius: 6,
              background: '#ffffff',
              padding: focused ? 4 : 14,
              height: focused ? '100%' : undefined,
              flex: focused ? 1 : undefined,
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
              pagination={{ pageSize: 25, pageSizeOptions: [10, 25, 50, 100], showSizeChanger: true }}
              scroll={{ x: true, y: focused ? 'calc(100vh - 120px)' : undefined }}
              rowClassName={(row) => (selection.selectedRowIds.includes(row.__rowId__ as string) ? 'ant-table-row-selected' : '')}
              onRow={(row) => ({
                onMouseEnter: () => dispatch(hoverAction(row.__rowId__ as string)),
                onMouseLeave: () => dispatch(hoverAction(null)),
              })}
            />
          </div>
        </Dropdown>
      </FocusTarget>
    </div>
  )
}
