import { useEffect, useRef, useState } from 'react'
import Modal from '../common/ActiveModal'
import MutationProgress from '../common/MutationProgress'
import { useRequestIdentity } from '../common/useRequestIdentity'
import { Button, Upload, Typography, notification } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { importCodebook } from '../../api/client'

interface CodebookCsvImportDialogProps {
  open: boolean
  onClose: () => void
  datasetId: string
  onSuccess: (committedDatasetId: string) => void
}

export default function CodebookCsvImportDialog({
  open,
  onClose,
  datasetId,
  onSuccess,
}: CodebookCsvImportDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { setFile(null) }, [datasetId])

  const busy = useRef(false)
  const request = useRequestIdentity(JSON.stringify([datasetId, open]))
  const handleImport = async () => {
    if (busy.current || !open || !file || !datasetId) return
    busy.current = true
    const current = request.begin()
    setLoading(true)
    try {
      const res = await importCodebook(datasetId, file)
      notification.success({
        message: '辞書インポート完了',
        description: `データセット ${datasetId}: ${res.updatedColumns}件の変数が更新されました（リビジョン: ${res.schemaRevision}）。`,
      })
      onSuccess(datasetId)
      if (current()) { setFile(null); onClose() }
    } catch (err: any) {
      notification.error({
        message: 'インポート失敗',
        description: err.message || 'コードブック辞書ファイルのインポートに失敗しました。',
      })
    } finally {
      busy.current = false
      setLoading(false)
    }
  }

  return (
    <Modal
      title="コードブック辞書ファイルのインポート"
      open={open}
      onCancel={() => { if (!busy.current) onClose() }}
      onDeactivate={onClose}
      closable={!loading}
      keyboard={!loading}
      maskClosable={!loading}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={loading}>
          キャンセル
        </Button>,
        <Button
          key="import"
          type="primary"
          disabled={!file || loading}
          loading={loading}
          onClick={handleImport}
        >
          インポート実行
        </Button>,
      ]}
    >
      <MutationProgress busy={loading} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        CSVまたはJSON辞書ファイルで、質問文、尺度、役割、値ラベル等を更新します。列名（<code>name</code>）で照合し、JSONで列名を省略した場合だけ列IDを使います。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        MA親設問・重み設定・調査設計も引き継ぐにはJSONを選んでください。CSVに含まれるのは列定義とライセンスです。省略した設定は原則として保持されます。
      </Typography.Paragraph>
      <Typography.Paragraph style={{ fontSize: 12 }}>
        「インポート実行」で検証後すぐに保存されます。外側の「保存」は不要で、実行後の「キャンセル」やUndoでは取り消せません。ファイルを選ぶだけでは検証・保存されません。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        未保存の編集は別に保持されます。後から保存すると取込内容を上書きする場合があるため、インポート前に編集を整理してください。
      </Typography.Paragraph>

      <Upload.Dragger
        disabled={loading}
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
