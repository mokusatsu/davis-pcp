import EChartSurface from '../charts/EChartSurface'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { type FC } from 'react'
import { Card, Typography } from 'antd'
import { chartLabelLineHeight } from '../../utils/chartLabelLayout'

interface ProjectionCircleProps {
  columns: string[]
  alpha: number[]
  beta: number[]
}

export const ProjectionCircle: FC<ProjectionCircleProps> = ({ columns, alpha, beta }) => {
  const size = 180
  const center = size / 2
  const radius = 65

  // Palette for variable arrows
  const colors = ['#1677ff', '#722ed1', '#13c2c2', '#52c41a', '#fa8c16', '#eb2f96', '#f5222d', '#faad14']

  return (
    <Card
      size="small"
      title={<Typography.Text style={{ fontSize: 11 }}>軸寄与円 (Projection Circle)</Typography.Text>}
      style={{
        width: size + 20,
        background: 'rgba(255, 255, 255, 0.92)',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
        borderRadius: 8,
        backdropFilter: 'blur(4px)',
      }}
      bodyStyle={{ padding: 8, display: 'flex', justifyContent: 'center' }}
      data-testid="tgt-projection-circle"
    >
      <EChartSurface width={size} height={size} style={{ display: 'block' }}>
        {/* Background unit circle */}
        <circle cx={center} cy={center} r={radius} fill="#fafafa" stroke="#d9d9d9" strokeWidth={1} />

        {/* Center axes */}
        <line x1={center - radius} y1={center} x2={center + radius} y2={center} stroke="#e8e8e8" strokeDasharray="2 2" />
        <line x1={center} y1={center - radius} x2={center} y2={center + radius} stroke="#e8e8e8" strokeDasharray="2 2" />

        {/* Axis vector arrows */}
        {columns.map((col, idx) => {
          const aVal = alpha[idx] ?? 0
          const bVal = beta[idx] ?? 0
          const endX = center + aVal * radius
          const endY = center - bVal * radius // Invert Y for canvas/svg
          const color = colors[idx % colors.length]
          const labelWidth = Math.min(100, Math.max(endX - 8, size - endX - 8))
          const textAnchor = endX > center ? 'end' : 'start'
          const labelX = textAnchor === 'start' ? Math.min(endX + 4, size - labelWidth - 4) : Math.max(endX - 4, labelWidth + 4)
          const labelY = Math.max(chartLabelLineHeight(9) * 2 + 4, Math.min(size - 4, endY + (bVal >= 0 ? -4 : 10)))


          return (
            <g key={col}>
              {/* Line */}
              <line
                x1={center}
                y1={center}
                x2={endX}
                y2={endY}
                stroke={color}
                strokeWidth={1.75}
              />
              {/* Tip dot */}
              <circle cx={endX} cy={endY} r={3} fill={color} />
              {/* Label */}
              <ColumnQuestionTooltip nameOrId={col} svg><text
                data-label-width={labelWidth}
                data-label-lines={2}
                x={labelX}
                y={labelY}
                fill={color}
                fontSize={9}
                fontWeight="bold"
                textAnchor={textAnchor}
              >
                <title>{col}</title>
                {col}
              </text></ColumnQuestionTooltip>
            </g>
          )
        })}
      </EChartSurface>
    </Card>
  )
}
