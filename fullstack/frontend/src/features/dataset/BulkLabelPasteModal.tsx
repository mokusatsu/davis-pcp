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
    if (parsedRows.length === 0) return []

    // Check if TSV with variable names
    const hasVarNames = parsedRows.some((r) => r.variableName)
    if (hasVarNames) {
      const colByName = new Map(candidateColumns.map((c) => [c.name.toLowerCase(), c]))
      // The full lookup is only for explaining excluded rows in the preview.
      const allColByName = new Map(columns.map((c) => [c.name.toLowerCase(), c]))
      return parsedRows.map((row) => {
        const matchedCol = row.variableName ? colByName.get(row.variableName.toLowerCase()) : undefined
        const knownCol = matchedCol ?? (row.variableName ? allColByName.get(row.variableName.toLowerCase()) : undefined)
        return {
          rowNumber: row.lineIndex,
          columnName: knownCol?.name || row.variableName || '(未マッチ)',
          currentLabel: knownCol?.label || '-',
          newLabel: row.label,
          update: matchedCol && row.label ? { columnId: matchedCol.columnId, label: row.label } : undefined,
          skipReason: matchedCol ? '空欄（変更なし）' : knownCol ? '対象フィルタ外' : '変数名不明',
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
        columnName: col ? col.name : '(範囲超過)',
        currentLabel: col ? col.label : '-',
        newLabel: parsedRows[i].label,
        // A blank row still consumes this position, but never clears a label.
        update: col && parsedRows[i].label ? { columnId: col.columnId, label: parsedRows[i].label } : undefined,
        skipReason: col ? '空欄（変更なし）' : '範囲超過',
      })
    }
    return results
  }, [parsedRows, candidateColumns, columns, startColId])

  const updates = useMemo(() => mapping.flatMap((m) => m.update ? [m.update] : []), [mapping])

  const handleApply = () => {
    if (updates.length === 0) return
    onApply(updates)
    setPasteText('')
    onClose()
  }

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
          disabled={updates.length === 0}
          onClick={handleApply}
        >
          反映する ({updates.length}件)
        </Button>,
      ]}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        Excelの質問文列やテキストをコピーし、下のテキストエリアに貼り付けてください（1行＝1設問、または <code>変数名 [タブ] 質問文</code> 形式）。
        空欄のラベルは変更しません。空行をスキップしない場合、空行も1列分として数えます。
      </Typography.Paragraph>

      <Input.TextArea
        aria-label="貼り付ける質問文"
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
            aria-label="開始変数"
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
            aria-label="対象フィルタ"
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
            マッピング・差分プレビュー ({updates.length} / {parsedRows.length}件を反映)
          </Typography.Text>
          <Table
            size="small"
            scroll={{ x: 700 }}
            pagination={{ pageSize: 5 }}
            dataSource={mapping.map((m, i) => ({ key: i, ...m }))}
            columns={[
              { title: '行', dataIndex: 'rowNumber', key: 'rowNumber', width: 50 },
              {
                title: '変数名',
                dataIndex: 'columnName',
                key: 'columnName',
                width: 120,
                render: (val, r) => (
                  <Typography.Text style={{ color: r.update ? undefined : '#94a3b8' }}>
                    {val}
                  </Typography.Text>
                ),
              },
              { title: '現在のラベル', dataIndex: 'currentLabel', key: 'currentLabel', width: 160, ellipsis: true },
              {
                title: '貼り付け後の新しい質問文',
                dataIndex: 'newLabel',
                key: 'newLabel',
                ellipsis: true,
                render: (val, r) => (
                  <Typography.Text strong={!!r.update} style={{ color: r.update ? '#16a34a' : '#94a3b8' }}>
                    {val || '（空欄）'}
                  </Typography.Text>
                ),
              },
              { title: '状態', key: 'status', width: 140, render: (_, r) => r.update ? '反映対象' : r.skipReason },
            ]}
          />
        </div>
      )}
    </Modal>
  )
}
