import { selectOrdinaryVariables } from '../../app/store'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { useLocation } from 'react-router-dom'
import { Space, Spin, Typography } from 'antd'
import type { RootState } from '../../app/store'
import { selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { GeodesicEngine } from './geodesicEngine'
import { TgtCanvas } from './TgtCanvas'
import { ProjectionCircle } from './ProjectionCircle'
import { TgtControlPanel } from './TgtControlPanel'
import GraphPanel from '../common/GraphPanel'
import EmptyStatePanel from '../common/EmptyStatePanel'

export default function TgtPage() {
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector(selectOrdinaryVariables)
  const activeVarIds = globalVars?.activeVariableIds
  const data = useColumnarData(selection.datasetId)

  const numericColumns = useMemo(() => {
    if (!data) return []
    return data.schema
      .filter((c) => c.semanticType === 'numeric' && activeVarIds.includes(c.name))
      .map((c) => c.name)
  }, [data, activeVarIds])

  const [chosen, setChosen] = useState<{ datasetId: string | null; names: string[] } | null>(null)
  const current = chosen?.datasetId === selection.datasetId ? chosen : null
  const selectedColumns = (current?.names ?? numericColumns.slice(0, Math.min(Math.max(numericColumns.length, 0), 6)))
    .filter((name) => numericColumns.includes(name))
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
  const rowIds = useMemo(() => {
    if (!data) return []
    return effectiveRowIds.length > 0 ? effectiveRowIds : data.rowIds
  }, [data, effectiveRowIds])

  // Compute standardized data matrix (N x p)
  const dataMatrix = useMemo(() => {
    if (!data || selectedColumns.length < 2 || rowIds.length === 0) return []

    const p = selectedColumns.length
    const rawCols: number[][] = []

    for (const colName of selectedColumns) {
      const numArr = data.numeric[colName]
      if (!numArr) continue
      const vals: number[] = []
      for (const rId of rowIds) {
        const rowIdx = data.rowIndex.get(rId)
        const v = rowIdx !== undefined ? numArr[rowIdx] : 0
        vals.push(Number.isFinite(v) ? v : 0)
      }


      // Compute mean and sample std
      let sum = 0
      for (const v of vals) sum += v
      const mean = sum / vals.length

      let sumSq = 0
      for (const v of vals) sumSq += (v - mean) * (v - mean)
      const std = Math.sqrt(sumSq / Math.max(vals.length - 1, 1)) || 1.0

      // Standardize
      const scaled = vals.map((v) => (v - mean) / std)
      rawCols.push(scaled)
    }

    if (rawCols.length < p) return []

    // Transpose to N x p
    const N = rowIds.length
    const matrix: number[][] = []
    for (let i = 0; i < N; i++) {
      const row: number[] = []
      for (let j = 0; j < p; j++) {
        row.push(rawCols[j][i])
      }
      matrix.push(row)
    }

    return matrix
  }, [data, selectedColumns, rowIds])

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

  // Global keyboard shortcuts (only active when on /touring tab)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isTouringActive) return
      // Don't trigger if user is typing in an input/select
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return

      if (e.code === 'Space') {
        e.preventDefault()
        handleTogglePlay()
      } else if (e.key === '.') {
        e.preventDefault()
        handleStep()
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        handleReset()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleTogglePlay, handleStep, handleReset, isTouringActive])

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
        message="Grand Tour には3つ以上の数値変数が必要です。上部の変数セレクタから追加してください。"
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

      {/* Action Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', maxWidth: 860 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            💡 ショートカット: <strong>Space</strong> (再生/一時停止) · <strong>.</strong> (1コマ送り) · <strong>R</strong> (視点リセット) · 一時停止中にドラッグで矩形選択
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
