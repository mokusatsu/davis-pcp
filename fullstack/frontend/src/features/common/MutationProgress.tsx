import { Alert } from 'antd'

export default function MutationProgress({ busy }: { busy: boolean }) {
  return busy ? <Alert type="info" showIcon role="status" style={{ marginBottom: 12 }}
    message="データを更新しています。処理中は編集・キャンセルできません。"
    description="ページを移動しても処理は続行します。完了・失敗は通知でお知らせします。" /> : null
}
