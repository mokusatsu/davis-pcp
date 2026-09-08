import { Select as AntSelect } from 'antd'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { useState, useEffect, useMemo } from 'react'
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
import { selectionApplied, pcpStateChanged } from '../../app/store'
import { api } from '../../api/client'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import ModernSubgroupMiningView from './ModernSubgroupMiningView'

export interface InsightItem {
  id: string
  subgroup: { name: string; label: string; type: string }
  question: { name: string; label: string; type: string }
  test: {
    method: string
    statistic: number | null
    p_value: number
    q_value: number
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
}

export default function SubgroupMiningPage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  const [columns, setColumns] = useState<Array<{ name: string; type: string }>>([])
  const [attrCols, setAttrCols] = useState<string[]>([])
  const [qCols, setQCols] = useState<string[]>([])
  const [alpha, setAlpha] = useState<number>(0.05)
  const [minGroupSize, setMinGroupSize] = useState<number>(10)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<{ message: string; details?: string; suggestedActions?: string[] } | null>(null)
  const [miningResult, setMiningResult] = useState<MiningResult | null>(null)
  const [selectedInsightId, setSelectedInsightId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'modern' | 'classic'>('modern')

  // Fetch columns on mount or datasetId change
  useEffect(() => {
    if (!datasetId) return
    let active = true
    api.get<{ schema: Array<{ name: string; physicalType: string; semanticType: string }> }>(`/datasets/${datasetId}`)
      .then((meta) => {
        if (!active) return
        const cols = meta.schema.map((c) => ({ name: c.name, type: c.semanticType || c.physicalType }))
        setColumns(cols)
        // Default attributes: categorical or string or small-cardinality
        const defaultAttrs = cols.filter((c) => c.type === 'categorical' || c.name.includes('group') || c.name.includes('species') || c.name.includes('segment')).map((c) => c.name)
        const defaultQs = cols.filter((c) => !defaultAttrs.includes(c.name)).map((c) => c.name)
        setAttrCols(defaultAttrs.length > 0 ? defaultAttrs : [cols[cols.length - 1]?.name].filter(Boolean))
        setQCols(defaultQs.length > 0 ? defaultQs : cols.map((c) => c.name))
      })
      .catch((err) => {
        console.error('Failed to load dataset columns', err)
      })
    return () => { active = false }
  }, [datasetId])

  const runMining = async () => {
    if (!datasetId) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.post<MiningResult>('/mining/subgroups', {
        datasetId,
        attributeCols: attrCols.length > 0 ? attrCols : undefined,
        questionCols: qCols.length > 0 ? qCols : undefined,
        alpha,
        minGroupSize,
      })
      setMiningResult(res)
      if (res.insights.length > 0) {
        setSelectedInsightId(res.insights[0].id)
      } else {
        setSelectedInsightId(null)
      }
    } catch (err: any) {
      console.error('Mining execution error', err)
      const msg = err?.message || err?.detail || '単変量マイニング処理中にエラーが発生しました。'
      const details = typeof err?.details === 'object' ? JSON.stringify(err.details, null, 2) : (err?.details ? String(err.details) : undefined)
      const actions = Array.isArray(err?.suggestedActions) ? err.suggestedActions : undefined
      setError({ message: msg, details, suggestedActions: actions })
    } finally {
      setLoading(false)
    }
  }

  // Auto-run once dataset is loaded (only if classic tab is active)
  useEffect(() => {
    if (datasetId && columns.length > 0 && !miningResult && !loading && activeTab === 'classic') {
      void runMining()
    }
  }, [datasetId, columns, activeTab])

  const currentInsight = useMemo(() => {
    if (!miningResult || !selectedInsightId) return null
    return miningResult.insights.find((ins) => ins.id === selectedInsightId) ?? miningResult.insights[0] ?? null
  }, [miningResult, selectedInsightId])

  const handleSelectRowsInPcp = (insight: InsightItem) => {
    const rids = insight.row_ids?.highest_group || insight.row_ids?.top_group || []
    if (rids.length > 0) {
      dispatch(selectionApplied({
        rowIds: rids,
        operation: 'replace',
        label: `Subgroup: ${insight.subgroup.name}=${insight.direction.highest_group || insight.direction.top_group}`,
      }))
    }
  }

  const handleFocusPcpPair = (insight: InsightItem) => {
    handleSelectRowsInPcp(insight)
    dispatch(pcpStateChanged({
      order: [insight.subgroup.name, insight.question.name],
      visibleColumns: [insight.subgroup.name, insight.question.name],
    }))
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
                    <Row gutter={[12, 12]} align="middle">
                      <Col xs={24} md={6}>
            <Typography.Text strong>属性変数 (Subgroups):</Typography.Text>
            <Select
              mode="multiple"
              style={{ width: '100%', marginTop: 4 }}
              placeholder="属性を選択"
              value={attrCols}
              onChange={setAttrCols}
              options={columns.map((c) => ({ label: c.name, value: c.name }))}
            />
          </Col>
          <Col xs={24} md={6}>
            <Typography.Text strong>質問変数 (Questions):</Typography.Text>
            <Select
              mode="multiple"
              style={{ width: '100%', marginTop: 4 }}
              placeholder="質問を選択"
              value={qCols}
              onChange={setQCols}
              options={columns.map((c) => ({ label: c.name, value: c.name }))}
            />
          </Col>
          <Col xs={12} md={3}>
            <Typography.Text strong>FDR α:</Typography.Text>
            <AntSelect
              style={{ width: '100%', marginTop: 4 }}
              value={alpha}
              onChange={setAlpha}
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
              style={{ width: '100%', marginTop: 22 }}
            >
              Run Auto Mining
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
                                  {ins.test.method} (q={ins.test.q_value}) | {ins.effect.measure}: {ins.effect.value.toFixed(2)}
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

                {/* Test & Score details */}
                <Divider style={{ margin: '12px 0' }} />
                <Row gutter={[12, 12]}>
                  <Col span={6}>
                    <Statistic title="検定統計量" value={currentInsight.test.statistic ?? '-'} precision={3} />
                  </Col>
                  <Col span={6}>
                    <Statistic title="p値" value={currentInsight.test.p_value} />
                  </Col>
                  <Col span={6}>
                    <Statistic title="q値 (FDR)" value={currentInsight.test.q_value} valueStyle={{ color: '#1677ff' }} />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title={`効果量 (${currentInsight.effect.measure})`}
                      value={currentInsight.effect.value}
                      precision={3}
                    />
                  </Col>
                </Row>
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
    </div>
  )
}
