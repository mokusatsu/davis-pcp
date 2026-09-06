import { useState } from 'react'
import { Checkbox, Input, Modal, Space, Table, Tag, Typography, notification } from 'antd'
import { api } from '../../api/client'

interface OneHotModalProps {
  open: boolean
  datasetId: string
  columnName: string
  categories: string[]
  onClose: () => void
  onSuccess: () => void
}

export default function OneHotModal({
  open,
  datasetId,
  columnName,
  categories,
  onClose,
  onSuccess,
}: OneHotModalProps) {
  const [dropFirst, setDropFirst] = useState(false)
  const [prefix, setPrefix] = useState(columnName)
  const [applying, setApplying] = useState(false)

  const activeCategories = dropFirst ? categories.slice(1) : categories
  const previewColNames = activeCategories.map((cat) => {
    const clean = String(cat).replace(/\s+/g, '_').replace(/\//g, '_')
    return `${prefix || columnName}_${clean}`
  })

  const handleApply = async () => {
    if (!datasetId || !columnName) return
    setApplying(true)
    try {
      await api.post(`/datasets/${datasetId}/transform`, {
        type: 'nominal_to_binary',
        source_column: columnName,
        options: {
          drop_first: dropFirst,
          prefix: prefix.trim() || columnName,
        },
      })
      notification.success({
        message: '二値化完了',
        description: `${previewColNames.length}個の0/1列を生成しました。`,
      })
      onSuccess()
      onClose()
    } catch (err) {
      const error = err as { message: string }
      notification.error({ message: '二値化エラー', description: error.message || '変換に失敗しました。' })
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      title={`カテゴリ変数の二値化 (One-Hot): ${columnName}`}
      open={open}
      onCancel={onClose}
      onOk={handleApply}
      okText="0/1二値列を生成"
      confirmLoading={applying}
      width={600}
    >
      <div data-testid="one-hot-modal-content">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Typography.Text strong>列名プレフィックス: </Typography.Text>
          <Input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder={columnName}
          />
        </div>

        <div>
          <Checkbox
            checked={dropFirst}
            onChange={(e) => setDropFirst(e.target.checked)}
            data-testid="one-hot-drop-first"
          >
            最初の水準を除外する (Drop First Category — 回帰・多重共線性対策)
          </Checkbox>
        </div>

        <div>
          <Typography.Text strong>生成される二値列 (プレビュー):</Typography.Text>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {previewColNames.map((name) => (
              <Tag color="blue" key={name}>{name}</Tag>
            ))}
          </div>
        </div>

        <div>
          <Typography.Text strong>カテゴリ水準一覧 ({categories.length}件):</Typography.Text>
          <Table
            size="small"
            pagination={{ pageSize: 5 }}
            dataSource={categories.map((c, i) => ({ key: c, index: i + 1, value: c }))}
            columns={[
              { title: '#', dataIndex: 'index', key: 'index', width: 50 },
              { title: '水準値', dataIndex: 'value', key: 'value' },
              {
                title: '生成ステータス',
                key: 'status',
                render: (_, record) => {
                  const isDropped = dropFirst && record.index === 1
                  return isDropped ? (
                    <Tag color="default">除外 (Base)</Tag>
                  ) : (
                    <Tag color="success">0/1列として生成</Tag>
                  )
                },
              },
            ]}
          />
        </div>
      </Space>
      </div>
    </Modal>
  )
}
