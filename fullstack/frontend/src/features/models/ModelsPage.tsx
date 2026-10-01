import { useScopedRun, AnalysisScopeSummary } from '../selection/analysisScope'
import { useQuestionText } from '../common/ColumnQuestionTooltip'
import EChart from '../charts/EChart'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Alert, Button, Card, Col, Descriptions, InputNumber, Row, Segmented, Space, Spin, Statistic, Tag, Typography, message,
} from 'antd'
import { AimOutlined, BranchesOutlined, CheckCircleOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionApplied, modelResultStored, selectEffectiveRowIds, selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import MaAxisPicker from '../pcp/MaAxisPicker'
import { api } from '../../api/client'
import { useCodebook } from '../dataset/useCodebookColumn'
import { getBrushOp } from '../selection/SelectionMenu'
import GraphPanel from '../common/GraphPanel'
import { truncateText } from '../../utils/textUtils'

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

/** Intrinsic dimensions preserve readable leaf spacing instead of squashing graph symbols. */
export function treeDiagramDimensions(root: TreeNode): { width: number; height: number } {
  let leaves = 0, maxDepth = 0
  const visit = (node: TreeNode, depth: number) => {
    maxDepth = Math.max(maxDepth, depth)
    if (node.isLeaf || !node.children?.length) leaves++
    else node.children.forEach(child => visit(child, depth + 1))
  }
  visit(root, 0)
  const rowHeight = Math.max(56, Math.min(92, Math.floor(520 / (maxDepth + 1))))
  return { width: Math.max(760, leaves * 104 + 40), height: (maxDepth + 1) * rowHeight + 30 }
}

interface ModelResponse {
  scopeCount: number
  ordinaryMissingExcluded: number
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
  representativeTree?: { index: number; forestAgreement: number | null; treeAgreements: number[] | null; forestMae: number | null; treeMaes: number[] | null }
  classLabels?: string[] | null
  nodeCount?: number
  leafCount?: number
  diagnostics: Record<string, unknown>
}

interface LeafRow { key: string; leafId: string; count: number; rowIds: string[] }

export default function ModelsPage() {
  const questionText = useQuestionText()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const rowIds = useSelector(selectEffectiveRowIds)
  const globalVariables = useSelector(selectOrdinaryVariables)
  const entities = useSelector(selectVariableEntities)
  const { columns: codebookColumns, schemaRevision } = useCodebook()
  const [modelType, setModelType] = useState<'decision_tree' | 'random_forest'>('decision_tree')
  const [target, setTarget] = useState<string | null>(null)
  const [chosen, setChosen] = useState<{ datasetId: string; names: string[]; children: string[] } | null>(null)
  const current = chosen?.datasetId === selection.datasetId ? chosen : null
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key)
    && ['question', 'attribute'].includes(item.role)).map(item => ({ groupId: item.name, label: item.label }))
  const candidates = codebookColumns.filter(c => ['question', 'attribute'].includes(c.role)
    && (c.multiResponseGroup ? current?.children.includes(c.name) && groups.some(g => g.groupId === c.multiResponseGroup)
      : ['nominal', 'ordinal', 'interval', 'ratio'].includes(c.scaleType) && globalVariables.activeVariableIds.includes(c.name)))
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
  const allColumns = candidates.map(c => c.name)
  const targetValue = target && allColumns.includes(target) ? target : candidates.find(c => c.role === 'question' && !c.multiResponseGroup)?.name ?? null
  const targetGroup = candidates.find(c => c.name === targetValue)?.multiResponseGroup
  const featureCandidates = candidates.filter(c => c.name !== targetValue && (!targetGroup || c.multiResponseGroup !== targetGroup))
  const numericColumns = (current?.names ?? []).filter(name => featureCandidates.some(c => c.name === name))
  const inputContext = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, rowIds, numericColumns,
    targetValue, modelType, maxDepth, nEstimators])
  const runScope = useScopedRun(inputContext)
  useEffect(() => {
    setResult(null); setRunning(false); setError(null); dispatch(modelResultStored(null))
  }, [runScope.identity, dispatch])

  const runModel = async () => {
    if (!selection.datasetId || !targetValue || !numericColumns.length) return
    const ticket = runScope.begin()
    const isCurrent = ticket.isCurrent
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
        rowIds: ticket.scope.rowIds,
        expectedSchemaRevision: schemaRevision,
        expectedDataRevision: selection.dataRevision,
      })
      if (!isCurrent()) return
      ticket.commit()
      setResult(response)
      dispatch(modelResultStored(response))
      message.success(`${modelType === 'decision_tree' ? '決定木' : 'ランダムフォレスト'}学習完了`)
    } catch (err) {
      if (isCurrent()) setError(err as { message: string })
    } finally {
      if (isCurrent()) setRunning(false)
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
    <div data-testid="models-page" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: '100%' }}>
      <AnalysisScopeSummary snapshot={runScope.snapshot} />
      {runScope.dirty && <Typography.Text type="warning">現在の入力と異なる実行済み結果です。再実行すると更新されます。</Typography.Text>}

      {(
        <Card size="small" style={{ background: '#fafafa' }}>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>機械学習モデル設定:</Typography.Text>
              <Button
                data-testid="run-model"
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={running}
                disabled={!targetValue || !numericColumns.length}
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
                  説明変数: {numericColumns.length}項目
                </Typography.Text>
              </Col>
            </Row>
            <Space wrap>
              <Typography.Text>説明変数:</Typography.Text>
              <Select mode="multiple" aria-label="モデルの説明変数" style={{ minWidth: 300 }} maxTagCount={4} value={numericColumns}
                options={featureCandidates.map(c => ({ value: c.name, label: c.multiResponseOptionLabel || c.label || c.name }))}
                onChange={(names: string[]) => setChosen({ datasetId: selection.datasetId!, names, children: current?.children ?? [] })} />
              <MaAxisPicker allowCount={false} groups={groups} columns={codebookColumns} onAdd={axes => {
                const added = axes.map(axis => codebookColumns.find(c => c.columnId === axis.columnId)?.name).filter((name): name is string => Boolean(name))
                setChosen({ datasetId: selection.datasetId!, names: [...new Set([...numericColumns, ...added])], children: [...new Set([...(current?.children ?? []), ...added])] })
              }} />
              <Typography.Text type="secondary">MAの重要度は子別です。</Typography.Text>
            </Space>
            {error && <Alert type="error" showIcon message={error.message} style={{ marginTop: 6 }} />}
          </Space>
        </Card>
      )}

      {/* Summary KPI Cards */}
      {result && <Typography.Text type="secondary">
        分析対象 {result.trainedRows} / {result.scopeCount} 行
        （除外 {result.scopeCount - result.trainedRows} 行、うち通常変数の欠損 {result.ordinaryMissingExcluded} 行）
      </Typography.Text>}
      {result && (
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="目的変数 & タスク"
                value={`${result.target}`}
                formatter={() => <ColumnQuestionTooltip nameOrId={result.target}>{result.target}</ColumnQuestionTooltip>}
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
                    <ColumnQuestionTooltip nameOrId={topFeature.name}>{topFeature.name}</ColumnQuestionTooltip>
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
                value={result.modelType === 'decision_tree' ? `葉数: ${result.leafCount ?? '—'}` : `決定木: ${result.diagnostics.nEstimators ?? result.treeStructures?.length ?? '—'}本`}
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
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {(
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
          {result.featureImportance && (
            <GraphPanel graphId="models/importance" title="特徴量重要度" available sizing="intrinsic" intrinsicSize={{ width: 640, height: Math.max(200, 60 + Object.keys(result.featureImportance).length * 36) }}>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Typography.Title level={5} style={{ margin: 0 }}>特徴量重要度 (Feature Importance)</Typography.Title>
                </div>
                <div
                  data-testid="feature-importance-panel"
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EChart height={Math.max(220, Object.keys(result.featureImportance).length * 32 + 70)} ariaLabel="特徴量重要度"
                    option={{ grid: { left: 150, right: 70, top: 20, bottom: 35 }, tooltip: { trigger: 'axis', renderMode: 'richText', formatter: (params: any) => { const p = params[0]; return p ? `${questionText(p.name)}\n重要度: ${p.value}` : '' } },
                      xAxis: { type: 'value', min: 0, max: 1 }, yAxis: { type: 'category', inverse: true, axisLabel: { width: 140 },
                        data: Object.entries(result.featureImportance).sort((a,b) => b[1]-a[1]).map(([name]) => name) },
                      series: [{ type: 'bar', itemStyle: { color: '#3b82f6' },
                        data: Object.entries(result.featureImportance).sort((a,b) => b[1]-a[1]).map(([,value]) => value),
                        label: { show: true, position: 'right', color: '#333', formatter: (p: any) => Number(p.value).toFixed(4) } }] }} />
                </div>
              </div>
            </GraphPanel>
          )}
          {result.treeStructures?.[0] && (
            <GraphPanel graphId="models/tree" title="決定木ダイアグラム" available sizing="intrinsic" intrinsicSize={{ width: treeDiagramDimensions(result.treeStructures[0]).width + 28, height: treeDiagramDimensions(result.treeStructures[0]).height + 150 }}>
            <div style={{ maxWidth: '100%', overflow: 'visible', padding: 14, userSelect: 'none' }}>
            <TreeDiagram
              root={result.treeStructures[0]}
              treeIndex={0}
              leafMembership={result.leafMembership ?? []}
              selectedRowIds={selection.selectedRowIds}
              onLeafSelect={selectLeaf}
              headerNote={
                result.modelType === 'random_forest' && result.representativeTree
                  ? result.taskType === 'regression'
                    ? ` — 森の予測との平均絶対差 ${result.representativeTree.forestMae?.toFixed(4)}（木${result.representativeTree.index}／${result.representativeTree.treeMaes?.length}本中、最小。学習行で比較）`
                    : ` — 森の予測との一致率 ${(result.representativeTree.forestAgreement! * 100).toFixed(1)}%（木${result.representativeTree.index}／${result.representativeTree.treeAgreements?.length}本中、最も高い）`
                  : undefined
              }
            />
            </div>
            </GraphPanel>
          )}

          {leaves.length > 0 && (
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
export function TreeDiagram({ root, treeIndex, leafMembership, selectedRowIds, onLeafSelect, headerNote }: {
  root: TreeNode
  treeIndex: number
  leafMembership: LeafMembership[]
  selectedRowIds: string[]
  onLeafSelect: (rowIds: string[]) => void
  headerNote?: string
}) {
  const questionText = useQuestionText()
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
  const { width, height } = treeDiagramDimensions(root)
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
      </Space>
      <div style={{ flex: 1, overflow: 'visible', minHeight: 0 }}>
        <EChart width={width} height={height} ariaLabel="決定木構造"
          option={{ grid: { left: 0, right: 0, top: 0, bottom: 0, outerBoundsMode: 'none' },
            xAxis: { type: 'value', min: 0, max: width, show: false },
            yAxis: { type: 'value', min: 0, max: height, inverse: true, show: false },
            tooltip: { renderMode: 'richText', formatter: (p: any) => p.data?.description ?? p.name },
            series: [{ type: 'graph', coordinateSystem: 'cartesian2d', layout: 'none', roam: false, edgeSymbol: ['none', 'none'],
              data: [...positions.values()].map(({x, y, node}) => ({ id: String(node.nodeId), value: [px(x), py(y)],
                nodeId: node.nodeId, isLeaf: node.isLeaf, symbol: 'roundRect', symbolSize: node.isLeaf ? [84, 38] : [100, 38],
                name: node.isLeaf ? `${truncateText(node.majority ?? 'leaf', 12)}${node.nodeId === activeLeafNodeId ? ' ✓' : ''}\nn=${node.count}${node.values?.[0] ? ` · ${Math.round(node.values[0].ratio * 100)}%` : ''}`
                  : `${truncateText(`${node.feature ?? ''} ≤ ${node.threshold}`, 14)}\nn=${node.count}`,
                description: node.isLeaf ? `${node.majority ?? 'leaf'}\n葉${node.nodeId} 学習時n=${node.count}\nクリックで所属行を選択`
                  : `${questionText(node.feature ?? '')} ≤ ${node.threshold}\n学習時n=${node.count}`,
                itemStyle: { color: node.isLeaf ? classColorOf(node.majority ?? null) : '#f8fafc',
                  borderColor: node.nodeId === activeLeafNodeId ? '#2a78d6' : '#94a3b8', borderWidth: node.nodeId === activeLeafNodeId ? 3 : 1 },
                label: { show: true, fontSize: 10, color: '#111' },
              })),
              links: [...positions.values()].flatMap(({node}) => (node.children ?? []).map((child, i) => ({
                source: String(node.nodeId), target: String(child.nodeId), name: i === 0 ? 'yes' : 'no' }))),
              edgeLabel: { show: true, formatter: (p: any) => p.data.name, fontSize: 10 },
              lineStyle: { color: '#b5b5ae', width: 1.3 }, emphasis: { focus: 'adjacency' },
            }] }} onEvents={{ click: p => { if (p.dataType === 'node' && p.data.isLeaf) selectByNode(p.data.nodeId) } }} />
        <details open style={{ padding: '4px 12px' }}><summary>葉をキーボードで選択</summary>
          {[...positions.values()].filter(p => p.node.isLeaf).map(({node}) => <button key={node.nodeId}
            data-testid={`tree-leaf-${treeIndex}-${node.nodeId}`} aria-pressed={node.nodeId === activeLeafNodeId} aria-label={`葉${node.nodeId}の${node.count}行を選択`}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectByNode(node.nodeId) } }}
            onClick={() => selectByNode(node.nodeId)}>葉{node.nodeId}: {node.majority ?? 'leaf'} (学習時n={node.count})</button>)}
        </details>
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
