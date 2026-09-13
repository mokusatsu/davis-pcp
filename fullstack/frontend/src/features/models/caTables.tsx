import { Table, Typography } from 'antd'
import type { CACategory } from './caTypes'

export function EigenvalueTable({ eigenvalues, ratio, cumulative }: {
  eigenvalues: number[]
  ratio: number[]
  cumulative: number[]
}): JSX.Element {
  const data = eigenvalues.map((v, i) => ({
    key: i + 1,
    axis: i + 1,
    eigenvalue: v.toFixed(6),
    ratio: `${(ratio[i] * 100).toFixed(2)}%`,
    cumulative: `${(cumulative[i] * 100).toFixed(2)}%`,
  }))
  return (
    <Table
      size="small"
      pagination={false}
      dataSource={data}
      columns={[
        { title: '軸', dataIndex: 'axis', key: 'axis' },
        { title: '固有値', dataIndex: 'eigenvalue', key: 'eigenvalue' },
        { title: '慣性比', dataIndex: 'ratio', key: 'ratio' },
        { title: '累積慣性比', dataIndex: 'cumulative', key: 'cumulative' },
      ]}
    />
  )
}

export function CategoryTable({ title, rows, rank }: {
  title: string
  rows: CACategory[]
  rank: number
}): JSX.Element {
  const data = rows.map((r) => ({
    key: r.categoryId,
    label: r.label,
    mass: r.mass.toFixed(4),
    coord1: r.principalCoordinates[0]?.toFixed(4) ?? '—',
    coord2: rank >= 2 ? (r.principalCoordinates[1]?.toFixed(4) ?? '—') : '—',
    contrib1: r.contributions[0]?.toFixed(4) ?? '—',
    cos2: r.cos2[0] === null || r.cos2[0] === undefined ? '—' : Number(r.cos2[0]).toFixed(4),
  }))
  return (
    <div>
      <Typography.Text strong>{title}</Typography.Text>
      <Table
        size="small"
        pagination={false}
        dataSource={data}
        columns={[
          { title: 'カテゴリ', dataIndex: 'label', key: 'label' },
          { title: '質量', dataIndex: 'mass', key: 'mass' },
          { title: '主座標1', dataIndex: 'coord1', key: 'coord1' },
          { title: '主座標2', dataIndex: 'coord2', key: 'coord2' },
          { title: '寄与1', dataIndex: 'contrib1', key: 'contrib1' },
          { title: 'cos2_1', dataIndex: 'cos2', key: 'cos2' },
        ]}
      />
    </div>
  )
}
