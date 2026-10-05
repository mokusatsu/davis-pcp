import { useAnalysisViewActive } from '../selection/analysisScope'
import MatrixHeatmap from '../charts/MatrixHeatmap'
import { selectOrdinaryVariables } from '../../app/store'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { AnalysisField } from '../common/AnalysisSetup'
import { editorModalOpened } from '../dataset/codebookSlice'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { Button, Radio, Space, Spin, Tag, Typography } from 'antd'
import { AppstoreOutlined, ArrowRightOutlined, LineChartOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { pcpStateChanged, selectEffectiveRowIds } from '../../app/store'
import { api } from '../../api/client'
import GraphPanel from '../common/GraphPanel'
import AnalysisErrorPanel, { analysisErrorMessage } from '../common/AnalysisErrorPanel'
import { useDatasetColumnSelection } from '../common/useDatasetColumnSelection'
import { useCodebook } from '../dataset/useCodebookColumn'

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
  const dispatch = useDispatch()
  const controlId = useId()
  const columnsId = `${controlId}-columns`
  const navigate = useNavigate()
  const viewActive = useAnalysisViewActive()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const globalVars = useSelector(selectOrdinaryVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const { columns, schemaRevision, isLoading: codebookLoading } = useCodebook()
  const codebookDatasetId = useSelector((s: RootState) => s.codebook.datasetId)
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision)
  const requestGeneration = useRef(0)
  const [error, setError] = useState<string | null>(null)

  const [mode, setMode] = useState<'cov' | 'corr' | 'prec'>('cov')
  const [loading, setLoading] = useState(false)
  const [covData, setCovData] = useState<CovarianceResponse | null>(null)
  const [selectedCell, setSelectedCell] = useState<{ r: number; c: number; col1: string; col2: string } | null>(null)

  const numericColumns = useMemo(
    () => columns.filter(c => !c.multiResponseGroup && ['attribute', 'question'].includes(c.role) && ['interval', 'ratio', 'ordinal'].includes(c.scaleType)).map(c => c.name),
    [columns],
  )

  const activeNumericColumns = useMemo(() => {
    const activeVarSet = new Set(globalVars.activeVariableIds)
    return numericColumns.filter(name => activeVarSet.has(name))
  }, [numericColumns, globalVars.activeVariableIds])
  const [selectedColumns, setSelectedColumns] = useDatasetColumnSelection(
    datasetId, activeNumericColumns, 8, Boolean(datasetId && codebookDatasetId === datasetId && !codebookLoading),
  )

  const liveKey = JSON.stringify([datasetId, dataRevision, schemaRevision, effectiveRowIds, selectedColumns, viewActive])
  const liveRef = useRef(liveKey)
  liveRef.current = liveKey
  useEffect(() => () => { requestGeneration.current++ }, [])

  const fetchCov = useCallback(async () => {
    const generation = ++requestGeneration.current
    const startedKey = liveRef.current
    const current = () => generation === requestGeneration.current && startedKey === liveRef.current
    setCovData(null)
    setSelectedCell(null)
    setError(null)
    if (!viewActive || !datasetId || selectedColumns.length < 2 || selectedColumns.some(c => !activeNumericColumns.includes(c))) { setLoading(false); return }
    setLoading(true)
    try {
      const res = await api.post<CovarianceResponse>('/statistics/covariance', {
        datasetId,
        columns: selectedColumns,
        rowIds: effectiveRowIds,
        expectedSchemaRevision: schemaRevision,
        expectedDataRevision: dataRevision,
      })
      if (current()) setCovData(res)
    } catch (err) {
      if (current()) setError(analysisErrorMessage(err))
    } finally {
      if (current()) setLoading(false)
    }
  }, [datasetId, selectedColumns, effectiveRowIds, schemaRevision, dataRevision, activeNumericColumns, viewActive])

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
    navigate('/loess', { state: { datasetId, xCol: selectedCell.col1, yCol: selectedCell.col2 } })
  }


  const matrixWidth = Math.max(560, 200 + (covData?.columns.length ?? 4) * 76)
  const matrixHeight = Math.max(400, (covData?.columns.length ?? 4) * 45 + 180)

  return (
    <div
      data-testid="covariance-page"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, minWidth: 0 }}
    >
      {error && <AnalysisErrorPanel title="共分散行列" error={error} onRetry={() => void fetchCov()} loading={loading} />}
      {/* Controls Card */}
        <div className="analysis-setup"
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
          <div className="analysis-form-stack" style={{ width: '100%' }}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              <AppstoreOutlined style={{ marginRight: 6, color: '#2a78d6' }} />
              分散共分散行列 (Covariance Matrix Suite)
            </Typography.Text>

            <div role="radiogroup" aria-label="共分散の表示行列" className="analysis-method-switch">
              <Radio.Group
                name={`${controlId}-mode`}
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
            </div>

            <AnalysisField label="対象列" htmlFor={columnsId}
              help="共通の有効変数のうち、役割が質問・属性、尺度が順序・間隔・比例の非MA列が対象です。初期選択は先頭8列までで、対象列を変えると自動で再計算します。表示行列の切替では再計算しません。">
              <Select
                id={columnsId} aria-label="共分散の対象列" aria-describedby={`${columnsId}-help`} roleName="共分散の対象列"
                data-testid="covariance-columns-select"
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="対象列を選択"
                value={selectedColumns}
                onChange={setSelectedColumns}
                options={activeNumericColumns.map((c) => ({ label: c, value: c }))}
                emptyHint={{ roleLabel: '共分散の対象', reason: '共分散の対象列の候補がありません。',
                  guidance: '共通の有効変数とコードブックの役割・尺度・MAグループを確認してください。質問・属性の順序・間隔・比例尺度の非MA列が対象です。',
                  onOpenCodebook: () => dispatch(editorModalOpened()) }}
                maxTagCount={4}
                size="small"
              />
            </AnalysisField>
          </div>
        </div>

      {/* Diagnostics Card */}
      {covData && (
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
      <GraphPanel
        graphId="covariance/matrix"
        title="分散共分散行列"
        available={Boolean(!loading && covData && covData.columns.length >= 2)}
        controls={<>{/* Cell Inspector Toolbar */}
              {selectedCell && covData && (
                <div
                  style={{
                    marginTop: 16,
                    padding: '10px 14px',
                    borderRadius: 6,
                    background: '#f8fafc',
                    border: '1px solid #cbd5e1',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <Space wrap size={12}>
                    <Typography.Text strong>
                      選択セル: [<ColumnQuestionTooltip nameOrId={selectedCell.col1}>{selectedCell.col1}</ColumnQuestionTooltip>] × [<ColumnQuestionTooltip nameOrId={selectedCell.col2}>{selectedCell.col2}</ColumnQuestionTooltip>]
                    </Typography.Text>
                    <span>
                      共分散: {covData.covariance[selectedCell.r][selectedCell.c].toFixed(4)} | 相関: {covData.correlation[selectedCell.r][selectedCell.c].toFixed(3)} | 偏相関: {covData.partialCorrelation[selectedCell.r][selectedCell.c].toFixed(3)}
                    </span>
                  </Space>

                  <Space wrap size={8}>
                    <Button size="small" type="primary" icon={<ArrowRightOutlined />} onClick={projectToPcp}>
                      PCPでこの2軸を先頭配置
                    </Button>
                    <Button size="small" icon={<LineChartOutlined />} onClick={navigateToLoess}>
                      Loess散布図で開く
                    </Button>
                  </Space>
                </div>
              )}</>}
        sizing="intrinsic"
        intrinsicSize={{
          width: matrixWidth,
          height: matrixHeight,
        }}
      >
        <div
          style={{
            outline: '1px solid #e5e7eb',
            outlineOffset: -1,
            borderRadius: 6,
            background: '#ffffff',
            position: 'relative',
            overflow: 'visible',
            userSelect: 'none',
            boxSizing: 'border-box',
          }}
        >
          {loading && (
            <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 10 }}>
              <Spin tip="行列を計算中..." />
            </div>
          )}

          {!loading && covData && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
              <MatrixHeatmap labels={covData.columns} matrix={activeMatrix} bound={mode === 'cov' ? Math.max(Math.abs(colorScale.min), Math.abs(colorScale.max), 1e-12) : 1}
                title={mode === 'cov' ? '分散共分散行列' : mode === 'corr' ? '相関行列' : '偏相関行列'} testId="covariance-matrix"
                selected={selectedCell ? [selectedCell.r, selectedCell.c] : null} onSelect={handleCellClick} decimals={mode === 'cov' ? 3 : 2}
                height={matrixHeight} />


            </div>
          )}

          {!loading && !error && (!covData || covData.columns.length < 2) && (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#9ca3af' }}>
              最低2つの数値列を選択してください。
            </div>
          )}
        </div>
      </GraphPanel>

      {/* Guide Note */}
        <div style={{ color: '#6b7280', fontSize: 12, padding: '0 4px' }}>
          ※ 共分散行列 Σ（スケール付き変動）、相関行列 R、および精度行列 Σ⁻¹（他の全変数を統制した偏相関）を包括表示します。セルクリックで2変数の詳細値を確認し、ワンクリックでPCPの隣接軸への射影やLoess散布図の起動が行えます。
        </div>
    </div>
  )
}
