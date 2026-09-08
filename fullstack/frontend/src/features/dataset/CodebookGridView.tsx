import { useMemo, useState } from 'react'
import { Checkbox, Input, Select, Space, Table, Tooltip, Typography } from 'antd'
import { CodebookColumn } from '../../api/client'

interface CodebookGridViewProps {
  columns: CodebookColumn[]
  onUpdateColumn: (columnId: string, patch: Partial<CodebookColumn>) => void
  onBulkUpdateLabels: (updates: { columnId: string; label: string }[]) => void
}

export default function CodebookGridView({
  columns,
  onUpdateColumn,
  onBulkUpdateLabels,
}: CodebookGridViewProps) {
  const [filterRole, setFilterRole] = useState<string>('all')

  const filteredColumns = useMemo(() => {
    return columns.filter((col) => {
      if (filterRole === 'all') return true
      return col.role === filterRole
    })
  }, [columns, filterRole])

  // Summarize value labels for display in grid cell
  const getValueLabelsSummary = (col: CodebookColumn) => {
    const keys = Object.keys(col.valueLabels || {})
    if (keys.length === 0) return '-'
    if (keys.length <= 3) {
      return keys.map((k) => `${k}:${col.valueLabels[k]}`).join(', ')
    }
    return `${keys[0]}:${col.valueLabels[keys[0]]} .. ${keys[keys.length - 1]}:${col.valueLabels[keys[keys.length - 1]]} (${keys.length}件)`
  }

  // Render full value labels in tooltip balloon
  const renderValueLabelsTooltip = (col: CodebookColumn) => {
    const labels = col.valueLabels || {}
    const keys = Object.keys(labels)
    if (keys.length === 0) {
      return <span style={{ fontSize: 12, color: '#cbd5e1' }}>（値ラベル設定なし）</span>
    }

    const order =
      col.categoryOrder && col.categoryOrder.length > 0
        ? col.categoryOrder.filter((k) => k in labels)
        : keys
    const allKeys = Array.from(new Set([...order, ...keys]))

    return (
      <div style={{ maxHeight: 280, overflowY: 'auto', padding: '2px 0' }}>
        <div
          style={{
            fontWeight: 600,
            borderBottom: '1px solid rgba(255,255,255,0.25)',
            paddingBottom: 4,
            marginBottom: 6,
            fontSize: 12,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>値ラベル一覧</span>
          <span style={{ fontSize: 11, opacity: 0.85 }}>全 {allKeys.length} 件</span>
        </div>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <tbody>
            {allKeys.map((code) => (
              <tr key={code} style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <td
                  style={{
                    fontWeight: 600,
                    paddingRight: 10,
                    paddingTop: 3,
                    paddingBottom: 3,
                    verticalAlign: 'top',
                    color: '#91caff',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {code}
                </td>
                <td style={{ paddingTop: 3, paddingBottom: 3, verticalAlign: 'top', color: '#ffffff' }}>
                  {labels[code]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // Handle paste in question label column
  const handleLabelPaste = (e: React.ClipboardEvent<HTMLInputElement>, startColId: string) => {
    const text = e.clipboardData.getData('text')
    if (!text || !text.includes('\n')) return // Single line, let normal input handle

    e.preventDefault()
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const startIndex = filteredColumns.findIndex((c) => c.columnId === startColId)
    if (startIndex === -1) return

    const updates: { columnId: string; label: string }[] = []
    for (let i = 0; i < lines.length; i++) {
      const col = filteredColumns[startIndex + i]
      if (col) {
        updates.push({ columnId: col.columnId, label: lines[i] })
      }
    }
    if (updates.length > 0) {
      onBulkUpdateLabels(updates)
    }
  }

  return (
    <div style={{ padding: 12, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <Space size="middle">
          <Space size="small">
            <Typography.Text style={{ fontSize: 12 }}>フィルタ:</Typography.Text>
            <Select
              size="small"
              popupMatchSelectWidth={false}
              value={filterRole}
              onChange={setFilterRole}
              style={{ width: 140 }}
              options={[
                { value: 'all', label: 'すべて表示' },
                { value: 'question', label: '質問変数のみ' },
                { value: 'attribute', label: '属性変数のみ' },
              ]}
            />
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            表示件数: {filteredColumns.length} / {columns.length} 変数
          </Typography.Text>
        </Space>

        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          ※ 質問文セルにExcel等の複数行をペースト (Ctrl+V) すると下方向に連続反映されます
        </Typography.Text>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <Table
          size="small"
          pagination={false}
          scroll={{ y: 'calc(100vh - 280px)', x: 1120 }}
          dataSource={filteredColumns.map((c, i) => ({ key: c.columnId, index: i + 1, ...c }))}
          columns={[
            {
              title: '#',
              dataIndex: 'index',
              key: 'index',
              width: 50,
              align: 'center',
            },
            {
              title: '変数名',
              dataIndex: 'name',
              key: 'name',
              width: 150,
              render: (name: string) => <Typography.Text strong style={{ fontSize: 12 }}>{name}</Typography.Text>,
            },
            {
              title: '尺度',
              dataIndex: 'scaleType',
              key: 'scaleType',
              width: 120,
              render: (scaleType: string, r) => (
                <Select
                  size="small"
                  popupMatchSelectWidth={false}
                  value={scaleType}
                  onChange={(val) => onUpdateColumn(r.columnId, { scaleType: val as any })}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'nominal', label: '名義' },
                    { value: 'ordinal', label: '順序' },
                    { value: 'interval', label: '間隔' },
                    { value: 'ratio', label: '比率' },
                    { value: 'text', label: 'テキスト' },
                    { value: 'id', label: 'ID' },
                  ]}
                />
              ),
            },
            {
              title: '役割',
              dataIndex: 'role',
              key: 'role',
              width: 120,
              render: (role: string, r) => (
                <Select
                  size="small"
                  popupMatchSelectWidth={false}
                  value={role}
                  onChange={(val) => onUpdateColumn(r.columnId, { role: val as any })}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'question', label: '質問' },
                    { value: 'attribute', label: '属性' },
                    { value: 'weight', label: 'ウェイト' },
                    { value: 'id', label: 'ID' },
                    { value: 'other', label: 'その他' },
                  ]}
                />
              ),
            },
            {
              title: '質問文 (ラベル)',
              dataIndex: 'label',
              key: 'label',
              render: (label: string, r) => (
                <Input
                  size="small"
                  value={label}
                  onChange={(e) => onUpdateColumn(r.columnId, { label: e.target.value })}
                  onPaste={(e) => handleLabelPaste(e, r.columnId)}
                  placeholder="質問文を入力"
                  style={{ fontSize: 12 }}
                />
              ),
            },
            {
              title: '値ラベル要約',
              key: 'valSummary',
              width: 200,
              render: (_, r) => {
                const keys = Object.keys(r.valueLabels || {})
                const hasLabels = keys.length > 0
                return (
                  <Tooltip
                    title={renderValueLabelsTooltip(r)}
                    placement="topLeft"
                    styles={{ root: { maxWidth: 420 } }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        color: hasLabels ? '#334155' : '#94a3b8',
                        cursor: hasLabels ? 'help' : 'default',
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {getValueLabelsSummary(r)}
                    </span>
                  </Tooltip>
                )
              },
            },
            {
              title: '欠損コード',
              dataIndex: 'missingCodes',
              key: 'missingCodes',
              width: 100,
              render: (codes: string[], r) => (
                <Input
                  size="small"
                  value={codes?.join(',') || ''}
                  placeholder="98,99"
                  onChange={(e) => {
                    const parsed = e.target.value.split(',').map((x) => x.trim()).filter(Boolean)
                    onUpdateColumn(r.columnId, { missingCodes: parsed })
                  }}
                  style={{ fontSize: 11 }}
                />
              ),
            },
            {
              title: '逆転',
              dataIndex: 'isReversed',
              key: 'isReversed',
              width: 60,
              align: 'center',
              render: (isReversed: boolean, r) => (
                <Checkbox
                  checked={isReversed}
                  onChange={(e) => onUpdateColumn(r.columnId, { isReversed: e.target.checked })}
                />
              ),
            },
            {
              title: 'MA群',
              dataIndex: 'multiResponseGroup',
              key: 'multiResponseGroup',
              width: 90,
              render: (ma: string | null, r) => (
                <Input
                  size="small"
                  value={ma || ''}
                  placeholder="Q5等"
                  onChange={(e) => onUpdateColumn(r.columnId, { multiResponseGroup: e.target.value || null })}
                  style={{ fontSize: 11 }}
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  )
}
