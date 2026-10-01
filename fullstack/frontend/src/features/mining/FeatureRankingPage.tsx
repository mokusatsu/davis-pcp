import { useScopedRun, AnalysisScopeSummary } from '../selection/analysisScope'
import { CHART_MARKERS } from '../charts/markerStyle'
import EChart from '../charts/EChart'
import { importanceBarsOption, rankingBarsOption, rankingScatterOption } from './rankingCharts'
import { selectOrdinaryVariables } from '../../app/store'
import { Select as AntSelect } from 'antd'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useCodebook } from '../dataset/useCodebookColumn'
import {
  Card,
  Row,
  Col,
  Checkbox,
  Button,
  Slider,
  InputNumber,
  Tag,
  Space,
  Typography,
  Spin,
  Alert,
  Tooltip,
  message,
} from 'antd'
import {
  CheckCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState, AppDispatch } from '../../app/store'
import { activeEntitiesSet, variableOrderReordered, selectEffectiveRowIds, selectVariableEntities } from '../../app/store'
import MaAxisPicker from '../pcp/MaAxisPicker'
import type { VariableEntity } from '../selection/variableEntities'
import { api } from '../../api/client'
import GraphPanel from '../common/GraphPanel'

export interface MetricScoreItem {
  rawScore: number
  normalizedScore: number
  rank: number
}

export interface VariableRankItem {
  variable: string
  bordaScore: number
  overallRank: number
  recommendationTier: 'high' | 'medium' | 'low'
  meanRedundancy: number
  scores: {
    relieff?: MetricScoreItem | null
    mutualInfo?: MetricScoreItem | null
    randomForest?: MetricScoreItem | null
    fStatistic?: MetricScoreItem | null
    pcaDispersion?: MetricScoreItem | null
  }
}

export interface ImportanceEntry {
  featureName: string
  importance?: number | null
  importanceMean?: number | null
  importanceStd?: number | null
  rank: number
}

export interface FeatureRankingResponse {
  weightApplied?: boolean
  weightStatus?: string
  scopeCount: number
  usedRows: number
  ordinaryMissingExcluded: number
  target?: string | null
  taskType: 'classification' | 'regression' | 'unsupervised'
  evaluatedVariables: string[]
  redundancyMatrix: number[][]
  rankings: VariableRankItem[]
  methodDisplay?: Record<string, { displayName: string; formula: string; scope: string; deprecatedAlias: string }>
  importance?: { mdi: ImportanceEntry[]; permutation_train: ImportanceEntry[] }
  importanceMetadata?: {
    mdi?: { available: boolean; scope?: string; model?: string; criterion?: string; reason?: string }
    permutation_train?: { available: boolean; scope?: string; repeats?: number; seed?: number; reason?: string }
  }
  metadata?: { warnings?: string[] }
  suggestedTopK: number
  executionTimeMs: number
  evidenceClass: string
}

function MethodInfoTip({ methodKey, display, taskType }: {
  methodKey: string
  display?: { displayName: string; formula: string; scope: string; deprecatedAlias: string }
  taskType?: string
}) {
  if (!display) return null
  const supervised = taskType !== 'unsupervised'
  const label = methodKey === 'relieff'
    ? (supervised ? 'ReliefF' : '分散（教師なし代理指標）')
    : methodKey === 'mutualInfo'
      ? (supervised ? '相互情報量' : '平均絶対相関（教師なし代理指標）')
      : display.displayName
  return (
    <Tooltip
      title={`${label}：${display.formula}（適用範囲：${display.scope}）`}
      aria-label={`${label}の説明`}
    >
      <span
        tabIndex={0}
        role="img"
        aria-label={`${label}の説明`}
        aria-describedby={`${methodKey}-formula`}
        style={{ cursor: 'help', marginLeft: 4 }}
      >
        ⓘ
      </span>
    </Tooltip>
  )
}

