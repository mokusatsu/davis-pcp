import { Button, Dropdown, Table, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'

export interface CrosstabCell {
  rowCategoryId: string
  colCategoryId: string
  rowLabel: string
  colLabel: string
  unweightedCount: number
  count: number
  rowPct: number | null
  colPct: number | null
  totalPct: number | null
  expectedCount: number
  asr: number | null
  significance: string
  rowIds: string[]
  rowIdCount: number
  rowIdsTruncated: boolean
}

export type DisplayMode = 'count' | 'rowPct' | 'colPct' | 'totalPct'

function cellValue(cell: CrosstabCell, mode: DisplayMode): string {
  if (mode === 'count') return `${cell.unweightedCount}`
  const value = cell[mode]
  return value === null ? '—' : `${value.toFixed(1)}%`
}

function asrColor(asr: number | null): string | undefined {
  if (asr === null) return undefined
  if (asr >= 1.96) return '#cf1322'
  if (asr <= -1.96) return '#1677ff'
  return undefined
}

interface GridProps {
  rows: { id: string; label: string }[]
  columns: { id: string; label: string }[]
  cells: Map<string, CrosstabCell>
  mode: DisplayMode
  onCellClick: (cell: CrosstabCell, operation: 'add' | 'replace' | 'toggle') => void
}

export default function CrosstabTable({ rows, columns, cells, mode, onCellClick }: GridProps) {
  const data = rows.map((row) => ({ key: row.id, label: row.label }))
  const tableColumns: ColumnsType<{ key: string; label: string }> = [
    { title: '', dataIndex: 'label', key: 'label', width: 160, fixed: 'left' },
    ...columns.map((col) => ({
      title: col.label,
      dataIndex: col.id,
      key: col.id,
      width: 150,
      render: (_: unknown, row: { key: string; label: string }) => {
        const cell = cells.get(`${row.key}::${col.id}`)
        if (!cell) return <span>—</span>
        const color = asrColor(cell.asr)
        const menu = {
          items: [
            { key: 'replace', label: '選択を置換' },
            { key: 'add', label: '選択に追加' },
            { key: 'toggle', label: '選択を切替' },
          ],
          onClick: ({ key }: { key: string }) =>
            onCellClick(cell, key as 'add' | 'replace' | 'toggle'),
        }
        return (
          <Dropdown menu={menu} trigger={['click']}>
            <Button
              type="text"
              size="small"
              data-testid={`crosstab-cell-${cell.rowCategoryId}-${cell.colCategoryId}`}
              aria-label={`${cell.rowLabel} × ${cell.colLabel} を選択 (n=${cell.rowIdCount}${cell.significance ? `, ${cell.significance}` : ''})`}
              style={{ width: '100%', height: 'auto', padding: '4px 8px', textAlign: 'left' }}
            >
              <span style={{ fontWeight: 600, color }}>{cellValue(cell, mode)}</span>{' '}
              <span style={{ color: '#888', fontSize: 11 }}>(n={cell.unweightedCount})</span>
              {cell.significance && (
                <Tooltip title={`調整済み残差 ${cell.asr}`}>
                  <Tag color={color} style={{ marginLeft: 4 }}>{cell.significance}</Tag>
                </Tooltip>
              )}
              {cell.rowIdsTruncated && <Tag style={{ marginLeft: 4 }}>一部</Tag>}
            </Button>
          </Dropdown>
        )
      },
    })),
  ]
  return <Table size="small" pagination={false} dataSource={data} columns={tableColumns} scroll={{ x: 'max-content' }} />
}
