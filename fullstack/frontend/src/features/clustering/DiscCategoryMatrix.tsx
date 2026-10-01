import EChart from '../charts/EChart'
import { Select as AntSelect } from 'antd'
import Select from '../common/ColumnSelect'
import { useMemo, useState } from 'react'
import { Alert, Space, Typography } from 'antd'
import GraphPanel, { useGraphPopupContainer } from '../common/GraphPanel'

interface DiscCategoryMatrixProps {
  categoryMatrices: Record<string, Record<string, { categories: string[]; matrix: number[][] }>>
  clusterCount: number
}

export default function DiscCategoryMatrix({
  categoryMatrices,
  clusterCount,
}: DiscCategoryMatrixProps) {
  const [selectedCluster, setSelectedCluster] = useState<string>('0')
  const clusterData = categoryMatrices[selectedCluster] ?? categoryMatrices[Object.keys(categoryMatrices)[0]] ?? {}
  const attributes = useMemo(() => Object.keys(clusterData), [clusterData])
  const [selectedAttr, setSelectedAttr] = useState<string>(attributes[0] ?? '')
  const getPopupContainer = useGraphPopupContainer('clusters/disc')

  const currentAttr = attributes.includes(selectedAttr) ? selectedAttr : attributes[0] ?? ''
  const matrixData = clusterData[currentAttr]
  const width = Math.max(640, (matrixData?.categories.length ?? 0) * 42 + 145)
  const height = Math.max(280, (matrixData?.categories.length ?? 0) * 42 + 120)

  return (
    <div data-testid="disc-matrix-panel">
      <GraphPanel graphId="clusters/disc" title="DISC カテゴリ関係行列" available={Boolean(matrixData?.categories.length)}
        style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, userSelect: 'none' }}
        sizing="intrinsic" intrinsicSize={{ width, height }} controls={<Space direction="vertical" size="small" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <Space wrap align="center">
              <Typography.Title level={5} style={{ margin: 0 }}>
                DISC カテゴリ適応関係行列 (AAAI 2026: Cluster-Customized Category Distance)
              </Typography.Title>
            </Space>
            <Space wrap align="center">
              <Typography.Text style={{ fontSize: 13 }}>クラスタ:</Typography.Text>
              <AntSelect
                getPopupContainer={getPopupContainer}
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
                getPopupContainer={getPopupContainer}
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

        </Space>}>
        {matrixData && matrixData.categories && matrixData.categories.length > 0 ? (
          <EChart testId="disc-heatmap-chart" height={height} width={width}
            ariaLabel={`${currentAttr} クラスタ ${selectedCluster} カテゴリ距離行列`}
            option={{
              grid: { left: 110, right: 35, top: 25, bottom: 95 },
              tooltip: { trigger: 'item', renderMode: 'richText', formatter: (p: any) => p.data?.description ?? '' },
              xAxis: { type: 'category', data: matrixData.categories, axisLabel: { interval: 0, width: 100, overflow: 'truncate' } },
              yAxis: { type: 'category', inverse: true, data: matrixData.categories, axisLabel: { width: 90, overflow: 'truncate' } },
              visualMap: { min: 0, max: 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: ['#ffffff', '#1d4ed8'] } },
              series: [{ type: 'heatmap', data: matrixData.matrix.flatMap((row, i) => row.map((value, j) => ({
                value: [j, i, value], description: `Distance(${matrixData.categories[i]}, ${matrixData.categories[j]}) = ${value.toFixed(4)} in Cluster ${selectedCluster}`,
                label: { color: value > 0.5 ? '#fff' : '#1e293b' },
              }))), label: { show: true, formatter: (p: any) => Number(p.value[2]).toFixed(2) },
                itemStyle: { borderWidth: 1, borderColor: '#cbd5e1' }, emphasis: { itemStyle: { borderWidth: 2, borderColor: '#2a78d6' } } }],
            }} />
        ) : (
          <Typography.Text type="secondary">カテゴリ関係行列データがありません。</Typography.Text>
        )}
      </GraphPanel>
    </div>
  )
}
