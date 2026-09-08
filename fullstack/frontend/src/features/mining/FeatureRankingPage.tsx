import { Select as AntSelect } from 'antd'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { useState, useEffect, useMemo, useCallback } from 'react'
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
  message,
} from 'antd'
import {
  CheckCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState, AppDispatch } from '../../app/store'
import { activeVariablesSet, variableOrderReordered, selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { api } from '../../api/client'

function computePearson(x: number[], y: number[]): number {
  let n = 0
  let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]
    const yi = y[i]
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue
    n++
    sumX += xi
    sumY += yi
    sumX2 += xi * xi
    sumY2 += yi * yi
    sumXY += xi * yi
  }
  if (n < 2) return 0
  const cov = sumXY - (sumX * sumY) / n
  const varX = sumX2 - (sumX * sumX) / n
  const varY = sumY2 - (sumY * sumY) / n
  const denom = Math.sqrt(Math.max(0, varX) * Math.max(0, varY))
  return denom > 1e-12 ? cov / denom : 0
}

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

export interface FeatureRankingResponse {
  target?: string | null
  taskType: 'classification' | 'regression' | 'unsupervised'
  evaluatedVariables: string[]
  rankings: VariableRankItem[]
  suggestedTopK: number
  executionTimeMs: number
  evidenceClass: string
}

const METHOD_COLORS: Record<string, string> = {
  relieff: '#1890ff',
  mutualInfo: '#52c41a',
  randomForest: '#722ed1',
  fStatistic: '#fa8c16',
  pcaDispersion: '#13c2c2',
}

