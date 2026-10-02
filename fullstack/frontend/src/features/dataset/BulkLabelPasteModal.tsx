import { useMemo, useState } from 'react'
import { Button, Checkbox, Modal, Select, Space, Table, Typography, Input } from 'antd'
import { CodebookColumn } from '../../api/client'
import ColumnSelect from '../common/ColumnSelect'
import { parseBulkLabels } from './codebookParsers'

interface BulkLabelPasteModalProps {
  open: boolean
  onClose: () => void
  columns: CodebookColumn[]
  onApply: (updates: { columnId: string; label: string }[]) => void
}

export default function BulkLabelPasteModal({
  open,
  onClose,
  columns,
  onApply,
}: BulkLabelPasteModalProps) {
  const [pasteText, setPasteText] = useState('')
  const [startColId, setStartColId] = useState<string>(columns[0]?.columnId || '')
  const [filterRole, setFilterRole] = useState<string>('all')
  const [skipEmpty, setSkipEmpty] = useState<boolean>(true)

  // Filter columns based on target role
  const candidateColumns = useMemo(() => {
    return columns.filter((c) => {
      if (filterRole === 'all') return true
      return c.role === filterRole
    })
  }, [columns, filterRole])

  // Parse lines
  const parsedRows = useMemo(() => {
    return parseBulkLabels(pasteText, skipEmpty)
  }, [pasteText, skipEmpty])

  // Map parsed rows to candidate columns
  const mapping = useMemo(() => {
    if (parsedRows.length === 0 || candidateColumns.length === 0) return []

    // Check if TSV with variable names
    const hasVarNames = parsedRows.some((r) => r.variableName)
    if (hasVarNames) {
      const colByName = new Map(columns.map((c) => [c.name.toLowerCase(), c]))
      return parsedRows.map((row) => {
        const matchedCol = row.variableName ? colByName.get(row.variableName.toLowerCase()) : undefined
        return {
          rowNumber: row.lineIndex,
          columnId: matchedCol?.columnId,
          columnName: matchedCol?.name || row.variableName || '(未マッチ)',
          currentLabel: matchedCol?.label || '-',
          newLabel: row.label,
          matched: !!matchedCol,
        }
      })
    }

    // Positional mapping starting from startColId
    let startIndex = candidateColumns.findIndex((c) => c.columnId === startColId)
    if (startIndex === -1) startIndex = 0

    const results = []
    for (let i = 0; i < parsedRows.length; i++) {
      const colIndex = startIndex + i
      const col = candidateColumns[colIndex]
      results.push({
        rowNumber: parsedRows[i].lineIndex,
        columnId: col?.columnId,
        columnName: col ? col.name : '(範囲超過)',
        currentLabel: col ? col.label : '-',
        newLabel: parsedRows[i].label,
        matched: !!col,
      })
    }
    return results
  }, [parsedRows, candidateColumns, columns, startColId])

  const handleApply = () => {
    const updates = mapping
      .filter((m) => m.matched && m.columnId && m.newLabel)
      .map((m) => ({ columnId: m.columnId!, label: m.newLabel }))

    onApply(updates)
    setPasteText('')
    onClose()
  }

  const validUpdateCount = mapping.filter((m) => m.matched).length

  return (
    <Modal
      title="質問文（ラベル）の一括貼り付け"
      open={open}
      onCancel={onClose}
      width={780}
      footer={[
        <Button key="cancel" onClick={onClose}>
          キャンセル
        </Button>,
        <Button
          key="apply"
          type="primary"
          disabled={validUpdateCount === 0}
          onClick={handleApply}
        >
          反映する ({validUpdateCount}件)
        </Button>,
      ]}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        Excelの質問文列やテキストをコピーし、下のテキストエリアに貼り付けてください（1行＝1設問、または <code>変数名 [タブ] 質問文</code> 形式）。
      </Typography.Paragraph>

      <Input.TextArea
        rows={6}
        value={pasteText}
        onChange={(e) => setPasteText(e.target.value)}
        placeholder={`当サービスの総合的な満足度をお答えください。\nシステムの使いやすさはいかがでしたか。\n処理速度・レスポンスについてどう感じますか。`}
        style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 12 }}
      />

      <Space wrap style={{ marginBottom: 12 }}>
        <Space size="small">
          <Typography.Text style={{ fontSize: 12 }}>開始変数:</Typography.Text>
          <ColumnSelect
            size="small"
            style={{ width: 180 }}
            popupMatchSelectWidth={false}
            value={startColId}
            onChange={setStartColId}
            options={candidateColumns.map((c) => ({
              value: c.columnId,
              label: c.name, questionName: c.name, questionText: c.label,
            }))}
          />
        </Space>

        <Space size="small">
          <Typography.Text style={{ fontSize: 12 }}>対象フィルタ:</Typography.Text>
          <Select
            size="small"
            style={{ width: 140 }}
            popupMatchSelectWidth={false}
            value={filterRole}
            onChange={setFilterRole}
            options={[
              { value: 'all', label: 'すべての列' },
              { value: 'question', label: '役割: 質問のみ' },
              { value: 'attribute', label: '役割: 属性のみ' },
            ]}
          />
        </Space>

        <Checkbox checked={skipEmpty} onChange={(e) => setSkipEmpty(e.target.checked)}>
          <span style={{ fontSize: 12 }}>空行をスキップ</span>
        </Checkbox>
      </Space>

      {mapping.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Typography.Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
            マッピング・差分プレビュー ({validUpdateCount} / {parsedRows.length}件一致)
          </Typography.Text>
          <Table
            size="small"
            pagination={{ pageSize: 5 }}
            dataSource={mapping.map((m, i) => ({ key: i, ...m }))}
            columns={[
              { title: '行', dataIndex: 'rowNumber', key: 'rowNumber', width: 50 },
              {
                title: '変数名',
                dataIndex: 'columnName',
                key: 'columnName',
                width: 140,
                render: (val, r) => (
                  <Typography.Text style={{ color: r.matched ? undefined : '#ef4444' }}>
                    {val}
                  </Typography.Text>
                ),
              },
              { title: '現在のラベル', dataIndex: 'currentLabel', key: 'currentLabel', width: 200, ellipsis: true },
              {
                title: '貼り付け後の新しい質問文',
                dataIndex: 'newLabel',
                key: 'newLabel',
                ellipsis: true,
                render: (val, r) => (
                  <Typography.Text strong style={{ color: r.matched ? '#16a34a' : '#94a3b8' }}>
                    {val}
                  </Typography.Text>
                ),
              },
            ]}
          />
        </div>
      )}
    </Modal>
  )
}
