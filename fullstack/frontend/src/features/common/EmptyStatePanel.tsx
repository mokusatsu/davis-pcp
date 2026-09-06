import React from 'react'
import { Button, Result } from 'antd'
import { AppstoreOutlined } from '@ant-design/icons'

interface EmptyStatePanelProps {
  message: string
  description?: string
  minVariables?: number
  onOpenVariableManager?: () => void
}

export const EmptyStatePanel: React.FC<EmptyStatePanelProps> = ({
  message,
  description,
  onOpenVariableManager,
}) => {
  return (
    <div
      data-testid="empty-state-panel"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        minHeight: 320,
        background: '#fafafa',
        borderRadius: 8,
        border: '1px dashed #d9d9d9',
        padding: 24,
      }}
    >
      <Result
        status="warning"
        title={message}
        subTitle={description || '上部の変数セレクタから変数を追加・選択してください。'}
        extra={
          onOpenVariableManager && (
            <Button
              type="primary"
              icon={<AppstoreOutlined />}
              onClick={onOpenVariableManager}
              data-testid="empty-state-open-manager-btn"
            >
              変数マネージャを開く
            </Button>
          )
        }
      />
    </div>
  )
}

export default EmptyStatePanel