export default function FeatureRankingPage() {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector((s: RootState) => s.globalVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const data = useColumnarData(selection.datasetId)

  const [targetColumn, setTargetColumn] = useState<string | undefined>(undefined)
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([])
  const [selectedMethods, setSelectedMethods] = useState<string[]>([
    'relieff',
    'mutual_info',
    'random_forest',
    'f_statistic',
  ])
  const [topK, setTopK] = useState<number>(3)
  const [rankingMetric, setRankingMetric] = useState<string>('borda')
  const [highlightedVar, setHighlightedVar] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<FeatureRankingResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Initialize targets and features
  useEffect(() => {
    if (!data?.schema) return
    const schema = data.schema
    const defaultTarget = globalVars.targetVariableId || schema.find((c) => c.semanticType !== 'numeric')?.name || schema[schema.length - 1]?.name
    setTargetColumn(defaultTarget)

    const numericCols = schema.filter((c) => c.semanticType === 'numeric').map((c) => c.name)
    const activeSet = new Set(globalVars.activeVariableIds)
    const defaultFeatures = numericCols.filter((c) => c !== defaultTarget && (activeSet.size === 0 || activeSet.has(c)))
    setSelectedFeatures(defaultFeatures.length > 0 ? defaultFeatures : numericCols.filter((c) => c !== defaultTarget))
  }, [data, globalVars.targetVariableId])

  const runRanking = async () => {
    if (!selection.datasetId || selectedFeatures.length === 0) {
      message.warning('評価対象の特徴量を1つ以上指定してください。')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const resp = await api.post<FeatureRankingResponse>('/mining/feature-ranking', {
        datasetId: selection.datasetId,
        targetColumn: targetColumn || undefined,
        featureColumns: selectedFeatures,
        methods: selectedMethods,
        activeRowIds: effectiveRowIds.length > 0 ? effectiveRowIds : undefined,
        seed: 42,
      })
      setResult(resp)
      setTopK(resp.suggestedTopK || Math.min(resp.rankings.length, 3))
      message.success(`特徴量ランキング計算完了 (${resp.executionTimeMs}ms)`)
    } catch (err) {
      const e = err as { message?: string }
      setError(e.message || '特徴量ランキング計算に失敗しました。')
    } finally {
      setLoading(false)
    }
  }

  // Auto-run once dataset is available
  useEffect(() => {
    if (selection.datasetId && selectedFeatures.length > 0 && !result && !loading) {
      void runRanking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.datasetId, selectedFeatures.length])

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
    if (!data || !result) return new Map<string, number>()
    const map = new Map<string, number>()
    const vars = result.rankings.map((r) => r.variable)
    const effectiveSet = new Set(effectiveRowIds)
    const indices: number[] = []
    for (let i = 0; i < data.rowIds.length; i++) {
      if (effectiveSet.has(data.rowIds[i])) indices.push(i)
    }
    for (let i = 0; i < vars.length; i++) {
      for (let j = i + 1; j < vars.length; j++) {
        const v1 = vars[i]
        const v2 = vars[j]
        const arr1 = data.numeric[v1]
        const arr2 = data.numeric[v2]
        if (!arr1 || !arr2) continue
        const sub1 = indices.map((idx) => arr1[idx])
        const sub2 = indices.map((idx) => arr2[idx])
        const corr = Math.abs(computePearson(sub1, sub2))
        map.set(`${v1}:::${v2}`, corr)
        map.set(`${v2}:::${v1}`, corr)
      }
    }
    return map
  }, [data, result, effectiveRowIds])

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
    dispatch(activeVariablesSet(topKVariables))
    const remaining = globalVars.allVariables.filter((id) => !topKVariables.includes(id))
    dispatch(variableOrderReordered([...topKVariables, ...remaining]))
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
      title: 'ReliefF',
      key: 'relieff',
      render: (_: unknown, row: VariableRankItem) =>
        row.scores.relieff ? `${row.scores.relieff.normalizedScore} (#${row.scores.relieff.rank})` : '-',
    },
    {
      title: '相互情報量 (MI)',
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
              options={(data?.schema || []).map((c) => ({ label: `${c.name} (${c.semanticType})`, value: c.name }))}
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
              options={(data?.schema || [])
                .filter((c) => c.name !== targetColumn && c.semanticType === 'numeric')
                .map((c) => ({ label: c.name, value: c.name }))}
              data-testid="ranking-features-select"
            />
          </Col>
          <Col xs={24} sm={24} md={6} style={{ display: 'flex', alignItems: 'flex-end', height: '100%' }}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={loading}
              onClick={runRanking}
              style={{ width: '100%', marginTop: 20 }}
              data-testid="compute-ranking-btn"
            >
              ランキング計算実行 (Compute)
            </Button>
          </Col>
        </Row>

        <div style={{ marginTop: 10 }}>
          <Typography.Text strong style={{ fontSize: 12, marginRight: 8 }}>評価手法:</Typography.Text>
          <Checkbox.Group
            value={selectedMethods}
            onChange={(v) => setSelectedMethods(v as string[])}
            options={[
              { label: 'ReliefF', value: 'relieff' },
              { label: '相互情報量 (MI)', value: 'mutual_info' },
              { label: 'Random Forest (MDI)', value: 'random_forest' },
              { label: 'ANOVA F / F-値', value: 'f_statistic' },
              { label: 'PCA分散 (Dispersion)', value: 'pca_dispersion' },
            ]}
          />
        </div>
      </Card>

      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}

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

      {/* Visualizations: Multi-Metric Bar & Relevance vs Redundancy Bubble Plot */}
      {result && !loading && (
        <Row gutter={[16, 16]}>
          {/* Multi-Metric Bar Chart */}
          <Col xs={24} lg={12}>
            <Card
              size="small"
              title={
                <div style={{ whiteSpace: 'normal', display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
                  <span>手法別スコア比較 (Normalized Scores [0, 1])</span>
                  <Space wrap size={8}>
                    {Object.entries(METHOD_COLORS).map(([m, color]) => (
                      <span key={m} style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 10, height: 10, backgroundColor: color, borderRadius: 2 }} />
                        {m}
                      </span>
                    ))}
                  </Space>
                </div>
              }
              data-testid="ranking-bar-card"
            >
              <div style={{ overflowY: 'auto', maxHeight: 360, paddingRight: 8 }}>
                {sortedRankings.map((item) => {
                  const isHighlighted = highlightedVar === item.variable
                  const isTopK = topKVariables.includes(item.variable)
                  return (
                    <div
                      key={item.variable}
                      style={{
                        marginBottom: 10,
                        padding: 6,
                        borderRadius: 4,
                        background: isHighlighted ? '#e6f7ff' : isTopK ? '#f6ffed' : 'transparent',
                        border: isHighlighted ? '1px solid #91d5ff' : '1px solid transparent',
                        cursor: 'pointer',
                      }}
                      onClick={() => setHighlightedVar(item.variable === highlightedVar ? null : item.variable)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                        <span style={{ fontWeight: isTopK ? 600 : 400 }}>
                          #{item.overallRank} <ColumnQuestionTooltip nameOrId={item.variable}>{item.variable}</ColumnQuestionTooltip>
                        </span>
                        <span style={{ color: '#666' }}>Borda: {item.bordaScore}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {Object.entries(item.scores).map(([mKey, scoreItem]) => {
                          const widthPct = Math.round((scoreItem?.normalizedScore ?? 0) * 100)
                          return (
                            <div key={mKey} style={{ display: 'flex', alignItems: 'center', height: 10, fontSize: 10 }}>
                              <div
                                style={{
                                  width: `${widthPct}%`,
                                  height: '100%',
                                  backgroundColor: METHOD_COLORS[mKey] || '#888',
                                  borderRadius: 2,
                                  transition: 'width 0.3s ease',
                                }}
                                title={`${mKey}: raw=${scoreItem?.rawScore}, norm=${scoreItem?.normalizedScore}`}
                              />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>
          </Col>

          {/* Relevance vs Redundancy Plot (mRMR) */}
          <Col xs={24} lg={12}>
            <Card
              size="small"
              title="関連度 vs 冗長性プロット (mRMR: Relevance vs Redundancy)"
              extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>右下が最良（高重要度・低冗長性）</Typography.Text>}
              data-testid="ranking-mrmr-card"
            >
              <svg width="100%" height={320} viewBox="0 0 400 300" style={{ background: '#fafafa', borderRadius: 4 }}>
                {/* Axes */}
                <line x1={50} y1={250} x2={380} y2={250} stroke="#999" strokeWidth={1} />
                <line x1={50} y1={250} x2={50} y2={30} stroke="#999" strokeWidth={1} />
                {/* Labels */}
                <text x={215} y={285} fontSize={11} textAnchor="middle" fill="#666">
                  統合重要度 (Relevance: Borda Score) →
                </text>
                <text x={-140} y={18} fontSize={11} textAnchor="middle" fill="#666" transform="rotate(-90)">
                  動的冗長性 (mRMR vs Top-{topK}) →
                </text>

                {/* Gridlines */}
                <line x1={50} y1={140} x2={380} y2={140} stroke="#e8e8e8" strokeDasharray="3 3" />
                <line x1={215} y1={30} x2={215} y2={250} stroke="#e8e8e8" strokeDasharray="3 3" />

                {/* Data points */}
                {(() => {
                  const maxBorda = Math.max(...result.rankings.map((r) => r.bordaScore), 1)
                  const minBorda = Math.min(...result.rankings.map((r) => r.bordaScore), 0)
                  const bordaRange = maxBorda - minBorda || 1

                  return result.rankings.map((r) => {
                    const normBorda = (r.bordaScore - minBorda) / bordaRange
                    const dynRedundancy = getDynamicRedundancy(r.variable, r.meanRedundancy)
                    const cx = 50 + normBorda * 310
                    const cy = 250 - Math.min(1, Math.max(0, dynRedundancy)) * 200

                    const isHighlighted = highlightedVar === r.variable
                    const isTopK = topKVariables.includes(r.variable)

                    return (
                      <g
                        key={r.variable}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setHighlightedVar(r.variable === highlightedVar ? null : r.variable)}
                      >
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isHighlighted ? 10 : isTopK ? 8 : 6}
                          fill={isHighlighted ? '#ff4d4f' : isTopK ? '#2f54eb' : '#8c8c8c'}
                          opacity={0.8}
                          stroke="#fff"
                          strokeWidth={1.5}
                        >
                          <title>{`${r.variable}\nBorda Score: ${r.bordaScore} (Rank #${r.overallRank})\nmRMR Redundancy vs Top-${topK}: ${dynRedundancy.toFixed(3)}\nStatic Mean Redundancy: ${r.meanRedundancy.toFixed(3)}`}</title>
                        </circle>
                        <ColumnQuestionTooltip nameOrId={r.variable} svg><text
                          x={cx + 9}
                          y={cy + 4}
                          fontSize={10}
                          fontWeight={isTopK || isHighlighted ? 600 : 400}
                          fill={isHighlighted ? '#cf1322' : '#333'}
                        >
                          {r.variable}
                        </text></ColumnQuestionTooltip>
                      </g>
                    )
                  })
                })()}
              </svg>
            </Card>
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
