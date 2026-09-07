import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Alert, Button, Card, Col, Descriptions, InputNumber, Row, Segmented, Select, Space, Spin, Statistic, Table, Tag, Typography, message,
} from 'antd'
import { AimOutlined, BranchesOutlined, CheckCircleOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionApplied, modelResultStored } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { api } from '../../api/client'
import { getBrushOp } from '../selection/SelectionMenu'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'

interface LeafMembership {
  nodeId: number
  treeIndex: number
  rowIds: string[]
}

interface TreeNode {
  nodeId: number
  isLeaf: boolean
  count: number
  values?: { label: string; count: number; ratio: number }[]
  feature?: string
  threshold?: number
  majority?: string | null
  children?: TreeNode[]
}

interface ModelResponse {
  resultId: string
  modelType: string
  taskType: string
  evidenceClass: string
  features: string[]
  target: string
  trainedRows: number
  featureImportance: Record<string, number>
  leafMembership?: LeafMembership[]
  treeStructures?: TreeNode[]
  representativeTree?: { index: number; forestAgreement: number | null; treeAgreements: number[] | null }
  classLabels?: string[] | null
  nodeCount?: number
  leafCount?: number
  diagnostics: Record<string, unknown>
}

interface LeafRow { key: string; leafId: string; count: number; rowIds: string[] }

