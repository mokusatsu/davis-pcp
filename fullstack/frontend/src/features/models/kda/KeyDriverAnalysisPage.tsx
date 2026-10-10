import Statistic from '../../common/RoundedStatistic'
import { vifDisplay } from './vifDisplay'
import { useScopedRun, AnalysisScopeSummary } from '../../selection/analysisScope'
import ColumnQuestionTooltip, { useQuestionText } from '../../common/ColumnQuestionTooltip'
import EChart from '../../charts/EChart'
import Table from '../../common/ColumnTable'
import Select from '../../common/ColumnSelect'
import { useState, useEffect, useMemo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Typography, Space, Button, Tag,
  Alert, Spin, Slider, Divider,
} from 'antd'
import {
  RocketOutlined, ThunderboltOutlined, ExperimentOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../../app/store'
import { pcpStateChanged } from '../../../app/store'
import { api } from '../../../api/client'
import GraphPanel from '../../common/GraphPanel'
import { captureKdaPraHandoff, type KdaPraHandoff } from '../../pra/kdaHandoff'
import { numericModelInputError, useNumericModelInputs } from './useNumericModelInputs'
import { useCodebook } from '../../dataset/useCodebookColumn'
import WeightUnsupportedAlert from '../../common/WeightUnsupportedAlert'

export interface DriverItem {
  name: string
  label: string
  kind: 'numeric' | 'nominal'
  encoding?: {
    levels: Array<{ code: string; label: string }>
    reference_code: string
    design_column_count: number
  }
  importance_raw: number
  importance_pct: number
  direction: number | null
  standardized_coef: number | null
  raw_slope: number | null
  pearson_r: number | null
  vif: number | null
  note: string
}

export interface KdaResponse {
  run_id: string
  method: string
  outcome: { name: string; label: string; type: string }
  model: {
    r_squared: number
    n_valid: number
    vif_max: number | null
    vif_coverage: 'all_drivers' | 'numeric_drivers_only'
    warnings: string[]
  }
  drivers: DriverItem[]
  what_if_baseline: {
    outcome_mean: number
    driver_means: Record<string, number>
    raw_slopes: Record<string, number>
  }
}

function driverDirection(driver: DriverItem) {
  if (driver.kind === 'nominal') return '名義尺度・方向なし'
  if (driver.direction == null) return '方向を算出できません'
  return driver.direction >= 0 ? '+ 正の寄与' : '- 負の寄与'
}

function whatIfDrivers(result: KdaResponse) {
  return result.drivers.filter(driver => driver.kind === 'numeric'
    && driver.raw_slope != null && Number.isFinite(driver.raw_slope)
    && Number.isFinite(result.what_if_baseline.driver_means[driver.name])
    && Number.isFinite(result.what_if_baseline.raw_slopes[driver.name]))
}

export default function KeyDriverAnalysisPage() {
  const questionText = useQuestionText()
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const weightColumnId = useSelector((s: RootState) => s.globalVariables.weightColumnId)
  const { columns: savedColumns } = useCodebook()
  const weightColumnName = savedColumns.find(column => column.columnId === weightColumnId)?.name

  const { outcomeColumns, predictorColumns, outcome, setOutcome, predictors: drivers, setPredictors: setDrivers, ready: columnsReady, error: columnsError, retry: retryColumns } = useNumericModelInputs('kda')
  const [loading, setLoading] = useState<boolean>(false)
  const [result, setResult] = useState<KdaResponse | null>(null)
  const runScope = useScopedRun(JSON.stringify([outcome, drivers]))
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const [runError, setRunError] = useState<string | null>(null)
  const [resultHandoff, setResultHandoff] = useState<KdaPraHandoff | null>(null)
  useEffect(() => { setResult(null); setResultHandoff(null); setLoading(false); setRunError(null) }, [runScope.identity])
  const [whatIfDeltas, setWhatIfDeltas] = useState<Record<string, number>>({})

  const inputError = numericModelInputError(datasetId, columnsReady, outcomeColumns, predictorColumns, outcome, drivers, runScope.scope.count, '説明変数 (Drivers)', 'kda')
  const nominalDrivers = result?.drivers.filter(driver => driver.kind === 'nominal') ?? []
  const eligibleWhatIfDrivers = useMemo(() => result ? whatIfDrivers(result) : [], [result])

  const calculateKda = async () => {
    if (loading || inputError || !datasetId) return
    const o = outcome
    const d = [...drivers]
    const ticket = runScope.begin()
    setRunError(null)
    setLoading(true)
    try {
      const res = await api.post<KdaResponse>('/models/kda', {
        datasetId,
        rowIds: ticket.scope.rowIds,
        expectedDataRevision: dataRevision,
        expectedSchemaRevision: schemaRevision,
        outcome: o,
        drivers: d,
      })
      if (!ticket.isCurrent()) return
      ticket.commit()
      setResult(res)
      const handoffDrivers = res.drivers.flatMap(driver => driver.direction != null && Number.isFinite(driver.direction)
        ? [{ name: driver.name, importancePct: driver.importance_pct, direction: driver.direction }] : [])
      setResultHandoff(res.drivers.some(driver => driver.kind === 'nominal') || handoffDrivers.length !== res.drivers.length ? null : captureKdaPraHandoff({
        version: 1, kind: 'kda-to-pra', sourceRunId: res.run_id, datasetId, dataRevision, schemaRevision,
        outcome: o, drivers: d, scopeSnapshot: ticket.scope,
        sourceConclusion: { kind: 'shapley-importance', method: res.method, rSquared: res.model.r_squared, nValid: res.model.n_valid,
          drivers: handoffDrivers },
      }))
      // reset what-if deltas
      const initialDeltas: Record<string, number> = {}
      whatIfDrivers(res).forEach((drv) => {
        initialDeltas[drv.name] = 0.0
      })
      setWhatIfDeltas(initialDeltas)
    } catch (err) {
      if (ticket.isCurrent()) setRunError((err as {message?: string}).message || '分析に失敗しました。')
    } finally {
      if (ticket.isCurrent()) setLoading(false)
    }
  }

  // Compute what-if predicted change
  const predictedOutcome = useMemo(() => {
    if (!result?.what_if_baseline || !eligibleWhatIfDrivers.length) return null
    const baseMean = result.what_if_baseline.outcome_mean
    let deltaSum = 0.0
    for (const driver of eligibleWhatIfDrivers) {
      deltaSum += result.what_if_baseline.raw_slopes[driver.name] * (whatIfDeltas[driver.name] ?? 0)
    }
    return {
      baseline: baseMean,
      predicted: baseMean + deltaSum,
      deltaTotal: deltaSum,
    }
  }, [result, eligibleWhatIfDrivers, whatIfDeltas])

  const handleProjectPcp = () => {
    if (!result || result.drivers.length === 0) return
    const top3 = result.drivers.slice(0, 3).map((d) => d.name)
    const axes = [result.outcome.name, ...top3]
    dispatch(pcpStateChanged({
      order: axes,
      visibleColumns: axes,
    }))
    navigate('/pcp')
  }

  const handleSendToPenaltyReward = () => {
    if (!resultHandoff) return
    navigate('/penalty-reward', { state: { kdaHandoff: captureKdaPraHandoff(resultHandoff) } })
  }


  return (
    <div
      style={{
        padding: 16,
        height: 'auto',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'visible',
      }}
      data-testid="kda-page"
    >
      <WeightUnsupportedAlert weightColumnName={weightColumnName} />
      <AnalysisScopeSummary snapshot={runScope.snapshot} />
      {runScope.dirty && <Alert type="info" message={inputError ? '現在の入力と異なる実行済み結果です。入力の不足を修正すると再実行できます。' : '現在の入力と異なる実行済み結果です。再実行すると更新されます。'} />}
      {columnsError && <Alert type="error" message={columnsError} action={<Button onClick={retryColumns}>列を再読込み</Button>} />}
      {runError && <Alert type="error" message={runError} />}
      {/* Configuration Header */}
      {(
        <Card size="small" style={{ marginBottom: 12, flexShrink: 0 }}>
          <Row gutter={[16, 12]} align="middle">
            <Col xs={24} md={8}>
              <Typography.Text strong>目的変数 (Outcome):</Typography.Text>
              <Select
                data-testid="kda-outcome-select"
                style={{ width: '100%', marginTop: 4 }}
                value={outcome || undefined}
                onChange={(val) => {
                  setOutcome(val)
                  const newD = predictorColumns.filter((c) => c !== val)
                  setDrivers(newD)
                }}
                options={outcomeColumns.map((c) => ({ label: c, value: c }))}
              />
            </Col>
            <Col xs={24} md={12}>
              <Typography.Text strong>説明変数 (Drivers):</Typography.Text>
              <Select
                mode="multiple"
                data-testid="kda-drivers-select"
                style={{ width: '100%', marginTop: 4 }}
                value={drivers}
                onChange={(vals) => {
                  setDrivers(vals)
                }}
                options={predictorColumns.filter((c) => c !== outcome).map((c) => ({ label: c, value: c }))}
              />
            </Col>
            <Col xs={24} md={4} style={{ textAlign: 'right' }}>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={loading}
                disabled={!!inputError}
                onClick={() => void calculateKda()}
                data-testid="kda-run-btn"
                style={{ marginTop: 22, width: '100%' }}
              >
                KDA 計算実行
              </Button>
            </Col>
          </Row>
          {inputError && <Alert type="warning" showIcon message={inputError} data-testid="kda-input-error" style={{ marginTop: 12 }} />}
        </Card>
      )}

      {loading && !result && (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip="Shapley回帰 (LMG決定係数分解) を計算中..." />
        </div>
      )}

      {result && (
        <>
          {/* KPI and Model Quality Card */}
          {(
            <Row gutter={[12, 12]} style={{ marginBottom: 12, flexShrink: 0 }}>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="決定係数 (Full R²)"
                    value={(result.model.r_squared * 100).toFixed(1)}
                    suffix="%"
                    valueStyle={{ color: '#1677ff' }}
                    prefix={<ThunderboltOutlined />}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="最大共線性 (Max VIF)"
                    value={result.model.vif_max ?? '—'}
                    formatter={() => vifDisplay(result.model.vif_max).text}
                    valueStyle={{ color: vifDisplay(result.model.vif_max).color }}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {vifDisplay(result.model.vif_max).label}。5超: 注意 / 10超: 強い共線性
                  </Typography.Text>
                  {result.model.vif_coverage === 'numeric_drivers_only' && <Typography.Text type="secondary" data-testid="kda-vif-coverage" style={{ display: 'block', fontSize: 11 }}>
                    VIFは算出可能な数値・順序尺度の要因のみが対象です。名義尺度の共線性は評価していません。
                  </Typography.Text>}
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic title="有効サンプル数" value={result.model.n_valid} />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic title="分析手法" value="Shapley (LMG)" valueStyle={{ fontSize: 16 }} />
                </Card>
              </Col>
            </Row>
          )}

          {result.model.warnings.length > 0 && (
            <Alert
              message="多重共線性診断の注記"
              description={result.model.warnings.join(' ')}
              type="warning"
              showIcon
              style={{ marginBottom: 12, flexShrink: 0 }}
            />
          )}

          {/* Main Visuals: Shapley Importance Chart & Correlation Contrast Table */}
          <Row gutter={[16, 16]} style={{ flexShrink: 0, minHeight: 0 }}>
            {/* Left: Shapley Importance Bar Chart: G32。比較表は対象外（X04） */}
            {(
              <Col xs={24} xxl={12} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
                  <GraphPanel
                    graphId="key-drivers/importance"
                    title="真のキードライバー重要度"
                    available={Boolean(result?.drivers?.length)}
                    sizing="intrinsic"
                    intrinsicSize={{ width: 560, height: Math.max(280, 120 + (result?.drivers?.length ?? 4) * 56) }}
                    normalWidth="viewport"
                  >
                  <Card
                    size="small"
                    data-testid="kda-importance-chart"
                    style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
                  >
                    <EChart height={Math.max(280, result.drivers.length * 48 + 80)} ariaLabel="Shapley重要度"
                      option={{ grid: { left: 170, right: 60, top: 20, bottom: 45 },
                        tooltip: { trigger: 'axis', renderMode: 'richText', formatter: (params: any) => { const p = params[0]; const d = p && result.drivers[p.dataIndex]; return d ? `${questionText(d.name)}\n重要度: ${d.importance_pct}%\n${driverDirection(d)}` : '' } },
                        xAxis: { type: 'value', min: 0, max: 100, name: '重要度 (%)', nameLocation: 'middle', nameGap: 28 },
                        yAxis: { type: 'category', inverse: true, data: result.drivers.map((d,i) => `#${i+1} ${d.label}\n${driverDirection(d)}`) },
                        series: [{ type: 'bar', data: result.drivers.map((d,i) => ({ value: d.importance_pct,
                          itemStyle: { color: d.kind === 'nominal' || d.direction == null ? '#8c8c8c' : i === 0 ? '#faad14' : d.direction >= 0 ? '#1677ff' : '#ff4d4f' } })),
                          label: { show: true, position: 'right', color: '#333', formatter: (p:any) => `${Number(p.value).toFixed(1)}%` } }] }} />
                  </Card>
                  </GraphPanel>
              </Col>
            )}

            {/* Right: Correlation vs True Impact Contrast Table: X04 対象外。拡大なし・表維持 */}
            {(
              <Col xs={24} xxl={12} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
                  <Card
                    size="small"
                    title="相関 (見かけ) vs Shapley (真のインパクト) 乖離分析"
                    data-testid="kda-contrast-table"
                    style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
                  >
                    <Table
                      size="small"
                      pagination={false}
                      tableLayout="fixed"
                      scroll={{ x: 760 }}
                      dataSource={result.drivers.map((d, idx) => ({ ...d, key: idx }))}
                      columns={[
                        { title: '要因名', dataIndex: 'label', width: 240, onCell: () => ({ style: { whiteSpace: 'normal', overflowWrap: 'anywhere' } }) },
                        {
                          title: 'Shapley %',
                          dataIndex: 'importance_pct',
                          width: 96,
                          render: (v: number) => <strong>{v.toFixed(1)}%</strong>,
                        },
                        {
                          title: '単相関 r',
                          dataIndex: 'pearson_r',
                          width: 120,
                          render: (v: number | null, driver: DriverItem) => v == null ? (driver.kind === 'nominal' ? '—（対象外）' : '—（算出不可）') : `r = ${v.toFixed(2)}`,
                        },
                        {
                          title: 'VIF',
                          dataIndex: 'vif',
                          width: 80,
                          render: (v: number | null, driver: DriverItem) => (
                            <span title={driver.kind === 'nominal' ? '名義尺度の単一VIFは対象外です' : vifDisplay(v).label} style={{ color: vifDisplay(v).color }}>{vifDisplay(v).text}</span>
                          ),
                        },
                        {
                          title: '乖離評価',
                          dataIndex: 'note',
                          width: 224,
                          render: (note: string) => {
                            const color = note.includes('見かけ') ? 'orange' : (note.includes('隠れた') ? 'purple' : 'default')
                            return <Tag color={color} style={{ whiteSpace: 'normal', maxWidth: '100%', overflowWrap: 'anywhere', marginInlineEnd: 0 }}>{note}</Tag>
                          },
                        },
                      ]}
                    />
                  </Card>
              </Col>
            )}
          </Row>

          {/* Interactive What-If Simulator & Action Bar */}
          {(
            <Card
              size="small"
              style={{ marginTop: 16, flexShrink: 0 }}
              title={
                <div style={{ whiteSpace: 'normal', display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
                  <Space>
                    <ExperimentOutlined />
                    <Typography.Text strong>
                      インタラクティブ改善シミュレーター (What-If Simulator)
                    </Typography.Text>
                  </Space>
                  <Space wrap size={8}>
                    <Button
                      type="primary"
                      icon={<ArrowRightOutlined />}
                      onClick={handleProjectPcp}
                      data-testid="project-pcp-axes-btn"
                    >
                      Project Top 3 Drivers to PCP Axes
                    </Button>
                    <Button
                      icon={<RocketOutlined />}
                      disabled={!resultHandoff}
                      aria-describedby={nominalDrivers.length ? 'kda-pra-nominal-unavailable' : undefined}
                      onClick={handleSendToPenaltyReward}
                      data-testid="send-pra-btn"
                    >
                      Send to Penalty-Reward
                    </Button>
                    <Button
                      icon={<ThunderboltOutlined />}
                      disabled
                      aria-describedby="kda-robustness-unavailable"
                      data-testid="send-robustness-btn"
                    >
                      Check Robustness
                    </Button>
                  </Space>
                  <Typography.Text type="secondary">実行済みKDAの目的変数・説明変数・要求対象行をPenalty-Rewardへ引き継ぎ、低評価側と高評価側の非対称性を別途分析します。</Typography.Text>
                  {nominalDrivers.length > 0 && <Typography.Text type="secondary" id="kda-pra-nominal-unavailable">
                    実行済みKDAに名義尺度の要因（{nominalDrivers.map(driver => driver.name).join(', ')}）が含まれるため、この分析全体を引き継げません。Penalty-Rewardには低評価・高評価の順序を持つ評価尺度が必要です。
                  </Typography.Text>}
                  <Typography.Text type="secondary" id="kda-robustness-unavailable">KDAのShapley重要度の頑健性検証には未対応です。Robustnessの平均値検証では代用できません。</Typography.Text>
                </div>
              }
              data-testid="kda-whatif-simulator"
            >
              {predictedOutcome ? (
                <Row gutter={[16, 16]} align="middle" style={{ marginBottom: 12 }}>
                  <Col xs={24} md={8}>
                    <Statistic
                      title="現在のアウトカム全体平均"
                      value={predictedOutcome.baseline}
                      precision={3}
                    />
                  </Col>
                  <Col xs={24} md={8}>
                    <Statistic
                      title="施策適用後の予測値"
                      value={predictedOutcome.predicted}
                      precision={3}
                      valueStyle={{
                        color: predictedOutcome.deltaTotal >= 0 ? '#3f8600' : '#cf1322',
                        fontWeight: 'bold',
                      }}
                    />
                  </Col>
                  <Col xs={24} md={8}>
                    <Statistic
                      title="予測向上幅 (Shift)"
                      value={predictedOutcome.deltaTotal}
                      precision={3}
                      prefix={predictedOutcome.deltaTotal >= 0 ? '+' : ''}
                      valueStyle={{ color: predictedOutcome.deltaTotal >= 0 ? '#3f8600' : '#cf1322' }}
                    />
                  </Col>
                </Row>
              ) : <Statistic title="現在のアウトカム全体平均" value={result.what_if_baseline.outcome_mean} precision={3} />}

              <Divider style={{ margin: '8px 0 16px 0' }} />

              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                {eligibleWhatIfDrivers.length ? '利用可能な数値・順序尺度の要因のスコアを変動させた場合の予測満足度変化をリアルタイム計算します。' : '利用可能な数値・順序尺度の傾きがないため、予測値・予測向上幅は算出できません。'}
                {nominalDrivers.length > 0 && '名義尺度には点数の大小がないため、平均値やポイント変動のスライダーは表示しません。'}
              </Typography.Text>

              <Row gutter={[16, 12]}>
                {eligibleWhatIfDrivers.slice(0, 6).map((d) => {
                  const currentDelta = whatIfDeltas[d.name] || 0.0
                  return (
                    <Col xs={24} sm={12} md={8} key={d.name}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <span><ColumnQuestionTooltip nameOrId={d.name}>{d.label}</ColumnQuestionTooltip></span>
                        <span>{currentDelta > 0 ? `+${currentDelta.toFixed(2)}` : currentDelta.toFixed(2)} pt</span>
                      </div>
                      <Slider
                        ariaLabelForHandle={`${d.label}のスコア変動`}
                        min={-2.0}
                        max={2.0}
                        step={0.1}
                        value={currentDelta}
                        onChange={(v) => {
                          setWhatIfDeltas((prev) => ({ ...prev, [d.name]: v }))
                        }}
                      />
                    </Col>
                  )
                })}
              </Row>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
