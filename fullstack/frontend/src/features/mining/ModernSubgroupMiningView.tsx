import { Select as AntSelect } from 'antd'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Button, Typography, Space, Tag, Row, Col,
  Statistic, Spin, Empty, InputNumber, Radio, Divider, Alert, Checkbox,
} from 'antd'
import {
  ThunderboltOutlined, CheckCircleOutlined,
  LineChartOutlined, SwapOutlined, FilterOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, selectEffectiveRowIds } from '../../app/store'
import { useMiningTargets } from './useMiningTargets'
import { getBrushOp } from '../selection/SelectionMenu'
import { api } from '../../api/client'
import VerificationConfigModal, { type VerificationConfig } from './VerificationConfigModal'
import { useCodebook } from '../dataset/useCodebookColumn'
import {
  METHOD_LABEL, REPLICATION_COLOR, REPLICATION_LABEL, untestableReason, verificationFor,
  type PinnedCandidateSummary, type VerificationInfo, type VerificationResultItem,
} from './verification'

/** Modern exploration exposes no FDR control, so verification runs at the default. */
const VERIFICATION_ALPHA = 0.05

export interface ModernCondition {
  column: string
  operator: string
  value: any
  label: string
}

export interface ModernInsight {
  id: string
  target_question?: string | null
  target_pair?: string[] | null
  rule: {
    conditions: ModernCondition[]
    complexity: number
    text: string
  }
  coverage: {
    n: number
    ratio: number
    row_ids: string[]
  }
  target_stats: {
    subgroup_mean?: number
    complement_mean?: number
    overall_mean?: number
    delta_mean?: number
    subgroup_sd?: number
    complement_sd?: number
    sd_ratio?: number
    variance_ratio?: number
    subgroup_proportion?: number
    complement_proportion?: number
    delta_proportion?: number
    subgroup_tau?: number
    complement_tau?: number
    delta_tau?: number
  }
  ranking_reason: {
    primary_driver: string
    description: string
  }
  score: number
  complete_separation?: boolean
  parent_insight_id?: string | null
  parent_delta_mean?: number | null
  emm_stats?: {
    subgroup_tau: number
    complement_tau: number
    delta_tau: number
    reversal: boolean
  } | null
  narrative: string
}

export interface ModernMiningResult {
  run_id: string
  mode: string
  inferenceMode?: 'exploration' | 'verification'
  algorithmMode?: string
  candidateSetHash?: string
  explorationNote?: string
  /** The candidates exploration pinned; some insights pin none and cannot be verified. */
  candidates?: PinnedCandidateSummary[]
  summary: {
    total_candidates_explored: number
    non_redundant_insights_count: number
    questions_evaluated_count?: number
  }
  insights: ModernInsight[]
}

