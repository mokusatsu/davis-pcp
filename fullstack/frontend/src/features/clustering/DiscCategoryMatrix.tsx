import { Select as AntSelect } from 'antd'
import Select from '../common/ColumnSelect'
import { useMemo, useState } from 'react'
import { Alert, Space, Typography } from 'antd'

interface DiscCategoryMatrixProps {
  categoryMatrices: Record<string, Record<string, { categories: string[]; matrix: number[][] }>>
  clusterCount: number
}

function cellColor(value: number): string {
  // Value is between 0.0 and 1.0
  // 0.0 is exact match (white / very light blue), 1.0 is maximum dissimilarity (deep blue #1d4ed8)
  const clamped = Math.max(0, Math.min(1, value))
  const r = Math.round(255 - clamped * (255 - 29))
  const g = Math.round(255 - clamped * (255 - 78))
  const b = Math.round(255 - clamped * (255 - 216))
  return `rgb(${r}, ${g}, ${b})`
}

function textColorForBg(value: number): string {
  return value > 0.5 ? '#ffffff' : '#1e293b'
}

export default function DiscCategoryMatrix({
  categoryMatrices,
  clusterCount,
}: DiscCategoryMatrixProps) {
  const [selectedCluster, setSelectedCluster] = useState<string>('0')
  const clusterData = categoryMatrices[selectedCluster] ?? categoryMatrices[Object.keys(categoryMatrices)[0]] ?? {}
  const attributes = useMemo(() => Object.keys(clusterData), [clusterData])
  const [selectedAttr, setSelectedAttr] = useState<string>(attributes[0] ?? '')

  const currentAttr = attributes.includes(selectedAttr) ? selectedAttr : attributes[0] ?? ''
  const matrixData = clusterData[currentAttr]

  return (
    <div
      data-testid="disc-matrix-panel"
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 6,
        background: '#ffffff',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        flexShrink: 0,
        minWidth: 0,
        overflow: 'visible',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Space wrap align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            DISC カテゴリ適応関係行列 (AAAI 2026: Cluster-Customized Category Distance)
          </Typography.Title>
        </Space>
        <Space wrap align="center">
          <Typography.Text style={{ fontSize: 13 }}>クラスタ:</Typography.Text>
          <AntSelect
            data-testid="disc-cluster-select"
            value={selectedCluster}
            onChange={setSelectedCluster}
            style={{ width: 130 }}
            options={Array.from({ length: clusterCount }, (_, i) => ({
              label: `クラスタ ${i}`,
              value: String(i),
            }))}
          />
          <Typography.Text style={{ fontSize: 13 }}>属性:</Typography.Text>
          <Select
            data-testid="disc-attr-select"
            value={currentAttr}
            onChange={setSelectedAttr}
            style={{ width: 180 }}
            options={attributes.map((a) => ({ label: a, value: a }))}
          />
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        message={
          <span style={{ fontSize: 12 }}>
            DISC はクラスタごとに固有のカテゴリ親和度・距離行列 M(k, j) を動的学習し、固定的トポロジー（Hamming distanceの限界）を打破します。
            濃い青ほどそのクラスタ内でカテゴリ同士が乖離（非類似）していることを表します。
          </span>
        }
        style={{ padding: '6px 12px', borderRadius: 6 }}
      />

      {matrixData && matrixData.categories && matrixData.categories.length > 0 ? (
        <div style={{ minHeight: 180 }}>
          <table
            data-testid="disc-heatmap-table"
            style={{
              borderCollapse: 'collapse',
              fontSize: 12,
              fontFamily: 'monospace',
              margin: '0 auto',
            }}
          >
            <thead>
              <tr>
                <th style={{ padding: '6px 10px', background: '#f8fafc', border: '1px solid #e2e8f0' }}></th>
                {matrixData.categories.map((cat, j) => (
                  <th
                    key={j}
                    style={{
                      padding: '6px 10px',
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      color: '#475569',
                      fontWeight: 600,
                      textAlign: 'center',
                    }}
                  >
                    {cat}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrixData.categories.map((catRow, i) => (
                <tr key={i}>
                  <th
                    style={{
                      padding: '6px 10px',
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      color: '#475569',
                      fontWeight: 600,
                      textAlign: 'right',
                    }}
                  >
                    {catRow}
                  </th>
                  {matrixData.matrix[i]?.map((val, j) => (
                    <td
                      key={j}
                      title={`Distance(${catRow}, ${matrixData.categories[j]}) = ${val.toFixed(4)} in Cluster ${selectedCluster}`}
                      style={{
                        padding: '8px 12px',
                        textAlign: 'center',
                        background: cellColor(val),
                        color: textColorForBg(val),
                        border: '1px solid #cbd5e1',
                        minWidth: 54,
                        transition: 'background 0.15s ease',
                      }}
                    >
                      {val.toFixed(2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Typography.Text type="secondary">カテゴリ関係行列データがありません。</Typography.Text>
      )}
    </div>
  )
}
