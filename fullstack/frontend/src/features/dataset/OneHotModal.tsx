import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Table from '../common/ColumnTable'
import { useEffect, useRef, useState } from 'react'
import Modal from '../common/ActiveModal'
import MutationProgress from '../common/MutationProgress'
import { useRequestIdentity } from '../common/useRequestIdentity'
import { Checkbox, ConfigProvider, Input, Space, Tag, Typography, notification } from 'antd'
import { api } from '../../api/client'

interface OneHotModalProps {
  open: boolean
  datasetId: string
  columnName: string
  categories: string[]
  onClose: () => void
  onSuccess: (committedDatasetId: string) => void
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

  const busy = useRef(false)
  const request = useRequestIdentity(JSON.stringify([datasetId, columnName, open]))
  useEffect(() => { if (open) { setPrefix(columnName); setDropFirst(false) } }, [open, datasetId, columnName])

  const effectiveDropFirst = dropFirst && categories.length > 1
  const effectivePrefix = prefix.trim() || columnName
  const activeCategories = effectiveDropFirst ? categories.slice(1) : categories
  const previewColNames = activeCategories.map((cat) => {
    const clean = String(cat).replace(/ /g, '_').replace(/\//g, '_')
    return `${effectivePrefix}_${clean}`
  })

  const handleApply = async () => {
    if (busy.current || !open || !datasetId || !columnName) return
    busy.current = true
    const current = request.begin()
    setApplying(true)
    try {
      const result = await api.post<{ createdColumns: string[] }>(`/datasets/${datasetId}/transform`, {
        type: 'nominal_to_binary',
        source_column: columnName,
        options: {
          drop_first: dropFirst,
          prefix: effectivePrefix,
        },
      })
      notification.success({
        message: '二値化完了',
        description: `${result.createdColumns.length}個の0/1列を生成しました。`,
      })
      onSuccess(datasetId)
      if (current()) onClose()
    } catch (err) {
      const error = err as { message: string }
      notification.error({ message: '二値化エラー', description: error.message || '変換に失敗しました。' })
    } finally {
      busy.current = false
      setApplying(false)
    }
  }

  return (
    <Modal
      title={<>カテゴリ変数の二値化 (One-Hot): <ColumnQuestionTooltip nameOrId={columnName} /></>}
      open={open}
      onCancel={() => { if (!busy.current) onClose() }}
      onDeactivate={onClose}
      closable={!applying}
      keyboard={!applying}
      maskClosable={!applying}
      cancelButtonProps={{ disabled: applying }}
      okButtonProps={{ disabled: applying }}
      onOk={handleApply}
      okText="0/1二値列を生成"
      confirmLoading={applying}
      width={600}
    >
      <MutationProgress busy={applying} />
      <ConfigProvider componentDisabled={applying}>
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
          {categories.length === 1 && (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              水準が1つの場合は除外せず、0/1列を生成します。
            </Typography.Paragraph>
          )}
        </div>

        <div>
          <Typography.Text strong>二値列名の候補 (プレビュー):</Typography.Text>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {previewColNames.map((name, index) => (
              <Tag color="blue" key={index}>{name}</Tag>
            ))}
          </div>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            既存の列名や候補同士で重複する場合は、末尾に _1、_2 などを付けて生成します。実際の列名と列数は実行時に確定します。
          </Typography.Paragraph>
        </div>

        <div>
          <Typography.Text strong>カテゴリ水準一覧 ({categories.length}件):</Typography.Text>
          <Table
            size="small"
            pagination={{ pageSize: 5 }}
            dataSource={categories.map((c, i) => ({ key: i, index: i + 1, value: c }))}
            columns={[
              { title: '#', dataIndex: 'index', key: 'index', width: 50 },
              { title: '水準値', dataIndex: 'value', key: 'value' },
              {
                title: '生成ステータス',
                key: 'status',
                render: (_, record) => {
                  const isDropped = effectiveDropFirst && record.index === 1
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
      </ConfigProvider>
    </Modal>
  )
}
