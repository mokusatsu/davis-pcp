import Table from '../common/ColumnTable'
import { useMemo, type FC } from 'react'
import { Card, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { PcaResponse } from './types'

interface LoadingTableProps {
  pcaData: PcaResponse | null
  loading: boolean
}

interface TableRow {
  key: string
  variable: string
  [key: string]: string | number
}

export const LoadingTable: FC<LoadingTableProps> = ({ pcaData, loading }) => {

  const dataSource = useMemo(() => {
    if (!pcaData) return []
    return pcaData.columns.map((col) => {
      const row: TableRow = { key: col, variable: col }
      const colLoadings = pcaData.loadings[col] || []
      colLoadings.forEach((val, idx) => {
        row[`pc_${idx}`] = val
      })
      return row
    })
  }, [pcaData])

  const columns: ColumnsType<TableRow> = useMemo(() => {
    if (!pcaData) return []

    const baseCols: ColumnsType<TableRow> = [
      {
        title: '変数 (Variable)',
        dataIndex: 'variable',
        key: 'variable',
        fixed: 'left',
        width: 140,
        render: (text: string) => <Typography.Text strong>{text}</Typography.Text>,
      },
    ]

    const k = pcaData.nComponents || pcaData.eigenvalues.length
    for (let i = 0; i < k; i++) {
      const variancePct = (pcaData.explainedVarianceRatio[i] * 100).toFixed(1)
      const dataKey = `pc_${i}`
      baseCols.push({
        title: (
          <div>
            <div>PC{i + 1}</div>
            <div style={{ fontSize: 10, color: '#888', fontWeight: 'normal' }}>({variancePct}%)</div>
          </div>
        ),
        dataIndex: dataKey,
        key: dataKey,
        width: 120,
        sorter: (a, b) => (Number(a[dataKey]) || 0) - (Number(b[dataKey]) || 0),
        render: (val: number) => {
          if (val === undefined || val === null) return '—'
          const isPositive = val >= 0
          const barWidth = Math.min(Math.abs(val) * 45, 45)
          const barColor = isPositive ? '#1890ff' : '#ff4d4f'

          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 44, textAlign: 'right', fontFamily: 'monospace', fontSize: 11 }}>
                {val >= 0 ? `+${val.toFixed(3)}` : val.toFixed(3)}
              </span>
              <div style={{ width: 45, height: 10, background: '#f0f0f0', borderRadius: 2, display: 'flex', alignItems: 'center' }}>
                <div
                  style={{
                    width: barWidth,
                    height: '100%',
                    backgroundColor: barColor,
                    borderRadius: 2,
                  }}
                />
              </div>
            </div>
          )
        },
      })
    }

    return baseCols
  }, [pcaData])

  return (
    <Card
      size="small"
      title="2. 因子負荷量テーブル (Factor Loadings & Weights)"
      style={{ width: '100%' }}
      loading={loading}
      data-testid="pca-loading-table"
    >
      <Table
        size="small"
        dataSource={dataSource}
        columns={columns}
        pagination={false}
        scroll={{ x: 'max-content', y: 220 }}
      />
      <div style={{ marginTop: 6, fontSize: 11, color: '#888' }}>
        ※ 青バー: 正の相関 (+), 赤バー: 負の相関 (-)。列見出しクリックでソート。
      </div>
    </Card>
  )
}
