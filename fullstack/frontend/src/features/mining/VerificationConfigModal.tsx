import Modal from '../common/ActiveModal'
import { useState } from 'react'
import { Alert, InputNumber, Radio, Select, Space, Typography } from 'antd'

export interface VerificationConfig {
  method: 'holdout' | 'cross_validation' | 'independent'
  test_size: number
  k: number
  correction: string
  alpha: number
  seed: number
  independent_dataset_id: string | null
}

interface VerificationConfigModalProps {
  open: boolean
  /** Number of candidates pinned by exploration; not the number of insights. */
  candidateCount: number
  candidateSetHash: string | null
  datasets: { value: string; label: string }[]
  currentDatasetId: string | null
  /** FDR level the run will use; shown so the screen and the result agree. */
  alpha: number
  onCancel: () => void
  onRun: (config: VerificationConfig) => void
}

export default function VerificationConfigModal({
  open, candidateCount, candidateSetHash, datasets, currentDatasetId, alpha, onCancel, onRun,
}: VerificationConfigModalProps) {
  const [method, setMethod] = useState<VerificationConfig['method']>('holdout')
  const [testSize, setTestSize] = useState(0.3)
  const [k, setK] = useState(5)
  const [seed, setSeed] = useState(42)
  const [independentId, setIndependentId] = useState<string | null>(null)

  return (
    <Modal
      title="検証モードの設定"
      open={open}
      onCancel={onCancel}
      onDeactivate={onCancel}
      okText="実行"
      cancelText="キャンセル"
      onOk={() => onRun({ method, test_size: testSize, k, correction: 'bh-fdr', alpha, seed,
        independent_dataset_id: method === 'independent' ? independentId : null })}
      okButtonProps={{
        disabled: (method === 'independent' && !independentId) || !candidateSetHash,
      }}
      data-testid="verification-config-modal"
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          候補{candidateCount}件（{candidateSetHash?.slice(0, 18) ?? '—'}…）を固定し、評価だけを実行します。候補の再探索はしません。
        </Typography.Text>
        {!candidateSetHash && (
          <Alert
            type="warning"
            showIcon
            message="候補集合がありません"
            description="検証には探索時に発行された候補集合が必要です。もう一度探索してください。"
          />
        )}
        <Radio.Group
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          data-testid="verification-method"
        >
          <Space direction="vertical">
            <Radio value="holdout">ホールドアウト分割（学習 70% / 検証 30%）</Radio>
            <Radio value="cross_validation">交差検証（k=5）</Radio>
            <Radio value="independent">独立データ指定</Radio>
          </Space>
        </Radio.Group>
        {method === 'holdout' && (
          <Space>
            <Typography.Text style={{ fontSize: 12 }}>検証割合:</Typography.Text>
            <InputNumber min={0.1} max={0.5} step={0.05} value={testSize} onChange={(v) => setTestSize(v ?? 0.3)} data-testid="verification-test-size" />
            <Typography.Text style={{ fontSize: 12 }}>seed:</Typography.Text>
            <InputNumber min={0} value={seed} onChange={(v) => setSeed(v ?? 42)} data-testid="verification-seed" />
          </Space>
        )}
        {method === 'cross_validation' && (
          <Space>
            <Typography.Text style={{ fontSize: 12 }}>k:</Typography.Text>
            <InputNumber min={2} max={10} value={k} onChange={(v) => setK(v ?? 5)} data-testid="verification-k" />
            <Typography.Text style={{ fontSize: 12 }}>seed:</Typography.Text>
            <InputNumber min={0} value={seed} onChange={(v) => setSeed(v ?? 42)} data-testid="verification-seed" />
          </Space>
        )}
        {method === 'independent' && (
          <>
            <Select
              style={{ width: '100%' }}
              placeholder="独立データセットを選択"
              value={independentId ?? undefined}
              onChange={(v) => setIndependentId(v)}
              options={datasets.filter((d) => d.value !== currentDatasetId)}
              // Without these the filter runs against the dataset id, so typing
              // a dataset name — the only thing the user can see — finds nothing.
              showSearch
              optionFilterProp="label"
              notFoundContent="他のデータセットがありません"
              data-testid="verification-independent-dataset"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              検証は選んだデータセットだけで行います。探索に使ったデータと同じ行が含まれていても、
              dataset が別であれば独立として扱われます。
            </Typography.Text>
          </>
        )}
        <Alert
          type="info"
          showIcon
          message={`多重比較補正: Benjamini-Hochberg (FDR, α=${alpha})`}
          description="候補集合全体を一つのfamilyとして補正します。α は画面上部の FDR α と共通です。"
        />
      </Space>
    </Modal>
  )
}
