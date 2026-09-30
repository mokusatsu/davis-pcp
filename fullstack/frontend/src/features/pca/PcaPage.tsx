import Select from '../common/ColumnSelect'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useSelector } from 'react-redux'
import { Alert, Button, Radio, Segmented, Space, Typography, message } from 'antd'
import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectEffectiveRowIds, selectOrdinaryVariables } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import { api } from '../../api/client'
import { ScreePlot } from './ScreePlot'
import { LoadingTable } from './LoadingTable'
import { BiplotView } from './BiplotView'
import { PcaMatrixPlot } from './PcaMatrixPlot'
import type { PcaResponse } from './types'


export default function PcaPage() {
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
  const contextRef = useRef(context)
  contextRef.current = context
  const requestVersion = useRef(0)
  useEffect(() => {
    requestVersion.current++
    setPcaData(null); setLoading(false); setError(null)
  }, [context])

  const runPca = useCallback(
    async (rowSubset?: string[]) => {
      if (!selection.datasetId) return
      if (selectedColumns.length < 2) {
        message.warning('PCAには2つ以上の数値変数を選択してください。')
        return
      }
      setLoading(true)
      setError(null)
      const version = ++requestVersion.current, startedContext = contextRef.current
      const isCurrent = () => version === requestVersion.current && startedContext === contextRef.current
      try {
        const res = await api.post<PcaResponse>('/models/pca', {
          datasetId: selection.datasetId,
          columns: selectedColumns,
          useCorrelation,
          rowIds: rowSubset === undefined ? rowIds : rowIds.filter(id => rowSubset.includes(id)),
          expectedSchemaRevision: schemaRevision,
          expectedDataRevision: selection.dataRevision,
        })
        if (!isCurrent()) return
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
    [selection.datasetId, selection.dataRevision, schemaRevision, rowIds, selectedColumns, useCorrelation]
  )

  const handleComponentSelectFromScree = (compIndex: number) => {
    if (compIndex === selectedX) {
      // If clicking X, switch to Y
      setSelectedY(compIndex)
    } else {
      setSelectedX(compIndex)
    }
  }

  const hasSelectedRows = selection.selectedRowIds.length > 0

  return (
    <div
      data-testid="pca-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4, height: 'auto', minHeight: '100%', flex: 'none', flexShrink: 0 }}
    >
      {/* Top Toolbar */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, background: '#fff', padding: '10px 14px', borderRadius: 6, border: '1px solid #f0f0f0' }}>
          <Typography.Text strong>分析変数: </Typography.Text>
          <Select
            mode="multiple"
            style={{ minWidth: 260, maxWidth: 460 }}
            placeholder="2つ以上の数値変数を選択"
            value={selectedColumns}
            onChange={setSelectedColumns}
            options={numericColumns.map((c) => ({ label: c, value: c }))}
            data-testid="pca-columns-select"
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
            <Typography.Text strong>手法: </Typography.Text>
            <Radio.Group
              value={useCorrelation}
              onChange={(e) => setUseCorrelation(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
              data-testid="pca-method-radio"
            >
              <Radio.Button value={true}>相関行列 (標準化)</Radio.Button>
              <Radio.Button value={false}>分散共分散行列</Radio.Button>
            </Radio.Group>
          </div>

          <Space style={{ marginLeft: 'auto' }}>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={loading}
              disabled={selectedColumns.length < 2}
              onClick={() => void runPca()}
              data-testid="pca-run-button"
            >
              PCA実行
            </Button>
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              disabled={!hasSelectedRows || selectedColumns.length < 2}
              onClick={() => void runPca(selection.selectedRowIds)}
              data-testid="pca-run-subset-button"
            >
              選択サブセットで再実行 ({selection.selectedRowIds.length}行)
            </Button>
          </Space>
        </div>

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
            flex: 'none', flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 560,
          }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                3. 主成分射影ビュー (Projection & Biplot)
              </Typography.Title>
              <Segmented
                value={viewMode}
                onChange={(val) => setViewMode(val as 'biplot' | 'matrix')}
                options={[
                  { label: '2D バイプロット (Biplot)', value: 'biplot' },
                  { label: '主成分散布図行列 (PC Matrix)', value: 'matrix' },
                ]}
                data-testid="pca-view-mode"
              />
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
