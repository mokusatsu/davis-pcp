import { useScopedRun, AnalysisScopeSummary } from '../selection/analysisScope'
import { useQuestionText } from '../common/ColumnQuestionTooltip'
import EChart from '../charts/EChart'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { AnalysisField, AnalysisRunRow, AnalysisSettings } from '../common/AnalysisSetup'
import { editorModalOpened } from '../dataset/codebookSlice'
import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Alert, Button, Card, Col, Descriptions, InputNumber, Radio, Row, Space, Spin, Statistic, Tag, Typography, message,
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
import { wrapChartLabel } from '../../utils/chartLabelLayout'

interface LeafMembership {
  nodeId: number
  treeIndex: number
  rowIds: string[]
}

interface TreeNode {
  nodeId: number
  isLeaf: boolean
  count: number
  values?: { label: string; count: number; ratio: number; classIndex: number }[]
  feature?: string
  threshold?: number
  majority?: string | null
  children?: TreeNode[]
}

interface ClassCategory { rawValue: string; code: string; label: string }
interface TreeClassMetadata {
  targetDtype: string
  classCategories: ClassCategory[][] | null
}

const CLASS_COLORS = ['#eb6834', '#1baf7a', '#4a3aa7', '#eda100', '#e87ba4']
const CLASS_LINE_HEIGHT = 18
const classColorOf = (classIndex: number) => CLASS_COLORS[classIndex % CLASS_COLORS.length]

