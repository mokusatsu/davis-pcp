import EChartSurface from '../charts/EChartSurface'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import GraphPanel from '../common/GraphPanel'
import Table from '../common/ColumnTable'
import { useEffect, useRef, useState } from 'react'
import Modal from '../common/ActiveModal'
import MutationProgress from '../common/MutationProgress'
import { useRequestIdentity } from '../common/useRequestIdentity'
import { useAnalysisViewActive } from '../selection/analysisScope'
import { Alert, Button, ConfigProvider, Input, Radio, Slider, Space, Typography, notification } from 'antd'
import { api } from '../../api/client'

interface BinInfo {
  binIndex: number
  label: string
  min: number
  max: number
  count: number
  ratio: number
}

interface PreviewResponse {
  column: string
  method: string
  edges: number[]
  bins: BinInfo[]
  histogram: {
    counts: number[]
    edges: number[]
  }
  min: number
  max: number
  count: number
}

interface BinningModalProps {
  open: boolean
  datasetId: string
  columnName: string
  dataRevision?: number
  onClose: () => void
  onSuccess: (committedDatasetId: string) => void
}

export default function BinningModal({ open, datasetId, columnName, dataRevision = 0, onClose, onSuccess }: BinningModalProps) {
  const [method, setMethod] = useState<'equal_width' | 'quantile' | 'custom'>('equal_width')
  const [numBins, setNumBins] = useState(4)
  const [customCuts, setCustomCuts] = useState('')
  const [outputName, setOutputName] = useState('')
  const [previewResult, setPreview] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)

  const active = useAnalysisViewActive()
  const busy = useRef(false)
  const nameEdited = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const inputKey = JSON.stringify([open, active, datasetId, dataRevision, columnName, method, numBins, customCuts])
  const request = useRequestIdentity(inputKey)
  const saveRequest = useRequestIdentity(JSON.stringify([datasetId, columnName, open, active]))
  const preview = previewKey === inputKey ? previewResult : null

  useEffect(() => {
    if (!open) return
    nameEdited.current = false
    setOutputName(`${columnName}_bin${numBins}`)
  }, [open, datasetId, columnName])
  useEffect(() => {
    if (!nameEdited.current) setOutputName(`${columnName}_bin${numBins}`)
  }, [columnName, numBins])

  const parseCuts = () => {
    if (method !== 'custom') return undefined
    const parts = customCuts.split(',').map(value => value.trim())
    const cuts = parts.map(Number)
    if (parts.some(value => !value) || cuts.some(value => !Number.isFinite(value)) || cuts.some((value, i) => i > 0 && value <= cuts[i - 1])) {
      throw new Error('境界値は小さい順に、重複しない数値をカンマ区切りで入力してください。')
    }
    return cuts
  }
  const loadPreview = async () => {
    const current = request.begin()
    setPreview(null)
    setPreviewKey(null)
    setError(null)
    if (!open || !active || !datasetId || !columnName) { setLoading(false); return }
    setLoading(true)
    try {
      const res = await api.post<PreviewResponse>(`/datasets/${datasetId}/transform/preview`, {
        column: columnName, method, num_bins: numBins, custom_cuts: parseCuts(),
      })
      if (!current()) return
      setPreview(res)
      setPreviewKey(inputKey)
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : 'プレビューを取得できませんでした。')
    } finally {
      if (current()) setLoading(false)
    }
  }
  useEffect(() => { void loadPreview() }, [inputKey])

  const handleApply = async () => {
    if (busy.current || !open || !active || !datasetId || !columnName || !preview || loading || error) return
    busy.current = true
    const current = saveRequest.begin()
    setApplying(true)
    try {
      const result = await api.post<{ createdColumns?: string[] }>(`/datasets/${datasetId}/transform`, {
        type: 'binning', source_column: columnName,
        options: { method, num_bins: numBins, custom_cuts: parseCuts(),
          output_column_name: outputName.trim() || undefined, labels_format: 'range' },
      })
      const createdColumns = Array.isArray(result?.createdColumns)
        && result.createdColumns.every(name => typeof name === 'string' && name.trim()) ? result.createdColumns : []
      notification.success({ message: 'ビン分割完了', description: createdColumns.length
        ? `新列 ${createdColumns.length} 列 (${createdColumns.map(name => `'${name}'`).join(', ')}) を生成しました。`
        : 'ビン分割を完了しました。生成列名を応答から確認できませんでした。' })
      onSuccess(datasetId)
      if (current()) onClose()
    } catch (err) {
      notification.error({ message: '変換エラー', description: err instanceof Error ? err.message : 'ビン分割に失敗しました。' })
    } finally {
      busy.current = false
      setApplying(false)
    }
  }

  return (
    <Modal
      title={<>連続変数のビン分割: <ColumnQuestionTooltip nameOrId={columnName} /></>}
      open={open}
      onCancel={() => { if (!busy.current) onClose() }}
      onDeactivate={onClose}
      closable={!applying}
      keyboard={!applying}
      maskClosable={!applying}
      cancelButtonProps={{ disabled: applying }}
      okButtonProps={{ disabled: applying || loading || !preview || Boolean(error) }}
      onOk={handleApply}
      okText="ビン列を生成"
      confirmLoading={applying}
      width={680}
    >
      <MutationProgress busy={applying} />
      {error && <Alert type="error" showIcon role="alert" message="プレビューを取得できませんでした" description={error}
        action={<Button onClick={() => void loadPreview()} disabled={applying} loading={loading}>再試行</Button>} style={{ marginBottom: 12 }} />}
      <ConfigProvider componentDisabled={applying}>
      <div data-testid="binning-modal-content">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Typography.Text strong>分割方式: </Typography.Text>
          <Radio.Group
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            data-testid="binning-method-group"
          >
            <Radio.Button value="equal_width">等幅 (Equal-width)</Radio.Button>
            <Radio.Button value="quantile">分位点 (Quantile)</Radio.Button>
            <Radio.Button value="custom">カスタム境界値</Radio.Button>
          </Radio.Group>
        </div>

        {method !== 'custom' ? (
          <div>
            <Typography.Text strong>ビン数: {numBins}</Typography.Text>
            <Slider
              min={2}
              max={10}
              value={numBins}
              onChange={(val) => {
                setNumBins(val)
              }}
              data-testid="binning-slider"
            />
          </div>
        ) : (
          <div>
            <Typography.Text strong>境界値 (カンマ区切り): </Typography.Text>
            <Input
              placeholder="例: 5.0, 6.0, 7.0"
              value={customCuts}
              onChange={(e) => setCustomCuts(e.target.value)}
            />
          </div>
        )}

        {/* Mini Histogram SVG: 図だけを拡大。終了で外側 Modal の編集中入力へ戻る */}
        {preview && preview.histogram.counts.length > 0 && (
          <GraphPanel
            graphId={`preprocess/binning/${columnName}`}
            title="ビニング分布プレビュー"
            available={open}
            sizing="intrinsic"
            intrinsicSize={{ width: 600, height: 120 }}
          >
          <div style={{ background: '#fafafa', padding: 8, borderRadius: 4 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>度数分布ヒストグラム &amp; ビン境界線</Typography.Text>
            <div style={{ height: 60, width: '100%', position: 'relative', marginTop: 4 }}>
              <EChartSurface width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
                {/* Histogram bars */}
                {(() => {
                  const maxC = Math.max(...preview.histogram.counts, 1)
                  const nBars = preview.histogram.counts.length
                  const w = 100 / nBars
                  return preview.histogram.counts.map((c, i) => {
                    const h = (c / maxC) * 85
                    return (
                      <rect
                        key={i}
                        x={i * w}
                        y={100 - h}
                        width={Math.max(w - 0.5, 0.5)}
                        height={h}
                        fill="#91caff"
                      />
                    )
                  })
                })()}
                {/* Bin cut lines */}
                {(() => {
                  const vMin = preview.min
                  const vMax = preview.max
                  const range = vMax - vMin || 1
                  return preview.edges.map((e, i) => {
                    const x = Math.max(0, Math.min(100, ((e - vMin) / range) * 100))
                    return (
                      <line
                        key={i}
                        x1={x}
                        y1={0}
                        x2={x}
                        y2={100}
                        stroke="#ff4d4f"
                        strokeWidth="1.2"
                        strokeDasharray="2,2"
                      />
                    )
                  })
                })()}
              </EChartSurface>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#888' }}>
              <span>Min: {preview.min.toFixed(2)}</span>
              <span>Max: {preview.max.toFixed(2)}</span>
            </div>
          </div>
          </GraphPanel>
        )}

        {/* Preview Table */}
        <div>
          <Typography.Text strong>生成されるビン一覧 (プレビュー):</Typography.Text>
          <Table
            size="small"
            pagination={false}
            loading={loading}
            dataSource={preview?.bins ?? []}
            rowKey="binIndex"
            columns={[
              { title: 'ビン', dataIndex: 'label', key: 'label' },
              { title: '下限値', dataIndex: 'min', key: 'min', render: (v) => v.toFixed(2) },
              { title: '上限値', dataIndex: 'max', key: 'max', render: (v) => v.toFixed(2) },
              { title: '件数', dataIndex: 'count', key: 'count' },
              { title: '比率', dataIndex: 'ratio', key: 'ratio', render: (v) => `${(v * 100).toFixed(1)}%` },
            ]}
          />
        </div>

        <div>
          <Typography.Text strong>出力列名: </Typography.Text>
          <Input
            value={outputName}
            onChange={(e) => { nameEdited.current = true; setOutputName(e.target.value) }}
            placeholder={`${columnName}_bin${numBins}`}
            data-testid="binning-output-name"
          />
        </div>
      </Space>
      </div>
      </ConfigProvider>
    </Modal>
  )
}
