import { useState, useEffect, useMemo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Typography, Space, Button, Select, Table, Tag,
  Statistic, Alert, Spin, Empty, Divider,
} from 'antd'
import {
  AimOutlined, ArrowRightOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, pcpStateChanged } from '../../app/store'
import { api } from '../../api/client'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { truncateText } from '../../utils/textUtils'

export interface PraAttribute {
  name: string
  label: string
  penalty: { coef: number; se: number; p: number; ci: [number, number] }
  reward: { coef: number; se: number; p: number; ci: [number, number] }
  asymmetry: number
  asym_p: number
  classification: 'basic' | 'performance' | 'excitement' | 'indifferent'
  class_label: string
  n_dissatisfied: number
  dissatisfied_row_ids: string[]
  narrative: string
}

export interface PraResponse {
  run_id: string
  outcome: { name: string; label: string; type: string }
  scale: { min: number | null; max: number | null; neutral: number | null }
  model: { r_squared: number; n_valid: number; alpha: number; warnings: string[] }
  attributes: PraAttribute[]
  all_basic_dissatisfied_row_ids: string[]
}

export default function PenaltyRewardPage() {
  const { focused, isTargetActive } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  const [columns, setColumns] = useState<string[]>([])
  const [outcome, setOutcome] = useState<string>('')
  const [attributes, setAttributes] = useState<string[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [result, setResult] = useState<PraResponse | null>(null)
  const [selectedAttribute, setSelectedAttribute] = useState<string | null>(null)

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
          setAttributes(numCols.slice(0, numCols.length - 1))
        }
      })
      .catch(() => {})
    return () => { active = false }
  }, [datasetId])

  const runEvaluation = async (targetOutcome?: string, targetAttrs?: string[]) => {
    const o = targetOutcome || outcome
    const a = targetAttrs || attributes
    if (!datasetId || !o || a.length === 0) return
    setLoading(true)
    try {
      const res = await api.post<PraResponse>('/pra/evaluate', {
        datasetId,
        outcome: o,
        attributes: a,
      })
      setResult(res)
      if (res.attributes.length > 0) {
        setSelectedAttribute(res.attributes[0].name)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (datasetId && outcome && attributes.length > 0 && !result && !loading) {
      void runEvaluation()
    }
  }, [datasetId, outcome, attributes])

  const currentAttr = useMemo(() => {
    if (!result || !selectedAttribute) return null
    return result.attributes.find((a) => a.name === selectedAttribute) ?? result.attributes[0] ?? null
  }, [result, selectedAttribute])

  const handleSelectDissatisfied = (attr?: PraAttribute) => {
    const ids = attr ? attr.dissatisfied_row_ids : result?.all_basic_dissatisfied_row_ids || []
    if (ids.length > 0) {
      dispatch(selectionApplied({
        rowIds: ids,
        operation: 'replace',
        label: attr ? `不満顧客: ${attr.label} (${ids.length}行)` : `当たり前品質の不満顧客 (${ids.length}行)`,
      }))
    }
  }

  const handleFocusPcp = (attr: PraAttribute) => {
    handleSelectDissatisfied(attr)
    dispatch(pcpStateChanged({
      order: [attr.name, result?.outcome.name || ''],
      visibleColumns: [attr.name, result?.outcome.name || ''],
    }))
    navigate('/pcp')
  }

  const handleProjectKanoAxesToPcp = () => {
    if (!result || result.attributes.length === 0) return
    const topBasic = result.attributes.find((a) => a.classification === 'basic')
    const topPerf = result.attributes.find((a) => a.classification === 'performance')
    const topExcite = result.attributes.find((a) => a.classification === 'excitement')

    const axes = [result.outcome.name]
    if (topBasic) axes.push(topBasic.name)
    if (topPerf) axes.push(topPerf.name)
    if (topExcite) axes.push(topExcite.name)
    result.attributes.forEach((a) => {
      if (!axes.includes(a.name) && axes.length < 5) {
        axes.push(a.name)
      }
    })

    dispatch(pcpStateChanged({
      order: axes,
      visibleColumns: axes,
    }))
    navigate('/pcp')
  }

  const getKanoColor = (classification: string) => {
    switch (classification) {
      case 'basic': return 'volcano'
      case 'performance': return 'blue'
      case 'excitement': return 'green'
      case 'indifferent': return 'default'
      default: return 'default'
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
      data-testid="penalty-reward-page"
    >
      {/* Header controls */}
      {!focused && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <Row gutter={[16, 12]} align="middle">
            <Col xs={24} md={8}>
              <Typography.Text strong>総合評価 / アウトカム (Outcome):</Typography.Text>
              <Select
                data-testid="pra-outcome-select"
                style={{ width: '100%', marginTop: 4 }}
                value={outcome || undefined}
                onChange={(val) => {
                  setOutcome(val)
                  const newA = columns.filter((c) => c !== val)
                  setAttributes(newA)
                  void runEvaluation(val, newA)
                }}
                options={columns.map((c) => ({ label: c, value: c }))}
              />
            </Col>
            <Col xs={24} md={12}>
              <Typography.Text strong>評価属性バッテリー (Attributes):</Typography.Text>
              <Select
                mode="multiple"
                data-testid="pra-attributes-select"
                style={{ width: '100%', marginTop: 4 }}
                value={attributes}
                onChange={(vals) => {
                  setAttributes(vals)
                  void runEvaluation(outcome, vals)
                }}
                options={columns.filter((c) => c !== outcome).map((c) => ({ label: c, value: c }))}
              />
            </Col>
            <Col xs={24} md={4} style={{ textAlign: 'right' }}>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={loading}
                onClick={() => void runEvaluation()}
                data-testid="pra-run-btn"
                style={{ marginTop: 22, width: '100%' }}
              >
                三因子分析を実行
              </Button>
            </Col>
          </Row>
        </Card>
      )}

      {loading && !result && (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip="Penalty-Rewardダミー回帰およびWald非対称性検定を計算中..." />
        </div>
      )}

      {result && (
        <>
          {/* Summary KPIs */}
          {!focused && (
            <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="回帰モデル R²"
                    value={(result.model.r_squared * 100).toFixed(1)}
                    suffix="%"
                    valueStyle={{ color: '#1677ff' }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="当たり前品質 (Must-be)"
                    value={result.attributes.filter((a) => a.classification === 'basic').length}
                    valueStyle={{ color: '#d4380d' }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="魅力的品質 (Delighter)"
                    value={result.attributes.filter((a) => a.classification === 'excitement').length}
                    valueStyle={{ color: '#389e0d' }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="一元的品質 (Performance)"
                    value={result.attributes.filter((a) => a.classification === 'performance').length}
                    valueStyle={{ color: '#0958d9' }}
                  />
                </Card>
              </Col>
            </Row>
          )}

          <Row
            gutter={focused ? [0, 0] : [16, 16]}
            style={{
              flex: focused ? 1 : undefined,
              height: focused ? '100%' : undefined,
              minHeight: 0,
            }}
          >
            {/* Left: 4-Quadrant Kano Strategy Board (SVG) */}
            {(!focused || isTargetActive('pra-kano') || isTargetActive('pra-diverging')) && (
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
                {(!focused || isTargetActive('pra-kano')) && (
                  <FocusTarget id="pra-kano" title="Kano 4象限戦略マトリクス">
                    <Card
                      size="small"
                      title="Kano 4象限戦略マトリクス (Penalty vs Reward)"
                      extra={<FocusEnterButton targetId="pra-kano" title="Kano 4象限戦略マトリクス" />}
                      data-testid="kano-quadrant-board"
                      style={{
                        height: focused ? '100%' : undefined,
                        flex: focused ? 1 : undefined,
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                      bodyStyle={focused ? { flex: 1, overflow: 'auto' } : undefined}
                    >
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                        <Button
                          size="small"
                          type="primary"
                          danger
                          icon={<AimOutlined />}
                          onClick={() => handleSelectDissatisfied()}
                          data-testid="select-dissatisfied-all"
                        >
                          当たり前品質の不満顧客をPCP選択 ({result.all_basic_dissatisfied_row_ids.length}行)
                        </Button>
                        <Button
                          size="small"
                          icon={<ArrowRightOutlined />}
                          onClick={handleProjectKanoAxesToPcp}
                          data-testid="project-kano-axes-btn"
                        >
                          Kano最重要軸をPCPへ投影
                        </Button>
                      </div>

                      {/* 4 Quadrants Graphic Area */}
                      <div style={{ position: 'relative', width: '100%', height: focused ? '100%' : 440, minHeight: 380, background: '#fdfdfd', border: '1px solid #e5e7eb', borderRadius: 6, userSelect: 'none' }}>
                        {/* Quadrant background badges */}
                        <div style={{ position: 'absolute', top: 8, right: 12, textAlign: 'right', fontSize: 11, fontWeight: 'bold', color: '#1677ff' }}>
                          一元的品質 (Performance) ↗
                        </div>
                        <div style={{ position: 'absolute', top: 8, left: 12, fontSize: 11, fontWeight: 'bold', color: '#389e0d' }}>
                          ↖ 魅力的品質 (Delighter/Excitement)
                        </div>
                        <div style={{ position: 'absolute', bottom: 8, right: 12, textAlign: 'right', fontSize: 11, fontWeight: 'bold', color: '#d4380d' }}>
                          当たり前品質 (Must-be/Basic) ↘
                        </div>
                        <div style={{ position: 'absolute', bottom: 8, left: 12, fontSize: 11, fontWeight: 'bold', color: '#8c8c8c' }}>
                          ↙ 無関心品質 (Indifferent)
                        </div>

                        {/* Interactive Kano Scatter SVG */}
                        <svg viewBox="0 0 500 400" style={{ width: '100%', height: '100%', display: 'block' }}>
                          {/* Axes */}
                          <line x1={250} y1={20} x2={250} y2={380} stroke="#d9d9d9" strokeDasharray="4 4" strokeWidth={1.5} />
                          <line x1={20} y1={200} x2={480} y2={200} stroke="#d9d9d9" strokeDasharray="4 4" strokeWidth={1.5} />

                          {/* 45 degree diagonal threshold line (symmetric impact) */}
                          <line x1={50} y1={350} x2={450} y2={50} stroke="#f0f0f0" strokeWidth={2} />

                          {/* Axis labels */}
                          <text x={250} y={395} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151">
                            Penalty Impact (|β_low|: 不満低下度) →
                          </text>
                          <text x={12} y={200} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151" transform="rotate(-90 12 200)">
                            Reward Impact (β_high: 満足向上度) →
                          </text>

                          {result.attributes.map((a) => {
                            const cx = 50 + Math.min(Math.max(Math.abs(a.penalty.coef) / 1.5, 0), 1) * 400
                            const cy = 350 - Math.min(Math.max(a.reward.coef / 1.5, 0), 1) * 300
                            const isSelected = a.name === selectedAttribute
                            const color = getKanoColor(a.classification)
                            const r = isSelected ? 8 : 6

                            return (
                              <g
                                key={a.name}
                                onClick={() => setSelectedAttribute(a.name)}
                                style={{ cursor: 'pointer' }}
                              >
                                <circle
                                  cx={cx}
                                  cy={cy}
                                  r={r}
                                  fill={color}
                                  opacity={isSelected ? 1.0 : 0.8}
                                  stroke={isSelected ? '#000' : '#fff'}
                                  strokeWidth={isSelected ? 2 : 1}
                                />
                                <text
                                  x={cx > 380 ? cx - 10 : cx + 10}
                                  y={cy + 4}
                                  textAnchor={cx > 380 ? 'end' : 'start'}
                                  fontSize={11}
                                  fontWeight={isSelected ? 'bold' : 'normal'}
                                  fill="#1f1f1f"
                                  paintOrder="stroke"
                                  stroke="#ffffff"
                                  strokeWidth={3}
                                >
                                  <title>{a.label}</title>
                                  {isSelected ? a.label : truncateText(a.label, 10)}
                                </text>
                              </g>
                            )
                          })}
                        </svg>
                      </div>
                    </Card>
                  </FocusTarget>
                )}

                {/* Diverging Impact Bars */}
                {(!focused || isTargetActive('pra-diverging')) && (
                  <FocusTarget id="pra-diverging" title="非対称インパクト対比">
                    <Card
                      size="small"
                      title="非対称インパクト対比棒グラフ (Diverging Impact Bars)"
                      extra={<FocusEnterButton targetId="pra-diverging" title="非対称インパクト対比" />}
                      data-testid="diverging-impact-bars"
                      style={{
                        marginTop: focused ? 0 : 16,
                        height: focused ? '100%' : undefined,
                        flex: focused ? 1 : undefined,
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                      bodyStyle={focused ? { flex: 1, overflow: 'auto' } : undefined}
                    >
                      <div style={{ width: '100%' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 'bold', marginBottom: 8 }}>
                          <span style={{ color: '#cf1322' }}>◀ Penalty Impact (低評価時の満足度低下 β_low)</span>
                          <span style={{ color: '#3f8600' }}>Reward Impact (高評価時の満足度向上 β_high) ▶</span>
                        </div>

                        {result.attributes.map((a) => {
                          const penWidth = Math.min(50, Math.round(Math.abs(a.penalty.coef) * 50))
                          const rewWidth = Math.min(50, Math.round(Math.abs(a.reward.coef) * 50))
                          const isSelected = a.name === selectedAttribute

                          return (
                            <div
                              key={a.name}
                              onClick={() => setSelectedAttribute(a.name)}
                              style={{
                                marginBottom: 8,
                                cursor: 'pointer',
                                padding: '4px 6px',
                                borderRadius: 4,
                                background: isSelected ? '#e6f7ff' : 'transparent',
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                                <Typography.Text strong ellipsis={{ tooltip: a.label }}>{a.label}</Typography.Text>
                                <Tag color={getKanoColor(a.classification)}>{a.class_label}</Tag>
                              </div>
                              <div style={{ display: 'flex', height: 16, background: '#f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
                                <div style={{ width: '50%', display: 'flex', justifyContent: 'flex-end' }}>
                                  <div style={{ width: `${penWidth * 2}%`, background: '#ff4d4f', height: '100%', borderRadius: '8px 0 0 8px' }} />
                                </div>
                                <div style={{ width: 2, background: '#8c8c8c' }} />
                                <div style={{ width: '50%', display: 'flex', justifyContent: 'flex-start' }}>
                                  <div style={{ width: `${rewWidth * 2}%`, background: '#52c41a', height: '100%', borderRadius: '0 8px 8px 0' }} />
                                </div>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#888', marginTop: 1 }}>
                                <span>{a.penalty.coef.toFixed(2)}</span>
                                <span>+{a.reward.coef.toFixed(2)}</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </Card>
                  </FocusTarget>
                )}
              </Col>
            )}

            {/* Right: Asymmetry Test Table & Action Strategy Board */}
            {!focused && (
              <Col xs={24} lg={11}>
                {currentAttr ? (
                  <Card
                    size="small"
                    title={
                      <Space>
                        <Typography.Text strong style={{ fontSize: 15 }}>
                          {currentAttr.label}
                        </Typography.Text>
                        <Tag color={getKanoColor(currentAttr.classification)}>
                          {currentAttr.class_label}
                        </Tag>
                      </Space>
                    }
                    data-testid="attribute-detail-card"
                  >
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
                      <Button
                        type="primary"
                        icon={<AimOutlined />}
                        onClick={() => handleSelectDissatisfied(currentAttr)}
                        data-testid="select-dissatisfied-pcp"
                        disabled={currentAttr.dissatisfied_row_ids.length === 0}
                      >
                        Select Dissatisfied Customers in PCP ({currentAttr.dissatisfied_row_ids.length}行)
                      </Button>
                      <Button
                        icon={<ArrowRightOutlined />}
                        onClick={() => handleFocusPcp(currentAttr)}
                      >
                        Focus PCP
                      </Button>
                    </div>
                  {/* Action Strategy Alert */}
                  <Alert
                    message="戦略的処方箋・行動指針"
                    description={currentAttr.narrative}
                    type={currentAttr.classification === 'basic' ? 'error' : (currentAttr.classification === 'excitement' ? 'success' : 'info')}
                    showIcon
                    style={{ marginBottom: 16 }}
                  />

                  {/* Coefficients Detail */}
                  <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                    <Col span={12}>
                      <Statistic
                        title="不満ペナルティ (β_low)"
                        value={currentAttr.penalty.coef}
                        precision={3}
                        valueStyle={{ color: '#cf1322' }}
                      />
                      <div style={{ fontSize: 11, color: '#888' }}>
                        p = {currentAttr.penalty.p.toFixed(3)}
                      </div>
                    </Col>
                    <Col span={12}>
                      <Statistic
                        title="充足リワード (β_high)"
                        value={currentAttr.reward.coef}
                        precision={3}
                        valueStyle={{ color: '#3f8600' }}
                      />
                      <div style={{ fontSize: 11, color: '#888' }}>
                        p = {currentAttr.reward.p.toFixed(3)}
                      </div>
                    </Col>
                  </Row>

                  <Divider style={{ margin: '8px 0 12px 0' }} />

                  {/* Wald Asymmetry Test */}
                  <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
                    Wald 非対称性検定 (H0: |β_high| = |β_low|)
                  </Typography.Text>
                  <Table
                    size="small"
                    pagination={false}
                    columns={[
                      { title: '項目', dataIndex: 'key' },
                      { title: '値', dataIndex: 'val' },
                    ]}
                    dataSource={[
                      { key: '非対称度 (|β_high| - |β_low|)', val: currentAttr.asymmetry.toFixed(3) },
                      { key: 'Wald検定 p値', val: currentAttr.asym_p.toFixed(4) },
                      {
                        key: '非対称性の判定',
                        val: currentAttr.asym_p < 0.15 ? '統計的有意な非対称性あり' : '対称的 (線形連動)',
                      },
                      { key: '不満回答者数 (Low)', val: `${currentAttr.n_dissatisfied} 名` },
                    ]}
                  />
                </Card>
              ) : (
                <Card style={{ textAlign: 'center', padding: 40 }}>
                  <Empty description="属性を選択してください" />
                </Card>
              )}

              {/* Full Attribute Wald Asymmetry Summary Table */}
              <Card
                size="small"
                title="全属性 Wald 非対称性・三因子分類一覧"
                data-testid="asymmetry-test-table"
                style={{ marginTop: 16 }}
              >
                <Table
                  size="small"
                  pagination={false}
                  dataSource={result.attributes.map((a, idx) => ({ ...a, key: idx }))}
                  columns={[
                    { title: '属性名', dataIndex: 'label' },
                    {
                      title: 'Penalty',
                      dataIndex: ['penalty', 'coef'],
                      render: (v: number) => <span style={{ color: '#cf1322' }}>{v.toFixed(2)}</span>,
                    },
                    {
                      title: 'Reward',
                      dataIndex: ['reward', 'coef'],
                      render: (v: number) => <span style={{ color: '#3f8600' }}>+{v.toFixed(2)}</span>,
                    },
                    {
                      title: '分類',
                      dataIndex: 'classification',
                      render: (cls: string, r) => <Tag color={getKanoColor(cls)}>{r.class_label.split(' ')[0]}</Tag>,
                    },
                  ]}
                />
              </Card>
            </Col>
          )}
        </Row>
      </>
    )}
    </div>
  )
}
