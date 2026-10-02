import Statistic from '../common/RoundedStatistic'
import { asymmetryVerdict } from './asymmetryDisplay'
import { useScopedRun, AnalysisScopeSummary } from '../selection/analysisScope'
import { CHART_MARKERS } from '../charts/markerStyle'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { useState, useEffect, useMemo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Typography, Space, Button, Tag,
  Alert, Spin, Empty, Divider,
} from 'antd'
import {
  AimOutlined, ArrowRightOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, pcpStateChanged, selectOrdinaryVariables } from '../../app/store'
import { api } from '../../api/client'
import GraphPanel from '../common/GraphPanel'
import EChart from '../charts/EChart'
import { kanoOption, praImpactOption } from './praCharts'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'

export interface PraAttribute {
  name: string
  label: string
  penalty: { coef: number; se: number; p: number; ci: [number, number] }
  reward: { coef: number; se: number; p: number; ci: [number, number] }
  asymmetry: number
  asym_p: number
  asymmetry_significant: boolean
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
  model: { r_squared: number; n_valid: number; alpha: number; asymmetry_alpha: number; warnings: string[] }
  attributes: PraAttribute[]
  all_basic_dissatisfied_row_ids: string[]
}

export default function PenaltyRewardPage() {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const selectedRowIds = useSelector((s: RootState) => s.selection.selectedRowIds)

  const globalVars = useSelector(selectOrdinaryVariables)
  const [allColumns, setAllColumns] = useState<string[]>([])
  const columns = useMemo(
    () => allColumns.filter((name) => globalVars.activeVariableIds.includes(name)),
    [allColumns, globalVars.activeVariableIds],
  )
  const [outcome, setOutcome] = useState<string>('')
  const [attributes, setAttributes] = useState<string[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [result, setResult] = useState<PraResponse | null>(null)
  const runScope = useScopedRun(JSON.stringify([outcome, attributes]))
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const [runError, setRunError] = useState<string | null>(null)
  useEffect(() => { setResult(null); setLoading(false); setRunError(null) }, [runScope.identity])
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
        setAllColumns(numCols)
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
    const ticket = runScope.begin()
    setRunError(null)
    setLoading(true)
    try {
      const res = await api.post<PraResponse>('/pra/evaluate', {
        datasetId,
        rowIds: ticket.scope.rowIds,
        expectedDataRevision: dataRevision,
        expectedSchemaRevision: schemaRevision,
        outcome: o,
        attributes: a,
      })
      if (!ticket.isCurrent()) return
      ticket.commit()
      setResult(res)
      if (res.attributes.length > 0) {
        setSelectedAttribute(res.attributes[0].name)
      }
    } catch (err) {
      if (ticket.isCurrent()) setRunError((err as {message?: string}).message || '分析に失敗しました。')
    } finally {
      if (ticket.isCurrent()) setLoading(false)
    }
  }

  useEffect(() => {
    setAttributes((prev) => {
      const next = prev.filter((name) => columns.includes(name))
      return next.length === prev.length ? prev : next
    })
    if (outcome && !columns.includes(outcome)) setOutcome('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns])


  const currentAttr = useMemo(() => {
    if (!result || !selectedAttribute) return null
    return result.attributes.find((a) => a.name === selectedAttribute) ?? result.attributes[0] ?? null
  }, [result, selectedAttribute])

  const handleSelectDissatisfied = (attr?: PraAttribute) => {
    const ids = attr ? attr.dissatisfied_row_ids : result?.all_basic_dissatisfied_row_ids || []
    if (ids.length > 0) {
      dispatch(selectionApplied({
        rowIds: ids,
        operation: getBrushOp(),
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
        padding: 16,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        minHeight: 0,
      }}
      data-testid="penalty-reward-page"
    >
      <AnalysisScopeSummary snapshot={runScope.snapshot} />
      {runScope.dirty && <Alert type="info" message="現在の入力と異なる実行済み結果です。再実行すると更新されます。" />}
      {runError && <Alert type="error" message={runError} />}
      {/* Header controls */}
      {(
        <Card size="small" style={{ marginBottom: 12 }}>
          {/* Wrap by the card's usable width, including an open sidebar, rather
              than the window-width breakpoints used by the result grid. */}
          <div data-testid="pra-controls" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px 16px' }}>
            <div style={{ flex: '2 1 220px', minWidth: 0, maxWidth: '100%' }}>
              <Typography.Text strong>総合評価 / アウトカム (Outcome):</Typography.Text>
              <Select
                data-testid="pra-outcome-select"
                style={{ width: '100%', marginTop: 4 }}
                value={outcome || undefined}
                onChange={(val) => {
                  setOutcome(val)
                  const newA = columns.filter((c) => c !== val)
                  setAttributes(newA)
                }}
                options={columns.map((c) => ({ label: c, value: c }))}
              />
            </div>
            <div style={{ flex: '3 1 260px', minWidth: 0, maxWidth: '100%' }}>
              <Typography.Text strong>評価属性バッテリー (Attributes):</Typography.Text>
              <Select
                mode="multiple"
                data-testid="pra-attributes-select"
                style={{ width: '100%', marginTop: 4 }}
                value={attributes}
                onChange={(vals) => {
                  setAttributes(vals)
                }}
                options={columns.filter((c) => c !== outcome).map((c) => ({ label: c, value: c }))}
              />
            </div>
            <div style={{ flex: '1 1 180px', minWidth: 0, maxWidth: '100%', textAlign: 'right' }}>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={loading}
                onClick={() => void runEvaluation()}
                data-testid="pra-run-btn"
                style={{ width: '100%', height: 'auto', minHeight: 32, whiteSpace: 'normal', overflowWrap: 'anywhere' }}
              >
                三因子分析を実行
              </Button>
            </div>
          </div>
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
          {(
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
            gutter={[16, 16]}
            style={{
                            minHeight: 0,
            }}
          >
            {/* Signed low/high coefficient comparison */}
            {(
              <Col
                xs={24}
                lg={13}
                style={{
                                    display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                }}
              >
                {(
                  <GraphPanel
                    graphId="penalty-reward/kano"
                    title="低評価側係数×高評価側係数"
                    available={Boolean(result?.attributes?.length)}
                    sizing="intrinsic"
                    intrinsicSize={{ width: 560, height: 440 }}
                    controls={<>                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
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

                      <SelectionMenu />
                      <Typography.Text type="secondary">点の色は既存モデルによる分類です。位置は両係数の符号と大きさをそのまま表します。</Typography.Text>
</>}
                  >
                    <Card
                      size="small"
                      styles={{ body: { padding: 0 } }}
                      bordered={false}
                      data-testid="kano-quadrant-board"
                      style={{
                                                display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                    >
                      <EChart fitPointMarkers pointHitRadius={CHART_MARKERS.hitRadius} testId="kano-chart" height={440} ariaLabel="低評価側係数と高評価側係数の符号付き比較"
                        option={kanoOption(result.attributes, selectedAttribute, selectedRowIds)}
                        onEvents={{ click: event => {
                          const attribute = result.attributes.find(a => a.name === event.data?.name)
                          if (attribute) { setSelectedAttribute(attribute.name); handleSelectDissatisfied(attribute) }
                        } }} />
                    </Card>
                  </GraphPanel>
                )}

                {/* Diverging Impact Bars */}
                {(
                  <GraphPanel
                    graphId="penalty-reward/diverging"
                    title="低評価側・高評価側の符号付き係数"
                    available={Boolean(result?.attributes?.length)}
                    sizing="intrinsic"
                    intrinsicSize={{ width: 560, height: Math.max(260, result.attributes.length * 58 + 90) }}
                    controls={<SelectionMenu />}
                  >
                    <Card
                      size="small"
                      styles={{ body: { padding: 0 } }}
                      bordered={false}
                      data-testid="diverging-impact-bars"
                      style={{
                                                display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                    >
                      <EChart testId="pra-impact-chart" height={Math.max(260, result.attributes.length * 58 + 90)}
                        ariaLabel="Penalty と Reward の符号付き回帰係数"
                        option={praImpactOption(result.attributes, selectedAttribute, selectedRowIds)}
                        onEvents={{ click: event => {
                          const attribute = result.attributes.find(a => a.name === event.data?.name)
                          if (attribute) { setSelectedAttribute(attribute.name); handleSelectDissatisfied(attribute) }
                        } }} />
                    </Card>
                  </GraphPanel>
                )}
              </Col>
            )}

            {/* Right: Asymmetry Test Table & Action Strategy Board */}
            {(
              <Col xs={24} lg={11}>
                {currentAttr ? (
                  <Card
                    size="small"
                    title={
                      <Space wrap>
                        <Typography.Text strong style={{ fontSize: 15 }}>
                          <ColumnQuestionTooltip nameOrId={currentAttr.name}>{currentAttr.label}</ColumnQuestionTooltip>
                        </Typography.Text>
                        <Tag color={getKanoColor(currentAttr.classification)}>
                          {currentAttr.class_label}
                        </Tag>
                      </Space>
                    }
                    data-testid="attribute-detail-card"
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginBottom: 12, minWidth: 0 }}>
                      <Button
                        type="primary"
                        icon={<AimOutlined />}
                        onClick={() => handleSelectDissatisfied(currentAttr)}
                        data-testid="select-dissatisfied-pcp"
                        style={{ maxWidth: '100%', height: 'auto', minHeight: 32, whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                        disabled={currentAttr.dissatisfied_row_ids.length === 0}
                      >
                        不満回答者を選択 ({currentAttr.dissatisfied_row_ids.length}行)
                      </Button>
                      <Button
                        icon={<ArrowRightOutlined />}
                        onClick={() => handleFocusPcp(currentAttr)}
                      >
                        選択してPCPへ移動
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

                  <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                    係数検定の有意水準: α = {result.model.alpha}（{result.model.alpha * 100}%）。
                    非対称性の探索的分類閾値: α = {result.model.asymmetry_alpha}（{result.model.asymmetry_alpha * 100}%）。
                    分類は探索的な目安で、因果効果や対称性・線形関係を証明するものではありません。
                  </Typography.Paragraph>
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
                        val: asymmetryVerdict(currentAttr.asym_p, result.model.asymmetry_alpha),
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
                      render: (v: number) => <span style={{ color: '#3f8600' }}>{v.toFixed(2)}</span>,
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
