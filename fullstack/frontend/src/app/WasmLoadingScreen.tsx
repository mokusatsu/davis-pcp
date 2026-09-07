import React, { useEffect, useState } from 'react'
import { Card, Progress, Typography, Spin, Alert } from 'antd'
import { pyodideClient, type WasmStatus } from '../engine/pyodideClient'

const { Title, Text, Paragraph } = Typography

interface Props {
  onReady: () => void
}

export const WasmLoadingScreen: React.FC<Props> = ({ onReady }) => {
  const [status, setStatus] = useState<WasmStatus>(pyodideClient.getStatus())

  useEffect(() => {
    const unsub = pyodideClient.onStatus((s) => {
      setStatus(s)
      if (s.stage === 'ready') {
        onReady()
      }
    })

    // Trigger initialization if not yet initiated
    pyodideClient.init().catch(() => {})

    return unsub
  }, [onReady])

  const percent = Math.round(status.progress * 100)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: '#f0f2f5',
        padding: 24,
      }}
    >
      <Card
        style={{
          width: 520,
          maxWidth: '100%',
          boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
          borderRadius: 8,
          textAlign: 'center',
        }}
      >
        <div style={{ marginBottom: 20 }}>
          <Title level={3} style={{ margin: 0, color: '#1677ff' }}>
            DAVIS-PCP
          </Title>
          <Text type="secondary">WebAssembly Standalone Environment</Text>
        </div>

        {status.stage === 'error' ? (
          <Alert
            type="error"
            message="初期化エラー"
            description={status.message}
            showIcon
            style={{ textAlign: 'left', marginTop: 16 }}
          />
        ) : (
          <div style={{ margin: '30px 0' }}>
            <Spin size="large" spinning={status.stage !== 'ready'} style={{ marginBottom: 24 }}>
              <div style={{ height: 20 }} />
            </Spin>
            <Progress
              percent={percent}
              status={status.stage === 'ready' ? 'success' : 'active'}
              strokeColor={{
                '0%': '#108ee9',
                '100%': '#87d068',
              }}
            />
            <Paragraph style={{ marginTop: 16, fontSize: 14, color: '#595959' }}>
              {status.message}
            </Paragraph>
          </div>
        )}

        <Text type="secondary" style={{ fontSize: 12 }}>
          Pythonランタイム・依存ライブラリ（NumPy, SciPy, Polars, scikit-learn）をブラウザ上で直接起動しています。
        </Text>
      </Card>
    </div>
  )
}
