import { useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  InputNumber,
  MenuProps,
  Modal,
  Popover,
  Space,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  BookOutlined,
  DeleteOutlined,
  DownOutlined,
  PlusCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { CodebookColumn } from '../../api/client'
import { parseQuickValueLabels, ParsedOption } from './codebookParsers'
import {
  CodebookPreset,
  deleteCustomPreset,
  getAllPresets,
  saveCustomPreset,
} from './codebookPresets'

interface QuickValueLabelsPopoverProps {
  column: CodebookColumn
  onApply: (options: ParsedOption[], applyToSelected: boolean) => void
  onApplyPreset: (preset: CodebookPreset, applyToSelected: boolean) => void
  selectedCount: number
}

export default function QuickValueLabelsPopover({
  column,
  onApply,
  onApplyPreset,
  selectedCount,
}: QuickValueLabelsPopoverProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [startNum, setStartNum] = useState<number>(1)
  const [applyToSelected, setApplyToSelected] = useState(false)

  // Custom preset registration state
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetVersion, setPresetVersion] = useState(0)

  // Current variable's value options
  const currentOptions = useMemo(() => {
    const labels = column?.valueLabels || {}
    const keys = Object.keys(labels)
    if (keys.length === 0) return []
    const order =
      column.categoryOrder && column.categoryOrder.length > 0
        ? column.categoryOrder.filter((k) => k in labels)
        : keys
    const allKeys = Array.from(new Set([...order, ...keys]))
    return allKeys.map((k) => ({ code: k, label: labels[k] }))
  }, [column?.valueLabels, column?.categoryOrder])

  const parsed = parseQuickValueLabels(text, startNum)

  const handleApply = () => {
    if (parsed.length > 0) {
      onApply(parsed, applyToSelected)
      setText('')
      setOpen(false)
    }
  }

  const handleOpenSaveModal = () => {
    const defaultName = column.label
      ? `${column.label.substring(0, 20)} (${currentOptions.length}段階)`
      : `${column.name} (${currentOptions.length}段階)`
    setPresetName(defaultName)
    setSaveModalOpen(true)
  }

  const handleSavePreset = () => {
    if (!presetName.trim()) return
    const scale = column.scaleType === 'nominal' ? 'nominal' : 'ordinal'
    saveCustomPreset(presetName.trim(), currentOptions, scale)
    message.success(`プリセット「${presetName.trim()}」を登録しました`)
    setPresetVersion((v) => v + 1)
    setSaveModalOpen(false)
  }

  const handleDeleteCustom = (e: React.MouseEvent, presetId: string, name: string) => {
    e.stopPropagation()
    deleteCustomPreset(presetId)
    message.info(`プリセット「${name}」を削除しました`)
    setPresetVersion((v) => v + 1)
  }

  // Load presets (including user-defined custom presets)
  const allPresets = useMemo(() => {
    // presetVersion dependency ensures re-read after save/delete
    return getAllPresets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetVersion])

  const presetMenuItems: MenuProps['items'] = useMemo(() => {
    const items: MenuProps['items'] = []

    if (allPresets.custom.length > 0) {
      items.push({
        type: 'group',
        label: `カスタムプリセット (${allPresets.custom.length}件)`,
        children: allPresets.custom.map((preset) => ({
          key: preset.id,
          label: (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>{preset.name}</span>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined style={{ fontSize: 11 }} />}
                onClick={(e) => handleDeleteCustom(e, preset.id, preset.name)}
                title="プリセットを削除"
              />
            </div>
          ),
          onClick: () => onApplyPreset(preset, selectedCount > 1),
        })),
      })
      items.push({ type: 'divider' })
    }

    items.push({
      type: 'group',
      label: '標準プリセット',
      children: allPresets.builtIn.map((preset) => ({
        key: preset.id,
        label: preset.name,
        onClick: () => onApplyPreset(preset, selectedCount > 1),
      })),
    })

    return items
  }, [allPresets, onApplyPreset, selectedCount])

  const popoverContent = (
    <div style={{ width: 360, padding: 4 }}>
      <Typography.Title level={5} style={{ margin: '0 0 8px 0', fontSize: 13 }}>
        選択肢・値ラベルのテキスト一括入力
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 8 }}>
        行ごとに選択肢を貼り付けてください（例: <code>1: 大いに不満</code> または <code>大いに不満</code>）
      </Typography.Paragraph>
      <Input.TextArea
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`1: 大いに不満\n2: やや不満\n3: どちらでもない\n4: やや満足\n5: 大いに満足`}
        style={{ fontSize: 12, fontFamily: 'monospace', marginBottom: 8 }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Text style={{ fontSize: 11 }}>ラベルのみの場合の開始番号:</Typography.Text>
        <InputNumber size="small" min={0} value={startNum} onChange={(v) => setStartNum(v ?? 1)} style={{ width: 60 }} />
      </div>

      {parsed.length > 0 && (
        <div style={{ background: '#f8fafc', padding: 6, borderRadius: 4, marginBottom: 8, maxHeight: 80, overflowY: 'auto' }}>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            プレビュー ({parsed.length}項目):
          </Typography.Text>
          <div style={{ fontSize: 11, color: '#334155', marginTop: 2 }}>
            {parsed.map((p) => `${p.code}:${p.label}`).join(' / ')}
          </div>
        </div>
      )}

      {selectedCount > 1 && (
        <div style={{ marginBottom: 12 }}>
          <Checkbox checked={applyToSelected} onChange={(e) => setApplyToSelected(e.target.checked)}>
            <span style={{ fontSize: 12 }}>選択中の他の変数（{selectedCount}件）にも適用</span>
          </Checkbox>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <Button size="small" onClick={() => setOpen(false)}>
          キャンセル
        </Button>
        <Button size="small" type="primary" disabled={parsed.length === 0} onClick={handleApply}>
          適用 ({parsed.length}件)
        </Button>
      </div>
    </div>
  )

  return (
    <>
      <Space size="small">
        <Popover
          content={popoverContent}
          trigger="click"
          open={open}
          onOpenChange={setOpen}
          placement="bottomRight"
        >
          <Button size="small" icon={<ThunderboltOutlined />}>
            テキスト一括貼付
          </Button>
        </Popover>

        <Tooltip
          title={
            currentOptions.length === 0
              ? '現在の変数に値ラベルが設定されていません'
              : '現在の値ラベルを再利用可能なプリセットとして登録'
          }
        >
          <Button
            size="small"
            icon={<PlusCircleOutlined />}
            disabled={currentOptions.length === 0}
            onClick={handleOpenSaveModal}
          >
            プリセット登録
          </Button>
        </Tooltip>

        <Dropdown menu={{ items: presetMenuItems }} trigger={['click']} placement="bottomRight">
          <Button size="small" icon={<BookOutlined />}>
            プリセット <DownOutlined style={{ fontSize: 10 }} />
          </Button>
        </Dropdown>
      </Space>

      <Modal
        title="値ラベルのプリセット登録"
        open={saveModalOpen}
        onCancel={() => setSaveModalOpen(false)}
        footer={[
          <Button key="cancel" size="small" onClick={() => setSaveModalOpen(false)}>
            キャンセル
          </Button>,
          <Button
            key="save"
            size="small"
            type="primary"
            disabled={!presetName.trim()}
            onClick={handleSavePreset}
          >
            登録する
          </Button>,
        ]}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div>
            <Typography.Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              プリセット名:
            </Typography.Text>
            <Input
              size="small"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="例: 5段階満足度 (1:大いに不満 〜 5:大いに満足)"
              onPressEnter={handleSavePreset}
            />
          </div>

          <div>
            <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
              登録内容プレビュー ({currentOptions.length}水準 / {column?.scaleType === 'nominal' ? '名義' : '順序'}):
            </Typography.Text>
            <div
              style={{
                background: '#f8fafc',
                padding: '8px 12px',
                borderRadius: 4,
                border: '1px solid #e2e8f0',
                maxHeight: 140,
                overflowY: 'auto',
                fontSize: 12,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              {currentOptions.map((opt) => (
                <span
                  key={opt.code}
                  style={{
                    background: '#e0f2fe',
                    color: '#0369a1',
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontSize: 11,
                  }}
                >
                  <strong>{opt.code}</strong>: {opt.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </>
  )
}
