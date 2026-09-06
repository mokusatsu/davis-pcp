import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { Space, Spin, Typography } from 'antd'
import type { RootState } from '../../app/store'
import { selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { GeodesicEngine } from './geodesicEngine'
import { TgtCanvas } from './TgtCanvas'
import { ProjectionCircle } from './ProjectionCircle'
import { TgtControlPanel } from './TgtControlPanel'
import SelectionMenu from '../selection/SelectionMenu'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import EmptyStatePanel from '../common/EmptyStatePanel'

export default function TgtPage() {
  const { focused } = useFocusMode()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector((s: RootState) => s.globalVariables)
  const activeVarIds = globalVars?.activeVariableIds
  const data = useColumnarData(selection.datasetId)

  const numericColumns = useMemo(() => {
    if (!data) return []
    return data.schema
      .filter((c) => c.semanticType === 'numeric' && (!activeVarIds || activeVarIds.length === 0 || activeVarIds.includes(c.name)))
      .map((c) => c.name)
  }, [data, activeVarIds])

  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [isPlaying, setIsPlaying] = useState(true)
  const [isTracking, setIsTracking] = useState(true)
  const [trailLength, setTrailLength] = useState(12)
  const [speed, setSpeed] = useState(1.0)
  const [basis, setBasis] = useState<{ alpha: number[]; beta: number[] }>({ alpha: [], beta: [] })

  // Adopt numeric columns (min 3)
  useEffect(() => {
    if (numericColumns.length >= 3) {
      setSelectedColumns(numericColumns.slice(0, Math.min(numericColumns.length, 6)))
    } else {
      setSelectedColumns([])
    }
  }, [numericColumns])

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

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
  }, [handleTogglePlay, handleStep, handleReset])

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
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: focused ? 0 : 12,
        padding: focused ? 0 : 4,
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : undefined,
        minHeight: 0,
      }}
    >
      {/* Control Toolbar */}
      {!focused && (
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
      )}

      {/* Action Bar */}
      {!focused && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', maxWidth: 860 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            💡 ショートカット: <strong>Space</strong> (再生/一時停止) · <strong>.</strong> (1コマ送り) · <strong>R</strong> (視点リセット) · 一時停止中にドラッグで矩形選択
          </Typography.Text>
          <Space>
            <SelectionMenu testId="tgt-selection-menu" />
            <FocusEnterButton targetId="tgt-canvas" title="Tracking Grand Tour" />
          </Space>
        </div>
      )}

      {/* Main Canvas & HUD Container */}
      <FocusTarget id="tgt-canvas" title="Tracking Grand Tour">
        <div
          style={{
            position: 'relative',
            display: 'block',
            background: '#141414',
            borderRadius: focused ? 0 : 8,
            boxShadow: focused ? 'none' : '0 4px 16px rgba(0, 0, 0, 0.15)',
            overflow: 'hidden',
            width: focused ? '100%' : 860,
            height: focused ? '100%' : 540,
            flex: focused ? 1 : undefined,
            userSelect: 'none',
          }}
        >
          {engine && dataMatrix.length > 0 && (
            <TgtCanvas
              engine={engine}
              rowIds={rowIds}
              dataMatrix={dataMatrix}
              isPlaying={isPlaying}
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
      </FocusTarget>
    </div>
  )
}