export default function ModelsPage() {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const { focused, isTargetActive } = useFocusMode()
  const data = useColumnarData(selection.datasetId)
  const [modelType, setModelType] = useState<'decision_tree' | 'random_forest'>('decision_tree')
  const [target, setTarget] = useState<string | null>(null)
  const [maxDepth, setMaxDepth] = useState(4)
  const [nEstimators, setNEstimators] = useState(100)
  const storedModel = useSelector((s: RootState) => s.selection.modelResult) as ModelResponse | null
  const [result, setResult] = useState<ModelResponse | null>(storedModel)
  // Follow store resets (dataset switch clears modelResult — audit R4-1).
  useEffect(() => {
    if (storedModel === null && result !== null) setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedModel])
  const [error, setError] = useState<{ message: string } | null>(null)
  const [running, setRunning] = useState(false)

  const numericColumns = data?.schema.filter((c) => c.semanticType === 'numeric').map((c) => c.name) ?? []
  const allColumns = data?.schema.map((c) => c.name) ?? []
  const targetValue = target ?? allColumns.find((c) => !numericColumns.includes(c)) ?? allColumns[numericColumns.length - 1] ?? null

  const runModel = async () => {
    if (!selection.datasetId || !targetValue) return
    setRunning(true)
    setError(null)
    try {
      const response = await api.post<ModelResponse & { leafMembership: LeafMembership[] }>('/models', {
        datasetId: selection.datasetId,
        modelType,
        taskType: 'auto',
        features: numericColumns.filter((c) => c !== targetValue),
        target: targetValue,
        maxDepth,
        nEstimators,
        seed: 42,
      })
      setResult(response)
      dispatch(modelResultStored(response))
      message.success(`${modelType === 'decision_tree' ? '決定木' : 'ランダムフォレスト'}学習完了`)
    } catch (err) {
      setError(err as { message: string })
    } finally {
      setRunning(false)
    }
  }

  const leaves: LeafRow[] = useMemo(() => {
    if (!result?.leafMembership) return []
    return result.leafMembership.map((leaf) => ({
      key: `${leaf.treeIndex}-${leaf.nodeId}`,
      leafId: `T${leaf.treeIndex}-L${leaf.nodeId}`,
      count: leaf.rowIds.length,
      rowIds: leaf.rowIds,
    }))
  }, [result])

  const selectLeaf = (rowIds: string[]) =>
    dispatch(selectionApplied({ rowIds, operation: getBrushOp(), label: 'tree leaf選択' }))

  const topFeature = useMemo(() => {
    if (!result?.featureImportance) return null
    const entries = Object.entries(result.featureImportance)
    if (entries.length === 0) return null
    entries.sort((a, b) => b[1] - a[1])
    return { name: entries[0][0], value: entries[0][1] }
  }, [result])

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="models-page" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: '100%', height: focused ? '100%' : undefined, flex: focused ? 1 : 'none', minHeight: focused ? 0 : undefined }}>
      {!focused && (
        <Card size="small" style={{ background: '#fafafa' }}>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>機械学習モデル設定:</Typography.Text>
              <Button
                data-testid="run-model"
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={running}
                onClick={() => void runModel()}
              >
                モデル学習
              </Button>
            </div>
            <Segmented
              data-testid="model-type"
              options={[{ label: '決定木 (Decision Tree)', value: 'decision_tree' }, { label: 'ランダムフォレスト (Random Forest)', value: 'random_forest' }]}
              value={modelType}
              onChange={(v) => setModelType(v as typeof modelType)}
            />
            <Row gutter={[16, 8]} align="middle">
              <Col>
                <Space size={6}>
                  <Typography.Text style={{ fontSize: 12 }}>目的変数:</Typography.Text>
                  <Select data-testid="target-column" size="small" style={{ minWidth: 160 }} value={targetValue} onChange={setTarget}
                    options={allColumns.map((c) => ({ value: c, label: c }))} />
                </Space>
              </Col>
              <Col>
                <Space size={6}>
                  <Typography.Text style={{ fontSize: 12 }}>木の最大深さ:</Typography.Text>
                  <InputNumber data-testid="max-depth" size="small" min={1} max={20} value={maxDepth} onChange={(v) => setMaxDepth(Number(v) ?? 4)} />
                </Space>
              </Col>
              {modelType === 'random_forest' && (
                <Col>
                  <Space size={6}>
                    <Typography.Text style={{ fontSize: 12 }}>決定木の本数:</Typography.Text>
                    <InputNumber data-testid="n-estimators" size="small" min={10} max={500} step={10} value={nEstimators} onChange={(v) => setNEstimators(Number(v) ?? 100)} />
                  </Space>
                </Col>
              )}
              <Col>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  説明変数: 数値列 {numericColumns.filter((c) => c !== targetValue).length}本
                </Typography.Text>
              </Col>
            </Row>
            {error && <Alert type="error" showIcon message={error.message} style={{ marginTop: 6 }} />}
          </Space>
        </Card>
      )}

      {/* Summary KPI Cards */}
      {!focused && result && (
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="目的変数 & タスク"
                value={`${result.target}`}
                prefix={<AimOutlined />}
                suffix={<Tag color="blue" style={{ marginLeft: 6 }}>{result.taskType}</Tag>}
                valueStyle={{ fontSize: 15 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="学習サンプル数"
                value={result.trainedRows}
                prefix={<CheckCircleOutlined />}
                suffix="行"
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>最重要特徴量</div>
              {topFeature ? (
                <Space align="baseline">
                  <span style={{ fontSize: 16, fontWeight: 600, color: '#1677ff' }}>
                    {topFeature.name}
                  </span>
                  <Tag color="purple">{(topFeature.value * 100).toFixed(1)}%</Tag>
                </Space>
              ) : (
                <span style={{ fontSize: 16, color: '#8c8c8c' }}>—</span>
              )}
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="モデル構造"
                value={result.modelType === 'decision_tree' ? `葉数: ${result.leafCount ?? '—'}` : `決定木: ${nEstimators}本`}
                prefix={<BranchesOutlined />}
                valueStyle={{ fontSize: 14 }}
              />
            </Card>
          </Col>
        </Row>
      )}

      {/* Loading Indicator */}
      {running && (
        <Card size="small" style={{ textAlign: 'center', padding: '40px 20px', background: '#fafafa', borderRadius: 8 }}>
          <Spin size="large" tip={`機械学習モデル (${modelType === 'decision_tree' ? '決定木' : 'ランダムフォレスト'}) を学習中...`} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12, marginBottom: 0 }}>
            最適分岐探索およびリーフ所属確率の集計を行っています
          </Typography.Paragraph>
        </Card>
      )}
      {result && (
        <Space direction="vertical" size="small" style={{ width: '100%', height: focused ? '100%' : undefined, flex: focused ? 1 : 'none', minHeight: focused ? 0 : undefined }}>
          {!focused && (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14 }}>
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <Typography.Title level={5} style={{ margin: 0 }}>モデル学習結果</Typography.Title>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>リーフクリック=集合演算で反映</Typography.Text>
                </div>
                <Descriptions size="small" bordered column={2}>
                  <Descriptions.Item label="task">{result.taskType}</Descriptions.Item>
                  <Descriptions.Item label="evidence">{result.evidenceClass}</Descriptions.Item>
                  <Descriptions.Item label="学習行数">{result.trainedRows}</Descriptions.Item>
                  <Descriptions.Item label="diagnostics"><code style={{ fontSize: 11, wordBreak: 'break-all' }}>{JSON.stringify(result.diagnostics).slice(0, 160)}</code></Descriptions.Item>
                </Descriptions>
              </Space>
            </div>
          )}
          {(!focused || isTargetActive('feature-importance')) && (
            <FocusTarget id="feature-importance" title="特徴量重要度">
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14, height: isTargetActive('feature-importance') ? '100%' : undefined, flex: isTargetActive('feature-importance') ? 1 : 'none', minHeight: isTargetActive('feature-importance') ? 0 : undefined }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Typography.Title level={5} style={{ margin: 0 }}>特徴量重要度 (Feature Importance)</Typography.Title>
                  <FocusEnterButton targetId="feature-importance" title="特徴量重要度" />
                </div>
                <div
                  data-testid="feature-importance-panel"
                  style={{ display: 'flex', flexDirection: 'column', gap: isTargetActive('feature-importance') ? 16 : 8, maxWidth: isTargetActive('feature-importance') ? 800 : undefined, margin: isTargetActive('feature-importance') ? '20px auto 0' : undefined }}
                >
                  {Object.entries(result.featureImportance).sort((a, b) => b[1] - a[1]).map(([feature, importance]) => (
                    <div key={feature} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ width: isTargetActive('feature-importance') ? 180 : 140, fontSize: isTargetActive('feature-importance') ? 14 : 12, fontWeight: 500 }}>{feature}</span>
                      <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: isTargetActive('feature-importance') ? 20 : 12 }}>
                        <div style={{ width: `${importance * 100}%`, background: '#3b82f6', height: '100%', borderRadius: 4 }} />
                      </div>
                      <span style={{ fontSize: isTargetActive('feature-importance') ? 13 : 11, width: 60, textAlign: 'right', fontWeight: 600 }}>{importance.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </FocusTarget>
          )}
          {(!focused || isTargetActive('tree')) && result.treeStructures?.[0] && (
            <FocusTarget id="tree" title="決定木ダイアグラム">
            <div style={{ maxWidth: '100%', height: focused ? '100%' : undefined, flex: focused ? 1 : 'none', minHeight: focused ? 0 : undefined, overflow: focused ? 'visible' : 'auto', border: focused ? 'none' : '1px solid #e5e7eb', borderRadius: focused ? 0 : 6, background: '#fff', padding: focused ? 8 : 14, userSelect: 'none' }}>
            <TreeDiagram
              root={result.treeStructures[0]}
              treeIndex={0}
              leafMembership={result.leafMembership ?? []}
              selectedRowIds={selection.selectedRowIds}
              onLeafSelect={selectLeaf}
              headerNote={
                result.modelType === 'random_forest' && result.representativeTree
                  ? ` — 森の予測との一致率 ${(result.representativeTree.forestAgreement! * 100).toFixed(1)}%（木${result.representativeTree.index}／${result.representativeTree.treeAgreements?.length}本中、最も高い）`
                  : undefined
              }
            />
            </div>
            </FocusTarget>
          )}

          {!focused && leaves.length > 0 && (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14 }}>
              <Typography.Title level={5} style={{ margin: '0 0 10px' }}>リーフ選択（選択で全ビューへrow集合を投影）</Typography.Title>
              <Table<LeafRow>
                data-testid="leaf-table"
                size="small"
                pagination={false}
                dataSource={leaves}
                columns={[
                  { title: 'leaf', dataIndex: 'leafId', key: 'leafId', width: 100 },
                  { title: '行数', dataIndex: 'count', key: 'count', width: 80 },
                  {
                    title: '操作',
                    key: 'action',
                    render: (_: unknown, row) => (
                      <Button size="small" data-testid={`leaf-select-${row.leafId}`} onClick={() => selectLeaf(row.rowIds)}>選択</Button>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </Space>
      )}
    </div>
  )
}

