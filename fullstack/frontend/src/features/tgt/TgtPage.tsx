import { selectOrdinaryVariables } from '../../app/store'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { useLocation } from 'react-router-dom'
import { Alert, Space, Spin, Typography } from 'antd'
import type { RootState } from '../../app/store'
import { selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { GeodesicEngine } from './geodesicEngine'
import { TgtCanvas } from './TgtCanvas'
import { ProjectionCircle } from './ProjectionCircle'
import { TgtControlPanel } from './TgtControlPanel'
import GraphPanel from '../common/GraphPanel'
import EmptyStatePanel from '../common/EmptyStatePanel'
import { useCodebook } from '../dataset/useCodebookColumn'
import { touringAnalysisValues } from './touringProjection'

export default function TgtPage() {
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector(selectOrdinaryVariables)
  const activeVarIds = globalVars?.activeVariableIds
  const data = useColumnarData(selection.datasetId)
  const { columns, getColumn } = useCodebook()

  const candidates = useMemo(() => {
    if (!data) return []
    const present = new Set(data.schema.map(column => column.name))
    return columns.filter(column => present.has(column.name) && activeVarIds.includes(column.name)
      && !column.multiResponseGroup && ['question', 'attribute'].includes(column.role)
      && ['interval', 'ratio', 'ordinal'].includes(column.scaleType))
  }, [data, columns, activeVarIds])
  const numericColumns = useMemo(() => candidates.map(column => column.name), [candidates])

  const [chosen, setChosen] = useState<{ datasetId: string | null; names: string[] } | null>(null)
  const current = chosen?.datasetId === selection.datasetId ? chosen : null
  const selectedColumns = useMemo(() => (current?.names
    ?? candidates.filter(column => column.scaleType !== 'ordinal').map(column => column.name).slice(0, 6))
    .filter((name) => numericColumns.includes(name)), [current, candidates, numericColumns])
  const setSelectedColumns = (names: string[]) => setChosen({ datasetId: selection.datasetId, names })
  const [isPlaying, setIsPlaying] = useState(true)
  const [isTracking, setIsTracking] = useState(true)
  const [trailLength, setTrailLength] = useState(12)
  const [speed, setSpeed] = useState(1.0)
  const [basis, setBasis] = useState<{ alpha: number[]; beta: number[] }>({ alpha: [], beta: [] })

  // Reset the manual override when the dataset changes so a stale column
  // list from another dataset never leaks in.
  useEffect(() => {
    setChosen(null)
  }, [selection.datasetId])

  // Active row IDs based on global observation scope
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  // Complete-case policy across every selected dimension. Keep the row IDs
  // and matrix in one projection so selection, colors and groups stay aligned.
  const projection = useMemo(() => {
    const rowIds: string[] = []
    const matrix: number[][] = []
    if (!data || selectedColumns.length < 2) return { rowIds, matrix, excluded: 0, errors: [] as string[] }
    const analysisColumns = selectedColumns.map(name => touringAnalysisValues(getColumn(name)!, data.columns[name] ?? []))
    const errors = analysisColumns.map(column => column.error).filter((error): error is string => error !== null)
    if (errors.length) return { rowIds, matrix, excluded: effectiveRowIds.length, errors }
    for (const rowId of effectiveRowIds) {
      const index = data.rowIndex.get(rowId)
      if (index === undefined) continue
      const values = analysisColumns.map(column => column.values[index] ?? NaN)
      if (!values.every(Number.isFinite)) continue
      rowIds.push(rowId)
      matrix.push(values)
    }
    // Standardize only the complete cases (sample standard deviation, ddof=1).
    for (let j = 0; j < selectedColumns.length && matrix.length; j += 1) {
      // Scale first so finite large magnitudes cannot overflow the mean/variance.
      const magnitude = matrix.reduce((max, row) => Math.max(max, Math.abs(row[j])), 0) || 1
      const scaled = matrix.map(row => row[j] / magnitude)
      const mean = scaled.reduce((sum, value) => sum + value / scaled.length, 0)
      const sumSq = scaled.reduce((sum, value) => sum + (value - mean) ** 2, 0)
      const std = Math.sqrt(sumSq / Math.max(matrix.length - 1, 1)) || 1
      for (let i = 0; i < matrix.length; i += 1) matrix[i][j] = (scaled[i] - mean) / std
    }
    return { rowIds, matrix, excluded: effectiveRowIds.length - rowIds.length, errors }
  }, [data, selectedColumns, effectiveRowIds, getColumn])
  const { rowIds, matrix: dataMatrix } = projection

  // Engine instance
  const engine = useMemo(() => {
    if (selectedColumns.length < 2) return null
    const eng = new GeodesicEngine(selectedColumns.length)
    eng.setSpeed(speed)
    eng.maxTrailLength = trailLength
    setBasis({ alpha: [...eng.alpha], beta: [...eng.beta] })
    return eng
  }, [selectedColumns.length]) // Only recreate if dimension changes

  // Update speed & trail length on engine
  useEffect(() => {
    if (engine) {
      engine.setSpeed(speed)
      engine.maxTrailLength = trailLength
    }
  }, [engine, speed, trailLength])

  const handleStep = useCallback(() => {
    if (engine) {
      engine.step()
      setBasis({ alpha: [...engine.alpha], beta: [...engine.beta] })
    }
  }, [engine])

  const handleReset = useCallback(() => {
    if (engine) {
      engine.reset()
      setBasis({ alpha: [...engine.alpha], beta: [...engine.beta] })
    }
  }, [engine])

  const handleTogglePlay = useCallback(() => {
    setIsPlaying((p) => !p)
  }, [])

  const location = useLocation()
  const isTouringActive = location.pathname === '/touring'

  const handleBasisUpdate = useCallback((newAlpha: number[], newBeta: number[]) => {
    setBasis({ alpha: newAlpha, beta: newBeta })
  }, [])

  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (numericColumns.length < 3) {
    return (
      <EmptyStatePanel
        message="Grand Tour には3つ以上の分析可能な変数（間隔・比率・明示選択する順序尺度）が必要です。上部の変数セレクタから追加してください。"
        minVariables={3}
      />
    )
  }

  return (
    <div
      data-testid="tgt-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4, minHeight: 0 }}
    >
      {/* Control Toolbar */}
        <TgtControlPanel
          columns={numericColumns}
          selectedColumns={selectedColumns}
          onColumnsChange={setSelectedColumns}
          isPlaying={isPlaying}
          onTogglePlay={handleTogglePlay}
          onStep={handleStep}
          onReset={handleReset}
          speed={speed}
          onSpeedChange={setSpeed}
          isTracking={isTracking}
          onToggleTracking={setIsTracking}
          trailLength={trailLength}
          onTrailLengthChange={setTrailLength}
        />

      <Alert type="info" showIcon message="順序尺度は対象変数で明示的に選択してください。コードブックの順序順位と逆転を投影に使います。ID・名義尺度・重み・MA子は対象外です。" />
      {projection.errors.map(error => <Alert key={error} type="error" showIcon message={error} />)}
      <Alert type={projection.excluded ? 'warning' : 'info'} showIcon
        data-testid="touring-missing-policy" message="欠損値の扱い: 選択した全変数が有効な行のみ投影（完全ケース）"
        description={`共通対象 ${effectiveRowIds.length}行 / 投影 ${rowIds.length}行 / 欠損・無効値による除外 ${projection.excluded}行。コードブックの欠損コード・有効範囲を適用し、残った行で標準化します。0での補完は行いません。`} />
      {selectedColumns.length >= 2 && !dataMatrix.length && <Alert type="warning"
        message="投影できる有効行がありません。対象行・変数・欠損コードを確認してください。" />}

      {/* Action Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', maxWidth: 860 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            💡 図にフォーカス中: <strong>Space</strong> (再生/一時停止) · <strong>.</strong> (1コマ送り) · <strong>R</strong> (視点リセット) · 一時停止中は矢印＋Enterで点選択、ドラッグで矩形選択
          </Typography.Text>
          <Space>
          </Space>
        </div>

      {/* Main Canvas & HUD Container: 主図と軸寄与円は一つの対象 */}
      <GraphPanel
        graphId="touring/main"
        title="Tracking Grand Tour"
        available={Boolean(engine && dataMatrix.length > 0)}
        sizing="intrinsic"
        intrinsicSize={{ width: 860, height: 540 }}
      >
        <div
          style={{
            position: 'relative',
            display: 'block',
            background: '#141414',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
            overflow: 'hidden',
            width: 860,
            height: 540,
            userSelect: 'none',
          }}
        >
          {engine && dataMatrix.length > 0 && (
            <TgtCanvas
              engine={engine}
              rowIds={rowIds}
              dataMatrix={dataMatrix}
              isPlaying={isPlaying && isTouringActive}
              isTracking={isTracking}
              onBasisUpdate={handleBasisUpdate}
              isActive={isTouringActive}
              onTogglePlay={handleTogglePlay}
              onStep={handleStep}
              onReset={handleReset}
            />
          )}

          {/* Floating Projection Circle HUD */}
          <div style={{ position: 'absolute', top: 12, right: 12 }}>
            <ProjectionCircle
              columns={selectedColumns}
              alpha={basis.alpha}
              beta={basis.beta}
            />
          </div>
        </div>
      </GraphPanel>
    </div>
  )
}
