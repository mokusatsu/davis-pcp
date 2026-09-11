import { Select as AntSelect } from 'antd'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import VerificationConfigModal, { type VerificationConfig } from './VerificationConfigModal'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Button, Typography, Space, Tag, Row, Col,
  Alert, Statistic, Spin, Empty, InputNumber, Divider, Tabs,
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
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import ModernSubgroupMiningView from './ModernSubgroupMiningView'
import {
  METHOD_LABEL, REPLICATION_COLOR, REPLICATION_LABEL, untestableReason, verificationFor,
  type PinnedCandidateSummary, type VerificationInfo, type VerificationResultItem,
} from './verification'

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
  analysisMode?: 'exploration' | 'verification'
  isExploratory?: boolean
  candidateSetHash?: string
  explorationNote?: string
  /** The candidates exploration pinned, in the order the server holds them. */
  candidates?: PinnedCandidateSummary[]
  verification?: VerificationInfo
  results?: VerificationResultItem[]
}

export default function SubgroupMiningPage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
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
  const [datasets, setDatasets] = useState<{ value: string; label: string }[]>([])
  const context = useMemo(() => JSON.stringify([datasetId, dataRevision, schemaRevision, rowIds, targets.attributes, targets.questions, alpha, minGroupSize]),
    [datasetId, dataRevision, schemaRevision, rowIds, targets.attributes.join('|'), targets.questions.join('|'), alpha, minGroupSize])
  const latestContext = useRef(context)
  latestContext.current = context
  const requestVersion = useRef(0)

  useEffect(() => {
    requestVersion.current += 1
    setMiningResult(null); setSelectedInsightId(null); setLoading(false); setError(null)
    setVerificationResult(null); setVerificationInfo(null); setInferenceMode('exploration')
  }, [context])

  // The picker has to be filled before it is opened, or 独立データ指定 looks
  // like a dead option; the current dataset is filtered out by the modal.
  const openVerificationModal = useCallback(() => {
    setVerificationModalOpen(true)
    void api.get<{ datasets: { datasetId: string; name: string; rowCount: number }[] }>('/datasets')
      .then((res) => setDatasets((res.datasets ?? []).map((d) => ({
        value: d.datasetId, label: `${d.name}（${d.rowCount}行）`,
      }))))
      .catch(() => setDatasets([]))
  }, [])

  const runVerification = async (config: VerificationConfig) => {
    if (!datasetId || !miningResult) return
    if (!miningResult.candidateSetHash) {
      setError({ message: '候補集合が発行されていません。もう一度探索してください。' })
      return
    }
    const version = ++requestVersion.current, startedContext = latestContext.current
    setVerifying(true)
    setError(null)
    try {
      // Only the hash is sent: the server re-tests the pinned set. Naming
      // individual candidates would fail whenever an insight produced no
      // pinned contrast, and re-listing them invites re-discovery.
      const res = await api.post<MiningResult>('/mining/subgroups', {
        datasetId,
        attributeCols: targets.attributes,
        questionCols: targets.questions,
        rowIds, expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision,
        alpha,
        minGroupSize,
        analysisMode: 'verification',
        verificationConfig: config,
        candidateSetHash: miningResult.candidateSetHash,
      })
      if (version !== requestVersion.current || startedContext !== latestContext.current) return
      setVerificationResult(res.results ?? null)
      setVerificationInfo(res.verification ?? null)
      setInferenceMode('verification')
      setVerificationModalOpen(false)
    } catch (err: any) {
      if (version !== requestVersion.current || startedContext !== latestContext.current) return
      setError({ message: err?.message || '検証の実行に失敗しました。' })
    } finally {
      if (version === requestVersion.current && startedContext === latestContext.current) setVerifying(false)
    }
  }

  const runMining = async () => {
    if (!datasetId || !targets.ready) return
    const version = ++requestVersion.current, startedContext = latestContext.current
    setLoading(true)
    setError(null)
    // A new exploration pins a new candidate set, so a previous verification of
    // the old set would otherwise stay on screen labelled as this run's result.
    setVerificationResult(null)
    setVerificationInfo(null)
    setInferenceMode('exploration')
    try {
      const res = await api.post<MiningResult>('/mining/subgroups', {
        datasetId,
        attributeCols: targets.attributes,
        questionCols: targets.questions,
        rowIds, expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision,
        alpha,
        minGroupSize,
      })
      if (version !== requestVersion.current || startedContext !== latestContext.current) return
      setMiningResult(res)
      if (res.insights.length > 0) {
        setSelectedInsightId(res.insights[0].id)
      } else {
        setSelectedInsightId(null)
      }
    } catch (err: any) {
      if (version !== requestVersion.current || startedContext !== latestContext.current) return
      console.error('Mining execution error', err)
      const msg = err?.message || err?.detail || '単変量マイニング処理中にエラーが発生しました。'
      const details = typeof err?.details === 'object' ? JSON.stringify(err.details, null, 2) : (err?.details ? String(err.details) : undefined)
      const actions = Array.isArray(err?.suggestedActions) ? err.suggestedActions : undefined
      setError({ message: msg, details, suggestedActions: actions })
    } finally {
      if (version === requestVersion.current && startedContext === latestContext.current) setLoading(false)
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
        padding: focused ? 0 : 16,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: focused ? 'hidden' : 'auto',
        minHeight: 0,
      }}
      data-testid="subgroup-mining-page"
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'modern' | 'classic')}
        type="card"
        tabBarStyle={focused ? { display: 'none' } : undefined}
        style={{
          marginBottom: focused ? 0 : 12,
          flex: focused ? 1 : undefined,
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
            children: <ModernSubgroupMiningView />,
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
                {/* Control bar */}
                {!focused && (
                  <Card size="small" style={{ marginBottom: 12, flexShrink: 0 }}>
                    {targets.control}
                    <Row gutter={[12, 12]} align="middle">
          <Col xs={12} md={3}>
            <Typography.Text strong>FDR α:</Typography.Text>
            <AntSelect
              style={{ width: '100%', marginTop: 4 }}
              value={alpha}
              onChange={setAlpha}
              disabled={inferenceMode === 'exploration'}
              options={[
                { label: '0.01 (厳格)', value: 0.01 },
                { label: '0.05 (標準)', value: 0.05 },
                { label: '0.10 (探索的)', value: 0.10 },
              ]}
            />
          </Col>
          <Col xs={12} md={3}>
            <Typography.Text strong>Min Group Size:</Typography.Text>
            <InputNumber
              style={{ width: '100%', marginTop: 4 }}
              min={2}
              max={1000}
              value={minGroupSize}
              onChange={(val) => setMinGroupSize(val || 10)}
            />
          </Col>
          <Col xs={24} md={6} style={{ display: 'flex', alignItems: 'flex-end' }}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => void runMining()}
              loading={loading}
              data-testid="mining-run-button"
              disabled={!targets.ready}
              style={{ width: '100%', marginTop: 22 }}
            >
              Run Auto Mining
            </Button>
          </Col>
          <Col xs={24} md={6} style={{ display: 'flex', alignItems: 'flex-end' }}>
            <Button
              icon={<CheckCircleOutlined />}
              onClick={openVerificationModal}
              loading={verifying}
              data-testid="mining-to-verification-btn"
              // Verification re-tests the pinned set, so without a hash there
              // is nothing to verify — the run would only be refused.
              disabled={!miningResult || !miningResult.candidateSetHash}
              style={{ width: '100%', marginTop: 22 }}
            >
              検証モードへ移行
            </Button>
          </Col>
                    </Row>
                  </Card>
                )}

                {/* Error Alert Display */}
                {!focused && error && (
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
                {!focused && miningResult && inferenceMode === 'exploration' && (
                  <Alert
                    type="warning"
                    showIcon
                    message="🔍 探索的候補"
                    description="この結果は全データ上の探索であり、母集団への確証ではありません。p値・q値・信頼区間は表示しません。"
                    style={{ marginBottom: 12, flexShrink: 0 }}
                    data-testid="exploration-badge"
                  />
                )}
                {!focused && inferenceMode === 'verification' && verificationInfo && (
                  <Alert
                    type="success"
                    showIcon
                    message="検証済み候補"
                    description={`手法: ${METHOD_LABEL[verificationInfo.method] ?? verificationInfo.method}／検定: ${verificationInfo.testUsed.join(', ') || 'なし'}／補正: ${verificationInfo.correction}（α=${verificationInfo.alpha}）／family=${verificationInfo.mHypotheses}／対象外=${verificationInfo.mExcluded}／nSelection=${verificationInfo.nSelection}／nEvaluation=${verificationInfo.nEvaluation}／seed=${verificationInfo.seed}${verificationInfo.note ? `／${verificationInfo.note}` : ''}`}
                    style={{ marginBottom: 12, flexShrink: 0 }}
                    data-testid="verification-badge"
                  />
                )}

                {/* Summary KPI Cards */}
                {!focused && miningResult && (
                  <Row gutter={[12, 12]} style={{ marginBottom: 12, flexShrink: 0 }}>
                    <Col span={4}>
                      <Card size="small">
                        <Statistic title="検定実行数" value={miningResult.summary.n_tests_run} prefix={<LineChartOutlined />} />
                      </Card>
                    </Col>
                    <Col span={5}>
                      <Card size="small">
                        <Statistic
                          title="FDR有意発見数"
                          value={miningResult.summary.n_significant_fdr}
                          valueStyle={{ color: '#1677ff' }}
                          prefix={<CheckCircleOutlined />}
                        />
                      </Card>
                    </Col>
                    <Col span={5}>
                      <Card size="small">
                        <Statistic title="Bonferroni有意" value={miningResult.summary.n_significant_bonferroni} />
                      </Card>
                    </Col>
                    <Col span={5}>
                      <Card size="small">
                        <Statistic
                          title="実質重要発見"
                          value={miningResult.summary.n_insights_after_filters}
                          valueStyle={{ color: '#52c41a' }}
                          prefix={<ThunderboltOutlined />}
                        />
                      </Card>
                    </Col>
                    <Col span={5}>
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
                    gutter={focused ? [0, 0] : [16, 16]}
                    style={{
                      flex: focused ? 1 : undefined,
                      minHeight: 0,
                      height: focused ? '100%' : undefined,
                    }}
                  >
                    {/* Left: Ranking Cards */}
                    {!focused && (
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
                                    <span> | {(() => {
                                      const v = verificationFor(verificationResult, ins.id)
                                      if (!v || !v.testable || !v.test) return '評価対象外'
                                      return `p=${v.test.pValue} adj=${v.test.pAdjusted}（${REPLICATION_LABEL[v.replicationStatus]}）`
                                    })()}</span>
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
                            <Empty description="条件に合致する有意なサブグループ差は見つかりませんでした。" />
                          )}
                        </Space>
                      </Col>
                    )}

                    {/* Right: Evidence & Drilldown Inspector */}
                    <Col
                      xs={24}
                      md={focused ? 24 : 14}
                      style={{
                        height: focused ? '100%' : undefined,
                        maxHeight: focused ? 'none' : 'calc(100vh - 270px)',
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                    >
                      {currentInsight ? (
                        <FocusTarget id="mining-detail" title="サブグループ詳細比較">
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
                            extra={
                              <FocusEnterButton targetId="mining-detail" title="サブグループ詳細比較" />
                            }
                            style={{
                              height: focused ? '100%' : undefined,
                              display: 'flex',
                              flexDirection: 'column',
                              flex: focused ? 1 : undefined,
                              minHeight: 0,
                            }}
                            bodyStyle={{
                              flex: focused ? 1 : undefined,
                              overflow: 'auto',
                              minHeight: 0,
                            }}
                          >
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <Button
                    type="primary"
                    icon={<AimOutlined />}
                    onClick={() => handleSelectRowsInPcp(currentInsight)}
                    data-testid="select-subgroup-pcp"
                  >
                    Select Subgroup in PCP
                  </Button>
                  <Button
                    icon={<ArrowRightOutlined />}
                    onClick={() => handleFocusPcpPair(currentInsight)}
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
                      navigate('/robustness', { state: { conclusion } })
                    }}
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
                  {inferenceMode === 'verification' && currentVerification && currentVerification.testable && (
                    <Col span={8}>
                      <div data-testid="verification-replication">
                        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                          探索結果との一致
                        </Typography.Text>
                        <Space size={4} style={{ marginTop: 4 }}>
                          <Tag color={REPLICATION_COLOR[currentVerification.replicationStatus]}>
                            {REPLICATION_LABEL[currentVerification.replicationStatus]}
                          </Tag>
                          {currentVerification.test?.significant
                            ? <Tag color="green">補正後も有意</Tag>
                            : <Tag>補正後は非有意</Tag>}
                          {currentVerification.effect?.weighted ? <Tag color="blue">加重</Tag> : null}
                        </Space>
                      </div>
                    </Col>
                  )}
                </Row>
                {inferenceMode === 'verification' && (
                  <Row gutter={[12, 12]} style={{ marginTop: 12 }} data-testid="verification-findings">
                    {!currentVerification ? (
                      <Col span={24}>
                        <Typography.Text type="secondary" data-testid="verification-not-pinned">
                          この候補は探索時の固定候補に含まれていないため、検証の対象外です。
                        </Typography.Text>
                      </Col>
                    ) : !currentVerification.testable || !currentVerification.test ? (
                      // An untestable candidate has no estimate at all; showing
                      // a blank statistic would read as "no difference found".
                      <Col span={24} data-testid="verification-untestable">
                        <Alert
                          type="warning"
                          showIcon
                          message={`検定できません（${currentVerification.reason ?? 'UNKNOWN'}）`}
                          description={untestableReason(currentVerification)}
                        />
                      </Col>
                    ) : (
                      <>
                        <Col span={6}>
                          <Statistic
                            title={`p値 (${currentVerification.test.name ?? '—'})`}
                            value={currentVerification.test.pValue ?? '-'}
                            data-testid="verification-p-value"
                          />
                        </Col>
                        <Col span={6}>
                          <Statistic
                            title={`補正後p値 (${verificationInfo?.correction ?? 'bh-fdr'})`}
                            value={currentVerification.test.pAdjusted ?? '-'}
                            valueStyle={{ color: '#1677ff' }}
                            data-testid="verification-p-adjusted"
                          />
                        </Col>
                        <Col span={6}>
                          <Statistic
                            title="差の95% CI"
                            value={currentVerification.effect?.ci95
                              ? `[${currentVerification.effect.ci95[0].toFixed(4)}, ${currentVerification.effect.ci95[1].toFixed(4)}]`
                              : '-'}
                            valueStyle={{ fontSize: 14 }}
                            data-testid="verification-ci"
                          />
                        </Col>
                        <Col span={6}>
                          <Statistic
                            title="点推定（評価に使った行数）"
                            value={currentVerification.effect?.estimate !== null && currentVerification.effect?.estimate !== undefined
                              ? `${currentVerification.effect.estimate.toFixed(4)}（${currentVerification.n.used}行）`
                              : '-'}
                            valueStyle={{ fontSize: 14 }}
                            data-testid="verification-estimate"
                          />
                        </Col>
                        {currentVerification.effect?.groupStats && currentVerification.effect.groupStats.length > 0 && (
                          <Col span={24}>
                            <Table
                              size="small"
                              pagination={false}
                              dataSource={currentVerification.effect.groupStats.map((g, i) => ({ ...g, key: i }))}
                              data-testid="verification-group-stats"
                              columns={[
                                { title: '群', dataIndex: 'label', key: 'label' },
                                { title: 'n', dataIndex: 'n', key: 'n' },
                                {
                                  title: '平均 / 比率',
                                  key: 'location',
                                  render: (_: unknown, record: { mean?: number | null; pct?: number | null }) =>
                                    record.mean !== undefined && record.mean !== null ? record.mean.toFixed(3)
                                      : (record.pct !== undefined && record.pct !== null ? record.pct.toFixed(3) : '-'),
                                },
                                {
                                  title: 'SD',
                                  dataIndex: 'sd',
                                  key: 'sd',
                                  render: (value: number | null | undefined) =>
                                    value !== undefined && value !== null ? value.toFixed(3) : '-',
                                },
                              ]}
                            />
                          </Col>
                        )}
                      </>
                    )}
                  </Row>
                )}
              </Card>
              </FocusTarget>
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
        candidateCount={miningResult?.candidates?.length ?? 0}
        candidateSetHash={miningResult?.candidateSetHash ?? null}
        datasets={datasets}
        currentDatasetId={datasetId}
        alpha={alpha}
        onCancel={() => setVerificationModalOpen(false)}
        onRun={(config) => void runVerification(config)}
      />
    </div>
  )
}
