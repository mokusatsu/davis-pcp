import { Select as AntSelect } from 'antd'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Button, Typography, Space, Tag, Row, Col,
  Statistic, Spin, Empty, InputNumber, Radio, Divider, Alert, Checkbox,
} from 'antd'
import {
  ThunderboltOutlined, CheckCircleOutlined,
  LineChartOutlined, SwapOutlined, FilterOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, pcpStateChanged } from '../../app/store'
import { api } from '../../api/client'
import { useCodebook } from '../dataset/useCodebookColumn'

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

export interface ModernMiningResult {
  run_id: string
  mode: string
  summary: {
    total_candidates_explored: number
    non_redundant_insights_count: number
    questions_evaluated_count?: number
  }
  insights: ModernInsight[]
}

interface ColumnMeta {
  name: string
  type: string
  role?: string
}

export const ModernSubgroupMiningView: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()

  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const selectedRowIds = useSelector((s: RootState) => s.selection.selectedRowIds)
  const { schemaRevision, getColumn, formatValueLabel } = useCodebook()
  const requestVersion = useRef(0)
  const resultContext = useRef('')
  const context = `${datasetId}:${schemaRevision}`
  resultContext.current = context
  const conditionLabel = (c: ModernCondition) => {
    const title = getColumn(c.column)?.label || c.column
    const value = ['==', '!=', 'in'].includes(c.operator)
      ? `「${formatValueLabel(c.column, c.value)}」` : String(c.value)
    return `${title} ${c.operator} ${value}`
  }

  const [columns, setColumns] = useState<ColumnMeta[]>([])
  const [miningMode, setMiningMode] = useState<'auto' | 'standard' | 'emm_kendall'>('auto')
  const [maxDepth, setMaxDepth] = useState<number>(2)
  const [minGroupSize, setMinGroupSize] = useState<number>(30)
  const [topK, setTopK] = useState<number>(12)
  const [filterQuestion, setFilterQuestion] = useState<string>('all')
  const [filterBySelection, setFilterBySelection] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<{ message: string; details?: string; suggestedActions?: string[] } | null>(null)
  const [result, setResult] = useState<ModernMiningResult | null>(null)
  const [selectedInsightId, setSelectedInsightId] = useState<string | null>(null)

  // Fetch columns on mount or datasetId change
  useEffect(() => {
    if (!datasetId) return
    let active = true
    api.get<{ schema: Array<{ name: string; physicalType: string; semanticType: string; role?: string }> }>(`/datasets/${datasetId}`)
      .then((meta) => {
        if (!active) return
        const cols: ColumnMeta[] = meta.schema.map((c) => ({
          name: c.name,
          type: c.semanticType || c.physicalType,
          role: c.role,
        }))
        setColumns(cols)
      })
      .catch((err: any) => {
        console.error('Failed to load dataset columns', err)
      })
    return () => { active = false }
  }, [datasetId, schemaRevision])

  useEffect(() => {
    requestVersion.current += 1
    setResult(null)
    setSelectedInsightId(null)
    setLoading(false)
    setError(null)
  }, [datasetId, schemaRevision])

  // Omnipresent Auto-mining runner
  const runAutoMining = async (overrideMode?: 'auto' | 'standard' | 'emm_kendall', overrideFilterSelection?: boolean) => {
    if (!datasetId) return
    const version = ++requestVersion.current
    const startedContext = resultContext.current
    setLoading(true)
    setError(null)
    try {
      const shouldUseFilter = overrideFilterSelection !== undefined ? overrideFilterSelection : filterBySelection
      const payload: any = {
        datasetId,
        mode: overrideMode || miningMode,
        maxDepth,
        minGroupSize,
        topK,
        selectedRowIds: shouldUseFilter ? selectedRowIds : undefined,
      }

      const res = await api.post<ModernMiningResult>('/mining/modern-subgroup', payload)
      if (version !== requestVersion.current || startedContext !== resultContext.current) return
      setResult(res)
      if (res.insights.length > 0) {
        setSelectedInsightId(res.insights[0].id)
      } else {
        setSelectedInsightId(null)
      }
    } catch (e: any) {
      if (version !== requestVersion.current || startedContext !== resultContext.current) return
      console.error('Failed to run omnipresent auto mining', e)
      const msg = e?.message || e?.detail || 'マイニング処理中にエラーが発生しました。'
      const details = typeof e?.details === 'object' ? JSON.stringify(e.details, null, 2) : (e?.details ? String(e.details) : undefined)
      const actions = Array.isArray(e?.suggestedActions) ? e.suggestedActions : undefined
      setError({ message: msg, details, suggestedActions: actions })
    } finally {
      if (version === requestVersion.current && startedContext === resultContext.current) setLoading(false)
    }
  }

  // Automatically run auto-mining on initial load once columns & dataset are ready!
  useEffect(() => {
    if (datasetId && columns.length > 0) {
      void runAutoMining('auto')
    }
  }, [datasetId, columns.length, schemaRevision])

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
        operation: 'replace',
        label: `Subgroup: ${insight.rule.text}`,
      })
    )

    // Automatically focus relevant question axes in PCP
    if (insight.target_pair && insight.target_pair.length === 2) {
      dispatch(
        pcpStateChanged({
          order: [insight.target_pair[0], insight.target_pair[1]],
          visibleColumns: [insight.target_pair[0], insight.target_pair[1]],
        })
      )
    } else if (insight.target_question && columns.length > 0) {
      // Put attribute condition column and target question adjacent
      const attrCol = insight.rule.conditions[0]?.column
      if (attrCol) {
        dispatch(
          pcpStateChanged({
            order: [attrCol, insight.target_question],
            visibleColumns: [attrCol, insight.target_question],
          })
        )
      }
    }
    navigate('/pcp')
  }

  const selectedInsight = useMemo(() => {
    if (!result || !selectedInsightId) return null
    return result.insights.find((ins) => ins.id === selectedInsightId) || null
  }, [result, selectedInsightId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top Header & Omnipresent Control Bar */}
      <Card size="small" style={{ background: '#fafafa' }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} md={7}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
              全件探索モード:
            </Typography.Text>
            <Radio.Group
              value={miningMode}
              onChange={(e) => {
                const newMode = e.target.value
                setMiningMode(newMode)
                void runAutoMining(newMode)
              }}
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="auto">全自動 (標準 ＋ EMM)</Radio.Button>
              <Radio.Button value="standard">複合条件のみ</Radio.Button>
              <Radio.Button value="emm_kendall">相関特異性のみ</Radio.Button>
            </Radio.Group>
          </Col>

          <Col xs={12} md={3}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>最大深さ:</Typography.Text>
            <AntSelect
              style={{ width: '100%' }}
              size="small"
              value={maxDepth}
              onChange={setMaxDepth}
              options={[
                { label: '1 (単一属性/区間)', value: 1 },
                { label: '2 (2属性の複合条件)', value: 2 },
              ]}
            />
          </Col>

          <Col xs={12} md={3}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>最小人数:</Typography.Text>
            <InputNumber
              style={{ width: '100%' }}
              size="small"
              min={5}
              max={500}
              value={minGroupSize}
              onChange={(v) => setMinGroupSize(v || 30)}
            />
          </Col>

          <Col xs={12} md={3}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>表示上限:</Typography.Text>
            <InputNumber
              style={{ width: '100%' }}
              size="small"
              min={1}
              max={30}
              value={topK}
              onChange={(v) => setTopK(v || 12)}
            />
          </Col>

          <Col xs={12} md={4}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
              <FilterOutlined /> 質問絞り込み:
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              size="small"
              value={filterQuestion}
              onChange={setFilterQuestion}
              options={[
                { label: '全ての質問 (全件表示)', value: 'all' },
                ...availableQuestionsInResults.map((q) => ({ label: q, value: q })),
              ]}
            />
          </Col>

          <Col xs={24} md={4} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            {selectedRowIds && selectedRowIds.length > 0 && (
              <Checkbox
                checked={filterBySelection}
                onChange={(e) => {
                  const checked = e.target.checked
                  setFilterBySelection(checked)
                  void runAutoMining(undefined, checked)
                }}
                style={{ fontSize: 11, marginBottom: 4 }}
              >
                PCP選択行 ({selectedRowIds.length}件) に絞り込む
              </Checkbox>
            )}
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => void runAutoMining()}
              loading={loading}
              style={{ width: '100%' }}
            >
              全件再探索
            </Button>
          </Col>
        </Row>
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

      {/* Summary KPI Cards */}
      {result && (
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="評価した質問数"
                value={result.summary.questions_evaluated_count || columns.length}
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
      {result && !loading && (
        <Row gutter={[16, 16]}>
          {/* Left: Insight Cards List */}
          <Col xs={24} md={14}>
            <Typography.Title level={5} style={{ marginBottom: 8 }}>
              全データから自動抽出された最重要インサイト ({displayedInsights.length} 件)
            </Typography.Title>

            {displayedInsights.length === 0 ? (
              <Empty description="条件に合致するインサイトはありませんでした。" />
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

                <Divider style={{ margin: '12px 0' }} />

                <Space direction="vertical" style={{ width: '100%' }}>
                  <Button
                    type="primary"
                    block
                    icon={<SwapOutlined />}
                    onClick={() => handleApplyToPcp(selectedInsight)}
                  >
                    このセグメントと対象質問をPCPで可視化
                  </Button>
                  <Button
                    block
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
                      navigate('/robustness', { state: { conclusion } })
                    }}
                    data-testid="modern-send-to-robustness-btn"
                  >
                    この結論の頑健性を検証 (Send to Robustness)
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    ※クリックすると、PCP上で該当データ行がシアン色で太線ハイライトされ、該当質問軸が自動でフォーカス配置されます。
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
    </div>
  )
}
export default ModernSubgroupMiningView
