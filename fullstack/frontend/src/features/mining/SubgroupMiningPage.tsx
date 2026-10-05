import Statistic from '../common/RoundedStatistic'
import { useScopedRun, AnalysisScopeSummary, AnalysisViewActivityContext, useAnalysisViewActive } from '../selection/analysisScope'
import { Select as AntSelect } from 'antd'
import { AnalysisField, AnalysisSettings, AnalysisRunRow } from '../common/AnalysisSetup'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import VerificationConfigModal, { type VerificationConfig } from './VerificationConfigModal'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Button, Typography, Space, Tag, Row, Col,
  Alert, Spin, Empty, InputNumber, Divider, Tabs,
} from 'antd'
import {
  ThunderboltOutlined, AimOutlined, CheckCircleOutlined,
  ArrowRightOutlined, BarChartOutlined, LineChartOutlined, AppstoreOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, selectEffectiveRowIds } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import { useMiningTargets } from './useMiningTargets'
import { getBrushOp } from '../selection/SelectionMenu'
import { api } from '../../api/client'
import ModernSubgroupMiningView from './ModernSubgroupMiningView'
import {
  verificationFor, verificationListSummary,
  type PinnedCandidateSummary, type VerificationInfo, type VerificationResultItem,
} from './verification'
import { VerificationFindings, VerificationSummary } from './VerificationResults'

export interface InsightItem {
  id: string
  subgroup: { name: string; label: string; type: string }
  question: { name: string; label: string; type: string }
  test: {
    method: string
    statistic: number | null
    p_value: number | null
    q_value: number | null
    significant: boolean
  }
  effect: {
    measure: string
    value: number
    label: string
  }
  group_stats: Array<{
    group: string
    n: number
    mean?: number
    sd?: number
    median?: number
    most_frequent_cat?: string
  }>
  contingency?: {
    rows: string[]
    cols: string[]
    observed: number[][]
    expected: number[][]
    residuals: number[][]
  }
  direction: Record<string, any>
  posthoc: Array<{
    pair: string[]
    p_adj: number
    significant: boolean
  }>
  scores: {
    stat: number
    effect: number
    practical: number
    surprise?: number | null
    insight_score: number
  }
  narrative: string
  warnings: string[]
  row_ids: Record<string, string[]>
}

export interface MiningResult {
  run_id: string
  summary: {
    n_subgroup_vars: number
    n_questions: number
    n_tests_run: number
    n_significant_fdr: number
    n_significant_bonferroni: number
    n_insights_after_filters: number
  }
  insights: InsightItem[]
  analysisMode?: 'exploration' | 'verification' | 'posthoc_stability'
  isExploratory?: boolean
  candidateSetHash?: string
  explorationNote?: string
  /** The candidates exploration pinned, in the order the server holds them. */
  candidates?: PinnedCandidateSummary[]
  verification?: VerificationInfo
  results?: VerificationResultItem[]
}