export const ModernSubgroupMiningView: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()

  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const selectedRowIds = useSelector((s: RootState) => s.selection.selectedRowIds)
  const rowIds = useSelector(selectEffectiveRowIds)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const targets = useMiningTargets()
  const { schemaRevision, getColumn, formatValueLabel } = useCodebook()
  const requestVersion = useRef(0)
  const resultContext = useRef('')
  const context = useMemo(() => JSON.stringify([datasetId, schemaRevision, dataRevision, rowIds, targets.attributes, targets.questions]),
    [datasetId, schemaRevision, dataRevision, rowIds, targets.attributes.join('|'), targets.questions.join('|')])
  resultContext.current = context
  const conditionLabel = (c: ModernCondition) => {
    const title = getColumn(c.column)?.label || c.column
    const value = ['==', '!=', 'in'].includes(c.operator)
      ? `「${formatValueLabel(c.column, c.value)}」` : String(c.value)
    return `${title} ${c.operator} ${value}`
  }

  const [miningMode, setMiningMode] = useState<'auto' | 'standard' | 'emm_kendall'>('auto')
  const [verificationModalOpen, setVerificationModalOpen] = useState(false)
  const [maxDepth, setMaxDepth] = useState<number>(2)
  const [minGroupSize, setMinGroupSize] = useState<number>(30)
  const [topK, setTopK] = useState<number>(12)
  const [filterQuestion, setFilterQuestion] = useState<string>('all')
  const [filterBySelection, setFilterBySelection] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<{ message: string; details?: string; suggestedActions?: string[] } | null>(null)
  const [result, setResult] = useState<ModernMiningResult | null>(null)
  const [selectedInsightId, setSelectedInsightId] = useState<string | null>(null)
  const [verificationResult, setVerificationResult] = useState<VerificationResultItem[] | null>(null)
  const [verificationInfo, setVerificationInfo] = useState<VerificationInfo | null>(null)
  const [verifying, setVerifying] = useState(false)
  /** Only used to offer independent-verification targets; never the analysis subject. */
  const [datasets, setDatasets] = useState<{ value: string; label: string }[]>([])

  // Verification is refused unless the scope hash matches exploration, so it has
  // to be fed exactly the rows the modern run scoped, filter included.
  const scopeRowIds = useMemo(() => {
    if (!filterBySelection) return rowIds
    const selected = new Set(selectedRowIds)
    return rowIds.filter((id) => selected.has(id))
  }, [rowIds, selectedRowIds, filterBySelection])
  const inputContext = useMemo(() => JSON.stringify([context, miningMode, maxDepth, minGroupSize, topK, filterBySelection, filterBySelection ? selectedRowIds : null]),
    [context, miningMode, maxDepth, minGroupSize, topK, filterBySelection, filterBySelection ? selectedRowIds : null])
  resultContext.current = inputContext

  useEffect(() => {
    requestVersion.current += 1
    setResult(null)
    setSelectedInsightId(null)
    setLoading(false)
    setError(null)
    setVerificationResult(null)
    setVerificationInfo(null)
  }, [inputContext])

  // The picker has to be filled before it opens, or 独立データ指定 looks dead;
  // the current dataset is filtered out by the modal itself.
  const openVerificationModal = useCallback(() => {
    setVerificationModalOpen(true)
    void api.get<{ datasets: { datasetId: string; name: string; rowCount: number }[] }>('/datasets')
      .then((res) => setDatasets((res.datasets ?? []).map((d) => ({
        value: d.datasetId, label: `${d.name}（${d.rowCount}行）`,
      }))))
      .catch(() => setDatasets([]))
  }, [])

  /**
   * Modern candidates are verified through the classic verification endpoint:
   * it loads the pinned set by hash and re-tests each candidate's own contrast,
   * whichever algorithm pinned it. Only the hash is sent, never candidate ids.
   */
  const runVerification = async (config: VerificationConfig) => {
    if (!datasetId || !result?.candidateSetHash) return
    const version = ++requestVersion.current, startedContext = resultContext.current
    setVerifying(true)
    setError(null)
    try {
      const res = await api.post<{ verification?: VerificationInfo; results?: VerificationResultItem[] }>(
        '/mining/subgroups', {
          datasetId,
          attributeCols: targets.attributes,
          questionCols: targets.questions,
          rowIds: scopeRowIds,
          expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision,
          minGroupSize,
          analysisMode: 'verification',
          verificationConfig: config,
          candidateSetHash: result.candidateSetHash,
        })
      if (version !== requestVersion.current || startedContext !== resultContext.current) return
      setVerificationResult(res.results ?? null)
      setVerificationInfo(res.verification ?? null)
      setVerificationModalOpen(false)
    } catch (e: any) {
      if (version !== requestVersion.current || startedContext !== resultContext.current) return
      const details = typeof e?.details === 'object' ? JSON.stringify(e.details, null, 2) : (e?.details ? String(e.details) : undefined)
      setError({
        message: e?.message || '検証の実行に失敗しました。',
        details,
        suggestedActions: Array.isArray(e?.suggestedActions) ? e.suggestedActions : undefined,
      })
    } finally {
      if (version === requestVersion.current && startedContext === resultContext.current) setVerifying(false)
    }
  }

  // Omnipresent Auto-mining runner
  const runAutoMining = async (overrideMode?: 'auto' | 'standard' | 'emm_kendall', overrideFilterSelection?: boolean) => {
    if (!datasetId || !targets.ready) return
    const version = ++requestVersion.current
    const startedContext = resultContext.current
    setLoading(true)
    setError(null)
    // A new exploration pins a new candidate set, so any previous verification
    // of the old set no longer describes the candidates on screen.
    setVerificationResult(null)
    setVerificationInfo(null)
    try {
      const shouldUseFilter = overrideFilterSelection !== undefined ? overrideFilterSelection : filterBySelection
      const payload: any = {
        datasetId,
        attributeCols: targets.attributes, targetQuestions: targets.questions, rowIds,
        expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision,
        mode: overrideMode || miningMode,
        maxDepth,
        minGroupSize,
        topK,
        selectedRowIds: shouldUseFilter ? selectedRowIds : undefined,
      }

      const res = await api.post<ModernMiningResult>('/mining/modern-subgroup', payload)
      if (version !== requestVersion.current || startedContext !== resultContext.current) return
      setResult(res)
      if (res.insights.length > 0) {
        setSelectedInsightId(res.insights[0].id)
      } else {
        setSelectedInsightId(null)
      }
    } catch (e: any) {
      if (version !== requestVersion.current || startedContext !== resultContext.current) return
      console.error('Failed to run omnipresent auto mining', e)
      const msg = e?.message || e?.detail || 'マイニング処理中にエラーが発生しました。'
      const details = typeof e?.details === 'object' ? JSON.stringify(e.details, null, 2) : (e?.details ? String(e.details) : undefined)
      const actions = Array.isArray(e?.suggestedActions) ? e.suggestedActions : undefined
      setError({ message: msg, details, suggestedActions: actions })
    } finally {
      if (version === requestVersion.current && startedContext === resultContext.current) setLoading(false)
    }
  }

  // Extract all distinct questions present in results for filtering
  const availableQuestionsInResults = useMemo(() => {
    if (!result) return []
    const set = new Set<string>()
    result.insights.forEach((ins) => {
      if (ins.target_question) set.add(ins.target_question)
      if (ins.target_pair) {
        ins.target_pair.forEach((q) => set.add(q))
      }
    })
    return Array.from(set)
  }, [result])

  // Filtered insights by selected question filter
  const displayedInsights = useMemo(() => {
    if (!result) return []
    if (filterQuestion === 'all') return result.insights
    return result.insights.filter((ins) => {
      if (ins.target_question === filterQuestion) return true
      if (ins.target_pair && ins.target_pair.includes(filterQuestion)) return true
      return false
    })
  }, [result, filterQuestion])

  const handleApplyToPcp = (insight: ModernInsight) => {
    // Apply row selection
    dispatch(
      selectionApplied({
        rowIds: insight.coverage.row_ids,
        operation: getBrushOp(),
        label: `Subgroup: ${insight.rule.text}`,
      })
    )

    navigate('/pcp')
  }

  const selectedInsight = useMemo(() => {
    if (!result || !selectedInsightId) return null
    return result.insights.find((ins) => ins.id === selectedInsightId) || null
  }, [result, selectedInsightId])

  const selectedVerification = useMemo(
    () => (selectedInsight ? verificationFor(verificationResult, selectedInsight.id) : null),
    [verificationResult, selectedInsight],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top Header & Omnipresent Control Bar */}
      <Card size="small" style={{ background: '#fafafa' }}>
        {targets.control}
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} md={7}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
              探索アルゴリズム:
            </Typography.Text>
            <Radio.Group
              value={miningMode}
              onChange={(e) => {
                const newMode = e.target.value
                setMiningMode(newMode)
              }}
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="auto">全自動 (標準 ＋ EMM)</Radio.Button>
              <Radio.Button value="standard">複合条件のみ</Radio.Button>
              <Radio.Button value="emm_kendall">相関特異性のみ</Radio.Button>
            </Radio.Group>
          </Col>

          <Col xs={12} md={3}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>最大深さ:</Typography.Text>
            <AntSelect
              style={{ width: '100%' }}
              size="small"
              value={maxDepth}
              onChange={setMaxDepth}
              options={[
                { label: '1 (単一属性/区間)', value: 1 },
                { label: '2 (2属性の複合条件)', value: 2 },
              ]}
            />
          </Col>

          <Col xs={12} md={3}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>最小人数:</Typography.Text>
            <InputNumber
              style={{ width: '100%' }}
              size="small"
              min={5}
              max={500}
              value={minGroupSize}
              onChange={(v) => setMinGroupSize(v || 30)}
            />
          </Col>

          <Col xs={12} md={3}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>表示上限:</Typography.Text>
            <InputNumber
              style={{ width: '100%' }}
              size="small"
              min={1}
              max={30}
              value={topK}
              onChange={(v) => setTopK(v || 12)}
            />
          </Col>

          <Col xs={12} md={4}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
              <FilterOutlined /> 質問絞り込み:
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              size="small"
              value={filterQuestion}
              onChange={setFilterQuestion}
              options={[
                { label: '全ての質問 (全件表示)', value: 'all' },
                ...availableQuestionsInResults.map((q) => ({ label: q, value: q })),
              ]}
            />
          </Col>

          <Col xs={24} md={4} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            {selectedRowIds && selectedRowIds.length > 0 && (
              <Checkbox
                checked={filterBySelection}
                onChange={(e) => {
                  const checked = e.target.checked
                  setFilterBySelection(checked)
                }}
                style={{ fontSize: 11, marginBottom: 4 }}
              >
                PCP選択行 ({selectedRowIds.length}件) に絞り込む
              </Checkbox>
            )}
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => void runAutoMining()}
              loading={loading}
              disabled={!targets.ready}
              style={{ width: '100%' }}
            >
              指定対象で実行
            </Button>
          </Col>
        </Row>
      </Card>

      {/* Dataset not selected prompt */}
      {!datasetId && (
        <Alert
          type="info"
          showIcon
          message="データセットが選択されていません"
          description="上部のメニューまたはデータセット管理画面から分析対象のデータセットを選択してください。"
        />
      )}

      {/* Error Alert Display */}
      {error && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setError(null)}
          message="マイニング処理エラー"
          description={
            <div style={{ marginTop: 4 }}>
              <div style={{ fontWeight: 500 }}>{error.message}</div>
              {error.suggestedActions && error.suggestedActions.length > 0 && (
                <ul style={{ margin: '6px 0 0 0', paddingLeft: 20 }}>
                  {error.suggestedActions.map((act, idx) => (
                    <li key={idx}>{act}</li>
                  ))}
                </ul>
              )}
              {error.details && (
                <pre
                  style={{
                    marginTop: 8,
                    padding: 8,
                    background: 'rgba(0,0,0,0.04)',
                    borderRadius: 4,
                    fontSize: 11,
                    maxHeight: 140,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {error.details}
                </pre>
              )}
              <div style={{ marginTop: 8 }}>
                <Button size="small" type="primary" danger onClick={() => void runAutoMining()}>
                  再試行
                </Button>
              </div>
            </div>
          }
        />
      )}

      {/* Summary KPI Cards */}
      {result && (
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="評価した質問数"
                value={result.summary.questions_evaluated_count ?? targets.questions.length}
                prefix={<LineChartOutlined />}
                suffix="問"
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="総探索ルール数"
                value={result.summary.total_candidates_explored}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="厳選インサイト数"
                value={result.summary.non_redundant_insights_count}
                valueStyle={{ color: '#1677ff' }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                全質問を横断して最もスコアが高い発見をリストアップしています。
                特定の質問に偏らないよう、1問あたりの選出上限を設定して多様性を確保しています。
              </Typography.Text>
            </Card>
          </Col>
        </Row>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin tip="全質問変数を対象に網羅的な自動マイニングを実行中..." size="large"><div style={{ height: 80 }} /></Spin>
        </div>
      )}

      {/* Result Cards & Detail View */}
      {result?.inferenceMode === 'exploration' && !loading && (
        <Alert
          type="warning"
          showIcon
          message="🔍 探索的候補"
          description={result.explorationNote ?? 'この結果は全データ上の探索であり、母集団への確証ではありません。'}
          data-testid="modern-exploration-badge"
        />
      )}
      {verificationInfo && !loading && (
        <Alert
          type="success"
          showIcon
          message="検証済み候補"
          description={`手法: ${METHOD_LABEL[verificationInfo.method] ?? verificationInfo.method}／検定: ${verificationInfo.testUsed.join(', ') || 'なし'}／補正: ${verificationInfo.correction}（α=${verificationInfo.alpha}）／family=${verificationInfo.mHypotheses}／対象外=${verificationInfo.mExcluded}／nSelection=${verificationInfo.nSelection}／nEvaluation=${verificationInfo.nEvaluation}／seed=${verificationInfo.seed}${verificationInfo.note ? `／${verificationInfo.note}` : ''}`}
          data-testid="modern-verification-badge"
        />
      )}
      {result && !loading && (
        <Row gutter={[16, 16]}>
          {/* Left: Insight Cards List */}
          <Col xs={24} md={14}>
            <Typography.Title level={5} style={{ marginBottom: 8 }}>
              全データから自動抽出された最重要インサイト ({displayedInsights.length} 件)
            </Typography.Title>

            {displayedInsights.length === 0 ? (
              <Empty description="条件に合致するインサイトはありませんでした。" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {displayedInsights.map((ins, idx) => {
                  const isSelected = ins.id === selectedInsightId
                  const isNumeric = ins.target_stats.delta_mean !== undefined
                  const isBinary = ins.target_stats.delta_proportion !== undefined
                  const isEmm = ins.emm_stats !== null && ins.emm_stats !== undefined

                  return (
                    <Card
                      key={ins.id}
                      size="small"
                      hoverable
                      onClick={() => setSelectedInsightId(ins.id)}
                      style={{
                        borderColor: isSelected ? '#1677ff' : '#f0f0f0',
                        boxShadow: isSelected ? '0 0 0 2px rgba(22, 119, 255, 0.2)' : undefined,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
                            <Tag color="blue">#{idx + 1}</Tag>
                            {/* Target Question / Pair Badge */}
                            {ins.target_question && (
                              <Tag color="geekblue" style={{ fontWeight: 'bold', maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                                対象: 【<ColumnQuestionTooltip nameOrId={ins.target_question!}>{ins.target_question}</ColumnQuestionTooltip>】
                              </Tag>
                            )}
                            {ins.target_pair && (
                              <Tag color="volcano" style={{ fontWeight: 'bold', maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                                対象ペア: 【<ColumnQuestionTooltip nameOrId={ins.target_pair[0]}>{ins.target_pair[0]}</ColumnQuestionTooltip> × <ColumnQuestionTooltip nameOrId={ins.target_pair[1]}>{ins.target_pair[1]}</ColumnQuestionTooltip>】
                              </Tag>
                            )}
                            {ins.parent_insight_id && (
                              <Tag color="purple">
                                親ルール: #{ins.parent_insight_id.replace('msd_', '')} ({ins.parent_delta_mean! >= 0 ? `+${ins.parent_delta_mean}` : ins.parent_delta_mean})
                              </Tag>
                            )}
                            {/* Condition chips */}
                            {ins.rule.conditions.map((c, ci) => (
                              <Tag key={ci} color="cyan" style={{ maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}><ColumnQuestionTooltip nameOrId={c.column}>{conditionLabel(c)}</ColumnQuestionTooltip></Tag>
                            ))}
                          </div>
                        </div>
                        <Button
                          style={{ flexShrink: 0, maxWidth: '100%' }}
                          size="small"
                          type="primary"
                          ghost
                          icon={<SwapOutlined />}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleApplyToPcp(ins)
                          }}
                        >
                          PCPで表示
                        </Button>
                      </div>

                      {/* Metrics row */}
                      <Row gutter={8} align="middle" style={{ marginTop: 6, marginBottom: 6 }}>
                        {isNumeric && (
                          <>
                            <Col span={8}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>サブグループ平均:</Typography.Text>
                              <Typography.Text strong style={{ fontSize: 16, display: 'block', color: '#1677ff' }}>
                                {ins.target_stats.subgroup_mean?.toFixed(2)}
                              </Typography.Text>
                            </Col>
                            <Col span={8}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>他群平均 (差):</Typography.Text>
                              <Typography.Text strong style={{ fontSize: 14, display: 'block' }}>
                                {ins.target_stats.complement_mean?.toFixed(2)}{' '}
                                <span style={{ color: (ins.target_stats.delta_mean || 0) >= 0 ? '#52c41a' : '#f5222d' }}>
                                  ({(ins.target_stats.delta_mean || 0) >= 0 ? '+' : ''}{ins.target_stats.delta_mean?.toFixed(2)})
                                </span>
                              </Typography.Text>
                            </Col>
                            <Col span={8}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>標準偏差比:</Typography.Text>
                              <Typography.Text style={{ fontSize: 13, display: 'block' }}>
                                {ins.target_stats.subgroup_sd?.toFixed(2)} / 他群 {ins.target_stats.complement_sd?.toFixed(2)}
                              </Typography.Text>
                            </Col>
                          </>
                        )}

                        {isBinary && (
                          <>
                            <Col span={8}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>該当割合:</Typography.Text>
                              <Typography.Text strong style={{ fontSize: 16, display: 'block', color: '#1677ff' }}>
                                {((ins.target_stats.subgroup_proportion || 0) * 100).toFixed(1)}%
                              </Typography.Text>
                            </Col>
                            <Col span={8}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>他群割合 (差):</Typography.Text>
                              <Typography.Text strong style={{ fontSize: 14, display: 'block' }}>
                                {((ins.target_stats.complement_proportion || 0) * 100).toFixed(1)}%{' '}
                                <span style={{ color: (ins.target_stats.delta_proportion || 0) >= 0 ? '#52c41a' : '#f5222d' }}>
                                  ({(ins.target_stats.delta_proportion || 0) >= 0 ? '+' : ''}{((ins.target_stats.delta_proportion || 0) * 100).toFixed(1)}%pt)
                                </span>
                              </Typography.Text>
                            </Col>
                          </>
                        )}

                        {isEmm && (
                          <>
                            <Col span={8}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>サブグループ Kendall τ:</Typography.Text>
                              <Typography.Text strong style={{ fontSize: 16, display: 'block', color: '#1677ff' }}>
                                {ins.emm_stats?.subgroup_tau.toFixed(2)}
                              </Typography.Text>
                            </Col>
                            <Col span={8}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>他群 Kendall τ (差):</Typography.Text>
                              <Typography.Text strong style={{ fontSize: 14, display: 'block' }}>
                                {ins.emm_stats?.complement_tau.toFixed(2)}{' '}
                                <span style={{ color: '#fa8c16' }}>
                                  (Δ {ins.emm_stats?.delta_tau.toFixed(2)})
                                </span>
                              </Typography.Text>
                            </Col>
                            <Col span={8}>
                              {ins.emm_stats?.reversal && (
                                <Tag color="volcano" icon={<SwapOutlined />}>順位相関逆方向</Tag>
                              )}
                            </Col>
                          </>
                        )}
                      </Row>

                      {/* Footer tags and coverage */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                        <Space size={4}>
                          <Tag color="default">人数: {ins.coverage.n}名 ({(ins.coverage.ratio * 100).toFixed(1)}%)</Tag>
                          <Tag color="geekblue">探索スコア: {ins.score.toFixed(2)}</Tag>
                          {ins.ranking_reason && (
                            <Tag color="orange">{ins.ranking_reason.description}</Tag>
                          )}
                        </Space>
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </Col>

          {/* Right: Selected Insight Detail Summary */}
          <Col xs={24} md={10}>
            {selectedInsight ? (
              <Card title="選択中インサイトの詳細解説" size="small" style={{ position: 'sticky', top: 16 }}>
                <Typography.Paragraph strong style={{ fontSize: 14 }}>
                  {selectedInsight.narrative}
                </Typography.Paragraph>

                <Divider style={{ margin: '12px 0' }} />

                <Typography.Text strong>対象質問:</Typography.Text>
                <div style={{ marginTop: 4, marginBottom: 12 }}>
                  {selectedInsight.target_question && (
                    <Tag color="geekblue" style={{ fontSize: 13, padding: '4px 8px' }}>
                      【質問変数】<ColumnQuestionTooltip nameOrId={selectedInsight.target_question!}>{selectedInsight.target_question}</ColumnQuestionTooltip>
                    </Tag>
                  )}
                  {selectedInsight.target_pair && (
                    <Tag color="volcano" style={{ fontSize: 13, padding: '4px 8px' }}>
                      【質問ペア】<ColumnQuestionTooltip nameOrId={selectedInsight.target_pair[0]}>{selectedInsight.target_pair[0]}</ColumnQuestionTooltip> × <ColumnQuestionTooltip nameOrId={selectedInsight.target_pair[1]}>{selectedInsight.target_pair[1]}</ColumnQuestionTooltip>
                    </Tag>
                  )}
                </div>

                <Typography.Text strong>ルール条件構成:</Typography.Text>
                <ul style={{ paddingLeft: 20, marginTop: 4 }}>
                  {selectedInsight.rule.conditions.map((c, i) => (
                    <li key={i}>
                      <code><ColumnQuestionTooltip nameOrId={c.column}>{conditionLabel(c)}</ColumnQuestionTooltip></code>
                    </li>
                  ))}
                </ul>

                <Divider style={{ margin: '12px 0' }} />

                <Typography.Text strong>集団サイズ・構成:</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  ・対象行数: <b>{selectedInsight.coverage.n} 行</b>（全体の {(selectedInsight.coverage.ratio * 100).toFixed(1)}%）
                </div>

                {verificationResult && (
                  <>
                    <Divider style={{ margin: '12px 0' }} />
                    <div data-testid="modern-verification-findings">
                      <Typography.Text strong>検証結果（固定候補・評価側のみ）:</Typography.Text>
                      {!selectedVerification ? (
                        <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}>
                          この候補は探索時の固定候補に含まれていないため、検証の対象外です。
                        </Typography.Paragraph>
                      ) : !selectedVerification.testable || !selectedVerification.test ? (
                        // No estimate exists for an untestable candidate, so a
                        // blank row would read as "no difference found".
                        <Alert
                          type="warning"
                          showIcon
                          style={{ marginTop: 8 }}
                          message={`検定できません（${selectedVerification.reason ?? 'UNKNOWN'}）`}
                          description={untestableReason(selectedVerification)}
                        />
                      ) : (
                        <>
                          <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
                            <Col span={8}>
                              <Statistic
                                title={`p値 (${selectedVerification.test.name ?? '—'})`}
                                value={selectedVerification.test.pValue ?? '-'}
                                data-testid="modern-verification-p-value"
                              />
                            </Col>
                            <Col span={8}>
                              <Statistic
                                title={`補正後p値 (${verificationInfo?.correction ?? 'bh-fdr'})`}
                                value={selectedVerification.test.pAdjusted ?? '-'}
                                valueStyle={{ color: '#1677ff' }}
                                data-testid="modern-verification-p-adjusted"
                              />
                            </Col>
                            <Col span={8}>
                              <Statistic
                                title="差の95% CI"
                                value={selectedVerification.effect?.ci95
                                  ? `[${selectedVerification.effect.ci95[0].toFixed(3)}, ${selectedVerification.effect.ci95[1].toFixed(3)}]`
                                  : '-'}
                                valueStyle={{ fontSize: 13 }}
                                data-testid="modern-verification-ci"
                              />
                            </Col>
                          </Row>
                          <Space size={4} style={{ marginTop: 8 }} data-testid="modern-verification-replication">
                            <Tag color={REPLICATION_COLOR[selectedVerification.replicationStatus]}>
                              {REPLICATION_LABEL[selectedVerification.replicationStatus]}
                            </Tag>
                            {selectedVerification.test.significant
                              ? <Tag color="green">補正後も有意</Tag>
                              : <Tag>補正後は非有意</Tag>}
                            <Tag>点推定 {selectedVerification.effect?.estimate?.toFixed(4) ?? '-'}</Tag>
                            <Tag>評価 {selectedVerification.n.used} 行</Tag>
                          </Space>
                        </>
                      )}
                    </div>
                  </>
                )}

                <Divider style={{ margin: '12px 0' }} />

                <Space direction="vertical" style={{ width: '100%' }}>
                  <Button
                    type="primary"
                    block
                    icon={<SwapOutlined />}
                    onClick={() => handleApplyToPcp(selectedInsight)}
                  >
                    このセグメントをPCPで表示
                  </Button>
                  <Button
                    block
                    onClick={openVerificationModal}
                    loading={verifying}
                    // Verification re-tests the pinned set, so without a hash
                    // there is nothing to evaluate.
                    disabled={!result?.candidateSetHash}
                    data-testid="modern-to-verification-btn"
                  >
                    検証モードへ移行（候補を固定して評価）
                  </Button>
                  <Button
                    block
                    icon={<ThunderboltOutlined />}
                    onClick={() => {
                      const targetCol = selectedInsight.target_question || (selectedInsight.target_pair ? selectedInsight.target_pair[0] : undefined)
                      if (!targetCol) return
                      const conclusion = {
                        id: `modern_${selectedInsight.id}`,
                        type: 'subgroup_diff',
                        metric: `subgroup_diff_${targetCol}`,
                        label: selectedInsight.narrative.slice(0, 60),
                        target_col: targetCol,
                        subgroup_row_ids: selectedInsight.coverage.row_ids,
                      }
                      navigate('/robustness', { state: { conclusion } })
                    }}
                    data-testid="modern-send-to-robustness-btn"
                  >
                    この結論の感度分析へ (Send to Robustness)
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    該当行を共通の選択に反映してPCPへ移動します。PCPの表示軸は保持されます。
                  </Typography.Text>
                </Space>
              </Card>
            ) : (
              <Card size="small">
                <Empty description="左の一覧からインサイトを選択してください。" />
              </Card>
            )}
          </Col>
        </Row>
      )}
      <VerificationConfigModal
        open={verificationModalOpen}
        candidateCount={result?.candidates?.length ?? 0}
        candidateSetHash={result?.candidateSetHash ?? null}
        datasets={datasets}
        currentDatasetId={datasetId}
        alpha={VERIFICATION_ALPHA}
        onCancel={() => setVerificationModalOpen(false)}
        onRun={(config) => void runVerification(config)}
      />
    </div>
  )
}
export default ModernSubgroupMiningView
