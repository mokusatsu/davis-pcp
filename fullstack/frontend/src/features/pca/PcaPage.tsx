import Select from '../common/ColumnSelect'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useSelector } from 'react-redux'
import { Alert, Button, Radio, Segmented, Space, Typography, message } from 'antd'
import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { api } from '../../api/client'
import { ScreePlot } from './ScreePlot'
import { LoadingTable } from './LoadingTable'
import { BiplotView } from './BiplotView'
import { PcaMatrixPlot } from './PcaMatrixPlot'
import type { PcaResponse } from './types'
import { useFocusMode } from '../common/FocusMode'

export default function PcaPage() {
  const { focused, isTargetActive } = useFocusMode()
  const selection = useSelector((s: RootState) => s.selection)
  const data = useColumnarData(selection.datasetId)

  const numericColumns = useMemo(
    () => (data ? data.schema.filter((c) => c.semanticType === 'numeric').map((c) => c.name) : []),
    [data]
  )

  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [useCorrelation, setUseCorrelation] = useState(true)
  const [loading, setLoading] = useState(false)
  const [pcaData, setPcaData] = useState<PcaResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [selectedX, setSelectedX] = useState(0)
  const [selectedY, setSelectedY] = useState(1)
  const [viewMode, setViewMode] = useState<'biplot' | 'matrix'>('biplot')

  // Initialize selected columns when data loads
  useEffect(() => {
    if (numericColumns.length >= 2 && selectedColumns.length === 0) {
      setSelectedColumns(numericColumns)
    }
  }, [numericColumns, selectedColumns.length])

  const runPca = useCallback(
    async (rowSubset?: string[]) => {
      if (!selection.datasetId) return
      if (selectedColumns.length < 2) {
        message.warning('PCAには2つ以上の数値変数を選択してください。')
        return
      }
      setLoading(true)
      setError(null)
      try {
        const res = await api.post<PcaResponse>('/models/pca', {
          datasetId: selection.datasetId,
          columns: selectedColumns,
          useCorrelation,
          rowIds: rowSubset && rowSubset.length > 0 ? rowSubset : undefined,
        })
        setPcaData(res)
        setSelectedX(0)
        setSelectedY(Math.min(1, (res.nComponents || res.eigenvalues.length) - 1))
      } catch (err) {
        const e = err as { message: string }
        setError(e.message || 'PCAの計算に失敗しました。')
      } finally {
        setLoading(false)
      }
    },
    [selection.datasetId, selectedColumns, useCorrelation]
  )

  // Auto-run on first load once columns are set
  useEffect(() => {
    if (selection.datasetId && selectedColumns.length >= 2 && !pcaData && !loading) {
      void runPca()
    }
  }, [selection.datasetId, selectedColumns, pcaData, loading, runPca])

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
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: focused ? 0 : 14,
        padding: focused ? 0 : 4,
        height: focused ? '100%' : 'auto',
        minHeight: '100%',
        flex: focused ? 1 : 'none',
        flexShrink: 0,
      }}
    >
      {/* Top Toolbar */}
      {!focused && (
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
              onClick={() => void runPca()}
              data-testid="pca-run-button"
            >
              PCA実行
            </Button>
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              disabled={!hasSelectedRows}
              onClick={() => void runPca(selection.selectedRowIds)}
              data-testid="pca-run-subset-button"
            >
              選択サブセットで再実行 ({selection.selectedRowIds.length}行)
            </Button>
          </Space>
        </div>
      )}

      {!focused && error && (
        <Alert
          type="error"
          message="PCA計算エラー"
          description={error}
          closable
          onClose={() => setError(null)}
        />
      )}

      {/* Pane 1: Scree Plot & Variance Explained */}
      {(!focused || isTargetActive('pca-scree')) && (
        <ScreePlot
          pcaData={pcaData}
          loading={loading}
          selectedX={selectedX}
          selectedY={selectedY}
          onSelectComponent={handleComponentSelectFromScree}
        />
      )}

      {/* Pane 2: Factor Loadings & Weights Table */}
      {!focused && <LoadingTable pcaData={pcaData} loading={loading} />}

      {/* Pane 3: Projection View (Biplot or Matrix) */}
      {(!focused || isTargetActive('pca-biplot') || isTargetActive('pca-matrix')) && (
        <div
          style={{
            background: '#fff',
            padding: focused ? 4 : 14,
            borderRadius: 6,
            border: focused ? 'none' : '1px solid #f0f0f0',
            height: focused ? '100%' : undefined,
            flex: focused ? 1 : 'none',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: focused ? 0 : 560,
          }}
        >
          {!focused && (
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
          )}

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
      )}
    </div>
  )
}
