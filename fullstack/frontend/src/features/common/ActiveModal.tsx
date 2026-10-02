import { useEffect } from 'react'
import { Modal, type ModalProps } from 'antd'
import { useAnalysisViewActive } from '../selection/analysisScope'

/** A cached page must never leave its body-portal dialog on another route. */
export default function ActiveModal({ onDeactivate, open, ...props }: ModalProps & { onDeactivate?: () => void }) {
  const active = useAnalysisViewActive()
  useEffect(() => {
    if (!active && open) onDeactivate?.()
  }, [active, open, onDeactivate])
  return <Modal cancelText="キャンセル" {...props} open={Boolean(open && active)} />
}
