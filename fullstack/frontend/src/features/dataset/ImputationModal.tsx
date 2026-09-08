import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Radio,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd'
import { api } from '../../api/client'

export interface ColumnMissingInfo {
  name: string
  missing: number
  total: number
  semanticType?: string
}

interface ImputationModalProps {
  open: boolean
  datasetId: string
  targetColumn?: string | null
  columnsWithMissing: ColumnMissingInfo[]
  onClose: () => void
  onSuccess: () => void
}

interface PreviewStats {
  totalCount: number
  missingCount: number
  missingPercent: number
  mean?: number
  std?: number
  min?: number
  max?: number
  median?: number
}

interface PreviewHistogramItem {
  binLabel: string
  beforeCount: number
  afterCount: number
  imputedAdded: number
}

interface ImputePreviewResponse {
  column: string
  strategy: string
  beforeStats: PreviewStats
  afterStats: PreviewStats
  histogram: PreviewHistogramItem[]
  diagnostics?: any
}

export default function ImputationModal({
  open,
  datasetId,
  targetColumn,
  columnsWithMissing,
  onClose,
  onSuccess,
}: ImputationModalProps) {
  const [selectedCols, setSelectedCols] = useState<string[]>([])
  const [strategy, setStrategy] = useState<string>('tabdiff')
  const [inPlace, setInPlace] = useState<boolean>(true)

  // Parameters
  const [tabdiffSteps, setTabdiffSteps] = useState<number>(20)
  const [temperature, setTemperature] = useState<number>(1.0)
  const [knnNeighbors, setKnnNeighbors] = useState<number>(5)
  const [constantVal, setConstantVal] = useState<string>('0')
  const [seed, setSeed] = useState<number>(42)

  // Preview state
  const [previewLoading, setPreviewLoading] = useState<boolean>(false)
  const [previewData, setPreviewData] = useState<ImputePreviewResponse | null>(null)
  const [previewCol, setPreviewCol] = useState<string>('')

  // Execution state
  const [executing, setExecuting] = useState<boolean>(false)

  useEffect(() => {
    if (targetColumn) {
      setSelectedCols([targetColumn])
      setPreviewCol(targetColumn)
    } else if (columnsWithMissing.length > 0) {
      const initial = columnsWithMissing.map((c) => c.name)
      setSelectedCols(initial)
      setPreviewCol(initial[0] || '')
    } else {
      setSelectedCols([])
      setPreviewCol('')
    }
    setPreviewData(null)
  }, [targetColumn, columnsWithMissing, open])

  const fetchPreview = async (colToPreview?: string) => {
    const col = colToPreview || previewCol || selectedCols[0]
    if (!col) return
    setPreviewLoading(true)
    try {
      const options: Record<string, any> = { seed }
      if (strategy === 'tabdiff') {
        options.num_steps = tabdiffSteps
        options.temperature = temperature
      } else if (strategy === 'knn') {
        options.knn_neighbors = knnNeighbors
      } else if (strategy === 'constant') {
        options.constant_value = constantVal
      }

      const res = await api.post<ImputePreviewResponse>(`/datasets/${datasetId}/impute/preview`, {
        column: col,
        strategy,
        options,
      })
      setPreviewData(res)
    } catch (err: any) {
      message.error(`プレビュー取得エラー: ${err.message || err}`)
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleApply = async () => {
    if (selectedCols.length === 0) {
      message.warning('補完対象の列を1つ以上選択してください。')
      return
    }
    setExecuting(true)
    try {
      const options: Record<string, any> = { seed }
      if (strategy === 'tabdiff') {
        options.num_steps = tabdiffSteps
        options.temperature = temperature
      } else if (strategy === 'knn') {
        options.knn_neighbors = knnNeighbors
      } else if (strategy === 'constant') {
        options.constant_value = constantVal
      }

      await api.post(`/datasets/${datasetId}/impute`, {
        columns: selectedCols,
        strategy,
        options,
        inPlace,
      })
      message.success(`欠損値補完完了 (${strategy})`)
      onSuccess()
      onClose()
    } catch (err: any) {
      message.error(`補完エラー: ${err.message || err}`)
    } finally {
      setExecuting(false)
    }
  }

  const maxHistCount = previewData?.histogram
    ? Math.max(...previewData.histogram.map((h) => h.afterCount), 1)
    : 1

  return (
    <Modal
      open={open}
      title={
        <Space>
          <Typography.Title level={5} style={{ margin: 0 }}>
            欠損値補完フィルター (Replace Missing Values)
          </Typography.Title>
          <Tag color="purple">TabDiff / Statistical</Tag>
        </Space>
      }
      width={840}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          キャンセル
        </Button>,
        <Button
          key="preview"
          onClick={() => void fetchPreview()}
          loading={previewLoading}
          disabled={selectedCols.length === 0}
        >
          プレビュー更新
        </Button>,
        <Button
          key="submit"
          type="primary"
          onClick={() => void handleApply()}
          loading={executing}
          disabled={selectedCols.length === 0}
          data-testid="btn-execute-imputation"
        >
          補完を適用
        </Button>,
      ]}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '68vh', overflowY: 'auto' }}>
        {/* Section 1: Columns */}
        <Card size="small" title="1. 補完対象の列を選択" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          {columnsWithMissing.length === 0 ? (
            <Alert type="info" message="欠損値を含む列は見つかりませんでした。" showIcon />
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {columnsWithMissing.map((col) => {
                const isChecked = selectedCols.includes(col.name)
                const pct = ((col.missing / Math.max(1, col.total)) * 100).toFixed(1)
                return (
                  <div
                    key={col.name}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: `1px solid ${isChecked ? '#2563eb' : '#e5e7eb'}`,
                      background: isChecked ? '#eff6ff' : '#ffffff',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      if (isChecked) {
                        setSelectedCols(selectedCols.filter((c) => c !== col.name))
                      } else {
                        setSelectedCols([...selectedCols, col.name])
                        setPreviewCol(col.name)
                      }
                    }}
                  >
                    <Space size="small">
                      <Checkbox checked={isChecked} />
                      <Typography.Text strong><ColumnQuestionTooltip nameOrId={col.name}>{col.name}</ColumnQuestionTooltip></Typography.Text>
                      <Tag color="red" style={{ margin: 0, fontSize: 11 }}>
                        欠損 {col.missing} ({pct}%)
                      </Tag>
                    </Space>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* Section 2: Strategy */}
        <Card size="small" title="2. 補完アルゴリズム" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Segmented
              data-testid="impute-strategy"
              options={[
                { label: 'TabDiff (拡散生成モデル)', value: 'tabdiff' },
                { label: 'KNN (k近傍)', value: 'knn' },
                { label: 'Mean (平均値)', value: 'mean' },
                { label: 'Median (中央値)', value: 'median' },
                { label: 'Mode (最頻値)', value: 'mode' },
                { label: 'Constant (定数)', value: 'constant' },
              ]}
              value={strategy}
              onChange={(v) => {
                setStrategy(String(v))
                setPreviewData(null)
              }}
            />

            {strategy === 'tabdiff' && (
              <div style={{ background: '#f8fafc', padding: 12, borderRadius: 6, border: '1px solid #e2e8f0' }}>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                  <b>TabDiff (Tabular Diffusion):</b>{' '}
                  観測された特徴量の同時結合条件をスコア関数として学習し、混合数値・カテゴリデータに対して現実的な条件付き分布から段階的にデノイジング生成します。
                </Typography.Paragraph>
                <Space wrap size="middle">
                  <Space>
                    <Typography.Text style={{ fontSize: 12 }}>逆拡散ステップ数 T:</Typography.Text>
                    <InputNumber min={5} max={100} value={tabdiffSteps} onChange={(v) => setTabdiffSteps(Number(v) ?? 20)} />
                  </Space>
                  <Space>
                    <Typography.Text style={{ fontSize: 12 }}>温度 (Temperature):</Typography.Text>
                    <InputNumber min={0.1} max={2.0} step={0.1} value={temperature} onChange={(v) => setTemperature(Number(v) ?? 1.0)} />
                  </Space>
                  <Space>
                    <Typography.Text style={{ fontSize: 12 }}>シード:</Typography.Text>
                    <InputNumber min={0} value={seed} onChange={(v) => setSeed(Number(v) ?? 42)} />
                  </Space>
                </Space>
              </div>
            )}

            {strategy === 'knn' && (
              <Space>
                <Typography.Text style={{ fontSize: 12 }}>近傍数 k:</Typography.Text>
                <InputNumber min={1} max={50} value={knnNeighbors} onChange={(v) => setKnnNeighbors(Number(v) ?? 5)} />
              </Space>
            )}

            {strategy === 'constant' && (
              <Space>
                <Typography.Text style={{ fontSize: 12 }}>補完定数値:</Typography.Text>
                <Input style={{ width: 160 }} value={constantVal} onChange={(e) => setConstantVal(e.target.value)} />
              </Space>
            )}
          </Space>
        </Card>

        {/* Section 3: Preview Comparison */}
        <Card
          size="small"
          title={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>3. 補完プレビュー &amp; 分布比較</span>
              {selectedCols.length > 1 && (
                <Space>
                  <Typography.Text style={{ fontSize: 12 }}>対象列:</Typography.Text>
                  <Radio.Group
                    size="small"
                    value={previewCol}
                    onChange={(e) => {
                      setPreviewCol(e.target.value)
                      void fetchPreview(e.target.value)
                    }}
                  >
                    {selectedCols.map((c) => (
                      <Radio.Button key={c} value={c}>
                        <ColumnQuestionTooltip nameOrId={c}>{c}</ColumnQuestionTooltip>
                      </Radio.Button>
                    ))}
                  </Radio.Group>
                </Space>
              )}
            </div>
          }
          style={{ borderRadius: 6, borderColor: '#e5e7eb' }}
        >
          {previewLoading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin tip="プレビュー計算中..." />
            </div>
          ) : previewData ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Comparison Stat Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>欠損数 変化</Typography.Text>
                  <div>
                    <Typography.Text delete type="danger">
                      {previewData.beforeStats.missingCount}
                    </Typography.Text>
                    {' → '}
                    <Typography.Text strong type="success">
                      {previewData.afterStats.missingCount} (0%)
                    </Typography.Text>
                  </div>
                </div>

                {previewData.beforeStats.mean !== undefined && (
                  <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>平均値 (Mean)</Typography.Text>
                    <div>
                      <Typography.Text>{previewData.beforeStats.mean?.toFixed(2)}</Typography.Text>
                      {' → '}
                      <Typography.Text strong style={{ color: '#2563eb' }}>
                        {previewData.afterStats.mean?.toFixed(2)}
                      </Typography.Text>
                    </div>
                  </div>
                )}

                {previewData.beforeStats.std !== undefined && (
                  <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>標準偏差 (Std)</Typography.Text>
                    <div>
                      <Typography.Text>{previewData.beforeStats.std?.toFixed(2)}</Typography.Text>
                      {' → '}
                      <Typography.Text strong style={{ color: '#2563eb' }}>
                        {previewData.afterStats.std?.toFixed(2)}
                      </Typography.Text>
                    </div>
                  </div>
                )}

                {previewData.beforeStats.median !== undefined && (
                  <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>中央値 (Median)</Typography.Text>
                    <div>
                      <Typography.Text>{previewData.beforeStats.median?.toFixed(2)}</Typography.Text>
                      {' → '}
                      <Typography.Text strong style={{ color: '#2563eb' }}>
                        {previewData.afterStats.median?.toFixed(2)}
                      </Typography.Text>
                    </div>
                  </div>
                )}
              </div>

              {/* Distribution Bar Chart */}
              {previewData.histogram && previewData.histogram.length > 0 && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      ビン度数分布（青=補完前観測値、緑=補完追加分）
                    </Typography.Text>
                    <Space size="small">
                      <Tag color="#3b82f6" style={{ margin: 0 }}>観測値</Tag>
                      <Tag color="#10b981" style={{ margin: 0 }}>補完生成値</Tag>
                    </Space>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {previewData.histogram.map((item, idx) => {
                      const obsWidth = (item.beforeCount / maxHistCount) * 100
                      const impWidth = (item.imputedAdded / maxHistCount) * 100
                      return (
                        <div key={idx} style={{ display: 'flex', alignItems: 'center', fontSize: 11, gap: 8 }}>
                          <span style={{ width: 110, textAlign: 'right', color: '#64748b', whiteSpace: 'nowrap' }}>
                            {item.binLabel}
                          </span>
                          <div style={{ flex: 1, background: '#f1f5f9', height: 16, borderRadius: 3, display: 'flex', overflow: 'hidden' }}>
                            <div
                              style={{
                                width: `${obsWidth}%`,
                                background: '#3b82f6',
                                height: '100%',
                              }}
                              title={`観測値: ${item.beforeCount}`}
                            />
                            <div
                              style={{
                                width: `${impWidth}%`,
                                background: '#10b981',
                                height: '100%',
                              }}
                              title={`補完追加: ${item.imputedAdded}`}
                            />
                          </div>
                          <span style={{ width: 60, color: '#334155' }}>
                            {item.afterCount}件
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 16, color: '#64748b' }}>
              「プレビュー更新」をクリックすると、選択した補完アルゴリズムによる分布変化が視覚化されます。
            </div>
          )}
        </Card>

        {/* Section 4: Output target */}
        <Card size="small" title="4. 適用先" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          <Radio.Group value={inPlace} onChange={(e) => setInPlace(e.target.value)}>
            <Space direction="vertical">
              <Radio value={true}>
                <Typography.Text strong>現在のデータセットを更新 (In-place update)</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                  現在のデータセットのリビジョンをインクリメントし、PCPや全プロットを即座に更新します。
                </Typography.Paragraph>
              </Radio>
              <Radio value={false}>
                <Typography.Text strong>新しいデータセットとして保存 (Create derived dataset)</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                  元のデータセットを保持したまま、末尾に _imputed を付与した新しいデータセットを作成します。
                </Typography.Paragraph>
              </Radio>
            </Space>
          </Radio.Group>
        </Card>
      </div>
    </Modal>
  )
}
