import { useState, useEffect, useMemo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Typography, Space, Button, Slider, Table, Tag,
  Segmented, Statistic, Empty, Spin,
} from 'antd'
import {
  FireOutlined, AimOutlined, AppstoreOutlined,
  DotChartOutlined, ArrowRightOutlined,
} from '@ant-design/icons'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, pcpStateChanged } from '../../app/store'
import { api } from '../../api/client'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'

export interface PairItem {
  id: string
  x: { name: string; label: string; type: string }
  y: { name: string; label: string; type: string }
  primary: { measure: string; value: number; sign: number; signed_value: number }
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
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  const [mode, setMode] = useState<'quadrant' | 'heatmap' | 'list'>('quadrant')
  const [wStrength, setWStrength] = useState<number>(50)
  const [loading, setLoading] = useState<boolean>(false)
  const [result, setResult] = useState<SurpriseResult | null>(null)
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null)

  const fetchSurprise = async (wStr: number) => {
    if (!datasetId) return
    setLoading(true)
    try {
      const res = await api.post<SurpriseResult>('/relationships/surprise', {
        datasetId,
        wStrength: wStr / 100.0,
        wUnexpected: (100 - wStr) / 100.0,
      })
      setResult(res)
      if (res.pairs.length > 0) {
        setSelectedPairId(res.pairs[0].id)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (datasetId) {
      void fetchSurprise(wStrength)
    }
  }, [datasetId])

  const currentPair = useMemo(() => {
    if (!result || !selectedPairId) return null
    return result.pairs.find((p) => p.id === selectedPairId) ?? result.pairs[0] ?? null
  }, [result, selectedPairId])

  const handleSelectLiftRowsInPcp = (pair: PairItem) => {
    if (pair.top_lift?.row_ids?.length) {
      dispatch(selectionApplied({
        rowIds: pair.top_lift.row_ids,
        operation: 'replace',
        label: `Lift cell: ${pair.x.name} x ${pair.y.name} (${pair.top_lift.cell})`,
      }))
    }
  }

  const handleFocusPcp = (pair: PairItem) => {
    if (pair.top_lift?.row_ids?.length) {
      handleSelectLiftRowsInPcp(pair)
    }
    dispatch(pcpStateChanged({
      order: [pair.x.name, pair.y.name],
      visibleColumns: [pair.x.name, pair.y.name],
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
      data-testid="surprise-association-view"
    >
      {/* Controls */}
      {!focused && (
        <Card size="small" style={{ marginBottom: 12, flexShrink: 0 }}>
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
                onChangeComplete={(v) => void fetchSurprise(v)}
              />
            </div>

            <div style={{ flexShrink: 0, marginLeft: 'auto' }}>
              <Button
                type="primary"
                icon={<FireOutlined />}
                loading={loading}
                onClick={() => void fetchSurprise(wStrength)}
                data-testid="refresh-surprise-btn"
              >
                再計算
              </Button>
            </div>
          </div>
        </Card>
      )}

      {loading && !result && (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip="Phik および意外性スコアを全ペア計算中..." />
        </div>
      )}

      {result && (
        <Row
          gutter={focused ? [0, 0] : [16, 16]}
          style={{
            flex: focused ? 1 : undefined,
            minHeight: 0,
            height: focused ? '100%' : undefined,
          }}
        >
          {/* Main Visual: Quadrant or Heatmap or List */}
          <Col
            xs={24}
            lg={focused ? 24 : 15}
            style={{
              height: focused ? '100%' : undefined,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            {mode === 'quadrant' && (
              <Card
                size="small"
                title="強度 (Strength) × 意外性 (Unexpectedness) 象限散布図"
                extra={<FocusEnterButton targetId="surprise-quadrant" title="意外性散布図" />}
                data-testid="surprise-quadrant-plot"
                style={{
                  height: focused ? '100%' : undefined,
                  display: 'flex',
                  flexDirection: 'column',
                  flex: focused ? 1 : undefined,
                  minHeight: 0,
                }}
                bodyStyle={{
                  flex: focused ? 1 : undefined,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                }}
              >
                <FocusTarget id="surprise-quadrant" title="意外性散布図">
                  <div
                    style={{
                      position: 'relative',
                      width: '100%',
                      height: focused ? '100%' : 440,
                      flex: focused ? 1 : undefined,
                      minHeight: 0,
                      background: '#fdfdfd',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
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
                    <div style={{ position: 'absolute', bottom: 8, right: 12, maxWidth: '45%', textAlign: 'right', fontSize: 11, fontWeight: 'bold', color: '#fa8c16', zIndex: 1 }}>
                      ⚡ 特異ニッチ関係 (低強度・高意外性)
                    </div>
                    <div style={{ position: 'absolute', bottom: 8, left: 12, maxWidth: '45%', fontSize: 11, fontWeight: 'bold', color: '#8c8c8c', zIndex: 1 }}>
                      💤 ノイズ・弱相関 (低強度・低意外性)
                    </div>

                    {/* SVG Plot of pairs with unified coordinate system */}
                    <svg viewBox="0 0 500 400" style={{ width: '100%', height: '100%', display: 'block' }}>
                      {/* Crosshairs */}
                      <line x1={250} y1={25} x2={250} y2={375} stroke="#d9d9d9" strokeDasharray="4 4" strokeWidth={1} />
                      <line x1={25} y1={200} x2={475} y2={200} stroke="#d9d9d9" strokeDasharray="4 4" strokeWidth={1} />

                      {/* Axis labels */}
                      <text x={250} y={395} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151">
                        意外性スコア (Unexpectedness) →
                      </text>
                      <text x={12} y={200} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151" transform="rotate(-90 12 200)">
                        関連強度 (|φ_k|) →
                      </text>

                      {result.pairs.map((p) => {
                        const cx = 40 + Math.min(Math.max(p.surprise.unexpectedness, 0), 1) * 420
                        const cy = 360 - Math.min(Math.max(p.strength, 0), 1) * 320
                        const isSelected = p.id === selectedPairId
                        const r = isSelected ? 8 : 6
                        const fill = isSelected ? '#2a78d6' : (p.surprise.unexpectedness > 0.5 && p.strength > 0.5 ? '#722ed1' : '#1677ff')

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
                                x={cx > 380 ? cx - 10 : cx + 10}
                                y={cy + 4}
                                textAnchor={cx > 380 ? 'end' : 'start'}
                                fontSize={11}
                                fontWeight="bold"
                                fill="#1f1f1f"
                                paintOrder="stroke"
                                stroke="#ffffff"
                                strokeWidth={3}
                              >
                                {p.x.name} × {p.y.name}
                              </text>
                            )}
                          </g>
                        )
                      })}
                    </svg>
                  </div>
                </FocusTarget>
              </Card>
            )}

            {mode === 'heatmap' && (
              <Card
                size="small"
                title="クラスタリング済み Phik (φ_k) 相関ヒートマップ"
                extra={<FocusEnterButton targetId="surprise-heatmap" title="相関ヒートマップ" />}
                data-testid="surprise-heatmap"
                style={{
                  overflowX: 'auto',
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
                <FocusTarget id="surprise-heatmap" title="相関ヒートマップ">
                  <table style={{ borderCollapse: 'collapse', fontSize: 11, margin: 'auto', userSelect: 'none' }}>
                    <thead>
                      <tr>
                        <th />
                        {result.pair_matrix.columns.map((col) => (
                          <th key={col} style={{ padding: '4px 6px', transform: 'rotate(-30deg)', whiteSpace: 'nowrap' }}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.pair_matrix.columns.map((rowCol, rIdx) => (
                        <tr key={rowCol}>
                          <td style={{ padding: '4px 8px', fontWeight: 500, whiteSpace: 'nowrap' }}>{rowCol}</td>
                          {result.pair_matrix.columns.map((colCol, cIdx) => {
                            const val = result.pair_matrix.matrix[rIdx][cIdx]
                            // Heatmap color from -1 (blue) to 0 (white) to 1 (red)
                            let bg = '#ffffff'
                            if (val > 0) {
                              const intensity = Math.min(1.0, val)
                              bg = `rgba(245, 34, 45, ${intensity * 0.85})`
                            } else if (val < 0) {
                              const intensity = Math.min(1.0, Math.abs(val))
                              bg = `rgba(24, 144, 255, ${intensity * 0.85})`
                            }
                            return (
                              <td
                                key={cIdx}
                                onClick={() => {
                                  const matched = result.pairs.find(
                                    (p) => (p.x.name === rowCol && p.y.name === colCol) || (p.x.name === colCol && p.y.name === rowCol)
                                  )
                                  if (matched) setSelectedPairId(matched.id)
                                }}
                                style={{
                                  width: 34,
                                  height: 34,
                                  textAlign: 'center',
                                  background: bg,
                                  cursor: 'pointer',
                                  border: '1px solid #f0f0f0',
                                  color: Math.abs(val) > 0.5 ? '#fff' : '#333',
                                }}
                                title={`${rowCol} × ${colCol}: φ_k = ${val}`}
                              >
                                {val !== 0 ? val.toFixed(2) : '0'}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </FocusTarget>
              </Card>
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
                    { title: 'Phik (強度)', dataIndex: 'strength', render: (v: number) => v.toFixed(3) },
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
          {!focused && (
            <Col xs={24} lg={9}>
              {currentPair ? (
                <Card
                  size="small"
                  title={
                    <div style={{ whiteSpace: 'normal', display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
                      <Typography.Text strong style={{ fontSize: 15, wordBreak: 'break-all', lineHeight: 1.3 }}>
                        {currentPair.x.name} × {currentPair.y.name}
                      </Typography.Text>
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
                        title="統一強度 (Phik φ_k)"
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
          )}
        </Row>
      )}
    </div>
  )
}
