import { Alert } from 'antd'
import type { FC } from 'react'

export const WeightUnsupportedAlert: FC<{ weightColumnName?: string | null }> = ({ weightColumnName }) => {
  if (!weightColumnName) return null
  return (
    <Alert
      type="warning"
      showIcon
      message="ウェイト未適用"
      description={`この分析は調査ウェイト（${weightColumnName}）を適用しません。表示値は非加重です。`}
      data-testid="weight-unsupported-alert"
      style={{ marginBottom: 8 }}
    />
  )
}

export default WeightUnsupportedAlert
