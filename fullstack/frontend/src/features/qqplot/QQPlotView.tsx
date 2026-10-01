import { useAnalysisViewActive } from '../selection/analysisScope'
import { selectOrdinaryVariables } from '../../app/store'
import RowScatter from '../charts/RowScatter'
import Select from '../common/ColumnSelect'
import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Card, Dropdown, Space, Tag, Typography } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionCleared, focusSelected, deleteSelected, resetWorkingSet, selectEffectiveRowIds } from '../../app/store'
import { api } from '../../api/client'
import { useColumnarData } from '../pcp/useDatasetColumns'
import GraphPanel, { useGraphPopupContainer } from '../common/GraphPanel'
import EmptyStatePanel from '../common/EmptyStatePanel'

interface QQPoint {
  rowId: string
  rank: number
  sampleValue: number
  theoreticalQuantile: number
}

interface QQResponse {
  column: string
  count: number
  normalityTest: {
    shapiroWilkW: number | null
    pValue: number | null
    isNormalAlpha05: boolean | null
    skewness: number
    kurtosis: number
  }
  referenceLine: {
    slope: number
    intercept: number
    q1Sample: number
    q3Sample: number
    q1Theoretical: number
    q3Theoretical: number
  }
  points: QQPoint[]
  minZ: number
  maxZ: number
  minVal: number
  maxVal: number
}

