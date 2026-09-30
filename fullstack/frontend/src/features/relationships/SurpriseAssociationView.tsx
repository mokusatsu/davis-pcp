import MatrixHeatmap from '../charts/MatrixHeatmap'
import EChartSurface from '../charts/EChartSurface'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip, { ColumnQuestionText } from '../common/ColumnQuestionTooltip'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Typography, Space, Button, Slider, Tag,
  Segmented, Statistic, Empty, Spin, Alert, Tooltip,
} from 'antd'
import Select from '../common/ColumnSelect'
import {
  FireOutlined, AimOutlined, AppstoreOutlined,
  DotChartOutlined, ArrowRightOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, selectEffectiveRowIds, selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import MaAxisPicker from '../pcp/MaAxisPicker'
import { getBrushOp } from '../selection/SelectionMenu'
import { api } from '../../api/client'
import GraphPanel from '../common/GraphPanel'
import { truncateText } from '../../utils/textUtils'

function CorrectedVTip() {
  return (
    <Tooltip
      title="補正V（Cramér's V系）：補正Cramér's V系。公式PhiKとは呼ばない（適用範囲：カテゴリ関連）"
      aria-label="補正Vの説明"
    >
      <span tabIndex={0} role="img" aria-label="補正Vの説明" style={{ cursor: 'help', marginLeft: 4 }}>ⓘ</span>
    </Tooltip>
  )
}

export interface PairItem {
  id: string
  x: { name: string; label: string; type: string }
  y: { name: string; label: string; type: string }
  primary: { measure: string; displayName?: string; formula?: string; scope?: string; value: number; sign: number; signed_value: number }
  secondary: {
    pearson_r: number | null
    spearman_rho: number | null
    kendall_tau: number | null
    correlation_ratio: number | null
  }
  strength: number
  unexpectedness_lift: number
  max_lift: number
  surprise: {
    strength: number
    unexpectedness_empirical: number
    unexpectedness_lift: number
    unexpectedness: number
    surprise_score: number
  }
  top_lift: {
    cell: string
    lift: number
    p_obs: number
    p_expected: number
    row_ids: string[]
  }
  n_valid: number
}

export interface SurpriseResult {
  run_id: string
  pairs: PairItem[]
  pair_matrix: {
    columns: string[]
    matrix: number[][]
  }
}

export default function SurpriseAssociationView() {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const rowIds = useSelector(selectEffectiveRowIds)
  const global = useSelector(selectOrdinaryVariables)
  const entities = useSelector(selectVariableEntities)
  const { columns, schemaRevision } = useCodebook()
  const [chosen, setChosen] = useState<{ datasetId: string; names: string[]; children: string[] } | null>(null)
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key)
    && ['question', 'attribute'].includes(item.role)).map(item => ({ groupId: item.name, label: item.label }))
  const current = chosen?.datasetId === datasetId ? chosen : null
  const candidates = columns.filter(column => ['question', 'attribute'].includes(column.role)
    && (column.multiResponseGroup ? current?.children.includes(column.name) && groups.some(group => group.groupId === column.multiResponseGroup)
      : global.activeVariableIds.includes(column.name)))
  const names = (current?.names ?? []).filter(name => candidates.some(column => column.name === name))
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const [mode, setMode] = useState<'quadrant' | 'heatmap' | 'list'>('quadrant')
  const [wStrength, setWStrength] = useState<number>(50)
  const [loading, setLoading] = useState<boolean>(false)
  const [result, setResult] = useState<SurpriseResult | null>(null)
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null)
  const namesKey = JSON.stringify(names)
  const context = useMemo(() => JSON.stringify([datasetId, dataRevision, schemaRevision, rowIds, namesKey, wStrength]),
    [datasetId, dataRevision, schemaRevision, rowIds, namesKey, wStrength])
  const contextRef = useRef(context)
  contextRef.current = context

  const fetchSurprise = async (wStr: number) => {
    if (!datasetId || names.length < 2) return
    const version = ++requestVersion.current, startedContext = contextRef.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.post<SurpriseResult>('/relationships/surprise', {
        datasetId,
        columns: names, rowIds, expectedSchemaRevision: schemaRevision, expectedDataRevision: dataRevision,
        wStrength: wStr / 100.0,
        wUnexpected: (100 - wStr) / 100.0,
      })
      if (version !== requestVersion.current || startedContext !== contextRef.current) return
      setResult(res)
      if (res.pairs.length > 0) {
        setSelectedPairId(res.pairs[0].id)
      }
    } catch (err: any) {
      if (version === requestVersion.current && startedContext === contextRef.current) setError(err.message || '計算に失敗しました。')
    } finally {
      if (version === requestVersion.current && startedContext === contextRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    requestVersion.current += 1
    setResult(null); setSelectedPairId(null); setLoading(false); setError(null)
  }, [context])

  const currentPair = useMemo(() => {
    if (!result || !selectedPairId) return null
    return result.pairs.find((p) => p.id === selectedPairId) ?? result.pairs[0] ?? null
  }, [result, selectedPairId])
  const heatmapColumnCount = result?.pair_matrix.columns.length ?? 0
  const heatmapLabelWidth = 150
  const heatmapCellWidth = 54
  const heatmapCellHeight = 40
  const heatmapHeaderHeight = 160
  const heatmapWidth = Math.max(400, heatmapLabelWidth + heatmapColumnCount * heatmapCellWidth)
  const heatmapHeight = Math.max(300, heatmapHeaderHeight + heatmapColumnCount * heatmapCellHeight)
  const quadrant = { left: 40, right: 460, top: 28, bottom: 320 }

  const handleSelectLiftRowsInPcp = (pair: PairItem) => {
    if (pair.top_lift?.row_ids?.length) {
      dispatch(selectionApplied({
        rowIds: pair.top_lift.row_ids,
        operation: getBrushOp(),
        label: `Lift cell: ${pair.x.name} x ${pair.y.name} (${pair.top_lift.cell})`,
      }))
    }
  }

  const handleFocusPcp = (pair: PairItem) => {
    if (pair.top_lift?.row_ids?.length) {
      handleSelectLiftRowsInPcp(pair)
    }
    navigate('/pcp')
  }

  return (
    <div
      style={{ padding: 16, display: 'flex', flexDirection: 'column', minWidth: 0 }}
      data-testid="surprise-association-view"
    >
      {/* Controls */}
        <Card size="small" style={{ marginBottom: 12, flexShrink: 0 }}>
          <Space wrap style={{ marginBottom: 12 }}>
            <Select mode="multiple" aria-label="Surpriseの対象変数" placeholder="対象変数を選択" value={names} allowClear maxTagCount={3}
              style={{ minWidth: 300 }} optionFilterProp="label"
              options={candidates.map(column => ({ value: column.name, label: `${column.name}: ${column.multiResponseOptionLabel || column.label || column.name}` }))}
              onChange={next => setChosen({ datasetId: datasetId!, names: next, children: current?.children ?? [] })} />
            <MaAxisPicker allowCount={false} groups={groups} columns={columns} onAdd={axes => {
              const added = axes.map(axis => columns.find(column => column.columnId === axis.columnId)?.name).filter((name): name is string => Boolean(name))
              setChosen({ datasetId: datasetId!, names: [...new Set([...names, ...added])], children: [...new Set([...(current?.children ?? []), ...added])] })
            }} />
          </Space>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px 20px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <Typography.Text strong style={{ whiteSpace: 'nowrap' }}>
                表示モード:
              </Typography.Text>
              <Segmented
                data-testid="surprise-view-mode"
                value={mode}
                onChange={(val) => setMode(val as any)}
                options={[
                  { label: '象限散布図 (Quadrant)', value: 'quadrant', icon: <DotChartOutlined /> },
                  { label: '階層化ヒートマップ (Heatmap)', value: 'heatmap', icon: <AppstoreOutlined /> },
                  { label: 'ランキング一覧 (List)', value: 'list' },
                ]}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <Typography.Text strong style={{ whiteSpace: 'nowrap' }}>
                重視配分: 強度 {wStrength}% : 意外性 {100 - wStrength}%
              </Typography.Text>
              <Slider
                style={{ width: 140, margin: '0 8px' }}
                value={wStrength}
                min={0}
                max={100}
                step={5}
                onChange={setWStrength}
              />
            </div>

            <div style={{ flexShrink: 0, marginLeft: 'auto' }}>
              <Button
                type="primary"
                icon={<FireOutlined />}
                loading={loading}
                disabled={!datasetId || names.length < 2}
                onClick={() => void fetchSurprise(wStrength)}
                data-testid="refresh-surprise-btn"
              >
                実行
              </Button>
            </div>
          </div>
        </Card>

      {error && <Alert type="error" showIcon message={error} />}
      {!result && !loading && <Alert type="info" message="対象変数を2つ以上指定して実行してください。同じMA設問内の選択肢同士は候補から除外します。" />}

      {loading && !result && (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip="補正V および意外性スコアを全ペア計算中..." />
        </div>
      )}

      {result && (
        <Row gutter={[16, 16]} style={{ minHeight: 0 }}>
          {/* Main Visual: Quadrant or Heatmap or List */}
          <Col span={24} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {mode === 'quadrant' && (
              <GraphPanel
                graphId="associations/quadrant"
                title="強度 (Strength) × 意外性 (Unexpectedness) 象限散布図"
                available={mode === 'quadrant' && Boolean(result)}
                sizing="intrinsic"
                intrinsicSize={{ width: 500, height: 400 }}
              >
                <div
                  data-testid="surprise-quadrant-plot"
                  style={{
                    position: 'relative',
                    width: 500,
                    height: 400,
                    outline: '1px solid #e5e7eb',
                    outlineOffset: -1,
                    borderRadius: 6,
                    background: '#fdfdfd',
                    userSelect: 'none',
                  }}
                >
                    {/* Quadrant labels */}
                    <div style={{ position: 'absolute', top: 8, right: 12, maxWidth: '45%', textAlign: 'right', fontSize: 11, fontWeight: 'bold', color: '#722ed1', zIndex: 1 }}>
                      💎 隠れた強相関 (高強度・高意外性)
                    </div>
                    <div style={{ position: 'absolute', top: 8, left: 12, maxWidth: '45%', fontSize: 11, fontWeight: 'bold', color: '#1677ff', zIndex: 1 }}>
                      📖 既知・当然の相関 (高強度・低意外性)
                    </div>
                    <div style={{ position: 'absolute', bottom: 34, right: 12, maxWidth: '45%', textAlign: 'right', fontSize: 11, fontWeight: 'bold', color: '#fa8c16', zIndex: 1 }}>
                      ⚡ 特異ニッチ関係 (低強度・高意外性)
                    </div>
                    <div style={{ position: 'absolute', bottom: 34, left: 12, maxWidth: '45%', fontSize: 11, fontWeight: 'bold', color: '#8c8c8c', zIndex: 1 }}>
                      💤 ノイズ・弱相関 (低強度・低意外性)
                    </div>

                    {/* SVG Plot of pairs with unified coordinate system */}
                    <EChartSurface width={500} height={400} viewBox="0 0 500 400" style={{ width: 500, height: 400, display: 'block' }}>
                      {/* Crosshairs */}
                      <line x1={(quadrant.left + quadrant.right) / 2} y1={quadrant.top} x2={(quadrant.left + quadrant.right) / 2} y2={quadrant.bottom} stroke="#d9d9d9" strokeDasharray="4 4" strokeWidth={1} />
                      <line x1={quadrant.left} y1={(quadrant.top + quadrant.bottom) / 2} x2={quadrant.right} y2={(quadrant.top + quadrant.bottom) / 2} stroke="#d9d9d9" strokeDasharray="4 4" strokeWidth={1} />

                      {/* Axis labels */}
                      <text x={(quadrant.left + quadrant.right) / 2} y={392} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151">
                        意外性スコア (Unexpectedness) →
                      </text>
                      <text x={14} y={(quadrant.top + quadrant.bottom) / 2} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151" transform={`rotate(-90 14 ${(quadrant.top + quadrant.bottom) / 2})`}>
                        関連強度 (|補正V|) →
                      </text>

                      {result.pairs.map((p) => {
                        const cx = quadrant.left + Math.min(Math.max(p.surprise.unexpectedness, 0), 1) * (quadrant.right - quadrant.left)
                        const cy = quadrant.bottom - Math.min(Math.max(p.strength, 0), 1) * (quadrant.bottom - quadrant.top)
                        const isSelected = p.id === selectedPairId
                        const r = isSelected ? 8 : 6
                        const fill = isSelected ? '#2a78d6' : (p.surprise.unexpectedness > 0.5 && p.strength > 0.5 ? '#722ed1' : '#1677ff')
                        const fullLabel = `${p.x.name} × ${p.y.name}`
                        const label = `${truncateText(p.x.name, 12)} × ${truncateText(p.y.name, 12)}`
                        const labelWidth = Array.from(label).length * 6
                        const labelOnRight = cx + 10 + labelWidth <= quadrant.right - 4

                        return (
                          <g key={p.id} onClick={() => setSelectedPairId(p.id)} style={{ cursor: 'pointer' }}>
                            <circle
                              cx={cx}
                              cy={cy}
                              r={r}
                              fill={fill}
                              opacity={isSelected ? 1.0 : 0.75}
                              stroke={isSelected ? '#000' : '#fff'}
                              strokeWidth={isSelected ? 2 : 1}
                            />
                            {isSelected && (
                              <text
                                x={labelOnRight ? cx + 10 : cx - 10}
                                y={cy + 4}
                                textAnchor={labelOnRight ? 'start' : 'end'}
                                fontSize={11}
                                fontWeight="bold"
                                fill="#1f1f1f"
                                paintOrder="stroke"
                                stroke="#ffffff"
                                strokeWidth={3}
                              >
                                <title>{fullLabel}</title>
                                {label}
                              </text>
                            )}
                          </g>
                        )
                      })}
                    </EChartSurface>
                </div>
              </GraphPanel>
            )}

            {mode === 'heatmap' && (
              <GraphPanel
                graphId="associations/heatmap"
                title="クラスタリング済み 補正V 相関ヒートマップ"
                available={mode === 'heatmap' && Boolean(result)}
                sizing="intrinsic"
                intrinsicSize={{ width: heatmapWidth, height: heatmapHeight }}
                controls={<Typography.Text type="secondary" style={{ fontSize: 12 }}>補正V<CorrectedVTip /></Typography.Text>}
              >
                <div data-testid="surprise-heatmap" style={{ width: heatmapWidth, height: heatmapHeight, overflow: 'hidden' }}>
                  <MatrixHeatmap labels={result.pair_matrix.columns.map(name => {
                      const label = columns.find(column => column.name === name)?.label
                      return label && label !== name ? `${name} — ${label}` : name
                    })} matrix={result.pair_matrix.matrix} bound={1}
                    height={heatmapHeight} title="補正V 相関ヒートマップ" testId="surprise-heatmap-chart"
                    selected={currentPair ? [result.pair_matrix.columns.indexOf(currentPair.x.name), result.pair_matrix.columns.indexOf(currentPair.y.name)] : null}
                    onSelect={(row, col) => {
                      const rowName = result.pair_matrix.columns[row], colName = result.pair_matrix.columns[col]
                      const matched = result.pairs.find(pair => (pair.x.name === rowName && pair.y.name === colName)
                        || (pair.x.name === colName && pair.y.name === rowName))
                      if (matched) setSelectedPairId(matched.id)
                    }} />
                </div>
              </GraphPanel>
            )}

            {mode === 'list' && (
              <Card size="small" title="意外性スコア順ペア一覧">
                <Table
                  size="small"
                  dataSource={result.pairs.map((p) => ({ ...p, key: p.id }))}
                  pagination={{ pageSize: 8 }}
                  rowClassName={(record) => (record.id === selectedPairId ? 'ant-table-row-selected' : '')}
                  onRow={(record) => ({
                    onClick: () => setSelectedPairId(record.id),
                    style: { cursor: 'pointer' },
                  })}
                  columns={[
                    { title: '変数ペア', render: (_, r) => `${r.x.name} × ${r.y.name}` },
                    { title: (<span>補正V (強度)<CorrectedVTip /></span>), dataIndex: 'strength', render: (v: number) => v.toFixed(3) },
                    { title: '非自明性 (意外性)', render: (_, r) => r.surprise.unexpectedness.toFixed(3) },
                    {
                      title: 'Surprise Score',
                      render: (_, r) => <Tag color="purple">{r.surprise.surprise_score.toFixed(3)}</Tag>,
                    },
                    { title: 'Max Lift', dataIndex: 'max_lift', render: (v: number) => `${v.toFixed(1)}x` },
                  ]}
                />
              </Card>
            )}
          </Col>

          {/* Right: Pair & Top Lift Detail Inspector */}
            <Col span={24}>
              {currentPair ? (
                <Card
                  size="small"
                  title={
                    <div style={{ whiteSpace: 'normal', display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
                      <Typography.Text strong style={{ fontSize: 15, wordBreak: 'break-all', lineHeight: 1.3 }}>
                        <ColumnQuestionTooltip nameOrId={currentPair.x.name}>{currentPair.x.name}</ColumnQuestionTooltip> × <ColumnQuestionTooltip nameOrId={currentPair.y.name}>{currentPair.y.name}</ColumnQuestionTooltip>
                      </Typography.Text>
                      <div style={{ fontWeight: 400, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
                        <div><ColumnQuestionText nameOrId={currentPair.x.name} /></div>
                        <div><ColumnQuestionText nameOrId={currentPair.y.name} /></div>
                      </div>
                      <Space wrap size={8}>
                        <Button
                          type="primary"
                          icon={<AimOutlined />}
                          onClick={() => handleSelectLiftRowsInPcp(currentPair)}
                          data-testid="select-lift-pcp"
                          disabled={!currentPair.top_lift?.row_ids?.length}
                        >
                          Select Lift Cell Rows in PCP
                        </Button>
                        <Button
                          icon={<ArrowRightOutlined />}
                          onClick={() => handleFocusPcp(currentPair)}
                        >
                          Focus PCP
                        </Button>
                      </Space>
                    </div>
                  }
                >
                  <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                    <Col span={12}>
                      <Statistic
                        title={<span>統一強度 (補正V)<CorrectedVTip /></span>}
                        value={currentPair.primary.signed_value}
                        precision={3}
                        valueStyle={{ color: currentPair.primary.sign > 0 ? '#cf1322' : '#0958d9' }}
                      />
                    </Col>
                    <Col span={12}>
                      <Statistic
                        title="複合サプライズスコア"
                        value={currentPair.surprise.surprise_score}
                        precision={3}
                        valueStyle={{ color: '#722ed1' }}
                      />
                    </Col>
                  </Row>

                  {/* Top Lift Box */}
                  <Card
                    size="small"
                    style={{ background: '#fafafa', marginBottom: 12 }}
                    data-testid="top-lift-inspector"
                  >
                    <Typography.Text strong style={{ display: 'block', color: '#1677ff', marginBottom: 4 }}>
                      🔥 最も予想外の偏りセル (Top Lift Cell)
                    </Typography.Text>
                    <Typography.Paragraph style={{ margin: 0 }}>
                      <strong>{currentPair.top_lift.cell}</strong>: 独立期待比 <strong>{currentPair.top_lift.lift}倍</strong> の集中
                    </Typography.Paragraph>
                    <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                      出現率: {(currentPair.top_lift.p_obs * 100).toFixed(1)}% (期待値: {(currentPair.top_lift.p_expected * 100).toFixed(1)}%)
                    </div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                      対象回答者: {currentPair.top_lift.row_ids.length} 行
                    </div>
                  </Card>

                  {/* Secondary metrics table */}
                  <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
                    多角相関・関連指標
                  </Typography.Text>
                  <Table
                    size="small"
                    pagination={false}
                    columns={[
                      { title: '指標', dataIndex: 'name' },
                      { title: '値', dataIndex: 'val' },
                    ]}
                    dataSource={[
                      { key: 1, name: 'Pearson 相関係数 r', val: currentPair.secondary.pearson_r ?? '-' },
                      { key: 2, name: 'Spearman 順位相関 ρ', val: currentPair.secondary.spearman_rho ?? '-' },
                      { key: 3, name: 'Kendall 順位相関 τ', val: currentPair.secondary.kendall_tau ?? '-' },
                      { key: 4, name: '相関比 η (Correlation Ratio)', val: currentPair.secondary.correlation_ratio ?? '-' },
                      { key: 5, name: '有効データ行数 (N)', val: currentPair.n_valid },
                    ]}
                  />
                </Card>
              ) : (
                <Card style={{ textAlign: 'center', padding: 40 }}>
                  <Empty description="ペアを選択してください" />
                </Card>
              )}
            </Col>
        </Row>
      )}
    </div>
  )
}
