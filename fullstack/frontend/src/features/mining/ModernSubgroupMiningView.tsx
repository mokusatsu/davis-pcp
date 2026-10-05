import { useScopedRun, AnalysisScopeSummary } from '../selection/analysisScope'
import { Select as AntSelect } from 'antd'
import { AnalysisField, AnalysisSettings, AnalysisRunRow } from '../common/AnalysisSetup'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Button, Typography, Space, Tag, Row, Col,
  Statistic, Spin, Empty, InputNumber, Radio, Divider, Alert,
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
  verificationFor,
  type PinnedCandidateSummary, type VerificationInfo, type VerificationResultItem,
} from './verification'
import { VerificationFindings, VerificationSummary } from './VerificationResults'

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

export interface EmmDiagnostics {
  status: string
  requestedQuestions: string[]
  eligibleQuestions: string[]
  ineligibleQuestions: { column: string; reason: string }[]
  pairsEvaluated: number
  evaluationsAttempted: number
  acceptedCandidates: number
  rejectionCounts: Record<string, number>
}

export interface ModernMiningResult {
  run_id: string
  mode: string
  inferenceMode?: 'exploration' | 'verification'
  algorithmMode?: string
  candidateSetHash?: string
  explorationNote?: string
  emmDiagnostics?: EmmDiagnostics
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
  const rowIds = useSelector(selectEffectiveRowIds)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const targets = useMiningTargets()
  const { schemaRevision, getColumn, formatValueLabel } = useCodebook()
  const context = useMemo(() => JSON.stringify([datasetId, schemaRevision, dataRevision, rowIds, targets.attributes, targets.questions]),
    [datasetId, schemaRevision, dataRevision, rowIds, targets.attributes.join('|'), targets.questions.join('|')])
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
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<{ message: string; details?: string; suggestedActions?: string[] } | null>(null)
  const [result, setResult] = useState<ModernMiningResult | null>(null)
  const [selectedInsightId, setSelectedInsightId] = useState<string | null>(null)
  const [verificationResult, setVerificationResult] = useState<VerificationResultItem[] | null>(null)
  const [verificationInfo, setVerificationInfo] = useState<VerificationInfo | null>(null)
  const [verifying, setVerifying] = useState(false)
  /** Only used to offer independent-verification targets; never the analysis subject. */
  const [datasetsLoading, setDatasetsLoading] = useState(false)
  const [datasetsError, setDatasetsError] = useState<string | null>(null)
  const [datasets, setDatasets] = useState<{ value: string; label: string }[]>([])

  const inputContext = JSON.stringify([context, miningMode, maxDepth, minGroupSize, topK])
  const runScope = useScopedRun(inputContext)
  const [runInput, setRunInput] = useState<Record<string, unknown> | null>(null)
  const verificationVersion = useRef(0)
  const verificationPending = useRef(false)
  const datasetListVersion = useRef(0)
  const resultRef = useRef(result)
  resultRef.current = result
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
    setResult(null)
    setSelectedInsightId(null)
    setLoading(false)
    setError(null)
    setVerificationResult(null)
    setVerificationInfo(null)
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

  /**
   * Modern candidates are verified through the classic verification endpoint:
   * it loads the pinned set by hash and re-tests each candidate's own contrast,
   * whichever algorithm pinned it. Only the hash is sent, never candidate ids.
   */
  const runVerification = async (config: VerificationConfig) => {
    if (verificationPending.current) return
    if (config.method === 'independent' && (datasetsLoading || datasetsError || !config.independent_dataset_id
      || config.independent_dataset_id === datasetId
      || !datasets.some(dataset => dataset.value === config.independent_dataset_id))) return
    if (!datasetId || !result?.candidateSetHash || !runInput) return
    const version = ++verificationVersion.current, sourceResult = result, sourceIdentity = runScope.identity
    const isCurrent = () => version === verificationVersion.current && resultRef.current === sourceResult && identityRef.current === sourceIdentity
    verificationPending.current = true
    setVerifying(true)
    setError(null)
    try {
      const res = await api.post<{ verification?: VerificationInfo; results?: VerificationResultItem[] }>(
        '/mining/subgroups', {
          ...runInput,
          analysisMode: 'verification',
          verificationConfig: config,
          candidateSetHash: result.candidateSetHash,
        })
      if (!isCurrent()) return
      setVerificationResult(res.results ?? null)
      setVerificationInfo(res.verification ?? null)
      setVerificationModalOpen(false)
    } catch (e: any) {
      if (!isCurrent()) return
      const details = typeof e?.details === 'object' ? JSON.stringify(e.details, null, 2) : (e?.details ? String(e.details) : undefined)
      setError({
        message: e?.message || '検証の実行に失敗しました。',
        details,
        suggestedActions: Array.isArray(e?.suggestedActions) ? e.suggestedActions : undefined,
      })
    } finally {
      if (isCurrent()) { verificationPending.current = false; setVerifying(false) }
    }
  }

