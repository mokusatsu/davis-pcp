import { useEffect, useState } from 'react'
import {
  Button,
  Checkbox,
  Input,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons'
import { CodebookColumn } from '../../api/client'
import QuickValueLabelsPopover from './QuickValueLabelsPopover'
import { CodebookPreset } from './codebookPresets'
import { ParsedOption } from './codebookParsers'

interface CodebookDetailFormProps {
  column: CodebookColumn
  allColumns: CodebookColumn[]
  selectedCount: number
  onUpdate: (patch: Partial<CodebookColumn>) => void
  onNavigate: (direction: 'prev' | 'next') => void
  onApplyQuickLabels: (options: ParsedOption[], applyToSelected: boolean) => void
  onApplyPreset: (preset: CodebookPreset, applyToSelected: boolean) => void
}

export default function CodebookDetailForm({
  column,
  allColumns,
  selectedCount,
  onUpdate,
  onNavigate,
  onApplyQuickLabels,
  onApplyPreset,
}: CodebookDetailFormProps) {
  const [newCode, setNewCode] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [missingCodeInput, setMissingCodeInput] = useState(column.missingCodes?.join(', ') || '')
  useEffect(() => { setMissingCodeInput(column.missingCodes?.join(', ') || '') }, [column.columnId, column.missingCodes])

  const currentIndex = allColumns.findIndex((c) => c.columnId === column.columnId)
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < allColumns.length - 1

  // Handle label change in option list
  const handleOptionLabelChange = (code: string, label: string) => {
    const nextLabels = { ...column.valueLabels, [code]: label }
    onUpdate({ valueLabels: nextLabels })
  }

  // Add new option
  const handleAddOption = () => {
    if (!newCode) return
    const codeStr = newCode.trim()
    const nextLabels = { ...column.valueLabels, [codeStr]: newLabel.trim() || codeStr }
    const nextOrder = column.categoryOrder ? [...column.categoryOrder] : []
    if (!nextOrder.includes(codeStr)) {
      nextOrder.push(codeStr)
    }
    onUpdate({ valueLabels: nextLabels, categoryOrder: nextOrder })
    setNewCode('')
    setNewLabel('')
  }

  // Delete option
  const handleDeleteOption = (code: string) => {
    const nextLabels = { ...column.valueLabels }
    delete nextLabels[code]
    const nextOrder = (column.categoryOrder || []).filter((c) => c !== code)
    onUpdate({ valueLabels: nextLabels, categoryOrder: nextOrder })
  }

  // Move option order
  const handleMoveOption = (index: number, direction: 'up' | 'down') => {
    const order = [...(column.categoryOrder || Object.keys(column.valueLabels))]
    const targetIdx = direction === 'up' ? index - 1 : index + 1
    if (targetIdx < 0 || targetIdx >= order.length) return
    const temp = order[index]
    order[index] = order[targetIdx]
    order[targetIdx] = temp
    onUpdate({ categoryOrder: order })
  }

  // Sort by code ascending
  const handleSortAscending = () => {
    const order = [...(column.categoryOrder || Object.keys(column.valueLabels))]
    order.sort((a, b) => {
      const numA = Number(a)
      const numB = Number(b)
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB
      return a.localeCompare(b)
    })
    onUpdate({ categoryOrder: order })
  }

  // Reverse sort
  const handleSortReverse = () => {
    const order = [...(column.categoryOrder || Object.keys(column.valueLabels))]
    order.reverse()
    onUpdate({ categoryOrder: order })
  }

  // Update missing codes
  const handleMissingCodesBlur = () => {
    const codes = missingCodeInput
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
    onUpdate({ missingCodes: codes })
  }

  const categoryOrder =
    column.categoryOrder && column.categoryOrder.length > 0
      ? column.categoryOrder
      : Object.keys(column.valueLabels || {})

  const optionRows = categoryOrder.map((code, idx) => ({
    key: code,
    code,
    label: column.valueLabels?.[code] ?? code,
    index: idx,
  }))

  return (
    <div style={{ padding: '12px 18px', height: '100%', overflowY: 'auto' }}>
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid #e2e8f0',
          paddingBottom: 8,
          marginBottom: 12,
        }}
      >
        <div>
          <Space align="center">
            <Typography.Title level={5} style={{ margin: 0, fontSize: 15 }}>
              変数: {column.name}
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              (列ID: {column.columnId})
            </Typography.Text>
          </Space>
        </div>
        <Space size="small">
          <Button
            size="small"
            icon={<LeftOutlined />}
            disabled={!hasPrev}
            onClick={() => onNavigate('prev')}
          >
            前の変数
          </Button>
          <Button
            size="small"
            icon={<RightOutlined />}
            disabled={!hasNext}
            onClick={() => onNavigate('next')}
          >
            次の変数
          </Button>
        </Space>
      </div>

      {/* Basic Attributes Form */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        <div>
          <Typography.Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
            質問文 (ラベル):
          </Typography.Text>
          <Input.TextArea
            rows={2}
            value={column.label}
            placeholder="当サービスの総合的な満足度をお答えください。"
            onChange={(e) => onUpdate({ label: e.target.value })}
            style={{ fontSize: 12 }}
          />
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
          <div>
            <Typography.Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              尺度水準:
            </Typography.Text>
            <Radio.Group
              size="small"
              value={column.scaleType}
              onChange={(e) => onUpdate({ scaleType: e.target.value })}
            >
              <Radio.Button value="nominal">名義</Radio.Button>
              <Radio.Button value="ordinal">順序</Radio.Button>
              <Radio.Button value="interval">間隔</Radio.Button>
              <Radio.Button value="ratio">比率</Radio.Button>
              <Radio.Button value="text">テキスト</Radio.Button>
              <Radio.Button value="id">ID</Radio.Button>
            </Radio.Group>
          </div>

          <div>
            <Typography.Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              設問役割:
            </Typography.Text>
            <Radio.Group
              size="small"
              value={column.role}
              onChange={(e) => onUpdate({ role: e.target.value })}
            >
              <Radio.Button value="question">質問</Radio.Button>
              <Radio.Button value="attribute">属性</Radio.Button>
              <Radio.Button value="weight">ウェイト</Radio.Button>
              <Radio.Button value="id">ID</Radio.Button>
              <Radio.Button value="other">その他</Radio.Button>
            </Radio.Group>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <Checkbox
              checked={column.isReversed}
              onChange={(e) => onUpdate({ isReversed: e.target.checked })}
            >
              <span style={{ fontSize: 12 }}>逆転項目 (値が大きいほどネガティブ)</span>
            </Checkbox>
            {column.isReversed && ['ratio', 'interval', 'numeric'].includes(column.scaleType)
              && !(column.categoryOrder || []).some((c) => Number.isFinite(Number(c))) && (
              <Typography.Text type="warning" style={{ fontSize: 11, display: 'block' }}>
                数値系の逆転には尺度範囲（選択肢順序の数値）が必要です。このまま保存すると422エラーになります。
              </Typography.Text>
            )}
          </div>

          <Space size="small">
            <Typography.Text style={{ fontSize: 12 }}>MAグループ:</Typography.Text>
            <Input
              size="small"
              style={{ width: 130 }}
              placeholder="例: Q5"
              value={column.multiResponseGroup || ''}
              onChange={(e) => onUpdate({ multiResponseGroup: e.target.value || null })}
            />
          </Space>

          <Space size="small">
            <Typography.Text style={{ fontSize: 12 }}>欠損値コード:</Typography.Text>
            <Input
              size="small"
              style={{ width: 140 }}
              placeholder="98, 99"
              value={missingCodeInput}
              onChange={(e) => setMissingCodeInput(e.target.value)}
              onBlur={handleMissingCodesBlur}
            />
          </Space>
        </div>
      </div>

      {/* Value labels section */}
      {(column.missingCodes ?? []).length > 0 && <Space wrap style={{ marginBottom: 12 }}>
        {column.missingCodes.map(code => <label key={code} style={{ fontSize: 12 }}>
          欠損理由 ({code})
          <Input size="small" aria-label={`欠損理由 ${code}`} style={{ width: 130, marginLeft: 6 }}
            value={column.missingReasons?.[code] ?? ''} placeholder="無回答 / 非該当"
            onChange={e => onUpdate({ missingReasons: { ...column.missingReasons, [code]: e.target.value } })} />
        </label>)}
      </Space>}
      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <Typography.Text strong style={{ fontSize: 12 }}>
            選択肢・値ラベル ({optionRows.length}水準)
          </Typography.Text>

          <QuickValueLabelsPopover
            column={column}
            onApply={onApplyQuickLabels}
            onApplyPreset={onApplyPreset}
            selectedCount={selectedCount}
          />
        </div>

        <Table
          size="small"
          pagination={false}
          dataSource={optionRows}
          columns={[
            {
              title: 'コード',
              dataIndex: 'code',
              key: 'code',
              width: 80,
              render: (code: string) => <Tag style={{ fontFamily: 'monospace' }}>{code}</Tag>,
            },
            {
              title: '表示ラベル',
              dataIndex: 'label',
              key: 'label',
              render: (lbl: string, r) => (
                <Input
                  size="small"
                  value={lbl}
                  onChange={(e) => handleOptionLabelChange(r.code, e.target.value)}
                  style={{ fontSize: 12 }}
                />
              ),
            },
            {
              title: '順序 / 操作',
              key: 'actions',
              width: 130,
              render: (_, r) => (
                <Space size={2}>
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowUpOutlined style={{ fontSize: 11 }} />}
                    disabled={r.index === 0}
                    onClick={() => handleMoveOption(r.index, 'up')}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowDownOutlined style={{ fontSize: 11 }} />}
                    disabled={r.index === optionRows.length - 1}
                    onClick={() => handleMoveOption(r.index, 'down')}
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined style={{ fontSize: 11 }} />}
                    onClick={() => handleDeleteOption(r.code)}
                  />
                </Space>
              ),
            },
          ]}
        />

        {/* Add option row & Sort buttons */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 8,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <Space size="small">
            <Input
              size="small"
              placeholder="コード (例: 1)"
              style={{ width: 90 }}
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              onPressEnter={handleAddOption}
            />
            <Input
              size="small"
              placeholder="表示ラベル (例: 不満)"
              style={{ width: 140 }}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onPressEnter={handleAddOption}
            />
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={!newCode}
              onClick={handleAddOption}
            >
              追加
            </Button>
          </Space>

          <Space size="small">
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              並び順:
            </Typography.Text>
            <Button size="small" onClick={handleSortAscending}>
              コード昇順
            </Button>
            <Button size="small" onClick={handleSortReverse}>
              反転
            </Button>
          </Space>
        </div>
      </div>
    </div>
  )
}
