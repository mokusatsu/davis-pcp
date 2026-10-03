import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Typography } from 'antd'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../../app/store'
import { licenseMetadataReceived, saveLicenseTextThunk } from './codebookSlice'
import { getCodebook } from '../../api/client'

/** Saving attribution is independent of the outer variable-editing transaction. */
export default function CodebookLicenseEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dispatch = useDispatch<AppDispatch>()
  const codebook = useSelector((state: RootState) => state.codebook)
  const [text, setText] = useState('')
  const [revision, setRevision] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const saving = useRef(false)
  // Capture on opening; later external writes must not replace the user's draft.
  useEffect(() => {
    generation.current++
    saving.current = false; setBusy(false); setError(null)
    if (open) { setText(codebook.licenseText ?? ''); setRevision(codebook.licenseRevision ?? 1) }
    return () => { generation.current++ }
  }, [open, codebook.datasetId])

  const reload = async () => {
    if (!codebook.datasetId || saving.current) return
    const current = generation.current
    saving.current = true
    setBusy(true)
    try {
      const saved = await getCodebook(codebook.datasetId)
      if (current !== generation.current || saved.datasetId !== codebook.datasetId) return
      const value = { datasetId: saved.datasetId, licenseText: saved.licenseText ?? '', licenseRevision: saved.licenseRevision ?? 1 }
      dispatch(licenseMetadataReceived(value)); setText(value.licenseText); setRevision(value.licenseRevision); setError(null)
    } catch (err) {
      if (current === generation.current) setError((err as { message?: string })?.message || '再読込に失敗しました。')
    } finally { if (current === generation.current) { saving.current = false; setBusy(false) } }
  }

  const save = async () => {
    if (!codebook.datasetId || saving.current) return
    const current = generation.current
    saving.current = true
    setBusy(true); setError(null)
    try {
      await dispatch(saveLicenseTextThunk({ datasetId: codebook.datasetId, licenseText: text,
        expectedLicenseRevision: revision })).unwrap()
      if (current === generation.current) onClose()
    } catch (err) {
      if (current === generation.current) setError((err as { message?: string })?.message || '保存に失敗しました。')
    } finally {
      if (current === generation.current) { saving.current = false; setBusy(false) }
    }
  }

  return <Modal title="ライセンス情報" open={open} width={720} zIndex={1100}
    onCancel={() => { if (!busy) onClose() }} onOk={() => void save()}
    okText="保存" cancelText="キャンセル" confirmLoading={busy}
    cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <Typography.Paragraph type="secondary">
      データの出典・利用条件・クレジットを入力してください。ここでの保存はすぐに反映され、コードブックの変数設定とは別に保存されます。
    </Typography.Paragraph>
    {error && <Alert type="error" showIcon message="ライセンス情報を保存できませんでした" description={<>{error}<br /><Button onClick={() => void reload()} disabled={busy}>
      最新の保存済みを再読込（入力を置換）</Button></>} style={{ marginBottom: 12 }} />}
    <Input.TextArea aria-label="ライセンス情報の本文" value={text} onChange={event => setText(event.target.value)}
      disabled={busy} autoSize={{ minRows: 12, maxRows: 22 }} style={{ whiteSpace: 'pre-wrap' }} />
  </Modal>
}