  // Omnipresent Auto-mining runner
  const runAutoMining = async (overrideMode?: 'auto' | 'standard' | 'emm_kendall') => {
    if (!datasetId || !targets.ready) return
    const ticket = runScope.begin()
    cancelVerification()
    setLoading(true)
    setError(null)
    // A new exploration pins a new candidate set, so any previous verification
    // of the old set no longer describes the candidates on screen.
    setVerificationResult(null)
    setVerificationInfo(null)
    try {
      const payload: any = {
        datasetId,
        attributeCols: [...targets.attributes], targetQuestions: [...targets.questions], rowIds: ticket.scope.rowIds,
        expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision,
        mode: overrideMode || miningMode,
        maxDepth,
        minGroupSize,
        topK,
      }

      const res = await api.post<ModernMiningResult>('/mining/modern-subgroup', payload)
      if (!ticket.isCurrent()) return
      ticket.commit()
      setRunInput({ datasetId, attributeCols: payload.attributeCols, questionCols: payload.targetQuestions,
        rowIds: ticket.scope.rowIds, expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision, minGroupSize })
      setResult(res)
      if (res.insights.length > 0) {
        setSelectedInsightId(res.insights[0].id)
      } else {
        setSelectedInsightId(null)
      }
    } catch (e: any) {
      if (!ticket.isCurrent()) return
      console.error('Failed to run omnipresent auto mining', e)
      const msg = e?.message || e?.detail || 'マイニング処理中にエラーが発生しました。'
      const details = typeof e?.details === 'object' ? JSON.stringify(e.details, null, 2) : (e?.details ? String(e.details) : undefined)
      const actions = Array.isArray(e?.suggestedActions) ? e.suggestedActions : undefined
      setError({ message: msg, details, suggestedActions: actions })
    } finally {
      if (ticket.isCurrent()) setLoading(false)
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
  const emmDiagnostics = result?.algorithmMode === 'emm_kendall'
    ? result.emmDiagnostics ?? null
    : null
  const emmDiagnosticIssue = emmDiagnostics?.status !== 'results_found' ? emmDiagnostics : null
  const emmDiagnosticMessage = (() => {
    if (!emmDiagnosticIssue) return null
    const rejectionLabels: Record<string, string> = {
      insufficient_group_size: '群サイズ不足',
      constant_value: '定数値',
      undefined_tau: '未定義の Kendall τ',
    }
    const rejectionSummary = Object.entries(emmDiagnosticIssue.rejectionCounts)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${rejectionLabels[reason] ?? reason}: ${count}件`)
      .join('、')

    switch (emmDiagnosticIssue.status) {
      case 'insufficient_rows':
        return 'Kendall-EMMには少なくとも2行のデータが必要です。'
      case 'requires_two_eligible_questions':
        return `Kendall-EMMには二値ではない数値の質問変数が2つ必要です。現在の適格変数は${emmDiagnosticIssue.eligibleQuestions.length}件です。`
      case 'selected_pair_ineligible':
        return `選択した質問ペアにKendall-EMMで使えない変数が含まれます（${emmDiagnosticIssue.ineligibleQuestions.map(item => item.column).join('、') || '不明'}）。二値ではない数値の質問を2つ選択してください。`
      case 'no_evaluable_rules':
        return '選択した質問ペアは適格ですが、評価可能なサブグループ条件を作れませんでした。属性変数または最小グループ人数を見直してください。'
      case 'no_valid_candidate':
        return `評価可能な条件はありましたが、Kendall τを計算できる候補がありませんでした。${rejectionSummary || '欠損・群サイズ・値のばらつきを確認してください。'}`
      case 'no_evaluable_pairs':
        return 'Kendall-EMMで評価できる質問ペアを作れませんでした。二値ではない数値の質問を2つ選択してください。'
      default:
        return 'Kendall-EMMで表示可能な候補を作れませんでした。質問変数、属性変数、最小グループ人数を確認してください。'
    }
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card title="サブグループ発見の設定" size="small" className="analysis-setup">
        <div className="analysis-form-stack">
          <AnalysisScopeSummary label="次回実行の対象" snapshot={result ? runScope.snapshot : null} />
          <Typography.Text type="secondary">属性変数と質問変数を選んで探索します。変数・詳細設定の変更は次回の実行に適用されます。</Typography.Text>
          {targets.control}
          <AnalysisSettings title="サブグループ発見の詳細設定" summary={`手法: ${miningMode === 'auto' ? '全自動' : miningMode === 'standard' ? '複合条件のみ' : '相関特異性のみ'} / 最大深さ: ${maxDepth} / 最小人数: ${minGroupSize} / 表示上限: ${topK}`}>
            <AnalysisField label="探索アルゴリズム">
              <Radio.Group aria-label="探索アルゴリズム" value={miningMode} onChange={(e) => setMiningMode(e.target.value)} buttonStyle="solid" size="small">
                <Radio.Button value="auto">全自動 (標準 ＋ EMM)</Radio.Button>
                <Radio.Button value="standard">複合条件のみ</Radio.Button>
                <Radio.Button value="emm_kendall">相関特異性のみ</Radio.Button>
              </Radio.Group>
            </AnalysisField>
            <div className="analysis-variable-grid">
              <AnalysisField label="最大深さ" htmlFor="modern-mining-depth">
                <AntSelect id="modern-mining-depth" style={{ width: '100%' }} size="small" value={maxDepth} onChange={setMaxDepth}
                  options={[{ label: '1 (単一属性/区間)', value: 1 }, { label: '2 (2属性の複合条件)', value: 2 }]} />
              </AnalysisField>
              <AnalysisField label="最小人数" htmlFor="modern-mining-min-size">
                <InputNumber id="modern-mining-min-size" style={{ width: '100%' }} size="small" min={5} max={500} value={minGroupSize} onChange={(v) => setMinGroupSize(v ?? 30)} />
              </AnalysisField>
              <AnalysisField label="表示上限" htmlFor="modern-mining-top-k">
                <InputNumber id="modern-mining-top-k" style={{ width: '100%' }} size="small" min={1} max={30} value={topK} onChange={(v) => setTopK(v ?? 12)} />
              </AnalysisField>
            </div>
          </AnalysisSettings>
          <AnalysisSettings title="探索と検証の見方" summary="複合条件・Kendall-EMM・固定した候補の検証について">
            <Typography.Text>複合条件では属性を組み合わせたサブグループを探します。Kendall-EMMは二値ではない数値の質問ペアについて相関の違いを探します。</Typography.Text>
            <Typography.Text>探索結果は確証ではありません。検証は探索時の候補集合と対象を固定します。ホールドアウト・交差検証は事後的な安定性確認で、検証のαは0.05です。</Typography.Text>
          </AnalysisSettings>
          {result && runScope.dirty && <Typography.Text type="warning" role="status">表示中の探索結果と検証母集団は実行時の対象を保持しています。再探索すると変数・設定・対象を更新します。</Typography.Text>}
          {!targets.ready && <Typography.Text type="secondary" role="status">属性変数と質問変数をそれぞれ1つ以上選択してください。</Typography.Text>}
          <AnalysisRunRow>
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void runAutoMining()} loading={loading} disabled={!datasetId || !targets.ready}
              style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%' }}>
              指定対象で実行
            </Button>
          </AnalysisRunRow>
        </div>
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

      {result && <Card title="表示中の結果の絞り込み" size="small" className="analysis-setup">
        <AnalysisField label={<><FilterOutlined /> 質問絞り込み</>} htmlFor="modern-mining-result-filter" help="実行済みの探索結果だけを絞り込みます。探索する質問は上の質問変数で指定します。">
          <Select id="modern-mining-result-filter" roleName="探索結果の質問絞り込み" aria-describedby="modern-mining-result-filter-help"
            style={{ width: '100%' }} size="small" value={filterQuestion} onChange={setFilterQuestion}
            options={[{ label: '全ての質問 (全件表示)', value: 'all' }, ...availableQuestionsInResults.map(q => ({ label: q, value: q }))]} />
        </AnalysisField>
      </Card>}

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
        <VerificationSummary info={verificationInfo} results={verificationResult} prefix="modern-verification" />
      )}
      {emmDiagnosticIssue && !loading && (
        <Alert
          type="warning"
          showIcon
          message="Kendall-EMM の結果を表示できません"
          description={emmDiagnosticMessage}
          data-testid="modern-emm-diagnostics"
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
              <Empty description={emmDiagnosticIssue
                ? 'Kendall-EMMで表示可能なインサイトはありません。上の理由を確認してください。'
                : '条件に合致するインサイトはありませんでした。'} />
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
                    <VerificationFindings info={verificationInfo} item={selectedVerification}
                      candidateId={selectedInsight.id} prefix="modern-verification" precision={3} />
                  </>
                )}

                <Divider style={{ margin: '12px 0' }} />

                <Space direction="vertical" style={{ width: '100%' }}>
                  <Button
                    type="primary"
                    block
                    style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%', overflowWrap: 'anywhere' }}
                    icon={<SwapOutlined />}
                    onClick={() => handleApplyToPcp(selectedInsight)}
                  >
                    このセグメントをPCPで表示
                  </Button>
                  <Button
                    block
                    style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%', overflowWrap: 'anywhere' }}
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
                    style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%', overflowWrap: 'anywhere' }}
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
                      navigate('/robustness', { state: { conclusion, analysisInput: runInput, scopeSnapshot: runScope.snapshot } })
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
        pending={verifying}
        error={error?.message ?? null}
        candidateCount={result?.candidates?.length ?? 0}
        candidateSetHash={result?.candidateSetHash ?? null}
        datasets={datasets}
        datasetsLoading={datasetsLoading}
        datasetsError={datasetsError}
        currentDatasetId={datasetId}
        alpha={VERIFICATION_ALPHA}
        onCancel={cancelVerification}
        onRun={(config) => void runVerification(config)}
      />
    </div>
  )
}
export default ModernSubgroupMiningView
