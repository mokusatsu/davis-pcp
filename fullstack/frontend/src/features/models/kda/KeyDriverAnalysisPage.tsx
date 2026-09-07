import { useState, useEffect, useMemo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Typography, Space, Button, Select, Table, Tag,
  Statistic, Alert, Spin, Progress, Slider, Divider,
} from 'antd'
import {
  RocketOutlined, ThunderboltOutlined, ExperimentOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../../app/store'
import { pcpStateChanged } from '../../../app/store'
import { api } from '../../../api/client'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../../common/FocusMode'

export interface DriverItem {
  name: string
  label: string
  importance_raw: number
  importance_pct: number
  direction: number
  standardized_coef: number
  raw_slope: number
  pearson_r: number
  vif: number
  note: string
}

export interface KdaResponse {
  run_id: string
  method: string
  outcome: { name: string; label: string; type: string }
  model: {
    r_squared: number
    n_valid: number
    vif_max: number
    warnings: string[]
  }
  drivers: DriverItem[]
  what_if_baseline: {
    outcome_mean: number
    driver_means: Record<string, number>
    raw_slopes: Record<string, number>
  }
}

export default function KeyDriverAnalysisPage() {
  const { focused, isTargetActive } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  const [columns, setColumns] = useState<string[]>([])
  const [outcome, setOutcome] = useState<string>('')
  const [drivers, setDrivers] = useState<string[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [result, setResult] = useState<KdaResponse | null>(null)
  const [whatIfDeltas, setWhatIfDeltas] = useState<Record<string, number>>({})

  // Fetch columns
  useEffect(() => {
    if (!datasetId) return
    let active = true
    api.get<{ schema: Array<{ name: string; semanticType: string; physicalType: string }> }>(`/datasets/${datasetId}`)
      .then((meta) => {
        if (!active) return
        const numCols = meta.schema
          .filter((c) => c.semanticType === 'numeric' || c.physicalType === 'float' || c.physicalType === 'int')
          .map((c) => c.name)
        setColumns(numCols)
        if (numCols.length >= 2) {
          setOutcome(numCols[numCols.length - 1])
          setDrivers(numCols.slice(0, numCols.length - 1))
        }
      })
      .catch(() => {})
    return () => { active = false }
  }, [datasetId])

  const calculateKda = async (targetOutcome?: string, targetDrivers?: string[]) => {
    const o = targetOutcome || outcome
    const d = targetDrivers || drivers
    if (!datasetId || !o || d.length === 0) return
    setLoading(true)
    try {
      const res = await api.post<KdaResponse>('/models/kda', {
        datasetId,
        outcome: o,
        drivers: d,
      })
      setResult(res)
      // reset what-if deltas
      const initialDeltas: Record<string, number> = {}
      res.drivers.forEach((drv) => {
        initialDeltas[drv.name] = 0.0
      })
      setWhatIfDeltas(initialDeltas)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (datasetId && outcome && drivers.length > 0 && !result && !loading) {
      void calculateKda()
    }
  }, [datasetId, outcome, drivers])

  // Compute what-if predicted change
  const predictedOutcome = useMemo(() => {
    if (!result?.what_if_baseline) return null
    const baseMean = result.what_if_baseline.outcome_mean
    let deltaSum = 0.0
    for (const [drvName, delta] of Object.entries(whatIfDeltas)) {
      const slope = result.what_if_baseline.raw_slopes[drvName] || 0.0
      deltaSum += slope * delta
    }
    return {
      baseline: baseMean,
      predicted: baseMean + deltaSum,
      deltaTotal: deltaSum,
    }
  }, [result, whatIfDeltas])

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
    if (!result) return
    navigate('/penalty-reward')
  }

  const handleSendToRobustness = () => {
    navigate('/robustness')
  }

  return (
    <div
      style={{
        padding: focused ? 0 : 16,
        height: focused ? '100%' : 'auto',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: focused ? 'hidden' : 'visible',
      }}
      data-testid="kda-page"
    >
      {/* Configuration Header */}
      {!focused && (
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
                  const newD = columns.filter((c) => c !== val)
                  setDrivers(newD)
                  void calculateKda(val, newD)
                }}
                options={columns.map((c) => ({ label: c, value: c }))}
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
                  void calculateKda(outcome, vals)
                }}
                options={columns.filter((c) => c !== outcome).map((c) => ({ label: c, value: c }))}
              />
            </Col>
            <Col xs={24} md={4} style={{ textAlign: 'right' }}>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={loading}
                onClick={() => void calculateKda()}
                data-testid="kda-run-btn"
                style={{ marginTop: 22, width: '100%' }}
              >
                KDA 計算実行
              </Button>
            </Col>
          </Row>
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
          {!focused && (
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
                    value={result.model.vif_max}
                    precision={1}
                    valueStyle={{ color: result.model.vif_max > 10 ? '#cf1322' : '#52c41a' }}
                  />
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

          {!focused && result.model.warnings.length > 0 && (
            <Alert
              message="多重共線性診断の注記"
              description={result.model.warnings.join(' ')}
              type="warning"
              showIcon
              style={{ marginBottom: 12, flexShrink: 0 }}
            />
          )}

          {/* Main Visuals: Shapley Importance Chart & Correlation Contrast Table */}
          <Row
            gutter={focused ? [0, 0] : [16, 16]}
            style={{
              flex: focused ? 1 : 'none',
              flexShrink: 0,
              minHeight: 0,
              height: focused ? '100%' : undefined,
            }}
          >
            {/* Left: Shapley Importance Bar Chart */}
            {(!focused || isTargetActive('kda-importance')) && (
              <Col
                xs={24}
                lg={focused ? 24 : 12}
                style={{
                  height: focused ? '100%' : undefined,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                }}
              >
                <FocusTarget id="kda-importance" title="キードライバー重要度">
                  <Card
                    size="small"
                    title="真のキードライバー重要度 (Shapley Importance %)"
                    extra={<FocusEnterButton targetId="kda-importance" title="キードライバー重要度" />}
                    data-testid="kda-importance-chart"
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
                    <Space direction="vertical" style={{ width: '100%' }} size={14}>
                      {result.drivers.map((d, idx) => {
                        const isTop = idx === 0
                        return (
                          <div key={d.name}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                              <Space>
                                <Typography.Text strong style={{ fontSize: 13 }}>
                                  #{idx + 1} {d.label}
                                </Typography.Text>
                                <Tag color={d.direction >= 0 ? 'blue' : 'red'}>
                                  {d.direction >= 0 ? '+ 正の寄与' : '- 負の寄与'}
                                </Tag>
                                {isTop && <Tag color="gold">#1 Driver</Tag>}
                              </Space>
                              <Typography.Text strong style={{ fontSize: 13 }}>
                                {d.importance_pct.toFixed(1)}%
                              </Typography.Text>
                            </div>
                            <Progress
                              percent={Math.round(d.importance_pct)}
                              strokeColor={isTop ? '#faad14' : (d.direction >= 0 ? '#1677ff' : '#ff4d4f')}
                              size="small"
                            />
                          </div>
                        )
                      })}
                    </Space>
                  </Card>
                </FocusTarget>
              </Col>
            )}

            {/* Right: Correlation vs True Impact Contrast Table */}
            {(!focused || isTargetActive('kda-contrast')) && (
              <Col
                xs={24}
                lg={focused ? 24 : 12}
                style={{
                  height: focused ? '100%' : undefined,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                }}
              >
                <FocusTarget id="kda-contrast" title="相関 vs 真の重要度">
                  <Card
                    size="small"
                    title="相関 (見かけ) vs Shapley (真のインパクト) 乖離分析"
                    extra={<FocusEnterButton targetId="kda-contrast" title="相関 vs 真の重要度" />}
                    data-testid="kda-contrast-table"
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
                    <Table
                      size="small"
                      pagination={false}
                      dataSource={result.drivers.map((d, idx) => ({ ...d, key: idx }))}
                      columns={[
                        { title: '要因名', dataIndex: 'label' },
                        {
                          title: 'Shapley %',
                          dataIndex: 'importance_pct',
                          render: (v: number) => <strong>{v.toFixed(1)}%</strong>,
                        },
                        {
                          title: '単相関 r',
                          dataIndex: 'pearson_r',
                          render: (v: number) => `r = ${v.toFixed(2)}`,
                        },
                        {
                          title: 'VIF',
                          dataIndex: 'vif',
                          render: (v: number) => (
                            <span style={{ color: v > 5 ? '#cf1322' : 'inherit' }}>{v.toFixed(1)}</span>
                          ),
                        },
                        {
                          title: '乖離評価',
                          dataIndex: 'note',
                          render: (note: string) => {
                            const color = note.includes('見かけ') ? 'orange' : (note.includes('隠れた') ? 'purple' : 'default')
                            return <Tag color={color}>{note}</Tag>
                          },
                        },
                      ]}
                    />
                  </Card>
                </FocusTarget>
              </Col>
            )}
          </Row>

          {/* Interactive What-If Simulator & Action Bar */}
          {!focused && (
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
                      onClick={handleSendToPenaltyReward}
                      data-testid="send-pra-btn"
                    >
                      Send to Penalty-Reward
                    </Button>
                    <Button
                      icon={<ThunderboltOutlined />}
                      onClick={handleSendToRobustness}
                      data-testid="send-robustness-btn"
                    >
                      Check Robustness
                    </Button>
                  </Space>
                </div>
              }
              data-testid="kda-whatif-simulator"
            >
              {predictedOutcome && (
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
              )}

              <Divider style={{ margin: '8px 0 16px 0' }} />

              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                各要因のスコアを改善（または変動）させた場合の予測満足度変化をリアルタイム計算します：
              </Typography.Text>

              <Row gutter={[16, 12]}>
                {result.drivers.slice(0, 6).map((d) => {
                  const currentDelta = whatIfDeltas[d.name] || 0.0
                  return (
                    <Col xs={24} sm={12} md={8} key={d.name}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <span>{d.label}</span>
                        <span>{currentDelta > 0 ? `+${currentDelta.toFixed(2)}` : currentDelta.toFixed(2)} pt</span>
                      </div>
                      <Slider
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