/** Decision-tree diagram: split nodes show the rule + sample count,
 *  leaves are clickable and select their row cohort across all views.
 *  Leaf color = majority class (validated categorical palette). */
function TreeDiagram({ root, treeIndex, leafMembership, selectedRowIds, onLeafSelect, headerNote }: {
  root: TreeNode
  treeIndex: number
  leafMembership: LeafMembership[]
  selectedRowIds: string[]
  onLeafSelect: (rowIds: string[]) => void
  headerNote?: string
}) {
  const CLASS_COLORS = ['#eb6834', '#1baf7a', '#4a3aa7', '#eda100', '#e87ba4']
  const MIN_LEAF_W = 96
  const MAX_TREE_HEIGHT = 520
  const positions = new Map<number, { x: number; y: number; node: TreeNode }>()
  let leafCursor = 0

  const measure = (node: TreeNode, depth: number): number => {
    if (node.isLeaf || !node.children) {
      const x = leafCursor++
      positions.set(node.nodeId, { x, y: depth, node })
      return x
    }
    const childXs = node.children.map((child) => measure(child, depth + 1))
    const x = (childXs[0] + childXs[childXs.length - 1]) / 2
    positions.set(node.nodeId, { x, y: depth, node })
    return x
  }
  measure(root, 0)

  const colW = MIN_LEAF_W + 8
  const maxDepth = Math.max(...[...positions.values()].map((p) => p.y))
  const rowH = Math.max(56, Math.min(92, Math.floor(MAX_TREE_HEIGHT / (maxDepth + 1))))
  const width = Math.max(1, leafCursor) * colW + 40
  const height = (maxDepth + 1) * rowH + 30
  // The active leaf is the one whose membership equals the current selection.
  const selectedSet = new Set(selectedRowIds)
  let activeLeafNodeId: number | null = null
  if (selectedRowIds.length) {
    const match = leafMembership.find((l) =>
      l.treeIndex === treeIndex
      && l.rowIds.length === selectedSet.size
      && l.rowIds.every((id) => selectedSet.has(id)))
    if (match) activeLeafNodeId = match.nodeId
  }

  const px = (x: number) => 20 + x * colW + colW / 2
  const py = (y: number) => 26 + y * rowH

  const classColorOf = (label: string | null): string => {
    if (!label) return '#898781'
    const labels = [...new Set(collectLabels(root))].sort()
    const idx = labels.indexOf(label)
    return CLASS_COLORS[(idx + 1) % CLASS_COLORS.length]
  }

  const selectByNode = (nodeId: number) => {
    const membership = leafMembership.find((l) => l.treeIndex === treeIndex && l.nodeId === nodeId)
    if (membership) onLeafSelect(membership.rowIds)
  }

  return (
    <div data-testid={`tree-diagram-${treeIndex}`} style={{ minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Space wrap style={{ padding: '8px 12px 0' }} align="center">
        <Typography.Title level={5} style={{ margin: 0 }}>
          決定木構造（葉をクリックでその行集合を選択・全ビューへ伝播）{headerNote}
        </Typography.Title>
        <FocusEnterButton targetId="tree" title="決定木ダイアグラム" />
      </Space>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', minWidth: Math.min(width, 700), maxWidth: 'none', height: 'auto', margin: '0 auto' }}>
        {[...positions.values()].map(({ x, y, node }) => {
          if (!node.children) return null
          return node.children!.map((child) => {
            const childPos = positions.get(child.nodeId)!
            const rule = child === node.children![0] ? 'yes' : 'no'
            return (
              <g key={`${node.nodeId}-${child.nodeId}`}>
                <line x1={px(x)} y1={py(y) + 16} x2={px(childPos.x)} y2={py(childPos.y) - 14}
                  stroke="#c3c2b7" strokeWidth={1.2} />
                <text x={(px(x) + px(childPos.x)) / 2} y={(py(y) + py(childPos.y)) / 2}
                  textAnchor="middle" fontSize={10} fill="#898781">{rule}</text>
              </g>
            )
          })
        })}
        {[...positions.values()].map(({ x, y, node }) => {
          const cx = px(x)
          const cy = py(y)
          if (node.isLeaf) {
            const color = classColorOf(node.majority ?? null)
            const topClass = node.values?.[0]
            const isActive = node.nodeId === activeLeafNodeId
            return (
              <g key={node.nodeId} style={{ cursor: 'pointer' }}
                onClick={() => selectByNode(node.nodeId)}
                data-testid={`tree-leaf-${treeIndex}-${node.nodeId}`}
              >
                <title>クリックでこのリーフの行を選択{isActive ? '（選択中）' : ''}</title>
                {isActive && (
                  <rect x={cx - 43} y={cy - 19} width={86} height={38} rx={8}
                        fill="none" stroke="#2a78d6" strokeWidth={2.5} strokeDasharray="5 3" />
                )}
                <rect x={cx - 38} y={cy - 15} width={76} height={30} rx={6}
                  fill={color} opacity={isActive ? 0.45 : 0.18} stroke={color}
                  strokeWidth={isActive ? 2.2 : 1.4} />
                <text x={cx} y={cy - 3} textAnchor="middle" fontSize={10} fontWeight={700} fill="#0b0b0b">
                  {node.majority ?? 'leaf'}{isActive ? ' ✓' : ''}
                </text>
                <text x={cx} y={cy + 10} textAnchor="middle" fontSize={9} fill="#52514e">
                  n={node.count}{topClass ? ` · ${Math.round(topClass.ratio * 100)}%` : ''}
                </text>
              </g>
            )
          }
          return (
            <g key={node.nodeId}>
              <rect x={cx - 46} y={cy - 15} width={92} height={30} rx={4}
                fill="#f8fafc" stroke="#94a3b8" strokeWidth={1.2} />
              <text x={cx} y={cy - 3} textAnchor="middle" fontSize={10} fontWeight={600} fill="#0b0b0b">
                {node.feature?.replace(/_cm$/, '')} ≤ {node.threshold}
              </text>
              <text x={cx} y={cy + 9} textAnchor="middle" fontSize={9} fill="#52514e">n={node.count}</text>
            </g>
          )
        })}
      </svg>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 4, padding: '0 12px 8px' }}>
        {[...new Set(collectLabels(root))].sort().map((label) => (
          <span key={label} style={{ fontSize: 11 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: classColorOf(label), borderRadius: 2, marginRight: 4 }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

function collectLabels(node: TreeNode, acc: string[] = []): string[] {
  for (const v of node.values ?? []) acc.push(v.label)
  node.children?.forEach((child) => collectLabels(child, acc))
  return acc
}
