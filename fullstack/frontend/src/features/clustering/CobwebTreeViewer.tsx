import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import React, { useState } from 'react'
import { Button, Space, Tag, Typography } from 'antd'
import { DownOutlined, RightOutlined } from '@ant-design/icons'

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

function TreeNodeItem({
  node,
  rowIds,
  onSelectRows,
  depth = 0,
}: {
  node: CobwebTreeNode
  rowIds: string[]
  onSelectRows: (ids: string[]) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = node.children && node.children.length > 0

  const handleSelect = (e: React.MouseEvent) => {
    e.stopPropagation()
    const targetIds = node.rowIndices.map((i) => rowIds[i]).filter(Boolean)
    onSelectRows(targetIds)
  }

  return (
    <div style={{ marginLeft: depth * 20, marginBottom: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          background: depth === 0 ? '#f8fafc' : '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: 6,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        {hasChildren ? (
          <span style={{ fontSize: 11, color: '#64748b' }}>
            {expanded ? <DownOutlined /> : <RightOutlined />}
          </span>
        ) : (
          <span style={{ display: 'inline-block', width: 12 }} />
        )}

        <Typography.Text strong style={{ fontSize: 13, color: '#1e293b' }}>
          {node.name}
        </Typography.Text>

        <Tag color="blue" style={{ borderRadius: 4, margin: 0 }}>
          {node.count} 行
        </Tag>

        {/* Attribute summary chips */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, marginLeft: 8 }}>
          {Object.entries(node.stats).slice(0, 3).map(([k, v]) => (
            <Tag key={k} style={{ fontSize: 11, background: '#f1f5f9', border: '1px solid #e2e8f0', color: '#475569', margin: 0 }}>
              <ColumnQuestionTooltip nameOrId={k}>{k}</ColumnQuestionTooltip>: {typeof v === 'object' && v !== null ? (v.mean !== undefined ? `μ=${v.mean}` : JSON.stringify(v).slice(0, 15)) : String(v)}
            </Tag>
          ))}
        </div>

        <Button
          size="small"
          type="link"
          data-testid={`select-cobweb-node-${node.id}`}
          onClick={handleSelect}
          style={{ fontSize: 12, padding: '0 6px' }}
        >
          この概念を選択 ({node.count})
        </Button>
      </div>

      {hasChildren && expanded && (
        <div style={{ marginTop: 4 }}>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.id}
              node={child}
              rowIds={rowIds}
              onSelectRows={onSelectRows}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function CobwebTreeViewer({
  conceptTree,
  rowIds,
  onSelectRows,
}: CobwebTreeViewerProps) {

  return (
    <div
      data-testid="cobweb-tree-panel"
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 6,
        background: '#ffffff',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        flexShrink: 0,
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Space wrap align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            Cobweb 概念階層木 (Concept Formation Hierarchy)
          </Typography.Title>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          ノードクリック=展開/折りたたみ · 「この概念を選択」=集合演算で全ビューへ伝播
        </Typography.Text>
      </div>

      <div style={{ paddingRight: 4 }}>
        <TreeNodeItem node={conceptTree} rowIds={rowIds} onSelectRows={onSelectRows} depth={0} />
      </div>
    </div>
  )
}
