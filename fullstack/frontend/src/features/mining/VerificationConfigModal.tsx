import Modal from '../common/ActiveModal'
import { useEffect, useId, useState } from 'react'
import { AnalysisField, AnalysisSettings } from '../common/AnalysisSetup'
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
  pending: boolean
  error?: string | null
  /** Number of candidates pinned by exploration; not the number of insights. */
  candidateCount: number
  candidateSetHash: string | null
  datasetsLoading?: boolean
  datasetsError?: string | null
  datasets: { value: string; label: string }[]
  currentDatasetId: string | null
  /** Supplied verification alpha; FDR inference applies only to independent data. */
  alpha: number
  onCancel: () => void
  onRun: (config: VerificationConfig) => void
}

export default function VerificationConfigModal({
  open, pending, error = null, candidateCount, candidateSetHash, datasets, datasetsLoading = false, datasetsError = null, currentDatasetId, alpha, onCancel, onRun,
}: VerificationConfigModalProps) {
  const inputId = useId()
  const [method, setMethod] = useState<VerificationConfig['method']>('holdout')
  const [testSize, setTestSize] = useState(0.3)
  const [k, setK] = useState(5)
  const [seed, setSeed] = useState(42)
  const [independentId, setIndependentId] = useState<string | null>(null)
  const eligibleDatasets = datasetsLoading || datasetsError ? [] : datasets.filter(dataset => dataset.value !== currentDatasetId)
  const validIndependentId = eligibleDatasets.some(dataset => dataset.value === independentId) ? independentId : null
  useEffect(() => { setIndependentId(null) }, [currentDatasetId])
  useEffect(() => {
    if (independentId !== null && !validIndependentId) setIndependentId(null)
  }, [independentId, validIndependentId])
  const canRun = Boolean(candidateSetHash) && !pending && (method !== 'independent' || Boolean(validIndependentId))

  return (
    <Modal
      title="検証モードの設定"
      open={open}
      onCancel={onCancel}
      onDeactivate={onCancel}
      okText="実行"
      cancelText="キャンセル"
      onOk={() => {
        if (!canRun) return
        onRun({ method, test_size: testSize, k, correction: 'bh-fdr', alpha, seed,
          independent_dataset_id: method === 'independent' ? validIndependentId : null })
      }}
      // Ant Modal's confirmLoading also blocks Cancel/Close. Keep dismissal
      // available so the parent can invalidate this read-only verification.
      okButtonProps={{ disabled: !canRun, loading: pending }}
      data-testid="verification-config-modal"
    >
      <div className="analysis-setup analysis-form-stack">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          候補{candidateCount}件（{candidateSetHash?.slice(0, 18) ?? '—'}…）を固定し、評価だけを実行します。候補の再探索はしません。
        </Typography.Text>
        {error && <Alert type="error" showIcon message="検証を実行できませんでした" description={error} />}
        {!candidateSetHash && (
          <Alert
            type="warning"
            showIcon
            message="候補集合がありません"
            description="検証には探索時に発行された候補集合が必要です。もう一度探索してください。"
          />
        )}
        <Radio.Group
          name={`${inputId}-method`}
          aria-label="検証手法"
          disabled={pending}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          data-testid="verification-method"
        >
          <Space direction="vertical">
            <Radio value="holdout">ホールドアウト分割（学習 {Math.round((1 - testSize) * 100)}% / 検証 {Math.round(testSize * 100)}%）</Radio>
            <Radio value="cross_validation">交差検証（k={k}）</Radio>
            <Radio value="independent">独立データ指定</Radio>
          </Space>
        </Radio.Group>
        {method !== 'independent' && (
          <AnalysisSettings title="分割の詳細設定" summary={method === 'holdout' ? `検証割合: ${testSize} / seed: ${seed}` : `k: ${k} / seed: ${seed}`}>
            <div className="analysis-variable-grid">
              {method === 'holdout' ? (
                <AnalysisField label="検証割合" htmlFor={`${inputId}-test-size`}>
                  <InputNumber id={`${inputId}-test-size`} min={0.1} max={0.5} step={0.05} value={testSize} disabled={pending}
                    style={{ width: '100%' }} onChange={(v) => setTestSize(v ?? 0.3)} data-testid="verification-test-size" />
                </AnalysisField>
              ) : (
                <AnalysisField label="分割数 k" htmlFor={`${inputId}-k`}>
                  <InputNumber id={`${inputId}-k`} min={2} max={10} value={k} disabled={pending}
                    style={{ width: '100%' }} onChange={(v) => setK(v ?? 5)} data-testid="verification-k" />
                </AnalysisField>
              )}
              <AnalysisField label="乱数 seed" htmlFor={`${inputId}-seed`}>
                <InputNumber id={`${inputId}-seed`} min={0} value={seed} disabled={pending}
                  style={{ width: '100%' }} onChange={(v) => setSeed(v ?? 42)} data-testid="verification-seed" />
              </AnalysisField>
            </div>
          </AnalysisSettings>
        )}
        {method === 'independent' && (
          <>
            <Select
              aria-label="独立検証データセット"
              disabled={pending || datasetsLoading}
              loading={datasetsLoading}
              style={{ width: '100%' }}
              placeholder="独立データセットを選択"
              value={validIndependentId ?? undefined}
              onChange={(v) => setIndependentId(v)}
              options={eligibleDatasets}
              // Without these the filter runs against the dataset id, so typing
              // a dataset name — the only thing the user can see — finds nothing.
              showSearch
              optionFilterProp="label"
              notFoundContent={datasetsLoading ? 'データセットを読み込み中…' : datasetsError ? 'データセットを取得できませんでした' : '他のデータセットがありません'}
              data-testid="verification-independent-dataset"
            />
            {datasetsLoading && <Typography.Text type="secondary" role="status">利用できるデータセットを読み込んでいます…</Typography.Text>}
            {datasetsError && <Alert type="warning" showIcon message="データセットを取得できませんでした" description="接続を確認して設定を開き直してください。" />}
            {!datasetsLoading && !datasetsError && !validIndependentId && <Typography.Text type="secondary" role="status">
              {eligibleDatasets.length ? '現在の候補から独立検証データセットを選択してください。' : '探索に使ったものとは別のデータセットを読み込み、この設定を開き直してください。'}
            </Typography.Text>}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              検証は選んだデータセットだけで行います。探索に使ったデータと同じ行が含まれていても、
              dataset が別であれば独立として扱われます。
            </Typography.Text>
          </>
        )}
        <Alert
          type="info"
          showIcon
          message={method === 'independent' ? `多重比較補正: Benjamini-Hochberg (FDR, α=${alpha})` : '探索後の安定性確認'}
          description={method === 'independent'
            ? `評価可能な候補を一つのfamilyとして補正します。この検証には α=${alpha} を使用します。`
            : 'ホールドアウト・交差検証では、探索後に分けたデータで効果の推定やfold間の安定性を確認します。確証検定のp値・有意性は表示せず、FDR補正は行いません。'}
        />
      </div>
    </Modal>
  )
}