export default function SubgroupMiningPage() {
  const dispatch = useDispatch<AppDispatch>()
  const pageActive = useAnalysisViewActive()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  const targets = useMiningTargets()
  const rowIds = useSelector(selectEffectiveRowIds)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const { schemaRevision } = useCodebook()
  const [alpha, setAlpha] = useState<number>(0.05)
  const [minGroupSize, setMinGroupSize] = useState<number>(10)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<{ message: string; details?: string; suggestedActions?: string[] } | null>(null)
  const [miningResult, setMiningResult] = useState<MiningResult | null>(null)
  const [selectedInsightId, setSelectedInsightId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'modern' | 'classic'>('modern')
  const [inferenceMode, setInferenceMode] = useState<'exploration' | 'verification'>('exploration')
  const [verificationModalOpen, setVerificationModalOpen] = useState(false)
  const [verificationResult, setVerificationResult] = useState<VerificationResultItem[] | null>(null)
  const [verificationInfo, setVerificationInfo] = useState<VerificationInfo | null>(null)
  const [verifying, setVerifying] = useState(false)
  /** Only used to offer independent-verification targets; never the analysis subject. */
  const [datasetsLoading, setDatasetsLoading] = useState(false)
  const [datasetsError, setDatasetsError] = useState<string | null>(null)
  const [datasets, setDatasets] = useState<{ value: string; label: string }[]>([])
  const context = useMemo(() => JSON.stringify([datasetId, dataRevision, schemaRevision, rowIds, targets.attributes, targets.questions, alpha, minGroupSize]),
    [datasetId, dataRevision, schemaRevision, rowIds, targets.attributes.join('|'), targets.questions.join('|'), alpha, minGroupSize])
  const runScope = useScopedRun(context)
  const [runInput, setRunInput] = useState<Record<string, unknown> | null>(null)
  const verificationVersion = useRef(0)
  const verificationPending = useRef(false)
  const datasetListVersion = useRef(0)
  const resultRef = useRef(miningResult)
  resultRef.current = miningResult
  const identityRef = useRef(runScope.identity)
  identityRef.current = runScope.identity


  useEffect(() => {
    verificationVersion.current += 1
    datasetListVersion.current += 1
    verificationPending.current = false
    setVerificationModalOpen(false)
    setDatasets([])
    setDatasetsLoading(false)
    setDatasetsError(null)
    setRunInput(null)
    setVerifying(false)
    setMiningResult(null); setSelectedInsightId(null); setLoading(false); setError(null)
    setVerificationResult(null); setVerificationInfo(null); setInferenceMode('exploration')
  }, [runScope.identity])

  useEffect(() => () => {
    verificationVersion.current += 1
    datasetListVersion.current += 1
  }, [])

  const cancelVerification = useCallback(() => {
    verificationVersion.current += 1
    datasetListVersion.current += 1
    verificationPending.current = false
    setVerifying(false)
    setDatasetsLoading(false)
    setVerificationModalOpen(false)
  }, [])

  // Refresh the eligible independent datasets; ignore a closed or superseded picker.
  const openVerificationModal = useCallback(() => {
    const version = ++datasetListVersion.current
    setDatasets([])
    setDatasetsLoading(true)
    setDatasetsError(null)
    setError(null)
    setVerificationModalOpen(true)
    void api.get<{ datasets: { datasetId: string; name: string; rowCount: number }[] }>('/datasets')
      .then((res) => {
        if (version !== datasetListVersion.current) return
        setDatasetsLoading(false)
        setDatasets((res.datasets ?? []).map((d) => ({ value: d.datasetId, label: `${d.name}（${d.rowCount}行）` })))
      })
      .catch(() => {
        if (version !== datasetListVersion.current) return
        setDatasetsLoading(false)
        setDatasetsError('データセットを取得できませんでした')
      })
  }, [])

  const runVerification = async (config: VerificationConfig) => {
    if (verificationPending.current) return
    if (config.method === 'independent' && (datasetsLoading || datasetsError || !config.independent_dataset_id
      || config.independent_dataset_id === datasetId
      || !datasets.some(dataset => dataset.value === config.independent_dataset_id))) return
    if (!datasetId || !miningResult || !runInput) return
    if (!miningResult.candidateSetHash) {
      setError({ message: '候補集合が発行されていません。もう一度探索してください。' })
      return
    }
    const version = ++verificationVersion.current, sourceResult = miningResult, sourceIdentity = runScope.identity
    const isCurrent = () => version === verificationVersion.current && resultRef.current === sourceResult && identityRef.current === sourceIdentity
    verificationPending.current = true
    setVerifying(true)
    setError(null)
    try {
      // Only the hash is sent: the server re-tests the pinned set. Naming
      // individual candidates would fail whenever an insight produced no
      // pinned contrast, and re-listing them invites re-discovery.
      const res = await api.post<MiningResult>('/mining/subgroups', {
        ...runInput,
        analysisMode: 'verification',
        verificationConfig: config,
        candidateSetHash: miningResult.candidateSetHash,
      })
      if (!isCurrent()) return
      setVerificationResult(res.results ?? null)
      setVerificationInfo(res.verification ?? null)
      setInferenceMode('verification')
      setVerificationModalOpen(false)
    } catch (err: any) {
      if (!isCurrent()) return
      setError({ message: err?.message || '検証の実行に失敗しました。' })
    } finally {
      if (isCurrent()) { verificationPending.current = false; setVerifying(false) }
    }
  }

  const runMining = async () => {
    if (!datasetId || !targets.ready) return
    const ticket = runScope.begin()
    cancelVerification()
    setLoading(true)
    setError(null)
    // A new exploration pins a new candidate set, so a previous verification of
    // the old set would otherwise stay on screen labelled as this run's result.
    setVerificationResult(null)
    setVerificationInfo(null)
    setInferenceMode('exploration')
    try {
      const payload = {
        datasetId,
        attributeCols: targets.attributes,
        questionCols: targets.questions,
        rowIds: ticket.scope.rowIds, expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision,
        alpha,
        minGroupSize,
      }
      const res = await api.post<MiningResult>('/mining/subgroups', payload)
      if (!ticket.isCurrent()) return
      ticket.commit()
      setRunInput(payload)
      setMiningResult(res)
      if (res.insights.length > 0) {
        setSelectedInsightId(res.insights[0].id)
      } else {
        setSelectedInsightId(null)
      }
    } catch (err: any) {
      if (!ticket.isCurrent()) return
      console.error('Mining execution error', err)
      const msg = err?.message || err?.detail || '単変量マイニング処理中にエラーが発生しました。'
      const details = typeof err?.details === 'object' ? JSON.stringify(err.details, null, 2) : (err?.details ? String(err.details) : undefined)
      const actions = Array.isArray(err?.suggestedActions) ? err.suggestedActions : undefined
      setError({ message: msg, details, suggestedActions: actions })
    } finally {
      if (ticket.isCurrent()) setLoading(false)
    }
  }

  const currentInsight = useMemo(() => {
    if (!miningResult || !selectedInsightId) return null
    return miningResult.insights.find((ins) => ins.id === selectedInsightId) ?? miningResult.insights[0] ?? null
  }, [miningResult, selectedInsightId])

  const currentVerification = useMemo(
    () => (currentInsight ? verificationFor(verificationResult, currentInsight.id) : null),
    [verificationResult, currentInsight],
  )

  const handleSelectRowsInPcp = (insight: InsightItem) => {
    const rids = insight.row_ids?.highest_group || insight.row_ids?.top_group || []
    if (rids.length > 0) {
      dispatch(selectionApplied({
        rowIds: rids,
        operation: getBrushOp(),
        label: `Subgroup: ${insight.subgroup.name}=${insight.direction.highest_group || insight.direction.top_group}`,
      }))
    }
  }

  const handleFocusPcpPair = (insight: InsightItem) => {
    handleSelectRowsInPcp(insight)
    navigate('/pcp')
  }

  return (
    <div
      style={{
        padding: 16,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        minHeight: 0,
      }}
      data-testid="subgroup-mining-page"
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => {
          if (k !== 'classic') cancelVerification()
          setActiveTab(k as 'modern' | 'classic')
        }}
        type="card"

        style={{
          marginBottom: 12,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
        items={[
          {
            key: 'modern',
            label: (
              <span>
                <ThunderboltOutlined />
                現代的サブグループ発見 (複合条件 / Kendall-EMM)
              </span>
            ),
            children: <AnalysisViewActivityContext.Provider value={pageActive && activeTab === 'modern'}><ModernSubgroupMiningView /></AnalysisViewActivityContext.Provider>,
          },
          {
            key: 'classic',
            label: (
              <span>
                <AppstoreOutlined />
                単変量総当たりマイニング (従来DAVIS互換)
              </span>
            ),
            children: (
              <>
                <Card title="単変量マイニングの設定" size="small" className="analysis-setup" style={{ marginBottom: 12, flexShrink: 0 }}>
                  <div className="analysis-form-stack">
                    <AnalysisScopeSummary label="次回実行の対象" snapshot={miningResult ? runScope.snapshot : null} />
                    <Typography.Text type="secondary">属性変数と質問変数を選んで探索します。変数・詳細設定の変更は次回の実行に適用されます。</Typography.Text>
                    {targets.control}
                    <AnalysisSettings title="単変量マイニングの詳細設定" summary={`最小人数: ${minGroupSize} / FDR α: ${alpha}`}>
                      <div className="analysis-variable-grid">
                        <AnalysisField label="FDR α" htmlFor="classic-mining-alpha" help="探索中は変更できません。検証後に変更すると、次回の独立データ検証に使うαを選べます。">
                          <AntSelect id="classic-mining-alpha" aria-describedby="classic-mining-alpha-help"
                            style={{ width: '100%' }} value={alpha} onChange={setAlpha} disabled={inferenceMode === 'exploration'}
                            options={[{ label: '0.01 (厳格)', value: 0.01 }, { label: '0.05 (標準)', value: 0.05 }, { label: '0.10 (探索的)', value: 0.10 }]} />
                        </AnalysisField>
                        <AnalysisField label="最小人数 (Min Group Size)" htmlFor="classic-mining-min-size">
                          <InputNumber id="classic-mining-min-size" style={{ width: '100%' }} min={2} max={1000} value={minGroupSize} onChange={(val) => setMinGroupSize(val ?? 10)} />
                        </AnalysisField>
                      </div>
                    </AnalysisSettings>
                    <AnalysisSettings title="探索と検証の見方" summary="探索候補・固定した候補の検証について">
                      <Typography.Text>選んだ属性と質問の組み合わせから差の候補を探します。探索結果は確証ではありません。</Typography.Text>
                      <Typography.Text>検証は探索時の候補集合と対象を固定して行います。ホールドアウト・交差検証は事後的な安定性確認です。</Typography.Text>
                    </AnalysisSettings>
                    {miningResult && runScope.dirty && <Typography.Text type="warning" role="status">表示中の探索結果と検証母集団は実行時の対象を保持しています。再探索すると変数・設定・対象を更新します。</Typography.Text>}
                    {!targets.ready && <Typography.Text type="secondary" role="status">属性変数と質問変数をそれぞれ1つ以上選択してください。</Typography.Text>}
                    <AnalysisRunRow>
                      <Button icon={<CheckCircleOutlined />} onClick={openVerificationModal} loading={verifying}
                        data-testid="mining-to-verification-btn" disabled={loading || !miningResult?.candidateSetHash}
                        style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%' }}>
                        検証モードへ移行
                      </Button>
                      <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void runMining()} loading={loading}
                        data-testid="mining-run-button" disabled={!datasetId || !targets.ready}
                        style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%' }}>
                        Run Auto Mining
                      </Button>
                    </AnalysisRunRow>
                  </div>
                </Card>

                {/* Error Alert Display */}
                {error && (
                  <Alert
                    type="error"
                    showIcon
                    closable
                    onClose={() => setError(null)}
                    message="単変量マイニング処理エラー"
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
                          <Button size="small" type="primary" danger onClick={() => void runMining()}>
                            再試行
                          </Button>
                        </div>
                      </div>
                    }
                    style={{ marginBottom: 12, flexShrink: 0 }}
                  />
                )}

                {/* Exploration badge */}
                {miningResult && inferenceMode === 'exploration' && (
                  <Alert
                    type="warning"
                    showIcon
                    message="🔍 探索的候補"
                    description="この結果は全データ上の探索であり、母集団への確証ではありません。p値・q値・信頼区間は表示しません。"
                    style={{ marginBottom: 12, flexShrink: 0 }}
                    data-testid="exploration-badge"
                  />
                )}
                {inferenceMode === 'verification' && verificationInfo && (
                  <VerificationSummary info={verificationInfo} results={verificationResult} prefix="verification"
                    style={{ marginBottom: 12, flexShrink: 0 }} />
                )}

                {/* Summary KPI Cards */}
                {miningResult && (
                  <Row gutter={[12, 12]} style={{ marginBottom: 12, flexShrink: 0 }}>
                    <Col span={8}>
                      <Card size="small">
                        <Statistic title="探索した比較数" value={miningResult.summary.n_tests_run} prefix={<LineChartOutlined />} />
                      </Card>
                    </Col>
                    <Col span={8}>
                      <Card size="small">
                        <Statistic title="探索候補数" value={miningResult.summary.n_insights_after_filters} prefix={<ThunderboltOutlined />} />
                      </Card>
                    </Col>
                    <Col span={8}>
                      <Card size="small">
                        <Statistic title="属性 × 質問" value={`${miningResult.summary.n_subgroup_vars} × ${miningResult.summary.n_questions}`} />
                      </Card>
                    </Col>
                  </Row>
                )}

                {loading && !miningResult && (
                  <div style={{ textAlign: 'center', padding: 60 }}>
                    <Spin size="large" tip="全組み合わせを統計検証中..." />
                  </div>
                )}

                {/* Split View: Ranking List (Left) & Evidence Drilldown (Right) */}
                {miningResult && (
                  <Row
                    gutter={[16, 16]}
                    style={{
                                            minHeight: 0,
                                          }}
                  >
                    {/* Left: Ranking Cards */}
                    {(
                      <Col xs={24} md={10} style={{ maxHeight: 'calc(100vh - 270px)', overflowY: 'auto' }}>
                        <Typography.Title level={5} style={{ marginTop: 0 }}>
                          発見インサイト一覧 ({miningResult.insights.length} 件)
                        </Typography.Title>
                        <Space direction="vertical" style={{ width: '100%' }}>
                          {miningResult.insights.map((ins, idx) => {
                            const isSelected = ins.id === selectedInsightId
                            const effColor = ins.effect.label === 'large' ? 'green' : (ins.effect.label === 'medium' ? 'blue' : 'orange')
                            return (
                              <Card
                                key={ins.id}
                                size="small"
                                hoverable
                                onClick={() => setSelectedInsightId(ins.id)}
                                style={{
                                  cursor: 'pointer',
                                  border: isSelected ? '2px solid #1677ff' : '1px solid #d9d9d9',
                                  borderRadius: 6,
                                }}
                                data-testid="insight-card"
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <Typography.Text strong style={{ fontSize: 14 }}>
                                    #{idx + 1} <ColumnQuestionTooltip nameOrId={ins.subgroup.name}>{ins.subgroup.label}</ColumnQuestionTooltip> × <ColumnQuestionTooltip nameOrId={ins.question.name}>{ins.question.label}</ColumnQuestionTooltip>
                                  </Typography.Text>
                                  <Space size={4}>
                                    <Tag color={effColor}>{ins.effect.label.toUpperCase()}</Tag>
                                    <Tag color="purple">Score: {ins.scores.insight_score.toFixed(2)}</Tag>
                                  </Space>
                                </div>
                                <div style={{ margin: '6px 0', fontSize: 12, color: '#555' }}>
                                  {ins.test.method} | {ins.effect.measure}: {ins.effect.value.toFixed(2)}
                                  {inferenceMode === 'verification' && verificationResult && (
                                    <span data-testid="verification-list-summary"> | {verificationListSummary(verificationInfo, verificationFor(verificationResult, ins.id))}</span>
                                  )}
                                </div>
                                <Typography.Paragraph
                                  ellipsis={{ rows: 2 }}
                                  style={{ fontSize: 12, marginBottom: 8, color: '#333' }}
                                >
                                  {ins.narrative}
                                </Typography.Paragraph>
                                <Space size={6}>
                                  <Button
                                    size="small"
                                    type={isSelected ? 'primary' : 'default'}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setSelectedInsightId(ins.id)
                                    }}
                                  >
                                    証拠詳細
                                  </Button>
                                  <Button
                                    size="small"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleSelectRowsInPcp(ins)
                                    }}
                                  >
                                    PCP選択
                                  </Button>
                                </Space>
                              </Card>
                            )
                          })}
                          {miningResult.insights.length === 0 && (
                            <Empty description="条件に合致する探索候補は見つかりませんでした。" />
                          )}
                        </Space>
                      </Col>
                    )}

                    {/* Right: Evidence & Drilldown Inspector */}
                    <Col
                      xs={24}
                      md={14}
                      style={{
                                                maxHeight: 'calc(100vh - 270px)',
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                    >
                      {currentInsight ? (
                          <Card
                            size="small"
                            title={
                              <Space wrap>
                                <Typography.Text strong style={{ fontSize: 16 }}>
                                  <ColumnQuestionTooltip nameOrId={currentInsight.subgroup.name}>{currentInsight.subgroup.label}</ColumnQuestionTooltip> × <ColumnQuestionTooltip nameOrId={currentInsight.question.name}>{currentInsight.question.label}</ColumnQuestionTooltip>
                                </Typography.Text>
                                <Tag color="blue">{currentInsight.test.method}</Tag>
                              </Space>
                            }
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              minHeight: 0,
                            }}
                          >
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <Button
                    type="primary"
                    icon={<AimOutlined />}
                    onClick={() => handleSelectRowsInPcp(currentInsight)}
                    style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%', overflowWrap: 'anywhere' }}
                    data-testid="select-subgroup-pcp"
                  >
                    Select Subgroup in PCP
                  </Button>
                  <Button
                    icon={<ArrowRightOutlined />}
                    onClick={() => handleFocusPcpPair(currentInsight)}
                    style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%', overflowWrap: 'anywhere' }}
                    data-testid="focus-pcp-pair"
                  >
                    Focus PCP on this Pair
                  </Button>
                  <Button
                    icon={<ThunderboltOutlined />}
                    onClick={() => {
                      const targetCol = currentInsight.question.name
                      const groupCol = currentInsight.subgroup.name
                      const compareGroups = currentInsight.group_stats.slice(0, 2).map((g) => g.group)
                      const conclusion = {
                        id: `mining_${currentInsight.id}`,
                        type: 'subgroup_diff',
                        metric: `${groupCol}_diff_${targetCol}`,
                        label: `${groupCol} のグループ差: ${targetCol}`,
                        target_col: targetCol,
                        group_col: groupCol,
                        compare_groups: compareGroups.length >= 2 ? compareGroups : undefined,
                        subgroup_row_ids: currentInsight.row_ids && compareGroups.length > 0 ? currentInsight.row_ids[compareGroups[0]] : undefined,
                      }
                      navigate('/robustness', { state: { conclusion, analysisInput: runInput, scopeSnapshot: runScope.snapshot } })
                    }}
                    style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%', overflowWrap: 'anywhere' }}
                    data-testid="send-to-robustness-btn"
                  >
                    Send to Robustness
                  </Button>
                </div>
                {/* Natural Language Summary Banner */}
                <Alert
                  message="自動生成インサイト要約"
                  description={currentInsight.narrative}
                  type="info"
                  showIcon
                  style={{ marginBottom: 14 }}
                />

                {/* Group Comparison Chart / Visual */}
                <div data-testid="group-comparison-plot" style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                    <BarChartOutlined /> グループ間比較 (Group Comparison)
                  </Typography.Text>
                  <Table
                    size="small"
                    pagination={false}
                    dataSource={currentInsight.group_stats.map((g, i) => ({ ...g, key: i }))}
                    columns={[
                      { title: 'グループ', dataIndex: 'group', key: 'group' },
                      { title: 'サンプル数 (n)', dataIndex: 'n', key: 'n' },
                      {
                        title: '平均値 (Mean)',
                        dataIndex: 'mean',
                        key: 'mean',
                        render: (v: number | undefined) => (v !== undefined ? v.toFixed(3) : '-'),
                      },
                      {
                        title: '標準偏差 (SD)',
                        dataIndex: 'sd',
                        key: 'sd',
                        render: (v: number | undefined) => (v !== undefined ? v.toFixed(3) : '-'),
                      },
                      {
                        title: '最頻値 / 中央値',
                        key: 'extra',
                        render: (_: any, record: any) =>
                          record.most_frequent_cat || (record.median !== undefined ? record.median.toFixed(2) : '-'),
                      },
                    ]}
                  />
                </div>

                {/* Contingency Table & Residuals if categorical */}
                {currentInsight.contingency && (
                  <div data-testid="residual-table" style={{ marginBottom: 16 }}>
                    <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                      分割表・調整済み残差 (Adjusted Residuals)
                    </Typography.Text>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#fafafa', borderBottom: '1px solid #eee' }}>
                          <th style={{ padding: 6, textAlign: 'left' }}>Subgroup</th>
                          {currentInsight.contingency.cols.map((c) => (
                            <th key={c} style={{ padding: 6, textAlign: 'center' }}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {currentInsight.contingency.rows.map((rowLabel, rIdx) => (
                          <tr key={rowLabel} style={{ borderBottom: '1px solid #f0f0f0' }}>
                            <td style={{ padding: 6, fontWeight: 500 }}>{rowLabel}</td>
                            {currentInsight.contingency!.cols.map((_, cIdx) => {
                              const obs = currentInsight.contingency!.observed[rIdx][cIdx]
                              const res = currentInsight.contingency!.residuals[rIdx][cIdx]
                              const isPositive = res >= 2.0
                              const isNegative = res <= -2.0
                              const bg = isPositive ? '#e6f7ff' : (isNegative ? '#fff1f0' : 'transparent')
                              const color = isPositive ? '#0958d9' : (isNegative ? '#cf1322' : '#333')
                              return (
                                <td key={cIdx} style={{ padding: 6, textAlign: 'center', background: bg, color }}>
                                  <div>{obs}</div>
                                  <div style={{ fontSize: 10, fontWeight: isPositive || isNegative ? 'bold' : 'normal' }}>
                                    (残差 {res > 0 ? `+${res}` : res})
                                  </div>
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Post-hoc Pairwise Contrasts */}
                {currentInsight.posthoc && currentInsight.posthoc.length > 0 && (
                  <div data-testid="posthoc-table" style={{ marginBottom: 16 }}>
                    <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                      ペアワイズ対比 (Post-hoc Pairwise Contrasts)
                    </Typography.Text>
                    <Table
                      size="small"
                      pagination={false}
                      dataSource={currentInsight.posthoc.map((p, i) => ({ ...p, key: i }))}
                      columns={[
                        {
                          title: '対比ペア',
                          dataIndex: 'pair',
                          key: 'pair',
                          render: (pair: string[]) => `${pair[0]} vs ${pair[1]}`,
                        },
                        {
                          title: '補正後 p値 (p_adj)',
                          dataIndex: 'p_adj',
                          key: 'p_adj',
                          render: (v: number) => v.toFixed(5),
                        },
                        {
                          title: '有意性',
                          dataIndex: 'significant',
                          key: 'significant',
                          render: (sig: boolean) =>
                            sig ? <Tag color="green">有意差あり (***)</Tag> : <Tag>非有意</Tag>,
                        },
                      ]}
                    />
                  </div>
                )}

                {/* Test & Score details: never mount p/q/CI in exploration */}
                <Divider style={{ margin: '12px 0' }} />
                <Row gutter={[12, 12]}>
                  <Col span={8}>
                    <Statistic title="検定統計量" value={currentInsight.test.statistic ?? '-'} precision={3} />
                  </Col>
                  <Col span={8}>
                    <Statistic
                      title={`効果量 (${currentInsight.effect.measure})`}
                      value={currentInsight.effect.value}
                      precision={3}
                    />
                  </Col>
                </Row>
                {inferenceMode === 'verification' && (
                  <VerificationFindings info={verificationInfo} item={currentVerification}
                    candidateId={currentInsight.id} prefix="verification" />
                )}
              </Card>
            ) : (
              <Card style={{ textAlign: 'center', padding: 40 }}>
                <Empty description="インサイトを選択してください" />
              </Card>
            )}
          </Col>
        </Row>
      )}
              </>
            ),
          },
        ]}
      />
      <VerificationConfigModal
        open={verificationModalOpen}
        pending={verifying}
        error={error?.message ?? null}
        candidateCount={miningResult?.candidates?.length ?? 0}
        candidateSetHash={miningResult?.candidateSetHash ?? null}
        datasets={datasets}
        datasetsLoading={datasetsLoading}
        datasetsError={datasetsError}
        currentDatasetId={datasetId}
        alpha={alpha}
        onCancel={cancelVerification}
        onRun={(config) => void runVerification(config)}
      />
    </div>
  )
}
