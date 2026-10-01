import EChart from '../charts/EChart'
import type { EChartsOption } from 'echarts'
import { Select as AntSelect } from 'antd'
import ColumnQuestionTooltip, { ColumnQuestionText } from '../common/ColumnQuestionTooltip'
import { useCodebook } from '../dataset/useCodebookColumn'
import Select from '../common/ColumnSelect'
import React, { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown, Radio, Space, Tag, Typography } from 'antd'
import { BarChartOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, selectEffectiveRowIds, selectOrdinaryVariables } from '../../app/store'
import { useBrushOp } from '../selection/SelectionMenu'
import GraphPanel, { useGraphPopupContainer } from '../common/GraphPanel'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { useRowColorResolver } from '../../theme/useRowColor'
import MultiResponseBarChart from './MultiResponseBarChart'

interface BarItem {
  category: string
  totalCount: number
  selectedCount: number
  rowIds: string[]
  subGroups?: Record<string, { total: number; selected: number; rowIds: string[] }>
}

export default function BarChartPage() {
  const graphPopupContainer = useGraphPopupContainer('barchart/main')
  const dispatch = useDispatch()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const activeRowIds = useSelector(selectEffectiveRowIds)
  const selectedRowIds = useSelector((s: RootState) => s.selection.selectedRowIds)
  const { formatValueLabel, columns: definitions } = useCodebook()
  const ordinary = useSelector(selectOrdinaryVariables)
  const [brushOp] = useBrushOp()
  const { colorBy, getColor } = useRowColorResolver()
  const l2ColorEnabled = useSelector((s: RootState) => s.selection.l2ColorEnabled)

  const [requestedColumn, setSelectedColumn] = useState<string>('')
  const [requestedSubColumn, setSubColumn] = useState<string>('')
  const [displayMode, setDisplayMode] = useState<'count' | 'percent'>('count')
  const [sortOrder, setSortOrder] = useState<'count-desc' | 'name-asc' | 'ratio-desc'>('count-desc')
  const [hoveredCategory, setHoveredBar] = useState<string | null>(null)

  const selectedSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds])

  const columns = useMemo(() => {
    return definitions
      .filter((c) => !c.multiResponseGroup && ordinary.activeVariableIds.includes(c.name))
      .map((c) => ({
        name: c.name,
        type: ['ratio', 'interval'].includes(c.scaleType) ? 'numeric' : 'categorical',
      }))
  }, [definitions, ordinary.activeVariableIds])

  const categoricalColumns = useMemo(() => {
    return columns.filter((c) => c.type !== 'numeric')
  }, [columns])

  const selectedColumn = columns.some(c => c.name === requestedColumn) ? requestedColumn : categoricalColumns[0]?.name || columns[0]?.name || ''
  const subColumn = requestedSubColumn !== selectedColumn && columns.some(c => c.name === requestedSubColumn) ? requestedSubColumn : ''
  const data = useColumnarData(datasetId, [selectedColumn, subColumn].filter(Boolean))
  React.useEffect(() => {
    setHoveredBar(null)
  }, [columns, selectedColumn, subColumn])

  // Aggregate bar data
  const barData: BarItem[] = useMemo(() => {
    if (!data || !selectedColumn) return []

    const colIndex = data.schema.findIndex((c) => c.name === selectedColumn)
    if (colIndex === -1) return []

    const subColIndex = subColumn ? data.schema.findIndex((c) => c.name === subColumn) : -1

    const groups: Record<string, { total: number; selected: number; rowIds: string[]; sub: Record<string, { total: number; selected: number; rowIds: string[] }> }> = Object.create(null)

    for (const rid of activeRowIds) {
      const idx = data.rowIndex.get(rid)
      if (idx === undefined) continue

      const rawVal = data.columns[selectedColumn]?.[idx]
      const catKey = rawVal === null || rawVal === undefined ? '(null)' : String(rawVal)

      if (!groups[catKey]) {
        groups[catKey] = { total: 0, selected: 0, rowIds: [], sub: Object.create(null) }
      }

      const isSel = selectedSet.has(rid)
      groups[catKey].total++
      groups[catKey].rowIds.push(rid)
      if (isSel) groups[catKey].selected++

      if (subColIndex !== -1) {
        const rawSub = data.columns[subColumn]?.[idx]
        const subKey = rawSub === null || rawSub === undefined ? '(null)' : String(rawSub)
        if (!groups[catKey].sub[subKey]) {
          groups[catKey].sub[subKey] = { total: 0, selected: 0, rowIds: [] }
        }
        groups[catKey].sub[subKey].total++
        groups[catKey].sub[subKey].rowIds.push(rid)
        if (isSel) groups[catKey].sub[subKey].selected++
      }
    }

    const items: BarItem[] = Object.entries(groups).map(([cat, g]) => ({
      category: cat,
      totalCount: g.total,
      selectedCount: g.selected,
      rowIds: g.rowIds,
      subGroups: subColIndex !== -1 ? g.sub : undefined,
    }))

    // Sort
    if (sortOrder === 'count-desc') {
      items.sort((a, b) => b.totalCount - a.totalCount)
    } else if (sortOrder === 'name-asc') {
      items.sort((a, b) => formatValueLabel(selectedColumn, a.category).localeCompare(formatValueLabel(selectedColumn, b.category)))
    } else if (sortOrder === 'ratio-desc') {
      items.sort((a, b) => (b.selectedCount / (b.totalCount || 1)) - (a.selectedCount / (a.totalCount || 1)))
    }

    return items
  }, [data, selectedColumn, subColumn, activeRowIds, selectedSet, sortOrder, formatValueLabel])
  const hoveredBar = barData.find(item => item.category === hoveredCategory)
  const colorSegmentsByCategory = useMemo(() => {
    const result = new Map<string, { color: string; count: number }[]>()
    if (!colorBy && !l2ColorEnabled) return result
    for (const item of barData) {
      const counts = new Map<string, number>()
      for (const rowId of item.rowIds) {
        const color = getColor(rowId)
        counts.set(color, (counts.get(color) ?? 0) + 1)
      }
      result.set(item.category, [...counts.entries()].map(([color, count]) => ({ color, count })))
    }
    return result
  }, [barData, colorBy, l2ColorEnabled, getColor])

  const totalActive = activeRowIds.length
  const maxBarCount = useMemo(() => {
    return Math.max(1, ...barData.map((b) => b.totalCount))
  }, [barData])

  // Context menu
  const contextMenuItems = [
    { key: 'focus', label: '選択に絞り込み', disabled: selectedRowIds.length === 0 },
    { key: 'delete', label: '選択を削除', disabled: selectedRowIds.length === 0 },
    { key: 'clear', label: '選択解除', disabled: selectedRowIds.length === 0 },
    { type: 'divider' as const },
    { key: 'reset', label: 'ベースデータに戻す' },
  ]

  const onContextMenuClick = (key: string) => {
    if (key === 'focus') dispatch(focusSelected())
    else if (key === 'delete') dispatch(deleteSelected())
    else if (key === 'clear') dispatch(selectionCleared())
    else if (key === 'reset') dispatch(resetWorkingSet())
  }

  // ECharts owns bar layout and hit-testing at every GraphPanel scale.
  const chartHeight = Math.max(380, 100 + barData.length * 48)
  const chartWidth = 1010
  const colors = [...new Set(barData.flatMap(item =>
    (colorSegmentsByCategory.get(item.category) ?? [{ color: '#e2e8f0', count: item.totalCount }]).map(segment => segment.color)))]
  const chartValue = (count: number) => displayMode === 'count' ? count : count / (totalActive || 1) * 100
  const chartOption: EChartsOption = {
    grid: { left: 250, right: 220, top: 40, bottom: 45 },
    xAxis: { type: 'value', min: 0, max: displayMode === 'count' ? maxBarCount : 100,
      position: 'top', axisLabel: { formatter: (value: number) => displayMode === 'count' ? String(value) : `${value}%` },
      splitLine: { lineStyle: { color: '#f3f4f6' } } },
    // Category codes are distinct even when the displayed labels match.
    yAxis: { type: 'category', inverse: true, triggerEvent: true, data: barData.map(item => item.category),
      axisLabel: { width: 230, overflow: 'truncate', formatter: (code: string) => formatValueLabel(selectedColumn, code) },
      axisLine: { show: false }, axisTick: { show: false } },
    tooltip: { show: false },
    series: [
      ...colors.map(color => ({
        id: `category-color-${color}`, type: 'bar' as const, stack: 'total', barWidth: 34,
        itemStyle: { color, opacity: color === '#e2e8f0' ? 1 : 0.78 },
        data: barData.map(item => {
          const segments = colorSegmentsByCategory.get(item.category) ?? [{ color: '#e2e8f0', count: item.totalCount }]
          const count = segments.find(segment => segment.color === color)?.count ?? 0
          const fraction = item.selectedCount / (item.totalCount || 1)
          const lastColor = colors.filter(candidate => segments.some(segment => segment.color === candidate)).at(-1)
          return { value: chartValue(count), name: item.category,
            label: { show: lastColor === color, position: 'right' as const, distance: 8,
              color: item.selectedCount > 0 ? '#2a78d6' : '#64748b', fontSize: 11,
              formatter: `${item.totalCount}件${item.selectedCount ? ` (${item.selectedCount}件選択 / ${(fraction * 100).toFixed(0)}%)` : ''}${displayMode === 'percent' ? ` [${chartValue(item.totalCount).toFixed(1)}%]` : ''}` },
          }
        }),
      })),
      { id: 'selected-count', type: 'bar', barWidth: 34, barGap: '-100%', z: 3,
        itemStyle: { color: '#2a78d6', opacity: 0.9 },
        data: barData.map(item => ({ name: item.category, value: chartValue(item.selectedCount) })) },
    ],
  }

  const contentRef = React.useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  React.useLayoutEffect(() => {
    const node = contentRef.current
    if (!node) return
    const measure = () => { if (node.offsetHeight > 0) setContentHeight(node.offsetHeight) }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    measure()
    return () => observer?.disconnect()
  }, [])

  return (
    <div
      data-testid="barchart-page"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}
    >
      {/* Controls Card */}
      <MultiResponseBarChart />
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#ffffff',
            padding: '10px 16px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexShrink: 0,
          }}
        >
          <Space wrap size={16}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              <BarChartOutlined style={{ marginRight: 6, color: '#2a78d6' }} />
              対話型棒グラフ (Bar Chart)
            </Typography.Text>

            <Space size={8}>
              <span style={{ fontSize: 13, color: '#4b5563' }}>対象変数:</span>
              <Select
                data-testid="barchart-col-select"
                style={{ width: 170 }}
                value={selectedColumn}
                onChange={setSelectedColumn}
                options={columns.map((c) => ({
                  label: `${c.name} (${c.type})`,
                  value: c.name,
                }))}
                size="small"
              />
            </Space>

            <Space size={8}>
              <span style={{ fontSize: 13, color: '#4b5563' }}>内訳変数:</span>
              <Select
                allowClear
                placeholder="なし (単変量)"
                style={{ width: 160 }}
                value={subColumn || undefined}
                onChange={(v) => setSubColumn(v || '')}
                options={columns.filter((c) => c.name !== selectedColumn).map((c) => ({
                  label: c.name,
                  value: c.name,
                }))}
                size="small"
              />
            </Space>

            <Radio.Group
              value={displayMode}
              onChange={(e) => setDisplayMode(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="count">度数 (Count)</Radio.Button>
              <Radio.Button value="percent">割合 (%)</Radio.Button>
            </Radio.Group>

            <AntSelect
              style={{ width: 150 }}
              value={sortOrder}
              onChange={setSortOrder}
              options={[
                { label: '度数降順', value: 'count-desc' },
                { label: 'カテゴリ名昇順', value: 'name-asc' },
                { label: '選択比率順', value: 'ratio-desc' },
              ]}
              size="small"
            />
          </Space>

          <Space size={12}>
          </Space>
        </div>

      {/* Main Chart Card */}
      <GraphPanel
        graphId="barchart/main"
        title="対話型棒グラフ"
        available={barData.length > 0}
        sizing="intrinsic"
        intrinsicSize={{ width: chartWidth, height: contentHeight ?? chartHeight + 150 }}
      >
        <Dropdown menu={{ items: contextMenuItems, onClick: ({ key }) => onContextMenuClick(key) }} trigger={['contextMenu']} getPopupContainer={graphPopupContainer}>
          <div
            ref={contentRef}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              background: '#ffffff',
              padding: 16,
              position: 'relative',
              overflow: 'visible',
              userSelect: 'none',
              minHeight: 380,
              flexShrink: 0,
            }}
          >
            {/* Status bar */}
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tag color="blue"><ColumnQuestionTooltip nameOrId={selectedColumn}>{selectedColumn}</ColumnQuestionTooltip></Tag>
              {colorBy && <Tag color="default">L1色分け: <ColumnQuestionTooltip nameOrId={colorBy}>{colorBy}</ColumnQuestionTooltip></Tag>}
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                カテゴリ数: {barData.length} | 有効行: {totalActive}行 | 選択行: {selectedRowIds.length}行 (
                {totalActive > 0 ? ((selectedRowIds.length / totalActive) * 100).toFixed(1) : 0}%)
              </span>
            </div>

            <div data-testid="barchart-questions" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5, marginBottom: 12 }}>
              {selectedColumn && <div>対象変数: <ColumnQuestionText nameOrId={selectedColumn} /></div>}
              {subColumn && <div>内訳変数: <ColumnQuestionText nameOrId={subColumn} /></div>}
            </div>
            <EChart testId="barchart-svg" width="100%" height={chartHeight}
              ariaLabel={`${selectedColumn} の度数分布`} option={chartOption}
              onEvents={{
                click: params => {
                  const item = params.componentType === 'yAxis' ? barData.find(item => item.category === String(params.value)) : barData[params.dataIndex]
                  if (item) dispatch(selectionApplied({ rowIds: item.rowIds, operation: brushOp, label: 'BarChart' }))
                },
                mouseover: params => {
                  const item = params.componentType === 'yAxis' ? barData.find(item => item.category === String(params.value)) : barData[params.dataIndex]
                  if (item) setHoveredBar(item.category)
                },
                mouseout: () => setHoveredBar(null),
                globalout: () => setHoveredBar(null),
              }} />
            {hoveredBar && (
              <div role="status" style={{ position: 'absolute', top: 16, right: 16, zIndex: 2, maxWidth: 360, maxHeight: 'calc(100% - 32px)', overflowY: 'auto', padding: 8, background: '#1e293b', color: '#fff', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {formatValueLabel(selectedColumn, hoveredBar.category)} ({hoveredBar.category}): 合計 {hoveredBar.totalCount}行 | 選択 {hoveredBar.selectedCount}行 ({((hoveredBar.selectedCount / (hoveredBar.totalCount || 1)) * 100).toFixed(1)}%) — クリックで選択
                {hoveredBar.subGroups && Object.entries(hoveredBar.subGroups).map(([code, group]) => <div key={code}>{formatValueLabel(subColumn, code)} ({code}): {group.total}行 / 選択 {group.selected}行</div>)}
              </div>
            )}

            {barData.length === 0 && (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#9ca3af' }}>
                集計可能なデータがありません。
              </div>
            )}
          </div>
        </Dropdown>
      </GraphPanel>

      {/* Guide Note */}
        <div style={{ color: '#6b7280', fontSize: 12, padding: '0 4px', flexShrink: 0 }}>
          ※ 任意のカテゴリ変数・離散変数の度数分布と選択行の割合を対話的に可視化します。バーをクリックするとそのカテゴリに属する行を選択（集合演算メニューと連動）し、PCPや全ビューへ即座に伝播します。
        </div>
    </div>
  )
}