export default function QQPlotView() {
  const graphPopupContainer = useGraphPopupContainer('distribution/qq')
  const dispatch = useDispatch<AppDispatch>()
  const viewActive = useAnalysisViewActive()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector(selectOrdinaryVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const data = useColumnarData(selection.datasetId)

  const numericColumns = useMemo(() => {
    if (!data) return []
    const activeVarSet = new Set(globalVars.activeVariableIds)
    return data.schema
      .filter((c) => c.semanticType === 'numeric' && (!activeVarSet || activeVarSet.has(c.name)))
      .map((c) => c.name)
  }, [data, globalVars?.activeVariableIds])

  const [selectedColumn, setSelectedColumn] = useState<string>('')
  const [qqData, setQqData] = useState<QQResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (numericColumns.length > 0 && (!selectedColumn || !numericColumns.includes(selectedColumn))) {
      setSelectedColumn(numericColumns[0])
    }
  }, [numericColumns, selectedColumn])

  useEffect(() => {
    if (!viewActive) return
    let cancelled = false
    setQqData(null)
    if (!selection.datasetId || !selectedColumn || !numericColumns.includes(selectedColumn)) { setLoading(false); return }
    setLoading(true)
    api.post<QQResponse>('/summaries/qqplot', {
      datasetId: selection.datasetId,
      column: selectedColumn,
      rowIds: effectiveRowIds,
      expectedDataRevision: selection.dataRevision,
    })
      .then(value => { if (!cancelled) setQqData(value) })
      .catch(() => { if (!cancelled) setQqData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [viewActive, selection.datasetId, selection.dataRevision, selectedColumn, effectiveRowIds, data, numericColumns])

  const width = 680
  const height = 440

  // Right-click context menu items (DAVIS legacy)
  const contextMenuItems = [
    {
      key: 'focus',
      label: 'Focus Selected (選択行のみに絞り込み)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: 'Delete Selected (選択行を一時除外)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: 'Clear Selection (選択解除)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      key: 'reset',
      label: 'Reset to Base Data (全データ復帰)',
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]

  if (numericColumns.length === 0) {
    return <EmptyStatePanel message="QQプロットには1つ以上の数値変数が必要です。上部の変数セレクタから追加してください。" />
  }

  const columnControls = (
    <Space wrap align="center">
      <Typography.Text strong>対象変数: </Typography.Text>
      <Select
        style={{ width: 180 }}
        value={selectedColumn}
        onChange={setSelectedColumn}
        options={numericColumns.map((c) => ({ label: c, value: c }))}
        getPopupContainer={graphPopupContainer}
        data-testid="qqplot-column-select"
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        ドラッグで矩形範囲ブラシ · 右クリックで Focus/Delete
      </Typography.Text>
    </Space>
  )

  return (
    <div data-testid="qqplot-view" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      <GraphPanel
        graphId="distribution/qq"
        title="正規Q-Qプロット"
        available={numericColumns.length > 0}
        sizing="intrinsic"
        intrinsicSize={{ width, height }}
        controls={columnControls}
        style={{ flex: '1 1 680px', minWidth: 0 }}
      >
          <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={graphPopupContainer}>
            <div
              style={{
                position: 'relative',
                width,
                height,
                outline: '1px solid #e5e7eb',
                outlineOffset: -1,
                borderRadius: 6,
                background: '#ffffff',
                userSelect: 'none',
              }}
            >
              <RowScatter points={(qqData?.points ?? []).map(point => ({ rowId: point.rowId, x: point.theoreticalQuantile, y: point.sampleValue,
                tooltip: `rowId: ${point.rowId}\n順位: ${point.rank}\n理論分位点: ${point.theoreticalQuantile}\n観測値: ${point.sampleValue}` }))}
                xName="理論正規分位点" yName={`サンプル分位点 (${qqData?.column ?? ''})`} height={height} testId="qqplot-canvas"
                option={{ series: qqData ? [{ type: 'line', name: 'Q1–Q3基準線', symbol: 'none', lineStyle: { color: '#ff4d4f', type: 'dashed' },
                  data: [qqData.minZ, qqData.maxZ].map(z => [z, qqData.referenceLine.intercept + qqData.referenceLine.slope * z]) }] : [] }} />
            </div>
          </Dropdown>
      </GraphPanel>

          {qqData && (
            <Card
              size="small"
              title="正規性診断サマリー (Normality)"
              style={{ flex: '1 1 300px', minWidth: 280 }}
              loading={loading}
              data-testid="qqplot-diagnostics"
            >
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <div>
                  <Typography.Text type="secondary">サンプル数: </Typography.Text>
                  <Typography.Text strong>{qqData.count}</Typography.Text>
                </div>

                <div>
                  <Typography.Text type="secondary">Shapiro-Wilk 検定: </Typography.Text>
                  <div>
                    W = {qqData.normalityTest.shapiroWilkW?.toFixed(4) ?? '—'}, p = {qqData.normalityTest.pValue?.toFixed(4) ?? '—'}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {qqData.normalityTest.isNormalAlpha05 ? (
                      <Tag color="success">正規分布 (p &ge; 0.05)</Tag>
                    ) : (
                      <Tag color="error">非正規分布 (p &lt; 0.05)</Tag>
                    )}
                  </div>
                </div>

                <div>
                  <Typography.Text type="secondary">歪度 (Skewness): </Typography.Text>
                  <Typography.Text strong>
                    {qqData.normalityTest.skewness.toFixed(3)}
                    {' '}
                    <span style={{ fontSize: 11, color: '#888' }}>
                      {qqData.normalityTest.skewness > 0.5 ? '(右に裾が長い)' : qqData.normalityTest.skewness < -0.5 ? '(左に裾が長い)' : '(対称に近い)'}
                    </span>
                  </Typography.Text>
                </div>

                <div>
                  <Typography.Text type="secondary">尖度 (Kurtosis): </Typography.Text>
                  <Typography.Text strong>
                    {qqData.normalityTest.kurtosis.toFixed(3)}
                    {' '}
                    <span style={{ fontSize: 11, color: '#888' }}>
                      {qqData.normalityTest.kurtosis > 0.5 ? '(尖鋭・重裾)' : qqData.normalityTest.kurtosis < -0.5 ? '(平坦・軽裾)' : '(正規に近い)'}
                    </span>
                  </Typography.Text>
                </div>

                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e8e8e8' }}>
                  <Typography.Text type="secondary">Q1-Q3 頑健基準線: </Typography.Text>
                  <div style={{ fontSize: 11 }}>
                    Slope: {qqData.referenceLine.slope.toFixed(3)} (標準偏差近似)
                  </div>
                </div>
              </Space>
            </Card>
          )}
      </div>
    </div>
  )
}
