import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { type FC } from 'react'
import { Card, Typography } from 'antd'
import { truncateText } from '../../utils/textUtils'

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
      <svg width={size} height={size} style={{ display: 'block' }}>
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
          const label = truncateText(col, 10)
          const labelWidth = Array.from(label).length * 9
          const fitsRight = endX + 4 + labelWidth <= size - 4
          const fitsLeft = endX - 4 - labelWidth >= 4
          const textAnchor = aVal >= 0
            ? (fitsRight ? 'start' : 'end')
            : (fitsLeft ? 'end' : 'start')
          const labelX = textAnchor === 'start'
            ? (aVal >= 0 && fitsRight ? endX + 4 : 4)
            : (aVal >= 0 && !fitsRight ? size - 4 : endX - 4)
          const labelY = Math.max(10, Math.min(size - 4, endY + (bVal >= 0 ? -4 : 10)))

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
                x={labelX}
                y={labelY}
                fill={color}
                fontSize={9}
                fontWeight="bold"
                textAnchor={textAnchor}
              >
                <title>{col}</title>
                {label}
              </text></ColumnQuestionTooltip>
            </g>
          )
        })}
      </svg>
    </Card>
  )
}
