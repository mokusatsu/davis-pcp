import { selectOrdinaryVariables } from '../../app/store'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Radio, Space, Spin, Tag, Typography } from 'antd'
import { AppstoreOutlined, ArrowRightOutlined, LineChartOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { pcpStateChanged, selectEffectiveRowIds } from '../../app/store'
import { api } from '../../api/client'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { useCodebook } from '../dataset/useCodebookColumn'
import { truncateText } from '../../utils/textUtils'

interface CovarianceResponse {
  columns: string[]
  nRows: number
  means: Record<string, number>
  stds: Record<string, number>
  covariance: number[][]
  correlation: number[][]
  precision: number[][]
  partialCorrelation: number[][]
  diagnostics: {
    generalizedVariance: number | string
    logGeneralizedVariance: number
    totalVariance: number
    conditionNumber: number
    isSingular: boolean
  }
}

export default function CovariancePage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const globalVars = useSelector(selectOrdinaryVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const { columns, schemaRevision } = useCodebook()
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const requestGeneration = useRef(0)
  const [error, setError] = useState<string | null>(null)

  const [mode, setMode] = useState<'cov' | 'corr' | 'prec'>('cov')
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [covData, setCovData] = useState<CovarianceResponse | null>(null)
  const [selectedCell, setSelectedCell] = useState<{ r: number; c: number; col1: string; col2: string } | null>(null)

  const numericColumns = useMemo(
    () => columns.filter(c => !c.multiResponseGroup && ['attribute', 'question'].includes(c.role) && ['interval', 'ratio', 'ordinal'].includes(c.scaleType)).map(c => c.name),
    [columns],
  )

  const activeNumericColumns = useMemo(() => {
    const activeVarSet = new Set(globalVars.activeVariableIds)
    return columns
      .filter((c) => numericColumns.includes(c.name) && c.scaleType !== 'ordinal' && (!activeVarSet || activeVarSet.has(c.name)))
      .map((c) => c.name)
  }, [columns, numericColumns, globalVars?.activeVariableIds])

  useEffect(() => {
    setSelectedColumns(previous => {
      const valid = previous.filter(name => numericColumns.includes(name))
      return valid.length === previous.length ? previous : valid
    })
  }, [numericColumns])

  useEffect(() => {
    if (activeNumericColumns.length >= 2 && selectedColumns.length === 0) {
      setSelectedColumns(activeNumericColumns.slice(0, 8))
    }
  }, [activeNumericColumns, selectedColumns.length])

  const fetchCov = useCallback(async () => {
    const generation = ++requestGeneration.current
    setCovData(null)
    setError(null)
    if (!datasetId || selectedColumns.length < 2 || selectedColumns.some(c => !numericColumns.includes(c))) { setLoading(false); return }
    setLoading(true)
    try {
      const res = await api.post<CovarianceResponse>('/statistics/covariance', {
        datasetId,
        columns: selectedColumns,
        rowIds: effectiveRowIds,
        expectedSchemaRevision: schemaRevision,
        expectedDataRevision: dataRevision,
      })
      if (generation === requestGeneration.current) setCovData(res)
    } catch (err) {
      if (generation === requestGeneration.current) setError((err as Error).message || '共分散の計算に失敗しました。')
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [datasetId, selectedColumns, effectiveRowIds, schemaRevision, dataRevision, numericColumns])

  useEffect(() => {
    void fetchCov()
  }, [fetchCov])

  // Active matrix depending on mode
  const activeMatrix = useMemo(() => {
    if (!covData) return []
    if (mode === 'cov') return covData.covariance
    if (mode === 'corr') return covData.correlation
    return covData.partialCorrelation
  }, [covData, mode])

  // Compute color scale boundaries
  const colorScale = useMemo(() => {
    if (!activeMatrix || activeMatrix.length === 0) return { min: -1, max: 1 }
    let min = 0
    let max = 0
    for (let r = 0; r < activeMatrix.length; r++) {
      for (let c = 0; c < activeMatrix[r].length; c++) {
        const v = activeMatrix[r][c]
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    return { min, max }
  }, [activeMatrix])

  const getCellColor = (val: number) => {
    if (mode === 'corr' || mode === 'prec') {
      // Bipolar -1 to 1: negative blue, positive red/orange
      if (val > 0) {
        const a = Math.min(1, val).toFixed(2)
        return `rgba(239, 68, 68, ${a})` // red
      } else if (val < 0) {
        const a = Math.min(1, Math.abs(val)).toFixed(2)
        return `rgba(59, 130, 246, ${a})` // blue
      }
      return '#ffffff'
    } else {
      // Raw covariance: normalize by max abs
      const maxAbs = Math.max(Math.abs(colorScale.min), Math.abs(colorScale.max)) || 1
      const norm = val / maxAbs
      if (norm > 0) {
        return `rgba(239, 68, 68, ${Math.min(1, norm).toFixed(2)})`
      } else if (norm < 0) {
        return `rgba(59, 130, 246, ${Math.min(1, Math.abs(norm)).toFixed(2)})`
      }
      return '#ffffff'
    }
  }

  const handleCellClick = (r: number, c: number) => {
    if (!covData) return
    setSelectedCell({
      r,
      c,
      col1: covData.columns[r],
      col2: covData.columns[c],
    })
  }

  const projectToPcp = () => {
    if (!selectedCell || !covData) return
    const remaining = covData.columns.filter((c) => c !== selectedCell.col1 && c !== selectedCell.col2)
    dispatch(pcpStateChanged({ order: [selectedCell.col1, selectedCell.col2, ...remaining] }))
    navigate('/pcp')
  }

  const navigateToLoess = () => {
    if (!selectedCell) return
    navigate('/loess')
  }

  const colsCount = covData?.columns.length ?? 1
  const CELL_SIZE = focused
    ? Math.max(120, Math.min(220, Math.floor(1000 / Math.max(colsCount, 1))))
    : 76
  const CELL_HEIGHT = focused ? 64 : 48
  const LABEL_WIDTH = focused ? 180 : 130
  const FONT_SIZE = focused ? 14 : 11
  const HEADER_FONT_SIZE = focused ? 13 : 12

  return (
    <div
      data-testid="covariance-page"
      style={{
        padding: focused ? 0 : 16,
        display: 'flex',
        flexDirection: 'column',
        gap: focused ? 0 : 12,
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : undefined,
        minHeight: 0,
      }}
    >
      {error && <Alert type="error" message={error} />}
      {/* Controls Card */}
      {!focused && (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#ffffff',
            padding: '10px 16px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <Space wrap size={16}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              <AppstoreOutlined style={{ marginRight: 6, color: '#2a78d6' }} />
              分散共分散行列 (Covariance Matrix Suite)
            </Typography.Text>

            <Radio.Group
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="cov" data-testid="covariance-mode-cov">共分散行列 (Covariance Σ)</Radio.Button>
              <Radio.Button value="corr" data-testid="covariance-mode-corr">相関行列 (Correlation R)</Radio.Button>
              <Radio.Button value="prec" data-testid="covariance-mode-prec">精度行列 (偏相関 Partial Corr)</Radio.Button>
            </Radio.Group>

            <Select
              mode="multiple"
              style={{ minWidth: 260 }}
              placeholder="対象列を選択"
              value={selectedColumns}
              onChange={setSelectedColumns}
              options={numericColumns.map((c) => ({ label: c, value: c }))}
              maxTagCount={4}
              size="small"
            />
          </Space>

          <FocusEnterButton targetId="covariance-container" />
        </div>
      )}

      {/* Diagnostics Card */}
      {!focused && covData && (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#ffffff',
            padding: '10px 16px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Typography.Text strong style={{ fontSize: 13, color: '#374151' }}>多変量診断指標:</Typography.Text>
          <Tag color="blue">一般化分散 |Σ|: {covData.diagnostics.generalizedVariance}</Tag>
          <Tag color="purple">総分散 Tr(Σ): {covData.diagnostics.totalVariance}</Tag>
          <Tag color="cyan">条件数: {covData.diagnostics.conditionNumber}</Tag>
          {covData.diagnostics.isSingular && (
            <Tag color="error">特異行列 (多重共線性あり)</Tag>
          )}
        </div>
      )}

      {/* Main Heatmap Matrix */}
      <FocusTarget id="covariance-container">
        <div
          style={{
            border: focused ? 'none' : '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#ffffff',
            padding: focused ? 8 : 16,
            position: 'relative',
            overflow: 'auto',
            userSelect: 'none',
            minHeight: focused ? undefined : 460,
            height: focused ? '100%' : undefined,
            flex: focused ? 1 : undefined,
          }}
        >
          {loading && (
            <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 10 }}>
              <Spin tip="行列を計算中..." />
            </div>
          )}

          {!loading && covData && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: focused ? 'center' : 'flex-start', width: '100%', minWidth: 'max-content' }}>
              <table data-testid="covariance-matrix" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ width: LABEL_WIDTH, padding: focused ? 10 : 6 }}></th>
                    {covData.columns.map((col) => (
                      <th
                        key={col}
                        title={col}
                        style={{
                          width: CELL_SIZE,
                          padding: focused ? 10 : 6,
                          fontSize: HEADER_FONT_SIZE,
                          fontWeight: 600,
                          color: '#374151',
                          textAlign: 'center',
                          borderBottom: '1px solid #e5e7eb',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        <ColumnQuestionTooltip nameOrId={col}>{focused ? col : truncateText(col, 10)}</ColumnQuestionTooltip>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {covData.columns.map((rCol, rIdx) => (
                    <tr key={rCol}>
                      <td
                        title={rCol}
                        style={{
                          width: LABEL_WIDTH,
                          padding: focused ? '8px 14px' : '6px 10px',
                          fontSize: HEADER_FONT_SIZE,
                          fontWeight: 600,
                          color: '#374151',
                          textAlign: 'right',
                          borderRight: '1px solid #e5e7eb',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        <ColumnQuestionTooltip nameOrId={rCol}>{focused ? rCol : truncateText(rCol, 12)}</ColumnQuestionTooltip>
                      </td>
                      {covData.columns.map((cCol, cIdx) => {
                        const val = activeMatrix[rIdx]?.[cIdx] ?? 0
                        const isDiag = rIdx === cIdx
                        const isSelected = selectedCell?.r === rIdx && selectedCell?.c === cIdx
                        const cellBg = getCellColor(val)

                        return (
                          <td
                            key={cCol}
                            data-testid={`covariance-cell-${rIdx}-${cIdx}`}
                            onClick={() => handleCellClick(rIdx, cIdx)}
                            style={{
                              width: CELL_SIZE,
                              height: CELL_HEIGHT,
                              textAlign: 'center',
                              background: cellBg,
                              border: isSelected ? '2px solid #2563eb' : '1px solid #e5e7eb',
                              cursor: 'pointer',
                              position: 'relative',
                            }}
                          >
                            <span
                              style={{
                                fontSize: FONT_SIZE,
                                fontWeight: isDiag ? 700 : 500,
                                color: Math.abs(val) > (mode === 'cov' ? (colorScale.max * 0.6) : 0.6) ? '#ffffff' : '#1f2937',
                              }}
                            >
                              {mode === 'cov' ? val.toFixed(3) : val.toFixed(2)}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Cell Inspector Toolbar */}
              {selectedCell && (
                <div
                  style={{
                    marginTop: 16,
                    padding: '10px 14px',
                    borderRadius: 6,
                    background: '#f8fafc',
                    border: '1px solid #cbd5e1',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <Space size={12}>
                    <Typography.Text strong>
                      選択セル: [<ColumnQuestionTooltip nameOrId={selectedCell.col1}>{selectedCell.col1}</ColumnQuestionTooltip>] × [<ColumnQuestionTooltip nameOrId={selectedCell.col2}>{selectedCell.col2}</ColumnQuestionTooltip>]
                    </Typography.Text>
                    <span>
                      共分散: {covData.covariance[selectedCell.r][selectedCell.c].toFixed(4)} | 相関: {covData.correlation[selectedCell.r][selectedCell.c].toFixed(3)} | 偏相関: {covData.partialCorrelation[selectedCell.r][selectedCell.c].toFixed(3)}
                    </span>
                  </Space>

                  <Space size={8}>
                    <Button size="small" type="primary" icon={<ArrowRightOutlined />} onClick={projectToPcp}>
                      PCPでこの2軸を先頭配置
                    </Button>
                    <Button size="small" icon={<LineChartOutlined />} onClick={navigateToLoess}>
                      Loess散布図で開く
                    </Button>
                  </Space>
                </div>
              )}
            </div>
          )}

          {!loading && (!covData || covData.columns.length < 2) && (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#9ca3af' }}>
              最低2つの数値列を選択してください。
            </div>
          )}
        </div>
      </FocusTarget>

      {/* Guide Note */}
      {!focused && (
        <div style={{ color: '#6b7280', fontSize: 12, padding: '0 4px' }}>
          ※ 共分散行列 Σ（スケール付き変動）、相関行列 R、および精度行列 Σ⁻¹（他の全変数を統制した偏相関）を包括表示します。セルクリックで2変数の詳細値を確認し、ワンクリックでPCPの隣接軸への射影やLoess散布図の起動が行えます。
        </div>
      )}
    </div>
  )
}
