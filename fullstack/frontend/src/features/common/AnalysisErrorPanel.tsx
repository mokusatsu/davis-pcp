import { Alert, Button } from 'antd'

/** Shared, keyboard-accessible recovery for automatically loaded analyses. */
export default function AnalysisErrorPanel({ title, error, onRetry, loading = false }: {
  title: string
  error: string
  onRetry: () => void
  loading?: boolean
}) {
  return <Alert
    type="error"
    showIcon
    message={`${title}の読み込みに失敗しました。`}
    description={error}
    action={<Button onClick={onRetry} loading={loading} disabled={loading}>再試行</Button>}
  />
}

export function analysisErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '通信状態を確認して、再試行してください。'
}
