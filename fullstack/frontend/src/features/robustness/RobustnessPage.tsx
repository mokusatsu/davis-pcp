import Statistic from '../common/RoundedStatistic'
import { useScopedRun, AnalysisScopeSummary, type AnalysisScopeSnapshot } from '../selection/analysisScope'
import CategoryBars from '../charts/CategoryBars'
import Table from '../common/ColumnTable'
import { QuestionTooltip, useQuestionText } from '../common/ColumnQuestionTooltip'
import { Select } from 'antd'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Card, Row, Col, Typography, Space, Button, Tag,
  Alert, Spin, Empty,
} from 'antd'
import {
  AlertOutlined, AimOutlined,
  ReloadOutlined, ArrowRightOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, pcpStateChanged, selectOrdinaryVariables } from '../../app/store'
import { api } from '../../api/client'
import GraphPanel from '../common/GraphPanel'

export interface PerturbationItem {
  strategy: string
  label: string
  param: any
  estimate: number
  drift: number
  flipped: boolean
}

/** Preserve the distinguishing bound instead of truncating both long CI labels
 * to the same prefix. The full scenario label remains in the tooltip. */
export function perturbationAxisLabel(item: Pick<PerturbationItem, 'strategy' | 'label'>): string {
  if (item.strategy === 'bootstrap_ci_lower') return '95%CI 下限'
  if (item.strategy === 'bootstrap_ci_upper') return '95%CI 上限'
  return item.label
}

export interface SweepPoint {
  fraction: number
  pct_label: string
  estimate: number
  drift: number
  flipped: boolean
}

export interface InfluentialRespondent {
  row_id: string
  raw_value: number | null
  influence: number
  abs_influence: number
}

export interface ConclusionItem {
  id: string
  type: string
  label: string
  target_col: string
  group_col?: string
  full_estimate: number
  ci_95: [number, number]
  robustness: {
    grade: 'robust' | 'mostly_robust' | 'somewhat_sensitive' | 'fragile'
    grade_label: string
    flip_rate: number
    max_drift: number
    bootstrap_se: number
  }
  perturbations: PerturbationItem[]
  sweep_curve: SweepPoint[]
  top_influence_respondents: InfluentialRespondent[]
}

export interface RobustnessResponse {
  run_id: string
  conclusions: ConclusionItem[]
}

export interface SensitivityResponse {
  runId: string
  method: string
  threshold: number
  bootstrapB?: number
  seed?: number
  baseline: { n: number; effectSize: number; confidenceInterval: [number, number] | null; direction: string; scopeHash: string }
  sensitivity: { n: number; excludedN: number; effectSize: number; confidenceInterval: [number, number] | null; direction: string; scopeHash: string }
  comparison: { relativeChange: number | null; baselineCiCrossesZero: boolean; sensitivityCiCrossesZero: boolean; directionPreserved: boolean; maxRelativeChange: number; isRobust: boolean; reason: string }
  outlierRowIds: string[]
  weightApplied: boolean
}

