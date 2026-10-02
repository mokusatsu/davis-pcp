import { useMemo } from 'react'
import { Alert, Select, Space, Typography } from 'antd'
import GraphPanel, { useGraphPopupContainer } from '../common/GraphPanel'
import RowScatter, { type RowPoint } from '../charts/RowScatter'
import L1Legend from '../common/L1Legend'
import SelectionMenu from '../selection/SelectionMenu'
import type { SparsePcaResponse, SparsePcaRow } from './sparsePcaTypes'

export function sparsePcaPoints(rows: SparsePcaRow[], axes: number[]): RowPoint[] {
  return rows.map(row => ({ rowId: row.rowId, x: row.coordinates[0], y: axes.length === 1 ? 0 : row.coordinates[1],
    tooltip: `rowId: ${row.rowId}\n${axes.map((axis, i) => `SP${axis}: ${row.coordinates[i]}`).join('\n')}` }))
}

function AxisControls({ count, axes, onAxes }: { count: number; axes: number[]; onAxes: (axes: number[]) => void }) {
  const getPopupContainer = useGraphPopupContainer()
  const options = Array.from({ length: count }, (_, i) => ({ value: i + 1, label: `SP${i + 1}` }))
  return <Space wrap>
    <label>X軸 <Select data-testid="sparse-pca-axis-x" aria-label="SparsePCA X軸" getPopupContainer={getPopupContainer}
      value={axes[0]} options={options} style={{ width: 90 }} onChange={axis => {
        onAxes(axes.length === 1 ? [axis] : axis === axes[1] ? [axis, axes[0]] : [axis, axes[1]])
      }} /></label>
    {count > 1 && <label>Y軸 <Select data-testid="sparse-pca-axis-y" aria-label="SparsePCA Y軸" getPopupContainer={getPopupContainer}
      value={axes[1]} options={options.filter(option => option.value !== axes[0])} style={{ width: 90 }}
      onChange={axis => onAxes([axes[0], axis])} /></label>}
    <SelectionMenu testId="sparse-pca-selection-menu" />
  </Space>
}

export default function SparsePcaScorePlot({ result, rows, axes, onAxes, available = true }: {
  result: SparsePcaResponse; rows: SparsePcaRow[]; axes: number[]; onAxes: (axes: number[]) => void; available?: boolean
}) {
  const points = useMemo(() => sparsePcaPoints(rows, axes), [rows, axes])
  const constant = points.length > 0 && points.every(point => point.x === points[0].x && point.y === points[0].y)
  const oneDimensional = axes.length === 1
  return <section aria-label="SparsePCA得点図">
    <Typography.Paragraph type="secondary">表示軸の変更は再学習しません。選択・ホバー・上部のL1/L2色分けは他のグラフと同期します。</Typography.Paragraph>
    {oneDimensional && <Alert type="info" message="1成分の得点を横軸だけに表示します。縦位置は配置用で、追加成分やjitterはありません。" />}
    {constant && <Alert type="warning" message="表示中の全得点が一定で、意味のある広がりはありません。重なったサンプルも得点一覧にすべて保持しています。" />}
    <L1Legend />
    <GraphPanel graphId="pca/sparse-scores" title="SparsePCA 得点散布図" available={available && rows.length > 0}
      sizing="intrinsic" intrinsicSize={{ width: 760, height: 450 }}
      controls={<AxisControls count={result.summary.nComponents} axes={axes} onAxes={onAxes} />}>
      <RowScatter key={axes.join(',')} points={points} xName={`SP${axes[0]}`} yName={oneDimensional ? '' : `SP${axes[1]}`}
        oneDimensional={oneDimensional} testId="sparse-pca-score-plot" height={450}
        option={{ animation: false, ...(oneDimensional ? { yAxis: { type: 'value', show: false, min: -1, max: 1 } } : {}) }} />
    </GraphPanel>
  </section>
}
