import { useScopedRun, AnalysisScopeSummary } from '../selection/analysisScope'
import Select from '../common/ColumnSelect'
import { AnalysisField, AnalysisRunRow } from '../common/AnalysisSetup'
import { editorModalOpened } from '../dataset/codebookSlice'
import { useCallback, useEffect, useId, useState } from 'react'

import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Radio, Typography, message } from 'antd'
import { PlayCircleOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectEffectiveRowIds, selectOrdinaryVariables } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import { api } from '../../api/client'
import { ScreePlot } from './ScreePlot'
import { LoadingTable } from './LoadingTable'
import { BiplotView } from './BiplotView'
import { PcaMatrixPlot } from './PcaMatrixPlot'
import type { PcaResponse } from './types'


export default function OrdinaryPcaPanel() {
  const dispatch = useDispatch()
  const controlId = useId()
  const columnsId = `${controlId}-columns`
  const selection = useSelector((s: RootState) => s.selection)
  const rowIds = useSelector(selectEffectiveRowIds)
  const globalVariables = useSelector(selectOrdinaryVariables)
  const { columns, schemaRevision } = useCodebook()
  const candidates = columns.filter(c => !c.multiResponseGroup && ['question', 'attribute'].includes(c.role)
    && ['interval', 'ratio', 'ordinal'].includes(c.scaleType) && globalVariables.activeVariableIds.includes(c.name))
  const numericColumns = candidates.map(c => c.name)
  const [chosen, setChosen] = useState<{ datasetId: string; names: string[] } | null>(null)
  const selectedColumns = (chosen?.datasetId === selection.datasetId ? chosen.names
    : candidates.filter(c => c.scaleType !== 'ordinal').map(c => c.name)).filter(name => numericColumns.includes(name))
  const setSelectedColumns = (names: string[]) => setChosen({ datasetId: selection.datasetId!, names })
  const [useCorrelation, setUseCorrelation] = useState(true)
  const [loading, setLoading] = useState(false)
  const [pcaData, setPcaData] = useState<PcaResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [selectedX, setSelectedX] = useState(0)
  const [selectedY, setSelectedY] = useState(1)
  const [viewMode, setViewMode] = useState<'biplot' | 'matrix'>('biplot')

  const context = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, rowIds, selectedColumns, useCorrelation])
  const runScope = useScopedRun(context)
  useEffect(() => {
    setPcaData(null); setLoading(false); setError(null)
  }, [runScope.identity])

  const runPca = useCallback(
    async () => {
      if (!selection.datasetId) return
      if (selectedColumns.length < 2) {
        message.warning('PCAには2つ以上の数値変数を選択してください。')
        return
      }
      setLoading(true)
      setError(null)
      const ticket = runScope.begin()
      const isCurrent = ticket.isCurrent
      try {
        const res = await api.post<PcaResponse>('/models/pca', {
          datasetId: selection.datasetId,
          columns: selectedColumns,
          useCorrelation,
          rowIds: ticket.scope.rowIds,
          expectedSchemaRevision: schemaRevision,
          expectedDataRevision: selection.dataRevision,
        })
        if (!isCurrent()) return
        ticket.commit()
        setPcaData(res)
        setSelectedX(0)
        setSelectedY(Math.min(1, (res.nComponents || res.eigenvalues.length) - 1))
      } catch (err) {
        if (!isCurrent()) return
        const e = err as { message: string }
        setError(e.message || 'PCAの計算に失敗しました。')
      } finally {
        if (isCurrent()) setLoading(false)
      }
    },
    [selection.datasetId, selection.dataRevision, schemaRevision, rowIds, selectedColumns, useCorrelation, runScope]
  )

  const handleComponentSelectFromScree = (compIndex: number) => {
    // A bar assigns X; choosing the current Y swaps the axes instead of duplicating it.
    if (compIndex === selectedX) return
    if (compIndex === selectedY) setSelectedY(selectedX)
    setSelectedX(compIndex)
  }


  return (
    <div
      data-testid="pca-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4, minWidth: 0, height: 'auto', minHeight: '100%', flex: 'none', flexShrink: 0 }}
    >
      <div className="analysis-setup analysis-form-stack" data-testid="pca-setup"
        style={{ background: '#fff', padding: '10px 14px', borderRadius: 6, border: '1px solid #f0f0f0' }}>
        <div className="analysis-variable-grid">
          <AnalysisField label="分析変数" htmlFor={columnsId}
            help="共通の有効変数のうち、役割が質問・属性、尺度が順序・間隔・比例の非MA列を選べます。初期選択は間隔・比例尺度の列です。">
            <Select
              id={columnsId} aria-label="通常PCAの分析変数" aria-describedby={`${columnsId}-help`} roleName="通常PCAの分析変数"
              mode="multiple" style={{ width: '100%' }}
              placeholder="2つ以上の数値変数を選択"
              value={selectedColumns}
              onChange={setSelectedColumns}
              options={numericColumns.map((c) => ({ label: c, value: c }))}
              emptyHint={{ roleLabel: '通常PCAの分析', reason: '通常PCAの分析変数の候補がありません。',
                guidance: '共通の有効変数とコードブックの役割・尺度・MAグループを確認してください。質問・属性の順序・間隔・比例尺度の非MA列が対象です。',
                onOpenCodebook: () => dispatch(editorModalOpened()) }}
              data-testid="pca-columns-select"
            />
          </AnalysisField>
          <AnalysisField label="手法">
            <div role="radiogroup" aria-label="通常PCAの手法" className="analysis-method-switch">
              <Radio.Group
                name={`${controlId}-method`}
                value={useCorrelation}
                onChange={(e) => setUseCorrelation(e.target.value)}
                optionType="button" buttonStyle="solid" size="small"
                data-testid="pca-method-radio"
              >
                <Radio.Button value={true}>相関行列 (標準化)</Radio.Button>
                <Radio.Button value={false}>分散共分散行列</Radio.Button>
              </Radio.Group>
            </div>
          </AnalysisField>
        </div>
        <AnalysisRunRow>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={loading}
            disabled={selectedColumns.length < 2} onClick={() => void runPca()} data-testid="pca-run-button">
            PCA実行
          </Button>
        </AnalysisRunRow>
      </div>

      <AnalysisScopeSummary snapshot={runScope.snapshot} />
      {runScope.dirty && <Alert type="info" message="実行時の対象・設定を保持しています。現在の入力で計算するには再実行してください。" />}
      {error && (
        <Alert
          type="error"
          message="PCA計算エラー"
          description={error}
          closable
          onClose={() => setError(null)}
        />
      )}

      {pcaData?.warnings?.map((warning) => (
        <Alert key={warning.code} type="warning" message={warning.message} showIcon data-testid="pca-warning" />
      ))}

      {/* Pane 1: Scree Plot & Variance Explained */}
        <ScreePlot
          pcaData={pcaData}
          loading={loading}
          selectedX={selectedX}
          selectedY={selectedY}
          onSelectComponent={handleComponentSelectFromScree}
        />
      

      {/* Pane 2: Factor Loadings & Weights Table */}
      <LoadingTable pcaData={pcaData} loading={loading} />

      {/* Pane 3: Projection View (Biplot or Matrix) */}
        <div
          style={{
            background: '#fff', padding: 14, borderRadius: 6, border: '1px solid #f0f0f0',
            flex: 'none', flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 560, minWidth: 0,
          }}
        >
            <div className="analysis-setup" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
              <Typography.Title level={5} style={{ margin: 0, minWidth: 0 }}>
                3. 主成分射影ビュー (Projection & Biplot)
              </Typography.Title>
              <div role="radiogroup" aria-label="通常PCAの射影ビュー" className="analysis-method-switch" style={{ maxWidth: '100%' }}>
                <Radio.Group
                  name={`${controlId}-view`}
                  value={viewMode} onChange={event => setViewMode(event.target.value)}
                  data-testid="pca-view-mode"
                >
                  <Radio.Button value="biplot">2D バイプロット (Biplot)</Radio.Button>
                  <Radio.Button value="matrix">主成分散布図行列 (PC Matrix)</Radio.Button>
                </Radio.Group>
              </div>
            </div>

          {viewMode === 'biplot' ? (
            <BiplotView
              pcaData={pcaData}
              selectedX={selectedX}
              selectedY={selectedY}
              onSelectX={setSelectedX}
              onSelectY={setSelectedY}
            />
          ) : (
            <PcaMatrixPlot pcaData={pcaData} />
          )}
        </div>
    </div>
  )
}
