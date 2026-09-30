import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Button, Space, Tag, Typography } from 'antd'
import type { RootState } from '../../app/store'
import GraphPanel from '../common/GraphPanel'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import SelectionMenu from '../selection/SelectionMenu'
import EChart from '../charts/EChart'
import { useRowColorResolver } from '../../theme/useRowColor'

export interface CobwebTreeNode {
  id: string
  name: string
  count: number
  rowIndices: number[]
  stats: Record<string, any>
  children: CobwebTreeNode[]
}

interface CobwebTreeViewerProps {
  conceptTree: CobwebTreeNode
  rowIds: string[]
  onSelectRows: (rowIds: string[]) => void
}

export default function CobwebTreeViewer({ conceptTree, rowIds, onSelectRows }: CobwebTreeViewerProps) {
  const dispatch = useDispatch()
  const { getColor, selectionColor } = useRowColorResolver()
  const selected = useSelector((state: RootState) => state.selection.selectedRowIds)
  const hovered = useSelector((state: RootState) => state.selection.hoveredRowId)
  const selectedSet = new Set(selected)
  const [inspectedId, setInspectedId] = useState(conceptTree.id)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([conceptTree.id, ...(conceptTree.children ?? []).map(node => node.id)]))
  const { nodes, width, height } = useMemo(() => {
    const items = new Map<string, CobwebTreeNode>()
    let leaves = 0
    let maxDepth = 0
    const visit = (node: CobwebTreeNode, depth: number) => {
      items.set(node.id, node)
      maxDepth = Math.max(maxDepth, depth)
      if (!node.children?.length) leaves++
      node.children?.forEach(child => visit(child, depth + 1))
    }
    visit(conceptTree, 0)
    // The full topology determines the drawing extent, including collapsed
    // descendants. Expanding a branch never clips or rescales another branch.
    return { nodes: items, width: Math.max(720, maxDepth * 200 + 260), height: Math.max(480, leaves * 34 + 70) }
  }, [conceptTree])
  useEffect(() => {
    setInspectedId(conceptTree.id)
    setExpanded(new Set([conceptTree.id, ...(conceptTree.children ?? []).map(node => node.id)]))
  }, [conceptTree])
  const inspected = nodes.get(inspectedId) ?? conceptTree
  const convert = (node: CobwebTreeNode): any => {
    const ids = node.rowIndices.map(index => rowIds[index]).filter(Boolean)
    const allSelected = ids.length > 0 && ids.every(id => selectedSet.has(id))
    const isHovered = Boolean(hovered && ids.includes(hovered))
    return { id: node.id, name: `${node.name} (${node.count})`, value: node.count,
      description: `${node.name}\n${node.count} 行\n${ids.length === 1 ? `${ids[0]}\n` : ''}${Object.entries(node.stats ?? {}).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n')}`,
      collapsed: !expanded.has(node.id), symbolSize: allSelected || isHovered ? 28 : 24,
      itemStyle: { color: ids.length ? getColor(ids[0]) : '#64748b', borderColor: allSelected || isHovered ? selectionColor : '#fff', borderWidth: allSelected || isHovered ? 3 : 1 },
      lineStyle: { color: allSelected ? selectionColor : '#94a3b8', width: allSelected ? 3 : 1 },
      children: node.children?.map(convert) ?? [] }
  }
  return <div data-testid="cobweb-tree-panel">
    <GraphPanel graphId="clusters/cobweb" title="Cobweb 概念木" available sizing="intrinsic" intrinsicSize={{ width, height }}
      style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, userSelect: 'none' }}
      controls={<Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Text strong>Cobweb 概念階層木 (Concept Formation Hierarchy)</Typography.Text>
          <SelectionMenu testId="clusters-cobweb-selection" />
          <Typography.Text type="secondary">ノードクリックで対象行を選択・枝を展開/折りたたみ</Typography.Text>
        </Space>
        <Space wrap>
          <Typography.Text strong>{inspected.name}</Typography.Text>
          <Tag>{inspected.count} 行</Tag>
          {Object.entries(inspected.stats ?? {}).slice(0, 3).map(([name, value]) => <Tag key={name}>
            <ColumnQuestionTooltip nameOrId={name}>{name}</ColumnQuestionTooltip>: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
          </Tag>)}
          <Button size="small" data-testid={`select-cobweb-node-${inspected.id}`}
            onClick={() => onSelectRows(inspected.rowIndices.map(index => rowIds[index]).filter(Boolean))}>この概念を選択 ({inspected.count})</Button>
        </Space>
      </Space>}>
      <EChart testId="cobweb-tree-chart" height={height} width={width} ariaLabel="Cobweb 概念階層木"
        option={{ tooltip: { trigger: 'item', renderMode: 'richText', formatter: (event: any) => event.data?.description ?? '' },
          series: [{ type: 'tree', data: [convert(conceptTree)], left: 80, right: 180, top: 35, bottom: 35,
            roam: true, expandAndCollapse: false, initialTreeDepth: -1,
            label: { position: 'right', fontSize: 12, color: '#333', width: 160, overflow: 'truncate' }, lineStyle: { curveness: 0.5 }, emphasis: { focus: 'descendant' } }] }}
        onEvents={{ click: event => {
          const node = nodes.get(event.data?.id)
          if (!node) return
          setInspectedId(node.id)
          setExpanded(previous => { const next = new Set(previous); next.has(node.id) ? next.delete(node.id) : next.add(node.id); return next })
          onSelectRows(node.rowIndices.map(index => rowIds[index]).filter(Boolean))
        }, mouseover: event => {
          const node = nodes.get(event.data?.id)
          const ids = node?.rowIndices.map(index => rowIds[index]).filter(Boolean) ?? []
          if (ids.length === 1) dispatch({ type: 'selection/hovered', payload: ids[0] })
        }, mouseout: () => dispatch({ type: 'selection/hovered', payload: null }) }} />
    </GraphPanel>
  </div>
}
