import { useMemo, type FC } from 'react'
import { Card, Space, Tag, Typography } from 'antd'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import type { PcaResponse } from './types'

interface ScreePlotProps {
  pcaData: PcaResponse | null
  loading: boolean
  selectedX: number
  selectedY: number
  onSelectComponent?: (compIndex: number) => void
}

export const ScreePlot: FC<ScreePlotProps> = ({
  pcaData,
  loading,
  selectedX,
  selectedY,
  onSelectComponent,
}) => {
  const { isTargetActive } = useFocusMode()
  const active = isTargetActive('pca-scree')

  const width = 800
  const height = 240
  const margin = { top: 30, right: 60, bottom: 40, left: 60 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  const maxEigen = useMemo(() => {
    if (!pcaData || pcaData.eigenvalues.length === 0) return 4
    const maxVal = Math.max(...pcaData.eigenvalues)
    return Math.max(maxVal * 1.15, pcaData.kaiserThreshold * 1.2, 1.5)
  }, [pcaData])

  if (!pcaData) {
    return (
      <Card
        size="small"
        title="1. スクリープロット (Scree Plot & Variance Explained)"
        style={{ width: '100%', height: '100%' }}
        loading={loading}
        data-testid="pca-scree-plot"
      >
        <Typography.Text type="secondary">PCAを実行してください。</Typography.Text>
      </Card>
    )
  }

  const k = pcaData.eigenvalues.length
  const colW = plotW / Math.max(k, 1)
  const barW = Math.max(colW * 0.55, 14)

  const scaleYLeft = (val: number) => margin.top + plotH - (val / maxEigen) * plotH
  const scaleYRight = (ratio: number) => margin.top + plotH - ratio * plotH

  const kaiserY = scaleYLeft(pcaData.kaiserThreshold)
  const line80Y = scaleYRight(0.8)

  // Cumulative line points
  const points = pcaData.cumulativeVarianceRatio.map((ratio, i) => {
    const cx = margin.left + i * colW + colW / 2
    const cy = scaleYRight(ratio)
    return { cx, cy, ratio }
  })

  const pathD = points.length > 0
    ? `M ${points.map((p) => `${p.cx},${p.cy}`).join(' L ')}`
    : ''

  return (
    <Card
      size="small"
      title={
        <div style={{ whiteSpace: 'normal', display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 0' }}>
          <span>1. スクリープロット (Scree Plot & Variance Explained)</span>
          <Space wrap size={8}>
            <Tag color="blue" style={{ margin: 0 }}>
              Kaiser基準推奨: {pcaData.kaiserThresholdComponents} 主成分
            </Tag>
          </Space>
        </div>
      }
      extra={<FocusEnterButton targetId="pca-scree" title="スクリープロット" />}
      style={{
        width: '100%',
        height: active ? '100%' : undefined,
        flex: active ? 1 : undefined,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
      bodyStyle={
        active
          ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: 8 }
          : undefined
      }
      loading={loading}
      data-testid="pca-scree-plot"
    >
      <FocusTarget id="pca-scree" title="スクリープロット">
        <div style={{ position: 'relative', width: '100%', height: active ? '100%' : undefined, flex: active ? 1 : undefined, display: 'flex', minHeight: 0 }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height: active ? '100%' : 'auto', maxHeight: active ? 'none' : 260, display: 'block', background: '#fafafa', borderRadius: 4 }}
          data-testid="pca-scree-canvas"
        >
          {/* Grid lines */}
          <line x1={margin.left} y1={margin.top} x2={margin.left + plotW} y2={margin.top} stroke="#eee" />
          <line x1={margin.left} y1={margin.top + plotH / 2} x2={margin.left + plotW} y2={margin.top + plotH / 2} stroke="#eee" />
          <line x1={margin.left} y1={margin.top + plotH} x2={margin.left + plotW} y2={margin.top + plotH} stroke="#ccc" />

          {/* Kaiser threshold reference line */}
          <line
            x1={margin.left}
            y1={kaiserY}
            x2={margin.left + plotW}
            y2={kaiserY}
            stroke="#ff4d4f"
            strokeDasharray="4 4"
            strokeWidth={1.5}
          />
          <text x={margin.left + plotW - 4} y={kaiserY - 4} fill="#ff4d4f" fontSize={10} textAnchor="end">
            Kaiser基準 (λ={pcaData.kaiserThreshold.toFixed(1)})
          </text>

          {/* 80% Cumulative line */}
          <line
            x1={margin.left}
            y1={line80Y}
            x2={margin.left + plotW}
            y2={line80Y}
            stroke="#52c41a"
            strokeDasharray="3 3"
            strokeWidth={1}
          />
          <text x={margin.left + 4} y={line80Y - 4} fill="#52c41a" fontSize={10} textAnchor="start">
            累積 80%
          </text>

          {/* Bars */}
          {pcaData.eigenvalues.map((val, i) => {
            const bx = margin.left + i * colW + (colW - barW) / 2
            const by = scaleYLeft(val)
            const bh = Math.max(margin.top + plotH - by, 0)
            const isX = selectedX === i
            const isY = selectedY === i
            const barFill = isX ? '#1677ff' : isY ? '#722ed1' : '#91caff'

            return (
              <g
                key={`bar-${i}`}
                style={{ cursor: 'pointer' }}
                onClick={() => onSelectComponent && onSelectComponent(i)}
              >
                <rect
                  x={bx}
                  y={by}
                  width={barW}
                  height={bh}
                  fill={barFill}
                  rx={2}
                />
                {/* Variance % label on top of bar */}
                <text
                  x={bx + barW / 2}
                  y={by - 4}
                  fill="#333"
                  fontSize={10}
                  textAnchor="middle"
                  fontWeight="bold"
                >
                  {(pcaData.explainedVarianceRatio[i] * 100).toFixed(1)}%
                </text>
                {/* X axis label */}
                <text
                  x={bx + barW / 2}
                  y={margin.top + plotH + 16}
                  fill={isX ? '#1677ff' : isY ? '#722ed1' : '#555'}
                  fontSize={11}
                  fontWeight={isX || isY ? 'bold' : 'normal'}
                  textAnchor="middle"
                >
                  PC{i + 1}
                  {isX ? ' (X)' : isY ? ' (Y)' : ''}
                </text>
              </g>
            )
          })}

          {/* Cumulative line & dots */}
          <path d={pathD} fill="none" stroke="#faad14" strokeWidth={2.5} />
          {points.map((p, i) => (
            <circle
              key={`dot-${i}`}
              cx={p.cx}
              cy={p.cy}
              r={4}
              fill="#fff"
              stroke="#faad14"
              strokeWidth={2}
            />
          ))}

          {/* Left Y Axis (Eigenvalues) */}
          <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + plotH} stroke="#999" />
          <text x={margin.left - 6} y={margin.top} fill="#666" fontSize={10} textAnchor="end">
            {maxEigen.toFixed(1)}
          </text>
          <text x={margin.left - 6} y={margin.top + plotH} fill="#666" fontSize={10} textAnchor="end">
            0
          </text>
          <text
            x={-margin.top - plotH / 2}
            y={margin.left - 34}
            fill="#374151"
            fontSize={12}
            fontWeight={600}
            transform="rotate(-90)"
            textAnchor="middle"
          >
            固有値 (λ)
          </text>

          {/* Right Y Axis (Cumulative %) */}
          <line x1={margin.left + plotW} y1={margin.top} x2={margin.left + plotW} y2={margin.top + plotH} stroke="#faad14" />
          <text x={margin.left + plotW + 6} y={margin.top + 4} fill="#faad14" fontSize={10} textAnchor="start">
            100%
          </text>
          <text x={margin.left + plotW + 6} y={margin.top + plotH} fill="#faad14" fontSize={10} textAnchor="start">
            0%
          </text>
          <text
            x={margin.top + plotH / 2}
            y={-(margin.left + plotW + 36)}
            fill="#d97706"
            fontSize={12}
            fontWeight={600}
            transform="rotate(90)"
            textAnchor="middle"
          >
            累積寄与率 (%)
          </text>
        </svg>

        <div style={{ marginTop: 6, fontSize: 11, color: '#888', display: 'flex', justifyContent: 'space-between' }}>
          <span>※ 棒をクリックしてX軸/Y軸に割り当て</span>
          <span>
            <span style={{ color: '#1677ff' }}>■ PC(X)</span>{' '}
            <span style={{ color: '#722ed1' }}>■ PC(Y)</span>{' '}
            <span style={{ color: '#faad14' }}>● 累積寄与率</span>
          </span>
        </div>
      </div>
      </FocusTarget>
    </Card>
  )
}
