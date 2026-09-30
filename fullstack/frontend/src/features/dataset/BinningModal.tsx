import EChartSurface from '../charts/EChartSurface'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import GraphPanel from '../common/GraphPanel'
import Table from '../common/ColumnTable'
import { useEffect, useState } from 'react'
import { Input, Modal, Radio, Slider, Space, Typography, notification } from 'antd'
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
  onClose: () => void
  onSuccess: () => void
}

export default function BinningModal({ open, datasetId, columnName, onClose, onSuccess }: BinningModalProps) {
  const [method, setMethod] = useState<'equal_width' | 'quantile' | 'custom'>('equal_width')
  const [numBins, setNumBins] = useState(4)
  const [customCuts, setCustomCuts] = useState('')
  const [outputName, setOutputName] = useState('')
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!open) return
    setOutputName(`${columnName}_bin${numBins}`)
    loadPreview()
  }, [open, datasetId, columnName, method, numBins, customCuts])

  const loadPreview = async () => {
    if (!datasetId || !columnName) return
    setLoading(true)
    try {
      const cuts = method === 'custom' && customCuts.trim()
        ? customCuts.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n))
        : undefined

      const res = await api.post<PreviewResponse>(`/datasets/${datasetId}/transform/preview`, {
        column: columnName,
        method,
        num_bins: numBins,
        custom_cuts: cuts,
      })
      setPreview(res)
    } catch {
      // preview error handled silently
    } finally {
      setLoading(false)
    }
  }

  const handleApply = async () => {
    if (!datasetId || !columnName) return
    setApplying(true)
    try {
      const cuts = method === 'custom' && customCuts.trim()
        ? customCuts.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n))
        : undefined

      await api.post(`/datasets/${datasetId}/transform`, {
        type: 'binning',
        source_column: columnName,
        options: {
          method,
          num_bins: numBins,
          custom_cuts: cuts,
          output_column_name: outputName.trim() || undefined,
          labels_format: 'range',
        },
      })
      notification.success({ message: 'ビン分割完了', description: `新列 '${outputName || `${columnName}_bin${numBins}`}' を生成しました。` })
      onSuccess()
      onClose()
    } catch (err) {
      const error = err as { message: string }
      notification.error({ message: '変換エラー', description: error.message || 'ビン分割に失敗しました。' })
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      title={<>連続変数のビン分割: <ColumnQuestionTooltip nameOrId={columnName} /></>}
      open={open}
      onCancel={onClose}
      onOk={handleApply}
      okText="ビン列を生成"
      confirmLoading={applying}
      width={680}
    >
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
                setOutputName(`${columnName}_bin${val}`)
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
            onChange={(e) => setOutputName(e.target.value)}
            placeholder={`${columnName}_bin${numBins}`}
            data-testid="binning-output-name"
          />
        </div>
      </Space>
      </div>
    </Modal>
  )
}