/** Use frozen fitted descriptors; display labels never identify a class. */
function describeTreeClass(categories: ClassCategory[], classIndex: number, targetDtype: string): string {
  const stringTarget = /^(String|Categorical|Enum)($|\()/i.test(targetDtype)
  const values = categories.map(category => {
    const raw = stringTarget ? JSON.stringify(category.rawValue) : category.rawValue
    const label = category.label === category.code ? '' : `（${category.label}）`
    return `${raw}${label}`
  })
  return `C${classIndex + 1}${categories.length > 1 ? '（複数の元の値）' : ''}: ${values.join('、')}`
}

function treeDiagramLayout(root: TreeNode, targetDtype: string, classCategories: ClassCategory[][] | null) {
  let leaves = 0, maxDepth = 0
  const visit = (node: TreeNode, depth: number) => {
    maxDepth = Math.max(maxDepth, depth)
    if (node.isLeaf || !node.children?.length) leaves++
    else node.children.forEach(child => visit(child, depth + 1))
  }
  visit(root, 0)
  const rowHeight = Math.max(56, Math.min(92, Math.floor(520 / (maxDepth + 1))))
  const width = Math.max(760, leaves * 104 + 40), treeHeight = (maxDepth + 1) * rowHeight + 30
  const mappingTitle = classCategories === null ? '' : 'クラス対応（元の値・値ラベル）'
  let bottom = treeHeight + 32
  const mapping = classCategories === null ? [] : classCategories.map((categories, classIndex) => {
    const description = describeTreeClass(categories, classIndex, targetDtype)
    // Every line belongs to the SVG. Grow its logical height instead of clipping
    // long labels or relying on HTML/hover content outside the exported chart.
    const lines = wrapChartLabel(description, width - 58, Infinity, 12)
    const y = bottom
    bottom += lines.length * CLASS_LINE_HEIGHT + 8
    return { classIndex, description, lines, y }
  })
  return { width, height: classCategories === null ? treeHeight : bottom + 12, treeHeight, mappingTitle, mapping }
}

/** Intrinsic dimensions include full class mapping and preserve readable leaf spacing. */
export function treeDiagramDimensions(root: TreeNode, targetDtype: string, classCategories: ClassCategory[][] | null): { width: number; height: number } {
  const { width, height } = treeDiagramLayout(root, targetDtype, classCategories)
  return { width, height }
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
  targetDtype: string
  classCategories: ClassCategory[][] | null
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

function validInteger(value: number | null, min: number, max: number): value is number {
  return value !== null && Number.isInteger(value) && value >= min && value <= max
}

/** Keep invalid drafts visible instead of silently rounding or clamping them on blur. */
function ModelNumberField({ id, testId, label, help, value, onChange, min, max, step = 1, invalid }: {
  id: string; testId: string; label: string; help: string; value: number | null
  onChange: (value: number | null) => void; min: number; max: number; step?: number; invalid: boolean
}) {
  return <AnalysisField label={label} htmlFor={id} help={help}>
    <InputNumber id={id} data-testid={testId} aria-describedby={`${id}-help`} aria-invalid={invalid || undefined}
      size="small" style={{ width: '100%' }} value={value} min={min} max={max} step={step}
      status={invalid ? 'error' : undefined} changeOnBlur={false} onChange={onChange}
      onInput={text => {
        // InputNumber omits onChange for some out-of-range or unparseable drafts.
        const parsed = text.trim() === '' ? NaN : Number(text)
        onChange(Number.isFinite(parsed) ? parsed : null)
      }} />
  </AnalysisField>
}

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
  const [maxDepth, setMaxDepth] = useState<number | null>(4)
  const [nEstimators, setNEstimators] = useState<number | null>(100)
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
  const validDepth = validInteger(maxDepth, 1, 20)
  const validEstimators = validInteger(nEstimators, 10, 500)
  const invalidSettings = [
    !validDepth && '木の最大深さ（1〜20の整数）',
    modelType === 'random_forest' && !validEstimators && '決定木の本数（10〜500の整数）',
  ].filter(Boolean)
  const canRun = Boolean(targetValue) && numericColumns.length > 0 && invalidSettings.length === 0
  const settingsSummary = `最大深さ: ${maxDepth ?? '未入力'}`
    + (modelType === 'random_forest' ? ` / 決定木の本数: ${nEstimators ?? '未入力'}` : '')
  const inputContext = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, rowIds, numericColumns,
    targetValue, modelType, maxDepth, nEstimators])
  const runScope = useScopedRun(inputContext)
  useEffect(() => {
    setResult(null); setRunning(false); setError(null); dispatch(modelResultStored(null))
  }, [runScope.identity, dispatch])

  const runModel = async () => {
    if (!selection.datasetId || !targetValue || !canRun) return
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
        // A retained invalid forest-only draft must not send null/fractions for a decision tree.
        nEstimators: validEstimators ? nEstimators : 100,
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

  const treeSize = result?.treeStructures?.[0]
    ? treeDiagramDimensions(result.treeStructures[0], result.targetDtype, result.classCategories) : null

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

      <Card title="機械学習モデルの設定" size="small" className="analysis-setup">
        <div className="analysis-form-stack">
          <Typography.Text type="secondary">目的変数・説明変数とモデルを選び、学習を実行します。入力の変更は次回の実行に適用されます。</Typography.Text>
          <div className="analysis-variable-grid">
            <AnalysisField label="目的変数" htmlFor="model-target" help="予測する列を1つ選びます。共通の有効変数に含まれる質問・属性が候補です。">
              <Select id="model-target" data-testid="target-column" aria-label="モデルの目的変数" aria-describedby="model-target-help"
                roleName="モデルの目的変数" size="small" placeholder="目的変数を選択" style={{ width: '100%' }} value={targetValue} onChange={setTarget}
                options={allColumns.map(c => ({ value: c, label: c }))}
                emptyHint={{ roleLabel: '目的変数', reason: '目的変数の候補がありません。',
                  guidance: '共通の有効変数で質問・属性を選択してください。コードブックで役割・尺度を確認できます。MA選択肢は下の追加ボタンから候補に追加します。',
                  onOpenCodebook: () => dispatch(editorModalOpened()) }} />
            </AnalysisField>
            <AnalysisField label="説明変数" htmlFor="model-features" help="1列以上選びます。目的変数と同じ列・同じMA設問の選択肢は説明変数にできません。">
              <Select id="model-features" mode="multiple" aria-label="モデルの説明変数" aria-describedby="model-features-help"
                roleName="モデルの説明変数" size="small" placeholder="説明変数を選択" style={{ width: '100%' }} maxTagCount={4} value={numericColumns}
                options={featureCandidates.map(c => ({ value: c.name, label: c.multiResponseOptionLabel || c.label || c.name }))}
                onChange={(names: string[]) => setChosen({ datasetId: selection.datasetId!, names, children: current?.children ?? [] })}
                emptyHint={{ roleLabel: '説明変数', reason: '説明変数の候補がありません。',
                  guidance: '共通の有効変数で、目的変数とは異なる質問・属性を選択してください。同じMA設問の選択肢は使えません。コードブックで役割・尺度を確認できます。',
                  onOpenCodebook: () => dispatch(editorModalOpened()) }} />
            </AnalysisField>
          </div>
          <div className="analysis-inline-fields">
            <MaAxisPicker allowCount={false} groups={groups} columns={codebookColumns} onAdd={axes => {
              const added = axes.map(axis => codebookColumns.find(c => c.columnId === axis.columnId)?.name).filter((name): name is string => Boolean(name))
              setChosen({ datasetId: selection.datasetId!, names: [...new Set([...numericColumns, ...added])], children: [...new Set([...(current?.children ?? []), ...added])] })
            }} />
            <Typography.Text type="secondary">MAの重要度は子別です。</Typography.Text>
          </div>
          <AnalysisField label={<span id="model-type-label">モデル</span>}>
            <div role="radiogroup" aria-labelledby="model-type-label" className="analysis-method-switch">
              <Radio.Group data-testid="model-type" name="model-type" value={modelType}
                onChange={event => setModelType(event.target.value)} optionType="button" buttonStyle="solid">
                <Radio.Button value="decision_tree">決定木 (Decision Tree)</Radio.Button>
                <Radio.Button value="random_forest">ランダムフォレスト (Random Forest)</Radio.Button>
              </Radio.Group>
            </div>
          </AnalysisField>
          <AnalysisSettings title="モデルの詳細設定" summary={settingsSummary} attention={invalidSettings.length > 0}>
            <div className="analysis-variable-grid">
              <ModelNumberField id="model-max-depth" testId="max-depth" label="木の最大深さ" help="1〜20の整数を指定します。標準値は4です。"
                min={1} max={20} value={maxDepth} onChange={setMaxDepth} invalid={!validDepth} />
              {modelType === 'random_forest' && <ModelNumberField id="model-n-estimators" testId="n-estimators" label="決定木の本数" help="10〜500の整数を指定します。標準値は100です。"
                min={10} max={500} step={10} value={nEstimators} onChange={setNEstimators} invalid={!validEstimators} />}
            </div>
          </AnalysisSettings>
          <AnalysisSettings title="手法と結果の見方" summary="自動判定・欠損・MA選択肢と実行済み結果について">
            <Typography.Text>目的変数の尺度から分類・回帰を自動判定します。乱数 seed は42です。</Typography.Text>
            <Typography.Text>欠損やMA回答状態による行の除外は実行結果で確認できます。MAの特徴量重要度は選択肢ごとに表示します。</Typography.Text>
            <Typography.Text>実行後の特徴量重要度・決定木・リーフは表示中の結果に対応します。リーフ選択は共通の選択に反映されます。</Typography.Text>
          </AnalysisSettings>
          {error && <Alert type="error" showIcon message={error.message} />}
          <AnalysisRunRow>
            <Typography.Text type={canRun ? 'secondary' : 'warning'} role="status" id="model-run-guidance">
              {invalidSettings.length > 0 ? `詳細設定を確認してください: ${invalidSettings.join('、')}`
                : !targetValue ? '目的変数を1列選択してください。'
                  : !numericColumns.length ? '説明変数を1列以上選択してください。'
                    : `目的変数: ${targetValue} / 説明変数: ${numericColumns.length}項目`}
            </Typography.Text>
            <Button data-testid="run-model" type="primary" icon={<ThunderboltOutlined />} loading={running}
              disabled={!canRun} aria-describedby="model-run-guidance" onClick={() => void runModel()}
              style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%' }}>
              モデル学習
            </Button>
          </AnalysisRunRow>
        </div>
      </Card>

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
            <GraphPanel graphId="models/tree" title="決定木ダイアグラム" available sizing="intrinsic" intrinsicSize={{ width: treeSize!.width + 28, height: treeSize!.height + 150 }}>
            <div style={{ maxWidth: '100%', overflow: 'visible', padding: 14, userSelect: 'none' }}>
            <TreeDiagram
              root={result.treeStructures[0]}
              targetDtype={result.targetDtype}
              classCategories={result.classCategories}
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
export function TreeDiagram({ root, targetDtype, classCategories, treeIndex, leafMembership, selectedRowIds, onLeafSelect, headerNote }: TreeClassMetadata & {
  root: TreeNode
  treeIndex: number
  leafMembership: LeafMembership[]
  selectedRowIds: string[]
  onLeafSelect: (rowIds: string[]) => void
  headerNote?: string
}) {
  const questionText = useQuestionText()
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
  const { width, height, treeHeight, mappingTitle, mapping } = treeDiagramLayout(root, targetDtype, classCategories)
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

  // Keep the API's existing sorted winner, including rounded-count ties.
  const classIndexOf = (node: TreeNode) => node.values![0].classIndex
  const leafBadge = (node: TreeNode) => classCategories === null
    ? truncateText(node.majority ?? 'leaf', 12)
    : `C${classIndexOf(node) + 1}: ${truncateText(node.majority ?? '', 8)}`
  const leafDescription = (node: TreeNode) => classCategories === null
    ? node.majority ?? 'leaf' : mapping[classIndexOf(node)].description

  const membershipByNode = (nodeId: number) => leafMembership.find((l) => l.treeIndex === treeIndex && l.nodeId === nodeId)
  const selectByNode = (nodeId: number) => {
    const membership = membershipByNode(nodeId)
    if (membership?.rowIds.length) onLeafSelect(membership.rowIds)
  }

  return (
    <div data-testid={`tree-diagram-${treeIndex}`} style={{ minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Space wrap style={{ padding: '8px 12px 0' }} align="center">
        <Typography.Title level={5} style={{ margin: 0 }}>
          決定木構造（葉をクリックでその行集合を選択・全ビューへ伝播）{headerNote}
        </Typography.Title>
      </Space>
      <div style={{ flex: 1, overflow: 'visible', minHeight: 0 }}>
        <EChart width={width} height={height} exportFileName="決定木構造"
          ariaLabel={['決定木構造', mappingTitle, ...mapping.map(entry => entry.description)].filter(Boolean).join('。')}
          option={{ grid: { left: 0, right: 0, top: 0, bottom: 0, outerBoundsMode: 'none' },
            xAxis: { type: 'value', min: 0, max: width, show: false },
            yAxis: { type: 'value', min: 0, max: height, inverse: true, show: false },
            tooltip: { renderMode: 'richText', formatter: (p: any) => p.data?.description ?? p.name },
            graphic: classCategories === null ? [] : [
              { type: 'text', x: 20, y: treeHeight + 8, silent: true,
                style: { text: mappingTitle, font: '12px sans-serif', lineHeight: CLASS_LINE_HEIGHT, fill: '#111' } },
              ...mapping.flatMap(entry => [
                { id: `class-${entry.classIndex}-color`, type: 'rect' as const, x: 20, y: entry.y + 4, silent: true,
                  shape: { width: 10, height: 10 }, style: { fill: classColorOf(entry.classIndex) } },
                { id: `class-${entry.classIndex}-description`, type: 'text' as const, x: 38, y: entry.y, silent: true,
                  style: { text: entry.lines.join('\n'), font: '12px sans-serif', lineHeight: CLASS_LINE_HEIGHT, fill: '#111' } },
              ]),
            ],
            series: [{ type: 'graph', coordinateSystem: 'cartesian2d', layout: 'none', roam: false, edgeSymbol: ['none', 'none'],
              data: [...positions.values()].map(({x, y, node}) => ({ id: String(node.nodeId), value: [px(x), py(y)],
                nodeId: node.nodeId, isLeaf: node.isLeaf, symbol: 'roundRect', symbolSize: node.isLeaf ? [84, 38] : [100, 38],
                name: node.isLeaf ? `${leafBadge(node)}${node.nodeId === activeLeafNodeId ? ' ✓' : ''}\nn=${node.count}${node.values?.[0] ? ` · ${Math.round(node.values[0].ratio * 100)}%` : ''}`
                  : `${truncateText(`${node.feature ?? ''} ≤ ${node.threshold}`, 14)}\nn=${node.count}`,
                description: node.isLeaf ? `${leafDescription(node)}\n葉${node.nodeId} 学習時n=${node.count}\nクリックで所属行を選択`
                  : `${questionText(node.feature ?? '')} ≤ ${node.threshold}\n学習時n=${node.count}`,
                itemStyle: { color: node.isLeaf ? classCategories === null ? node.majority ? CLASS_COLORS[0] : '#898781' : classColorOf(classIndexOf(node)) : '#f8fafc',
                  borderColor: node.nodeId === activeLeafNodeId ? '#2a78d6' : '#94a3b8', borderWidth: node.nodeId === activeLeafNodeId ? 3 : 1 },
                label: { show: true, fontSize: 10, color: '#111' },
              })),
              links: [...positions.values()].flatMap(({node}) => (node.children ?? []).map((child, i) => ({
                source: String(node.nodeId), target: String(child.nodeId), name: i === 0 ? 'yes' : 'no' }))),
              edgeLabel: { show: true, formatter: (p: any) => p.data.name, fontSize: 10 },
              lineStyle: { color: '#b5b5ae', width: 1.3 }, emphasis: { focus: 'none' },
            }] }} onEvents={{ click: p => { if (p.dataType === 'node' && p.data.isLeaf) selectByNode(p.data.nodeId) } }} />
        <details open style={{ padding: '4px 12px' }}><summary>葉をキーボードで選択</summary>
          {[...positions.values()].filter(p => p.node.isLeaf).map(({node}) => {
            const selectionCount = membershipByNode(node.nodeId)?.rowIds.length ?? 0
            return <button key={node.nodeId} disabled={selectionCount === 0}
            data-testid={`tree-leaf-${treeIndex}-${node.nodeId}`} aria-pressed={node.nodeId === activeLeafNodeId}
            aria-label={`葉${node.nodeId}の${selectionCount}行を選択${classCategories === null ? '' : `: ${leafDescription(node)}`}`}
            title={leafDescription(node)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectByNode(node.nodeId) } }}
            onClick={() => selectByNode(node.nodeId)}>葉{node.nodeId}: {classCategories === null ? node.majority ?? 'leaf' : leafBadge(node)} (学習時n={node.count})</button>
          })}
        </details>
      </div>
    </div>
  )
}
