import { useMemo } from 'react'
import { Checkbox, Input, Select, Tag, Typography } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { CodebookColumn } from '../../api/client'

interface CodebookVariableListProps {
  columns: CodebookColumn[]
  activeColumnId: string | null
  selectedColumnIds: string[]
  filter: {
    keyword: string
    scaleType: string | null
    role: string | null
  }
  onSelectActive: (columnId: string) => void
  onToggleSelected: (columnIds: string[]) => void
  onFilterChange: (patch: { keyword?: string; scaleType?: string | null; role?: string | null }) => void
}

const SCALE_COLORS: Record<string, string> = {
  nominal: 'blue',
  ordinal: 'purple',
  interval: 'cyan',
  ratio: 'green',
  text: 'orange',
  id: 'default',
}

const SCALE_LABELS: Record<string, string> = {
  nominal: '名義',
  ordinal: '順序',
  interval: '間隔',
  ratio: '比率',
  text: 'テキスト',
  id: 'ID',
}

export default function CodebookVariableList({
  columns,
  activeColumnId,
  selectedColumnIds,
  filter,
  onSelectActive,
  onToggleSelected,
  onFilterChange,
}: CodebookVariableListProps) {
  const filteredColumns = useMemo(() => {
    return columns.filter((col) => {
      if (filter.scaleType && col.scaleType !== filter.scaleType) return false
      if (filter.role && col.role !== filter.role) return false
      if (filter.keyword) {
        const kw = filter.keyword.toLowerCase()
        const nameMatch = col.name.toLowerCase().includes(kw)
        const labelMatch = (col.label || '').toLowerCase().includes(kw)
        if (!nameMatch && !labelMatch) return false
      }
      return true
    })
  }, [columns, filter])

  const allFilteredIds = useMemo(() => filteredColumns.map((c) => c.columnId), [filteredColumns])
  const isAllSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => selectedColumnIds.includes(id))
  const isSomeSelected = allFilteredIds.some((id) => selectedColumnIds.includes(id)) && !isAllSelected

  const handleToggleAll = (checked: boolean) => {
    if (checked) {
      const merged = Array.from(new Set([...selectedColumnIds, ...allFilteredIds]))
      onToggleSelected(merged)
    } else {
      const remaining = selectedColumnIds.filter((id) => !allFilteredIds.includes(id))
      onToggleSelected(remaining)
    }
  }

  const handleToggleOne = (colId: string, checked: boolean) => {
    if (checked) {
      onToggleSelected([...selectedColumnIds, colId])
    } else {
      onToggleSelected(selectedColumnIds.filter((id) => id !== colId))
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderRight: '1px solid #e2e8f0' }}>
      {/* Search & Filter Header */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Input
          size="small"
          placeholder="変数名やラベルで検索..."
          prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
          value={filter.keyword}
          onChange={(e) => onFilterChange({ keyword: e.target.value })}
          allowClear
        />

        <div style={{ display: 'flex', gap: 6 }}>
          <Select
            size="small"
            style={{ flex: 1 }}
            popupMatchSelectWidth={false}
            placeholder="尺度: 全て"
            value={filter.scaleType}
            onChange={(val) => onFilterChange({ scaleType: val })}
            allowClear
            options={[
              { value: 'nominal', label: '尺度: 名義' },
              { value: 'ordinal', label: '尺度: 順序' },
              { value: 'interval', label: '尺度: 間隔' },
              { value: 'ratio', label: '尺度: 比率' },
              { value: 'text', label: '尺度: テキスト' },
              { value: 'id', label: '尺度: ID' },
            ]}
          />
          <Select
            size="small"
            style={{ flex: 1 }}
            popupMatchSelectWidth={false}
            placeholder="役割: 全て"
            value={filter.role}
            onChange={(val) => onFilterChange({ role: val })}
            allowClear
            options={[
              { value: 'question', label: '役割: 質問' },
              { value: 'attribute', label: '役割: 属性' },
              { value: 'weight', label: '役割: ウェイト' },
              { value: 'id', label: '役割: ID' },
              { value: 'other', label: '役割: その他' },
            ]}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
          <Checkbox
            checked={isAllSelected}
            indeterminate={isSomeSelected}
            onChange={(e) => handleToggleAll(e.target.checked)}
          >
            <span style={{ fontSize: 11, color: '#64748b' }}>
              全選択 ({filteredColumns.length}件)
            </span>
          </Checkbox>
          {selectedColumnIds.length > 0 && (
            <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>
              {selectedColumnIds.length}件選択中
            </Tag>
          )}
        </div>
      </div>

      {/* Variable List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {filteredColumns.map((col) => {
          const isActive = col.columnId === activeColumnId
          const isChecked = selectedColumnIds.includes(col.columnId)

          return (
            <div
              key={col.columnId}
              onClick={() => onSelectActive(col.columnId)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '6px 12px',
                cursor: 'pointer',
                background: isActive ? '#eff6ff' : 'transparent',
                borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
                transition: 'background 0.15s',
              }}
            >
              <Checkbox
                checked={isChecked}
                onChange={(e) => {
                  e.stopPropagation()
                  handleToggleOne(col.columnId, e.target.checked)
                }}
                style={{ marginRight: 8 }}
              />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <Typography.Text
                    strong
                    ellipsis
                    style={{ fontSize: 12, color: isActive ? '#1d4ed8' : '#1e293b' }}
                  >
                    {col.name}
                  </Typography.Text>
                  <Tag
                    color={SCALE_COLORS[col.scaleType] || 'default'}
                    style={{ fontSize: 9, padding: '0 4px', lineHeight: '14px', margin: 0 }}
                  >
                    {SCALE_LABELS[col.scaleType] || col.scaleType}
                  </Tag>
                  {col.role === 'question' && (
                    <Tag color="geekblue" style={{ fontSize: 9, padding: '0 4px', lineHeight: '14px', margin: 0 }}>
                      問
                    </Tag>
                  )}
                  {col.isReversed && (
                    <Tag color="magenta" style={{ fontSize: 9, padding: '0 4px', lineHeight: '14px', margin: 0 }}>
                      逆
                    </Tag>
                  )}
                </div>

                {col.label && (
                  <Typography.Text
                    type="secondary"
                    ellipsis
                    style={{ fontSize: 11, display: 'block', lineHeight: 1.2 }}
                  >
                    {col.label}
                  </Typography.Text>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
