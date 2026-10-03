import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Typography } from 'antd'
import { api } from '../../api/client'

export interface DatasetLicense { datasetId: string; name: string; text: string; sampleId?: string }

/** Text nodes preserve newlines and never interpret user-provided markup. */
export default function DatasetLicenseNotice({ license, onClose }: {
  license: DatasetLicense | null; onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => { generation.current++; setError(null) }, [license?.datasetId, license?.text])
  const download = async () => {
    const current = generation.current
    if (!license?.sampleId) return
    setError(null)
    try {
      const blob = await api.downloadBlob(`/datasets/samples/${encodeURIComponent(license.sampleId)}/package`)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `${license.sampleId}-sample.zip`
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) { if (current === generation.current) setError((err as { message?: string })?.message || 'ダウンロードに失敗しました。') }
  }
  return <Modal title="ライセンス情報" open={Boolean(license?.text.trim())} width={760}
    onCancel={onClose} footer={<Button type="primary" onClick={onClose}>OK</Button>}>
    {error && <Alert type="error" message={error} />}
    {license?.sampleId && <Button onClick={() => void download()} style={{ marginBottom: 12 }}>元の組込みデータ・コードブック・利用条件をダウンロード</Button>}
    <Typography.Paragraph strong>{license?.name}</Typography.Paragraph>
    <div data-testid="dataset-license-text" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      maxHeight: '60vh', overflowY: 'auto' }}>{license?.text}</div>
  </Modal>
}
