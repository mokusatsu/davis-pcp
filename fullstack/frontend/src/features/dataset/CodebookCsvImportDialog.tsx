import { useState } from 'react'
import { Button, Modal, Upload, Typography, notification } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { importCodebook } from '../../api/client'

interface CodebookCsvImportDialogProps {
  open: boolean
  onClose: () => void
  datasetId: string
  onSuccess: () => void
}

export default function CodebookCsvImportDialog({
  open,
  onClose,
  datasetId,
  onSuccess,
}: CodebookCsvImportDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)

  const handleImport = async () => {
    if (!file || !datasetId) return
    setLoading(true)
    try {
      const res = await importCodebook(datasetId, file)
      notification.success({
        message: '辞書インポート完了',
        description: `${res.updatedColumns}件の変数が更新されました（リビジョン: ${res.schemaRevision}）。`,
      })
      setFile(null)
      onSuccess()
      onClose()
    } catch (err: any) {
      notification.error({
        message: 'インポート失敗',
        description: err.message || 'コードブック辞書ファイルのインポートに失敗しました。',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title="コードブック辞書ファイルのインポート"
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={loading}>
          キャンセル
        </Button>,
        <Button
          key="import"
          type="primary"
          disabled={!file}
          loading={loading}
          onClick={handleImport}
        >
          インポート実行
        </Button>,
      ]}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        エクスポートされたCSVまたはJSON辞書ファイルをアップロードしてください。列名（<code>name</code>）または列IDをもとに各変数の質問文、尺度、役割、値ラベル等の設定が一括反映されます。
      </Typography.Paragraph>

      <Upload.Dragger
        accept=".csv,.json"
        multiple={false}
        beforeUpload={(f) => {
          setFile(f)
          return false
        }}
        onRemove={() => setFile(null)}
        fileList={file ? [file as any] : []}
        style={{ padding: '16px 0' }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined style={{ fontSize: 36, color: '#3b82f6' }} />
        </p>
        <p className="ant-upload-text" style={{ fontSize: 13 }}>
          クリックまたはファイルをここにドラッグ＆ドロップ
        </p>
        <p className="ant-upload-hint" style={{ fontSize: 11 }}>
          対応形式: .csv, .json (UTF-8推奨)
        </p>
      </Upload.Dragger>
    </Modal>
  )
}