export default function RobustnessPage() {
  const questionText = useQuestionText()
  const conclusionQuestions = (c: { target_col?: string; group_col?: string }) =>
    [c.target_col, c.group_col].filter((name): name is string => Boolean(name)).map(questionText).join('\n')
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const location = useLocation()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  const [customConclusion, setCustomConclusion] = useState<any>(
    (location.state as any)?.conclusion || null
  )
  const [sourceInput, setSourceInput] = useState<Record<string, unknown> | null>((location.state as any)?.analysisInput ?? null)
  const [sourceScope, setSourceScope] = useState<AnalysisScopeSnapshot | null>((location.state as any)?.scopeSnapshot ?? null)
  const [runError, setRunError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [data, setData] = useState<RobustnessResponse | null>(null)
  const [selectedConclusionId, setSelectedConclusionId] = useState<string | null>(null)
  const [sensitivity, setSensitivity] = useState<SensitivityResponse | null>(null)
  const [sensitivityLoading, setSensitivityLoading] = useState(false)
  const [sensitivityError, setSensitivityError] = useState<string | null>(null)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const inputContext = useMemo(() => JSON.stringify([datasetId, dataRevision, schemaRevision, customConclusion, sourceInput]), [datasetId, dataRevision, schemaRevision, customConclusion, sourceInput])
  const contextRef = useRef(inputContext)
  contextRef.current = inputContext
  const runScope = useScopedRun(inputContext)
  const sensitivityRun = useScopedRun(inputContext)
  const sourceIsCurrent = !sourceInput || (sourceInput.datasetId === datasetId && sourceInput.expectedDataRevision === dataRevision && sourceInput.expectedSchemaRevision === schemaRevision)

  const fetchRobustness = async (targetConclusion = customConclusion, overrideDatasetId?: string) => {
    const effectiveDatasetId = overrideDatasetId ?? datasetId
    if (!effectiveDatasetId) return
    if (!sourceIsCurrent) { setRunError('探索時のデータ世代と一致しません。元の分析から再実行してください。'); return }
    const ticket = runScope.begin(customConclusion && sourceScope ? sourceScope : undefined)
    const startedContext = contextRef.current
    const isCurrent = () => ticket.isCurrent() && startedContext === contextRef.current
    setRunError(null)
    setLoading(true)
    try {
      const payload: Record<string, any> = {
        datasetId: effectiveDatasetId,
        rowIds: ticket.scope.rowIds, expectedDataRevision: dataRevision, expectedSchemaRevision: schemaRevision,
        bootstrapB: 100,
      }
      if (targetConclusion) {
        payload.conclusions = [targetConclusion]
      }
      const res = await api.post<RobustnessResponse>('/robustness/evaluate', payload)
      if (!isCurrent()) return
      ticket.commit()
      setData(res)
      if (res.conclusions.length > 0) {
        setSelectedConclusionId(res.conclusions[0].id)
      }
    } catch (err) {
      if (isCurrent()) setRunError((err as { message?: string }).message || '評価に失敗しました。')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  const runSensitivity = async () => {
    if (!datasetId || !customConclusion?.target_col) return
    if (!sourceIsCurrent) { setSensitivityError('探索時のデータ世代と一致しません。元の分析から再実行してください。'); return }
    const ticket = sensitivityRun.begin(customConclusion && sourceScope ? sourceScope : undefined)
    const startedContext = contextRef.current
    const isCurrent = () => ticket.isCurrent() && startedContext === contextRef.current
    setSensitivityLoading(true)
    setSensitivityError(null)
    try {
      const res = await api.post<SensitivityResponse>('/robustness/sensitivity', {
        datasetId,
        scopeRowIds: ticket.scope.rowIds, expectedDataRevision: dataRevision, expectedSchemaRevision: schemaRevision,
        targetColumn: customConclusion.target_col,
        candidate: {
          type: customConclusion.type ?? 'subgroup_diff',
          groupColumn: customConclusion.group_col ?? null,
          compareGroups: customConclusion.compare_groups ?? null,
          rowIds: customConclusion.subgroup_row_ids ?? null,
        },
        outlierMethod: 'standardized_deviation',
        threshold: 3.0,
        bootstrapB: 200,
        seed: 42,
      })
      if (!isCurrent()) return
      ticket.commit()
      setSensitivity(res)
    } catch (err: any) {
      if (!isCurrent()) return
      setSensitivityError(err?.message || '感度分析の実行に失敗しました。')
    } finally {
      if (isCurrent()) setSensitivityLoading(false)
    }
  }

  // KeepAlive leaves this page mounted while other routes are active. A new
  // mining handoff must replace the previous candidate on each navigation.
  // Ordinary revisits without a handoff preserve the current analysis.
  useEffect(() => {
    const incoming = (location.state as { conclusion?: unknown } | null)?.conclusion
    if (location.pathname.replace(/\/$/, '') === '/robustness' && incoming && incoming !== customConclusion) {
      setCustomConclusion(incoming)
      setSourceInput((location.state as any)?.analysisInput ?? null)
      setSourceScope((location.state as any)?.scopeSnapshot ?? null)
    }
    // Only a navigation is a handoff; dismissing it must not restore it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.pathname, location.state])

  useEffect(() => {
    const snapshot = datasetId
    setData(null)
    setSelectedConclusionId(null)
    setLoading(false)
    setSensitivity(null)
    setSensitivityError(null)
    setSensitivityLoading(false)
    if (snapshot) {
      void fetchRobustness(customConclusion, snapshot)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, dataRevision, schemaRevision, customConclusion, sourceInput])

  const globalVars = useSelector(selectOrdinaryVariables)
  // A conclusion about a variable excluded from the global active variables
  // is out of scope — show the remaining ones instead of stale content.
  // selectOrdinaryVariables derives from the codebook; when the codebook has
  // no columns (e.g. unit tests) there is no global signal, so keep everything.
  const hasGlobalSignal = globalVars.allVariables.length > 0
  const visibleConclusions = useMemo(() => {
    if (!data || !hasGlobalSignal) return data?.conclusions ?? []
    const active = new Set(globalVars.activeVariableIds)
    return data.conclusions.filter((c) => (!c.target_col || active.has(c.target_col))
      && (!c.group_col || active.has(c.group_col)))
  }, [data, globalVars.activeVariableIds, hasGlobalSignal])
  useEffect(() => {
    if (data && selectedConclusionId && !visibleConclusions.some((c) => c.id === selectedConclusionId)) {
      setSelectedConclusionId(visibleConclusions[0]?.id ?? null)
    }
  }, [data, selectedConclusionId, visibleConclusions])
  const currentConclusion = useMemo(() => {
    if (!data || !selectedConclusionId) return null
    return data.conclusions.find((c) => c.id === selectedConclusionId) ?? data.conclusions[0] ?? null
  }, [data, selectedConclusionId])

  const [selectedInfluentialRowKeys, setSelectedInfluentialRowKeys] = useState<React.Key[]>([])

  const handleSelectInfluentialRows = (conclusion: ConclusionItem) => {
    const ids = selectedInfluentialRowKeys.length > 0
      ? selectedInfluentialRowKeys.map(String)
      : conclusion.top_influence_respondents.map((r) => r.row_id)
    if (ids.length > 0) {
      dispatch(selectionApplied({
        rowIds: ids,
        operation: 'replace',
        label: `Influential respondents for ${conclusion.label} (${ids.length} rows)`,
      }))
    }
  }

  const handleFocusPcp = (conclusion: ConclusionItem) => {
    handleSelectInfluentialRows(conclusion)
    const axes = [conclusion.target_col]
    if (conclusion.group_col) axes.unshift(conclusion.group_col)
    dispatch(pcpStateChanged({
      order: axes,
      visibleColumns: axes,
    }))
    navigate('/pcp')
  }

  const gradeTag = (grade: string) => {
    switch (grade) {
      case 'robust':
        return <Tag color="green" icon={<CheckCircleOutlined />}>頑健 (Robust)</Tag>
      case 'mostly_robust':
        return <Tag color="cyan" icon={<CheckCircleOutlined />}>概ね頑健 (Mostly Robust)</Tag>
      case 'somewhat_sensitive':
        return <Tag color="gold" icon={<AlertOutlined />}>やや敏感 (Somewhat Sensitive)</Tag>
      case 'fragile':
        return <Tag color="red" icon={<AlertOutlined />}>脆い (Fragile)</Tag>
      default:
        return <Tag>{grade}</Tag>
    }
  }

  return (
    <div
      style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto', minHeight: 0 }}
      data-testid="robustness-page"
    >
      <AnalysisScopeSummary snapshot={runScope.snapshot} />
      {sourceInput && <Typography.Text type="secondary">探索結果の検証には探索時の母集団を固定して使用します。</Typography.Text>}
      {runScope.dirty && <Typography.Text type="warning">現在の共通対象と異なる実行済み評価です。</Typography.Text>}
      {runError && <Alert type="error" message={runError} />}

      {/* Inherited conclusion banner */}
      {customConclusion && (
        <Alert
          type="info"
          showIcon
          closable
          onClose={() => {
            setCustomConclusion(null); setSourceInput(null); setSourceScope(null)
          }}
          message="サブグループマイニングから引き継いだ結論を検証中"
          description={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <div><b>対象:</b> <QuestionTooltip nameOrId={customConclusion.target_col ?? '結論'} question={conclusionQuestions(customConclusion)}>{customConclusion.label || customConclusion.metric}</QuestionTooltip></div>
              <Button
                size="small"
                onClick={() => {
                  setCustomConclusion(null); setSourceInput(null); setSourceScope(null)
                }}
              >
                デフォルト全体結論に戻す
              </Button>
            </div>
          }
          style={{ marginBottom: 12 }}
          data-testid="inherited-conclusion-alert"
        />
      )}

      {/* Top Bar */}
      {(
        <Card size="small" style={{ marginBottom: 12 }}>
          <Row gutter={[16, 12]} align="middle">
            <Col xs={24} md={12}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Typography.Text strong style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>診断対象結論 (Conclusion):</Typography.Text>
                <Select
                  data-testid="conclusion-selector"
                  showSearch
                  optionFilterProp="searchText"
                  optionRender={option => <QuestionTooltip nameOrId={option.data.questionName} question={option.data.questionText}>{option.label}</QuestionTooltip>}
                  style={{ flex: '1 1 320px', minWidth: 0, width: 'min(100%, 360px)' }}
                  value={selectedConclusionId ?? undefined}
                  onChange={setSelectedConclusionId}
                  options={(visibleConclusions.length ? visibleConclusions : data?.conclusions ?? []).map((c) => ({
                    label: `${c.label} [${c.robustness.grade_label}]`,
                    questionName: [c.target_col, c.group_col].filter(Boolean).join(' / '),
                    questionText: conclusionQuestions(c),
                    searchText: `${c.label} ${c.robustness.grade_label} ${conclusionQuestions(c)}`,
                    value: c.id,
                  }))}
                />
              </div>
            </Col>
            <Col xs={24} md={12} style={{ textAlign: 'right' }}>
              <Button
                type="primary"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => void fetchRobustness()}
                data-testid="robustness-reevaluate-btn"
              >
                感度診断を再実行
              </Button>
            </Col>
          </Row>
        </Card>
      )}

      {loading && !data && (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip="数値的外れ度に基づく感度分析（外れ値除外・ブートストラップ・ジャックナイフ）実行中..." />
        </div>
      )}

      {(
        <Card size="small" style={{ marginBottom: 16 }} data-testid="sensitivity-comparison-panel">
          <AnalysisScopeSummary snapshot={sensitivityRun.snapshot} label="次回の共通対象" />
          <Typography.Text strong style={{ fontSize: 14 }}>数値的外れ度に基づく感度分析</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 12px' }}>
            baseline（全データ）と外れ値除外後のsensitivityを同じ効果量・CI方法で比較します。除外行の確認だけで、datasetや中央Selectionは自動で変更しません。
          </Typography.Paragraph>
          <Space wrap>
            <Button
              type="primary"
              onClick={() => void runSensitivity()}
              loading={sensitivityLoading}
              disabled={!customConclusion?.target_col}
              data-testid="sensitivity-run-btn"
            >
              数値的外れ度に基づく感度分析を実行
            </Button>
            {sensitivity && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                method={sensitivity.method}／threshold={sensitivity.threshold}／除外 {sensitivity.sensitivity.excludedN} 行
              </Typography.Text>
            )}
          </Space>
          {sensitivityError && <Alert type="error" showIcon message={sensitivityError} style={{ marginTop: 8 }} />}
          {sensitivity && (
            <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
              <Col xs={24} lg={12}>
                <Card size="small" title={`baseline（全データ, n=${sensitivity.baseline.n}）`}>
                  <Statistic title="効果量" value={sensitivity.baseline.effectSize} precision={3} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    CI: {sensitivity.baseline.confidenceInterval ? `[${sensitivity.baseline.confidenceInterval[0]}, ${sensitivity.baseline.confidenceInterval[1]}]` : '—'}／方向: {sensitivity.baseline.direction}
                  </Typography.Text>
                </Card>
              </Col>
              <Col xs={24} lg={12}>
                <Card size="small" title={`sensitivity（除外後, n=${sensitivity.sensitivity.n}）`}>
                  <Statistic title="効果量" value={sensitivity.sensitivity.effectSize} precision={3} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    CI: {sensitivity.sensitivity.confidenceInterval ? `[${sensitivity.sensitivity.confidenceInterval[0]}, ${sensitivity.sensitivity.confidenceInterval[1]}]` : '—'}／方向: {sensitivity.sensitivity.direction}
                  </Typography.Text>
                </Card>
              </Col>
              <Col span={24}>
                <Alert
                  type={sensitivity.comparison.isRobust ? 'success' : 'warning'}
                  showIcon
                  message={sensitivity.comparison.isRobust ? '頑健: 方向とCIの0跨ぎが保持されました' : '敏感: 方向・CI・相対変化のいずれかが変化しました'}
                  description={`相対変化=${sensitivity.comparison.relativeChange}（上限 ${sensitivity.comparison.maxRelativeChange}）／理由=${sensitivity.comparison.reason}／weightApplied=${String(sensitivity.weightApplied)}`}
                />
                {sensitivity.outlierRowIds.length > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    除外行を確認: {sensitivity.outlierRowIds.slice(0, 10).join(', ')}{sensitivity.outlierRowIds.length > 10 ? `（他 ${sensitivity.outlierRowIds.length - 10} 行）` : ''}
                  </Typography.Text>
                )}
              </Col>
            </Row>
          )}
        </Card>
      )}

      {currentConclusion && (
        <>
          {/* Robustness Scorecard */}
          {(
            <Card size="small" style={{ marginBottom: 16 }} data-testid="robustness-scorecard">
              <Row gutter={[16, 16]} align="middle">
                <Col xs={24} sm={6}>
                  <Typography.Text type="secondary">頑健性総合判定</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Typography.Title level={4} style={{ margin: 0 }}>
                      {gradeTag(currentConclusion.robustness.grade)}
                    </Typography.Title>
                  </div>
                </Col>
                <Col xs={12} sm={4}>
                  <Statistic
                    title="反転率 (Flip Rate)"
                    value={(currentConclusion.robustness.flip_rate * 100).toFixed(1)}
                    suffix="%"
                    valueStyle={{ color: currentConclusion.robustness.flip_rate > 0.2 ? '#cf1322' : '#3f8600' }}
                  />
                </Col>
                <Col xs={12} sm={4}>
                  <Statistic
                    title="最大ドリフト"
                    value={(currentConclusion.robustness.max_drift * 100).toFixed(1)}
                    suffix="%"
                  />
                </Col>
                <Col xs={12} sm={5}>
                  <Statistic
                    title="フルサンプル推定値"
                    value={currentConclusion.full_estimate}
                    precision={3}
                  />
                </Col>
                <Col xs={12} sm={5}>
                  <Statistic
                    title="Bootstrap 95% CI"
                    value={`[${currentConclusion.ci_95[0].toFixed(2)}, ${currentConclusion.ci_95[1].toFixed(2)}]`}
                    valueStyle={{ fontSize: 16 }}
                  />
                </Col>
              </Row>
            </Card>
          )}

          {/* Warning Banner for Fragile conclusions */}
          { currentConclusion.robustness.grade === 'fragile' && (
            <Alert
              message="結論の脆弱性警告"
              description="この結論は回答者サンプルの軽微な摂動（外れ回答者の除外やリサンプリング）によって反転・大幅変動する可能性が高い脆い結論です。意思決定に利用する際は慎重に検証してください。"
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          <Row gutter={[16, 16]} style={{ minHeight: 0 }}>
            {/* Left: Tornado Plot & Quality Removal Curve */}
              <Col xs={24} lg={13} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {/* Tornado Plot: G31。スイープ数値表は対象外（X05） */}
                  <GraphPanel
                    graphId="robustness/tornado"
                    title="摂動トルネード分析"
                    available={Boolean(currentConclusion?.perturbations?.length)}
                    sizing="intrinsic"
                    intrinsicSize={{ width: 560, height: Math.max(280, 120 + (currentConclusion?.perturbations?.length ?? 4) * 48) }}
                    normalWidth="viewport"
                  >
                    <Card
                      size="small"
                      data-testid="perturbation-tornado-plot"
                      style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', minHeight: 0 }}
                    >
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                        各摂動シナリオ下での推定値ドリフト（%）。反転が起きた場合は赤色でハイライト。
                      </Typography.Text>
                      <CategoryBars axisName="推定値ドリフト (%)" testId="robustness-tornado-echart" items={currentConclusion.perturbations.map((p, index) => ({
                        id: String(index), label: perturbationAxisLabel(p), value: p.drift * 100, color: p.flipped ? '#ff4d4f' : '#1890ff',
                        detail: `${p.label}\n推定値: ${p.estimate}${p.flipped ? ' / 反転発生' : ''}`,
                      }))} />
                    </Card>
                  </GraphPanel>

                {/* Quality Sweep Curve Table / View: X05 対象外。拡大なし・表操作維持 */}
                    <Card
                      size="small"
                      title="数値的外れ度に基づく感度スイープ曲線 (Sensitivity Sweep Curve)"
                      data-testid="quality-sweep-curve"
                      style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
                    >
                      <Table
                        size="small"
                        pagination={false}
                        dataSource={currentConclusion.sweep_curve.map((s, idx) => ({ ...s, key: idx }))}
                        columns={[
                          { title: '外れ値除外率', dataIndex: 'pct_label' },
                          { title: '再評価推定値', dataIndex: 'estimate', render: (v: number) => v.toFixed(3) },
                          { title: '基準とのドリフト', dataIndex: 'drift', render: (v: number) => `${(v * 100).toFixed(1)}%` },
                          {
                            title: '状態',
                            dataIndex: 'flipped',
                            render: (f: boolean) =>
                              f ? <Tag color="red">判定反転</Tag> : <Tag color="green">維持 (安定)</Tag>,
                          },
                        ]}
                      />
                    </Card>
              </Col>

            {/* Right: Top-Influence Respondents Table */}
              <Col xs={24} lg={11}>
                <Card
                  size="small"
                  title="結論を左右するトップ影響回答者"
                  data-testid="top-influence-table"
                >
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                    <Button
                      type="primary"
                      icon={<AimOutlined />}
                      onClick={() => handleSelectInfluentialRows(currentConclusion)}
                      data-testid="highlight-influential-pcp"
                    >
                      Highlight Influential Rows in PCP
                    </Button>
                    <Button
                      icon={<ArrowRightOutlined />}
                      onClick={() => handleFocusPcp(currentConclusion)}
                    >
                      Focus PCP
                    </Button>
                  </div>
                  <Alert
                    message="ジャックナイフ影響度診断 (Jackknife Diagnostics)"
                    description="以下の回答者を1名除外しただけで、全体の結論値が大きくシフトします。回答内容の妥当性や誤入力を確認してください。"
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                  />
                  <Table
                    size="small"
                    rowSelection={{
                      selectedRowKeys: selectedInfluentialRowKeys,
                      onChange: setSelectedInfluentialRowKeys,
                    }}
                    pagination={{ pageSize: 7 }}
                    dataSource={currentConclusion.top_influence_respondents.map((r) => ({ ...r, key: r.row_id }))}
                    columns={[
                      { title: '回答者 ID', dataIndex: 'row_id' },
                      {
                        title: '該当値',
                        dataIndex: 'raw_value',
                        render: (v: number | null) => (v !== null ? v.toFixed(2) : '-'),
                      },
                      {
                        title: '除外影響度 (Δ)',
                        dataIndex: 'influence',
                        render: (v: number) => (
                          <span style={{ color: v > 0 ? '#cf1322' : '#0958d9', fontWeight: 'bold' }}>
                            {v > 0 ? `+${v.toFixed(3)}` : v.toFixed(3)}
                          </span>
                        ),
                      },
                    ]}
                  />
                </Card>
              </Col>
          </Row>
        </>
      )}

      {!loading && !currentConclusion && (
        <Card style={{ textAlign: 'center', padding: 40 }}>
          <Empty description="診断可能な結論が見つかりませんでした。" />
        </Card>
      )}
    </div>
  )
}
