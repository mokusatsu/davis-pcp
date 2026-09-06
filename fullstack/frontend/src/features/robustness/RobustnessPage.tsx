import { useState, useEffect, useMemo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Typography, Space, Button, Table, Tag,
  Select, Statistic, Alert, Spin, Empty, Progress,
} from 'antd'
import {
  AlertOutlined, AimOutlined,
  ReloadOutlined, ArrowRightOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, pcpStateChanged } from '../../app/store'
import { api } from '../../api/client'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'

export interface PerturbationItem {
  strategy: string
  label: string
  param: any
  estimate: number
  drift: number
  flipped: boolean
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

export default function RobustnessPage() {
  const { focused, isTargetActive } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  const [loading, setLoading] = useState<boolean>(false)
  const [data, setData] = useState<RobustnessResponse | null>(null)
  const [selectedConclusionId, setSelectedConclusionId] = useState<string | null>(null)

  const fetchRobustness = async () => {
    if (!datasetId) return
    setLoading(true)
    try {
      const res = await api.post<RobustnessResponse>('/robustness/evaluate', {
        datasetId,
        bootstrapB: 100,
      })
      setData(res)
      if (res.conclusions.length > 0) {
        setSelectedConclusionId(res.conclusions[0].id)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (datasetId) {
      void fetchRobustness()
    }
  }, [datasetId])

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
      style={{
        padding: focused ? 0 : 16,
        height: '100%',
        flex: focused ? 1 : undefined,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        minHeight: 0,
      }}
      data-testid="robustness-page"
    >
      {/* Top Bar */}
      {!focused && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <Row gutter={[16, 12]} align="middle">
            <Col xs={24} md={12}>
              <Space>
                <Typography.Text strong>診断対象結論 (Conclusion):</Typography.Text>
                <Select
                  data-testid="conclusion-selector"
                  style={{ minWidth: 320 }}
                  value={selectedConclusionId ?? undefined}
                  onChange={setSelectedConclusionId}
                  options={data?.conclusions.map((c) => ({
                    label: `${c.label} [${c.robustness.grade_label}]`,
                    value: c.id,
                  }))}
                />
              </Space>
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
          <Spin size="large" tip="摂動シミュレーション（品質除去・ブートストラップ・ジャックナイフ）実行中..." />
        </div>
      )}

      {currentConclusion && (
        <>
          {/* Robustness Scorecard */}
          {!focused && (
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
          {!focused && currentConclusion.robustness.grade === 'fragile' && (
            <Alert
              message="結論の脆弱性警告"
              description="この結論は回答者サンプルの軽微な摂動（外れ回答者の除外やリサンプリング）によって反転・大幅変動する可能性が高い脆い結論です。意思決定に利用する際は慎重に検証してください。"
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          <Row
            gutter={focused ? [0, 0] : [16, 16]}
            style={{
              flex: focused ? 1 : undefined,
              height: focused ? '100%' : undefined,
              minHeight: 0,
            }}
          >
            {/* Left: Tornado Plot & Quality Removal Curve */}
            {(!focused || isTargetActive('robustness-tornado') || isTargetActive('robustness-sweep')) && (
              <Col
                xs={24}
                lg={focused ? 24 : 13}
                style={{
                  height: focused ? '100%' : undefined,
                  flex: focused ? 1 : undefined,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                }}
              >
                {/* Tornado Plot */}
                {(!focused || isTargetActive('robustness-tornado')) && (
                  <FocusTarget id="robustness-tornado" title="摂動トルネード分析">
                    <Card
                      size="small"
                      title="摂動トルネード分析 (Perturbation Tornado Plot)"
                      extra={<FocusEnterButton targetId="robustness-tornado" title="摂動トルネード分析" />}
                      data-testid="perturbation-tornado-plot"
                      style={{
                        marginBottom: focused ? 0 : 16,
                        height: focused ? '100%' : undefined,
                        flex: focused ? 1 : undefined,
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                      bodyStyle={focused ? { flex: 1, overflow: 'auto' } : undefined}
                    >
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                        各摂動シナリオ下での推定値ドリフト（%）。反転が起きた場合は赤色でハイライト。
                      </Typography.Text>
                      <Space direction="vertical" style={{ width: '100%' }} size={12}>
                        {currentConclusion.perturbations.map((p, idx) => {
                          const driftPct = Math.min(100, Math.round(p.drift * 100))
                          return (
                            <div key={idx}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                                <span><strong>{p.label}</strong> (推定: {p.estimate})</span>
                                <span>
                                  {p.flipped && <Tag color="error">反転発生</Tag>}
                                  ドリフト: {driftPct}%
                                </span>
                              </div>
                              <Progress
                                percent={driftPct}
                                status={p.flipped ? 'exception' : 'normal'}
                                strokeColor={p.flipped ? '#ff4d4f' : '#1890ff'}
                                size="small"
                              />
                            </div>
                          )
                        })}
                      </Space>
                    </Card>
                  </FocusTarget>
                )}

                {/* Quality Sweep Curve Table / View */}
                {(!focused || isTargetActive('robustness-sweep')) && (
                  <FocusTarget id="robustness-sweep" title="品質除去スイープ曲線">
                    <Card
                      size="small"
                      title="回答者品質除去スイープ曲線 (Quality Sweep Curve)"
                      extra={<FocusEnterButton targetId="robustness-sweep" title="品質除去スイープ曲線" />}
                      data-testid="quality-sweep-curve"
                      style={{
                        height: focused ? '100%' : undefined,
                        flex: focused ? 1 : undefined,
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                      bodyStyle={focused ? { flex: 1, overflow: 'auto' } : undefined}
                    >
                      <Table
                        size="small"
                        pagination={false}
                        dataSource={currentConclusion.sweep_curve.map((s, idx) => ({ ...s, key: idx }))}
                        columns={[
                          { title: '品質除去率', dataIndex: 'pct_label' },
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
                  </FocusTarget>
                )}
              </Col>
            )}

            {/* Right: Top-Influence Respondents Table */}
            {!focused && (
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
            )}
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
