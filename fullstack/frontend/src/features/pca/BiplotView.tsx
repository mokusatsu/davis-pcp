import { Select as AntSelect } from 'antd'
import RowScatter from '../charts/RowScatter'
import { escapeHtml } from '../charts/EChart'
import type { EChartsOption } from 'echarts'
import { useMemo, useState, type FC } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Checkbox, Dropdown, Space, Typography } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import GraphPanel, { useGraphPopupContainer } from '../common/GraphPanel'
import type { PcaResponse } from './types'
import { truncateText } from '../../utils/textUtils'

interface BiplotViewProps {
  pcaData: PcaResponse | null
  selectedX: number
  selectedY: number
  onSelectX: (val: number) => void
  onSelectY: (val: number) => void
}

export const BiplotView: FC<BiplotViewProps> = ({

  pcaData,
  selectedX,
  selectedY,
  onSelectX,
  onSelectY,
}) => {
  const graphPopupContainer = useGraphPopupContainer('pca/biplot')
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const definitions = useSelector((s: RootState) => s.codebook.columns)
  const [showVectors, setShowVectors] = useState(true)
  const height = 480
  // Coordinate ranges for scores
  const scoreBounds = useMemo(() => {
    if (!pcaData || pcaData.scores.length === 0) {
      return { minX: -3, maxX: 3, minY: -3, maxY: 3 }
    }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    for (const item of pcaData.scores) {
      const x = item.pc[selectedX] ?? 0
      const y = item.pc[selectedY] ?? 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    const padX = Math.max((maxX - minX) * 0.08, 0.5)
    const padY = Math.max((maxY - minY) * 0.08, 0.5)

    return {
      minX: minX - padX,
      maxX: maxX + padX,
      minY: minY - padY,
      maxY: maxY + padY,
    }
  }, [pcaData, selectedX, selectedY])

  // Vector scaling to map loading [-1, 1] into plot coordinate scale
  const vectorScale = useMemo(() => {
    const spanX = (scoreBounds.maxX - scoreBounds.minX) / 2
    const spanY = (scoreBounds.maxY - scoreBounds.minY) / 2
    return Math.min(spanX, spanY) * 0.75
  }, [scoreBounds])

  const chartOption: EChartsOption = {
    xAxis: { type: 'value', name: `PC${selectedX + 1}`, min: scoreBounds.minX, max: scoreBounds.maxX },
    yAxis: { type: 'value', name: `PC${selectedY + 1}`, min: scoreBounds.minY, max: scoreBounds.maxY },
    series: showVectors && pcaData ? pcaData.columns.map(column => ({
      type: 'line' as const, name: column, data: [],
      markLine: { symbol: ['none', 'arrow'], symbolSize: 9, lineStyle: { color: '#d4380d', width: 2, type: 'solid' },
        label: { show: true, formatter: () => truncateText(column, 14), position: 'end' },
        data: [[{ coord: [0, 0] }, { coord: [(pcaData.loadings[column]?.[selectedX] ?? 0) * vectorScale, (pcaData.loadings[column]?.[selectedY] ?? 0) * vectorScale] }]],
        tooltip: { formatter: () => `${escapeHtml(column)}${definitions.find(definition => definition.name === column)?.label ? ` — ${escapeHtml(definitions.find(definition => definition.name === column)!.label)}` : ''}: (${pcaData.loadings[column]?.[selectedX] ?? 0}, ${pcaData.loadings[column]?.[selectedY] ?? 0})` },
      },
    })) : [],
  }

  const contextMenuItems = [
    {
      key: 'focus',
      label: 'Focus Selected (選択行で絞り込み)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: 'Delete Selected (選択行を除外)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: '選択解除 (Clear Selection)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'reset',
      label: '作業セット復元 (Reset Working Set)',
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]

  const numComponents = pcaData?.nComponents || pcaData?.eigenvalues.length || 2
  const componentOptions = Array.from({ length: numComponents }, (_, i) => {
    const ratio = pcaData?.explainedVarianceRatio[i]
      ? ` (${(pcaData.explainedVarianceRatio[i] * 100).toFixed(1)}%)`
      : ''
    return { label: `PC${i + 1}${ratio}`, value: i }
  })

  const controls = (
    <Space wrap>
      <Typography.Text strong>X軸: </Typography.Text>
      <AntSelect style={{ width: 140 }} value={selectedX} onChange={onSelectX}
        options={componentOptions} getPopupContainer={graphPopupContainer} data-testid="pca-axis-x" />
      <Typography.Text strong>Y軸: </Typography.Text>
      <AntSelect style={{ width: 140 }} value={selectedY} onChange={onSelectY}
        options={componentOptions} getPopupContainer={graphPopupContainer} data-testid="pca-axis-y" />
      <Checkbox checked={showVectors} onChange={event => setShowVectors(event.target.checked)} data-testid="pca-biplot-vectors">
        負荷量ベクトル表示 (Loading Vectors)
      </Checkbox>
    </Space>
  )
  return (
    <div data-testid="pca-biplot-view" style={{ minHeight: 0 }}>
      <GraphPanel graphId="pca/biplot" title="PCAバイプロット"
        available={Boolean(pcaData?.scores.length)} sizing="intrinsic"
        intrinsicSize={{ width: 720, height }} controls={controls}>
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={graphPopupContainer}>
          <div style={{ width: 720, height, position: 'relative', boxShadow: 'inset 0 0 0 1px #e5e7eb', borderRadius: 6, background: '#fff', userSelect: 'none' }}>
            <RowScatter points={(pcaData?.scores ?? []).map(item => ({ rowId: item.rowId || item.row_id || '', x: item.pc[selectedX] ?? 0, y: item.pc[selectedY] ?? 0 }))}
              xName={`PC${selectedX + 1}`} yName={`PC${selectedY + 1}`} height={height} option={chartOption} testId="pca-biplot-canvas" />
          </div>
        </Dropdown>
      </GraphPanel>
    </div>
  )
}
