import { Select as AntSelect } from 'antd'
import ColumnQuestionTooltip, { ColumnQuestionText } from '../common/ColumnQuestionTooltip'
import { useCodebook } from '../dataset/useCodebookColumn'
import Select from '../common/ColumnSelect'
import React, { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown, Radio, Space, Tag, Typography } from 'antd'
import { BarChartOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { useBrushOp } from '../selection/SelectionMenu'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { truncateText } from '../../utils/textUtils'

interface BarItem {
  category: string
  totalCount: number
  selectedCount: number
  rowIds: string[]
  subGroups?: Record<string, { total: number; selected: number; rowIds: string[] }>
}

export default function BarChartPage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const activeRowIds = useSelector((s: RootState) => s.selection.activeRowIds)
  const selectedRowIds = useSelector((s: RootState) => s.selection.selectedRowIds)
  const data = useColumnarData(datasetId)
  const { formatValueLabel } = useCodebook()
  const [brushOp] = useBrushOp()

  const [selectedColumn, setSelectedColumn] = useState<string>('')
  const [subColumn, setSubColumn] = useState<string>('')
  const [displayMode, setDisplayMode] = useState<'count' | 'percent' | 'stacked'>('count')
  const [sortOrder, setSortOrder] = useState<'count-desc' | 'name-asc' | 'ratio-desc'>('count-desc')
  const [hoveredCategory, setHoveredBar] = useState<string | null>(null)

  const selectedSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds])

  // Get all columns (prefer categorical, but include all)
  const columns = useMemo(() => {
    if (!data) return []
    return data.schema
      .filter((c) => c.name !== '__rowId__')
      .map((c) => ({
        name: c.name,
        type: c.semanticType,
      }))
  }, [data])

  const categoricalColumns = useMemo(() => {
    return columns.filter((c) => c.type !== 'numeric')
  }, [columns])

  // Default selection
  React.useEffect(() => {
    if (columns.length > 0 && !columns.some(c => c.name === selectedColumn)) {
      const preferred = categoricalColumns[0]?.name || columns[0].name
      setSelectedColumn(preferred)
    }
  }, [columns, categoricalColumns, selectedColumn])
  React.useEffect(() => {
    if (subColumn === selectedColumn || !columns.some(c => c.name === subColumn)) setSubColumn('')
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

  // Layout parameters
  const MARGIN_LEFT = 250
  const MARGIN_RIGHT = 240
  const MARGIN_TOP = 40
  const BAR_HEIGHT = 34
  const BAR_GAP = 14
  const PLOT_WIDTH = 500
  const totalSvgHeight = Math.max(380, MARGIN_TOP + barData.length * (BAR_HEIGHT + BAR_GAP) + 60)
  const totalSvgWidth = MARGIN_LEFT + PLOT_WIDTH + MARGIN_RIGHT

  return (
    <div
      data-testid="barchart-page"
      style={{
        padding: focused ? 0 : 16,
        display: 'flex',
        flexDirection: 'column',
        gap: focused ? 0 : 12,
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : undefined,
        minHeight: 0,
      }}
    >
      {/* Controls Card */}
      {!focused && (
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
            <FocusEnterButton targetId="barchart-container" title="対話型棒グラフ" />
          </Space>
        </div>
      )}

      {/* Main Chart Card */}
      <FocusTarget id="barchart-container" title="対話型棒グラフ">
        <Dropdown menu={{ items: contextMenuItems, onClick: ({ key }) => onContextMenuClick(key) }} trigger={['contextMenu']} getPopupContainer={() => document.body}>
          <div
            style={{
              border: focused ? 'none' : '1px solid #e5e7eb',
              borderRadius: focused ? 0 : 6,
              background: '#ffffff',
              padding: focused ? 8 : 16,
              position: 'relative',
              overflow: focused ? 'visible' : 'auto',
              userSelect: 'none',
              height: focused ? '100%' : undefined,
              flex: focused ? 1 : undefined,
              minHeight: 0,
            }}
          >
            {/* Status bar */}
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tag color="blue"><ColumnQuestionTooltip nameOrId={selectedColumn}>{selectedColumn}</ColumnQuestionTooltip></Tag>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                カテゴリ数: {barData.length} | 有効行: {totalActive}行 | 選択行: {selectedRowIds.length}行 (
                {totalActive > 0 ? ((selectedRowIds.length / totalActive) * 100).toFixed(1) : 0}%)
              </span>
            </div>

            <div data-testid="barchart-questions" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5, marginBottom: 12 }}>
              {selectedColumn && <div>対象変数: <ColumnQuestionText nameOrId={selectedColumn} /></div>}
              {subColumn && <div>内訳変数: <ColumnQuestionText nameOrId={subColumn} /></div>}
            </div>
            <svg data-testid="barchart-svg" width={totalSvgWidth} height={totalSvgHeight} style={{ display: 'block' }}>
              {/* Background Grid Lines */}
              {[0, 0.25, 0.5, 0.75, 1.0].map((frac) => {
                const gx = MARGIN_LEFT + frac * PLOT_WIDTH
                const valLabel =
                  displayMode === 'count'
                    ? Math.round(frac * maxBarCount)
                    : `${(frac * 100).toFixed(0)}%`
                return (
                  <g key={frac}>
                    <line x1={gx} y1={MARGIN_TOP - 10} x2={gx} y2={totalSvgHeight - 40} stroke="#f3f4f6" strokeWidth={1} />
                    <text x={gx} y={MARGIN_TOP - 15} textAnchor="middle" style={{ fontSize: 10, fill: '#9ca3af' }}>
                      {valLabel}
                    </text>
                  </g>
                )
              })}

              {/* Bars */}
              {barData.map((item, idx) => {
                const y = MARGIN_TOP + idx * (BAR_HEIGHT + BAR_GAP)
                const frac = displayMode === 'count' ? item.totalCount / maxBarCount : item.totalCount / (totalActive || 1)
                const barWidth = Math.max(2, frac * PLOT_WIDTH)

                // Selected fraction within this bar
                const selFrac = item.totalCount > 0 ? item.selectedCount / item.totalCount : 0
                const selBarWidth = barWidth * selFrac

                return (
                  <g
                    key={item.category}
                    data-testid={`barchart-bar-${idx}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => dispatch(selectionApplied({ rowIds: item.rowIds, operation: brushOp, label: 'BarChart' }))}
                    onMouseEnter={() => setHoveredBar(item.category)}
                    onMouseLeave={() => setHoveredBar(null)}
                  >
                    {/* Category Label */}
                    <text
                      x={MARGIN_LEFT - 12}
                      y={y + BAR_HEIGHT / 2 + 4}
                      textAnchor="end"
                      style={{ fontSize: 12, fontWeight: 500, fill: '#374151' }}
                    >
                      <title>{formatValueLabel(selectedColumn, item.category)} ({item.category})</title>
                      {truncateText(formatValueLabel(selectedColumn, item.category), 18)}
                    </text>

                    {/* Base Bar (Unselected / Total) */}
                    <rect
                      x={MARGIN_LEFT}
                      y={y}
                      width={barWidth}
                      height={BAR_HEIGHT}
                      rx={4}
                      fill="#e2e8f0"
                      stroke="#cbd5e1"
                      strokeWidth={1}
                    />

                    {/* Selected Highlight Overlay Bar */}
                    {selBarWidth > 0 && (
                      <rect
                        x={MARGIN_LEFT}
                        y={y}
                        width={selBarWidth}
                        height={BAR_HEIGHT}
                        rx={selFrac === 1 ? 4 : 0}
                        fill="#2a78d6"
                        opacity={0.9}
                      />
                    )}

                    {/* Value Badge / Text */}
                    <text
                      x={MARGIN_LEFT + barWidth + 8}
                      y={y + BAR_HEIGHT / 2 + 4}
                      style={{ fontSize: 11, fill: item.selectedCount > 0 ? '#2a78d6' : '#64748b', fontWeight: 600 }}
                    >
                      {item.totalCount}件
                      {item.selectedCount > 0 && (
                        <tspan fill="#2a78d6"> ({item.selectedCount}件選択 / {(selFrac * 100).toFixed(0)}%)</tspan>
                      )}
                      {displayMode === 'percent' && (
                        <tspan fill="#94a3b8"> [{(frac * 100).toFixed(1)}%]</tspan>
                      )}
                    </text>
                  </g>
                )
              })}

              {/* Hover Tooltip Overlay */}
            </svg>
            {hoveredBar && (
              <div role="status" style={{ padding: 8, background: '#1e293b', color: '#fff', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
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
      </FocusTarget>

      {/* Guide Note */}
      {!focused && (
        <div style={{ color: '#6b7280', fontSize: 12, padding: '0 4px', flexShrink: 0 }}>
          ※ 任意のカテゴリ変数・離散変数の度数分布と選択行の割合を対話的に可視化します。バーをクリックするとそのカテゴリに属する行を選択（集合演算メニューと連動）し、PCPや全ビューへ即座に伝播します。
        </div>
      )}
    </div>
  )
}