export default function FeatureRankingPage() {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector(selectOrdinaryVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const { schemaRevision, columns: dictionary } = useCodebook()
  const entities = useSelector(selectVariableEntities)
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key)
    && ['question', 'attribute'].includes(item.role)).map(item => ({ groupId: item.name, label: item.label }))
  const [maChoices, setMaChoices] = useState<{ datasetId: string; names: string[] } | null>(null)
  const candidates = dictionary.filter(c => ['question', 'attribute'].includes(c.role)
    && (c.multiResponseGroup ? maChoices?.datasetId === selection.datasetId && maChoices.names.includes(c.name)
      && groups.some(g => g.groupId === c.multiResponseGroup)
      : ['nominal', 'ordinal', 'interval', 'ratio'].includes(c.scaleType) && globalVars.activeVariableIds.includes(c.name)))

  const [requestedTarget, setTargetColumn] = useState<string | undefined>(undefined)
  const targetColumn = candidates.find(c => c.name === requestedTarget)?.name
  const targetGroup = candidates.find(c => c.name === targetColumn)?.multiResponseGroup
  const [requestedFeatures, setSelectedFeatures] = useState<string[]>([])
  const featureCandidates = candidates.filter(c => c.name !== targetColumn && (!targetGroup || c.multiResponseGroup !== targetGroup))
  const selectedFeatures = requestedFeatures.filter(name => featureCandidates.some(c => c.name === name))
  const [selectedMethods, setSelectedMethods] = useState<string[]>([
    'relieff',
    'mutual_info',
    'random_forest',
    'f_statistic',
  ])
  const [topK, setTopK] = useState<number>(3)
  const [rankingMetric, setRankingMetric] = useState<string>('borda')
  const [highlightedVar, setHighlightedVar] = useState<string | null>(null)
  const [usePermutation, setUsePermutation] = useState<boolean>(true)

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<FeatureRankingResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputContext = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision,
    effectiveRowIds, targetColumn, selectedFeatures, selectedMethods, usePermutation])
  const runScope = useScopedRun(inputContext)
  useEffect(() => {
    setResult(null)
    setError(null)
    setLoading(false)
  }, [runScope.identity])

  // Initialize targets and features
  useEffect(() => {
    if (!dictionary.length) return
    const defaultTarget = candidates.find(c => c.name === globalVars.targetVariableId)?.name
    setTargetColumn(defaultTarget)
    setSelectedFeatures(candidates.filter(c => c.name !== defaultTarget && ['interval', 'ratio'].includes(c.scaleType)).map(c => c.name))
  }, [selection.datasetId, dictionary, globalVars.targetVariableId])

  const runRanking = async () => {
    if (!selection.datasetId || selectedFeatures.length === 0) {
      message.warning('評価対象の特徴量を1つ以上指定してください。')
      return
    }
    setLoading(true)
    setError(null)
    const ticket = runScope.begin()
    const isCurrent = ticket.isCurrent
    try {
      const resp = await api.post<FeatureRankingResponse>('/mining/feature-ranking', {
        datasetId: selection.datasetId,
        targetColumn: targetColumn || undefined,
        featureColumns: selectedFeatures,
        methods: selectedMethods,
        activeRowIds: ticket.scope.rowIds,
        expectedSchemaRevision: schemaRevision,
        expectedDataRevision: selection.dataRevision,
        usePermutationImportance: usePermutation,
        seed: 42,
      })
      if (!isCurrent()) return
      ticket.commit()
      setResult(resp)
      setTopK(resp.suggestedTopK || Math.min(resp.rankings.length, 3))
      message.success(`特徴量ランキング計算完了 (${resp.executionTimeMs}ms)`)
    } catch (err) {
      if (!isCurrent()) return
      const e = err as { message?: string }
      setError(e.message || '特徴量ランキング計算に失敗しました。')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  // Top-K items based on selection metric
  const sortedRankings = useMemo(() => {
    if (!result) return []
    const items = [...result.rankings]
    if (rankingMetric === 'borda') {
      items.sort((a, b) => a.overallRank - b.overallRank)
    } else {
      items.sort((a, b) => {
        const sa = a.scores[rankingMetric as keyof typeof a.scores]?.normalizedScore ?? -1
        const sb = b.scores[rankingMetric as keyof typeof b.scores]?.normalizedScore ?? -1
        return sb - sa
      })
    }
    return items
  }, [result, rankingMetric])

  const topKVariables = useMemo(() => {
    return sortedRankings.slice(0, topK).map((r) => r.variable)
  }, [sortedRankings, topK])

  const pairwiseCorr = useMemo(() => {
    if (!result) return new Map<string, number>()
    const map = new Map<string, number>()
    const vars = result.evaluatedVariables
    for (let i = 0; i < vars.length; i++) {
      for (let j = i + 1; j < vars.length; j++) {
        const v1 = vars[i]
        const v2 = vars[j]
        const corr = result.redundancyMatrix[i][j]
        map.set(`${v1}:::${v2}`, corr)
        map.set(`${v2}:::${v1}`, corr)
      }
    }
    return map
  }, [result])

  const getDynamicRedundancy = useCallback((variable: string, fallback: number): number => {
    if (!pairwiseCorr.size || topKVariables.length === 0) return fallback
    const targetSet = topKVariables.includes(variable)
      ? topKVariables.filter((v) => v !== variable)
      : topKVariables
    if (targetSet.length === 0) return fallback
    let sumCorr = 0
    let count = 0
    for (const other of targetSet) {
      const c = pairwiseCorr.get(`${variable}:::${other}`)
      if (c !== undefined) {
        sumCorr += c
        count++
      }
    }
    return count > 0 ? sumCorr / count : fallback
  }, [pairwiseCorr, topKVariables])

  const handleApplyToActiveVariables = () => {
    if (topKVariables.length === 0) return
    const selected: VariableEntity[] = []
    for (const name of topKVariables) {
      const column = dictionary.find(c => c.name === name)
      if (!column) continue
      const entity: VariableEntity = column.multiResponseGroup ? { kind: 'ma', groupId: column.multiResponseGroup }
        : { kind: 'column', columnId: column.columnId }
      if (!selected.some(item => JSON.stringify(item) === JSON.stringify(entity))) selected.push(entity)
    }
    dispatch(activeEntitiesSet(selected))
    const orderedNames = selected.map(entity => entity.kind === 'ma' ? entity.groupId
      : dictionary.find(c => c.columnId === entity.columnId)!.name)
    const remaining = entities.items.map(item => item.name).filter(name => !orderedNames.includes(name))
    dispatch(variableOrderReordered([...orderedNames, ...remaining]))
    message.success(`上位 ${topKVariables.length} 変数を共通 Variable Selector に適用しました！`)
  }

  if (!selection.datasetId) {
    return (
      <Alert
        type="info"
        showIcon
        message="データセットを読み込んでください。"
        style={{ margin: 16 }}
      />
    )
  }

  const columns = [
    {
      title: '順位',
      dataIndex: 'overallRank',
      key: 'overallRank',
      width: 65,
      render: (rank: number) => (
        <Tag color={rank === 1 ? 'gold' : rank === 2 ? 'cyan' : rank === 3 ? 'blue' : 'default'}>
          {rank}位
        </Tag>
      ),
    },
    {
      title: '変数名',
      dataIndex: 'variable',
      key: 'variable',
      render: (text: string) => (
        <span style={{ fontWeight: highlightedVar === text ? 'bold' : 'normal', color: highlightedVar === text ? '#1890ff' : 'inherit' }}>
          {text}
        </span>
      ),
    },
    {
      title: '統合Borda点',
      dataIndex: 'bordaScore',
      key: 'bordaScore',
      render: (score: number) => <strong>{score}</strong>,
    },
    {
      title: (<span>{result?.taskType === 'unsupervised' ? '分散（教師なし代理指標）' : 'ReliefF'} <MethodInfoTip methodKey="relieff" display={result?.methodDisplay?.relieff} taskType={result?.taskType} /></span>),
      key: 'relieff',
      render: (_: unknown, row: VariableRankItem) =>
        row.scores.relieff ? `${row.scores.relieff.normalizedScore} (#${row.scores.relieff.rank})` : '-',
    },
    {
      title: (<span>{result?.taskType === 'unsupervised' ? '平均絶対相関（教師なし代理指標）' : '相互情報量'} <MethodInfoTip methodKey="mutualInfo" display={result?.methodDisplay?.mutualInfo} taskType={result?.taskType} /></span>),
      key: 'mutualInfo',
      render: (_: unknown, row: VariableRankItem) =>
        row.scores.mutualInfo ? `${row.scores.mutualInfo.normalizedScore} (#${row.scores.mutualInfo.rank})` : '-',
    },
    {
      title: 'RF (MDI)',
      key: 'randomForest',
      render: (_: unknown, row: VariableRankItem) =>
        row.scores.randomForest ? `${row.scores.randomForest.normalizedScore} (#${row.scores.randomForest.rank})` : '-',
    },
    {
      title: 'F値 / ANOVA',
      key: 'fStatistic',
      render: (_: unknown, row: VariableRankItem) =>
        row.scores.fStatistic ? `${row.scores.fStatistic.normalizedScore} (#${row.scores.fStatistic.rank})` : '-',
    },
    {
      title: `冗長性 (vs Top-${topK})`,
      key: 'dynamicRedundancy',
      render: (_: unknown, row: VariableRankItem) => {
        const dyn = getDynamicRedundancy(row.variable, row.meanRedundancy)
        return (
          <span title={`静的平均相関: ${row.meanRedundancy.toFixed(3)}`}>
            {dyn.toFixed(3)}
          </span>
        )
      },
    },
    {
      title: '推奨度',
      dataIndex: 'recommendationTier',
      key: 'recommendationTier',
      width: 90,
      render: (tier: 'high' | 'medium' | 'low') => {
        const color = tier === 'high' ? 'green' : tier === 'medium' ? 'orange' : 'default'
        return <Tag color={color}>{tier.toUpperCase()}</Tag>
      },
    },
  ]

  return (
    <div data-testid="feature-ranking-page" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <AnalysisScopeSummary snapshot={runScope.snapshot} />
      {runScope.dirty && <Typography.Text type="warning">現在の入力と異なる実行済み結果です。再実行すると更新されます。</Typography.Text>}

      {/* Top Configuration Card */}
      <Card size="small" title="特徴量ランキング・選択設定 (Feature Ranking Configuration)" data-testid="ranking-config-card">
        <Row gutter={[16, 12]} align="middle">
          <Col xs={24} sm={8} md={6}>
            <Typography.Text strong style={{ fontSize: 12 }}>目的変数 Y (Target):</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              allowClear
              placeholder="教師なし (Unsupervised)"
              value={targetColumn}
              onChange={(v) => setTargetColumn(v)}
              options={candidates.map(c => ({ label: `${c.name}: ${c.label || c.name}`, value: c.name }))}
              data-testid="ranking-target-select"
            />
          </Col>
          <Col xs={24} sm={16} md={12}>
            <Typography.Text strong style={{ fontSize: 12 }}>評価対象 X (Features):</Typography.Text>
            <Select
              mode="multiple"
              maxTagCount={4}
              style={{ width: '100%', marginTop: 4 }}
              value={selectedFeatures}
              onChange={setSelectedFeatures}
              options={featureCandidates
                .map((c) => ({ label: c.name, value: c.name }))}
              data-testid="ranking-features-select"
            />
          </Col>
          <Col xs={24} sm={24} md={6} style={{ display: 'flex', alignItems: 'flex-end', height: '100%' }}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={loading}
              disabled={selectedFeatures.length === 0 || selectedMethods.length === 0}
              onClick={runRanking}
              style={{ width: '100%', marginTop: 20 }}
              data-testid="compute-ranking-btn"
            >
              ランキング計算実行 (Compute)
            </Button>
          </Col>
        </Row>

        <div style={{ marginTop: 10 }}>
          <MaAxisPicker allowCount={false} groups={groups} columns={dictionary} onAdd={axes => {
            const added = axes.map(axis => dictionary.find(c => c.columnId === axis.columnId)?.name).filter((name): name is string => Boolean(name))
            setMaChoices({ datasetId: selection.datasetId!, names: [...new Set([...(maChoices?.datasetId === selection.datasetId ? maChoices.names : []), ...added])] })
            setSelectedFeatures(previous => [...new Set([...previous, ...added])])
          }} />
          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>MAは指定した子だけを評価します。重要度は子別です。</Typography.Text>
        </div>

        <div style={{ marginTop: 10 }}>
          <Typography.Text strong style={{ fontSize: 12, marginRight: 8 }}>評価手法:</Typography.Text>
          <Checkbox.Group
            value={selectedMethods}
            onChange={(v) => setSelectedMethods(v as string[])}
            options={[
              { label: 'ReliefF / 分散（教師なし代理指標）', value: 'relieff' },
              { label: '相互情報量 / 平均絶対相関（教師なし代理指標）', value: 'mutual_info' },
              { label: 'Random Forest (MDI)', value: 'random_forest' },
              { label: 'ANOVA F / F-値', value: 'f_statistic' },
              { label: 'PCA分散 (Dispersion)', value: 'pca_dispersion' },
            ]}
          />
          <div style={{ marginTop: 8 }}>
            <Checkbox
              checked={usePermutation}
              onChange={(e) => setUsePermutation(e.target.checked)}
              data-testid="ranking-permutation-toggle"
            >
              Permutation Importance（訓練データ、教師ありのみ）も計算する
            </Checkbox>
          </div>
        </div>
      </Card>

      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
      {result && <Typography.Text type="secondary">
        分析対象 {result.usedRows} / {result.scopeCount} 行
        （除外 {result.scopeCount - result.usedRows} 行、うち通常変数の欠損 {result.ordinaryMissingExcluded} 行）
      </Typography.Text>}

      {/* Top-K Action Bar (Key Requirement FEAT-014) */}
      {result && (
        <Card
          size="small"
          style={{ background: '#f0f5ff', borderColor: '#adc6ff' }}
          data-testid="top-k-action-bar"
        >
          <Row gutter={[16, 10]} align="middle" justify="space-between">
            <Col xs={24} md={14}>
              <Space wrap size="middle" align="center">
                <Typography.Text strong style={{ color: '#1d39c4' }}>
                  上位 K 変数の一括選択:
                </Typography.Text>
                <div style={{ display: 'inline-flex', alignItems: 'center', width: 180, gap: 8 }}>
                  <Slider
                    min={1}
                    max={result.rankings.length}
                    value={topK}
                    onChange={(v) => setTopK(v)}
                    style={{ flex: 1 }}
                    data-testid="top-k-slider"
                  />
                  <InputNumber
                    min={1}
                    max={result.rankings.length}
                    value={topK}
                    onChange={(v) => setTopK(v ?? 1)}
                    size="small"
                    style={{ width: 55 }}
                  />
                </div>
                <AntSelect
                  size="small"
                  value={rankingMetric}
                  onChange={setRankingMetric}
                  style={{ width: 140 }}
                  options={[
                    { value: 'borda', label: '統合Borda順' },
                    { value: 'relieff', label: 'ReliefF順' },
                    { value: 'mutualInfo', label: '相互情報量順' },
                    { value: 'randomForest', label: 'Random Forest順' },
                    { value: 'fStatistic', label: 'ANOVA F順' },
                  ]}
                  data-testid="ranking-metric-select"
                />
              </Space>
              <div style={{ marginTop: 6 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  選択対象:
                </Typography.Text>{' '}
                {topKVariables.map((v) => (
                  <Tag key={v} color="blue">
                    <ColumnQuestionTooltip nameOrId={v}>{v}</ColumnQuestionTooltip>
                  </Tag>
                ))}
              </div>
            </Col>
            <Col xs={24} md={10} style={{ textAlign: 'right' }}>
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                onClick={handleApplyToActiveVariables}
                data-testid="apply-to-active-vars-btn"
                style={{ background: '#2f54eb' }}
              >
                上部共通 Variable Selector へ適用 (Apply to Active Variables)
              </Button>
            </Col>
          </Row>
        </Card>
      )}

      {loading && (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <Spin size="large" tip="各評価エンジンで特徴量ランキングを計算中..." />
        </div>
      )}

      {/* Importance warnings (Feature 23: contribution, not causation) */}
      {result && !loading && result.metadata?.warnings && (
        <Alert
          type="warning"
          showIcon
          message={result.metadata.warnings.join('／')}
          data-testid="importance-warnings"
          style={{ marginBottom: 0 }}
        />
      )}

      {/* Importance split: MDI (left) vs Permutation train (right) */}
      {result && !loading && result.importance && (
        <Row gutter={[16, 16]} data-testid="importance-split">
          <Col xs={24} lg={12}>
            <Card
              size="small"
              title={<span>MDI (Mean Decrease Impurity) <MethodInfoTip methodKey="mdi" display={{ displayName: 'MDI', formula: 'feature_importances_', scope: 'train', deprecatedAlias: '' }} taskType={result.taskType} /></span>}
              extra={<Tag>高カーディナリティ特徴にバイアス</Tag>}
            >
              <EChart testId="ranking-mdi-chart" height={Math.max(180, (result.importance.mdi?.length ?? 0) * 34 + 70)}
                ariaLabel="MDI importance" option={importanceBarsOption(result.importance.mdi ?? [], 'mdi')} />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card
              size="small"
              title={<span>Permutation Importance（訓練データ） <MethodInfoTip methodKey="permutation" display={{ displayName: 'Permutation', formula: 'permutation_importance（5 repeats）', scope: 'train', deprecatedAlias: '' }} taskType={result.taskType} /></span>}
              extra={<Tag>過学習の影響を受ける</Tag>}
            >
              {result.importanceMetadata?.permutation_train?.available === false ? (
                <Typography.Text type="secondary">教師ありのみ</Typography.Text>
              ) : (
                <EChart testId="ranking-permutation-chart" height={Math.max(180, (result.importance.permutation_train?.length ?? 0) * 34 + 70)}
                  ariaLabel="訓練データの符号付き permutation importance" option={importanceBarsOption(result.importance.permutation_train ?? [], 'permutation')} />
              )}
            </Card>
          </Col>
        </Row>
      )}

      {/* Visualizations: Multi-Metric Bar & Relevance vs Redundancy Bubble Plot */}
      {result && !loading && (
        <Row gutter={[16, 16]} data-testid="ranking-chart-stack">
          {/* Multi-Metric Bar Chart */}
          <Col span={24}>
            <GraphPanel
              graphId="ranking/metrics"
              normalWidth="viewport"
              title="手法別スコア比較"
              available={Boolean(result && sortedRankings.length)}
              sizing="intrinsic"
              intrinsicSize={{ width: 620, height: Math.max(320, sortedRankings.length * 70) }}
              controls={<Typography.Text type="secondary">正規化スコア [0, 1]</Typography.Text>}
            >
            <div data-testid="ranking-bar-card">
                <EChart testId="ranking-bars-chart" height={Math.max(320, sortedRankings.length * 70)}
                  ariaLabel="手法別の変数スコア比較"
                  option={rankingBarsOption(sortedRankings, highlightedVar, topKVariables)}
                  onEvents={{ click: event => { if (event.data?.name) setHighlightedVar(event.data.name === highlightedVar ? null : event.data.name) } }} />
            </div>
            </GraphPanel>
          </Col>

          {/* Relevance vs Redundancy Plot (mRMR) */}
          <Col span={24}>
            <GraphPanel
              graphId="ranking/mrmr"
              normalWidth="viewport"
              title="関連度 vs 冗長性プロット"
              available={Boolean(result && result.rankings.length)}
              sizing="intrinsic"
              intrinsicSize={{ width: 560, height: 340 }}
              controls={<Typography.Text type="secondary">右下が最良（高重要度・低冗長性）</Typography.Text>}
            >
            <div data-testid="ranking-mrmr-card">
              <EChart fitPointMarkers pointHitRadius={CHART_MARKERS.hitRadius} testId="ranking-mrmr-chart" height={340} ariaLabel="関連度と動的冗長性"
                option={rankingScatterOption(result.rankings, highlightedVar, topKVariables, getDynamicRedundancy, topK)}
                onEvents={{ click: event => { if (event.data?.name) setHighlightedVar(event.data.name === highlightedVar ? null : event.data.name) } }} />
            </div>
            </GraphPanel>
          </Col>
        </Row>
      )}

      {/* Summary Table */}
      {result && !loading && (
        <Card size="small" title="統合ランキング詳細テーブル (Borda Count Aggregation Table)" data-testid="ranking-table-card">
          <Table
            size="small"
            columns={columns}
            dataSource={result.rankings.map((r) => ({ ...r, key: r.variable }))}
            pagination={false}
            rowClassName={(record) => (record.variable === highlightedVar ? 'ant-table-row-selected' : '')}
            onRow={(record) => ({
              onClick: () => setHighlightedVar(record.variable === highlightedVar ? null : record.variable),
            })}
          />
        </Card>
      )}
    </div>
  )
}
