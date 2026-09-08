import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Empty, Progress, Space, Spin, Typography } from 'antd'

import { ClearOutlined, DeleteOutlined, FilterOutlined } from '@ant-design/icons'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionCleared, focusSelected, deleteSelected, selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { api } from '../../api/client'
import { MosaicControlPanel } from './MosaicControlPanel'
import { LineMosaicCanvas } from './LineMosaicCanvas'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import type { LineMosaicCell, LineMosaicResponse } from './types'

export default function LineMosaicPage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector((s: RootState) => s.globalVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const data = useColumnarData(selection.datasetId)

  const allColumns = useMemo(() => {
    if (!data) return []
    const activeVarSet = globalVars?.activeVariableIds?.length ? new Set(globalVars.activeVariableIds) : null
    return activeVarSet
      ? data.schema.filter((c) => activeVarSet.has(c.name)).map((c) => c.name)
      : data.schema.map((c) => c.name)
  }, [data, globalVars?.activeVariableIds])

  const categoricalColumns = useMemo(() => {
    if (!data) return []
    const activeVarSet = globalVars?.activeVariableIds?.length ? new Set(globalVars.activeVariableIds) : null
    return data.schema
      .filter((c) => c.semanticType !== 'numeric' && (!activeVarSet || activeVarSet.has(c.name)))
      .map((c) => c.name)
  }, [data, globalVars?.activeVariableIds])

  const [colVars, setColVars] = useState<string[]>([])
  const [rowVars, setRowVars] = useState<string[]>([])
  const [targetVar, setTargetVar] = useState<string | null>(null)
  const [normalization, setNormalization] = useState<'global' | 'row'>('global')

  const [mosaicData, setMosaicData] = useState<LineMosaicResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCell, setSelectedCell] = useState<LineMosaicCell | null>(null)

  // Initialize default variables based on dataset columns
  useEffect(() => {
    if (allColumns.length > 0 && colVars.length === 0 && rowVars.length === 0) {
      if (categoricalColumns.length >= 2) {
        setColVars([categoricalColumns[0]])
        setRowVars([categoricalColumns[1]])
        if (categoricalColumns.length >= 3) {
          setTargetVar(categoricalColumns[2])
        }
      } else if (categoricalColumns.length === 1) {
        setColVars([categoricalColumns[0]])
        // Pick one numeric or other column
        const other = allColumns.find((c) => c !== categoricalColumns[0])
        if (other) setRowVars([other])
      } else {
        // Pick first 2 columns
        setColVars([allColumns[0]])
        if (allColumns.length > 1) setRowVars([allColumns[1]])
      }
    }
  }, [allColumns, categoricalColumns, colVars.length, rowVars.length])

  // Fetch mosaic contingency table
  const fetchMosaic = useCallback(async () => {
    if (!selection.datasetId || (colVars.length === 0 && rowVars.length === 0)) {
      setMosaicData(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const res = await api.post<LineMosaicResponse>('/summaries/line_mosaic', {
        datasetId: selection.datasetId,
        columnVariables: colVars,
        rowVariables: rowVars,
        targetVariable: targetVar || undefined,
        rowIds: effectiveRowIds.length < (data?.rowIds.length ?? 0) ? effectiveRowIds : undefined,
      })
      setMosaicData(res)
      setSelectedCell(null)
    } catch (err) {
      const e = err as { message: string }
      setError(e.message || 'モザイクプロットの集計に失敗しました。')
      setMosaicData(null)
    } finally {
      setLoading(false)
    }
  }, [selection.datasetId, colVars, rowVars, targetVar, effectiveRowIds, data])

  useEffect(() => {
    void fetchMosaic()
  }, [fetchMosaic])

  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  const selectedCount = selection.selectedRowIds.length

  return (
    <div
      data-testid="mosaic-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: focused ? 0 : 12,
        padding: focused ? 0 : 4,
        height: focused ? '100%' : 'auto',
        minHeight: '100%',
        overflow: focused ? 'hidden' : 'visible',
      }}
    >
      {/* Top Controls */}
      {!focused && (
        <MosaicControlPanel
          allColumns={allColumns}
          colVars={colVars}
          onColVarsChange={setColVars}
          rowVars={rowVars}
          onRowVarsChange={setRowVars}
          targetVar={targetVar}
          onTargetVarChange={setTargetVar}
          normalization={normalization}
          onNormalizationChange={setNormalization}
          targetInfo={mosaicData?.target ?? null}
        />
      )}

      {!focused && error && (
        <Alert
          type="error"
          message="集計エラー"
          description={error}
          closable
          onClose={() => setError(null)}
        />
      )}

      {/* Action Bar */}
      {!focused && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            ドラッグで矩形範囲選択 · 右クリックで Focus/Delete
          </Typography.Text>
          <Space>
            <FocusEnterButton targetId="line-mosaic" title="Line Mosaic Plot" />
          </Space>
        </div>
      )}

      {/* Main Layout: Canvas on Left, Details & Legend on Right */}
      <div
        style={{
          display: 'flex',
          gap: focused ? 0 : 12,
          alignItems: 'stretch',
          flex: focused ? 1 : undefined,
          height: focused ? '100%' : undefined,
          minHeight: 0,
        }}
      >
        {/* Canvas Plot */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            height: focused ? '100%' : undefined,
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
            padding: focused ? 4 : 10,
            borderRadius: focused ? 0 : 8,
            border: focused ? 'none' : '1px solid #f0f0f0',
            minHeight: 0,
          }}
        >
          <FocusTarget id="line-mosaic" title="Line Mosaic Plot">
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <Spin tip="モザイククロス集計を計算中..." />
              </div>
            ) : mosaicData && mosaicData.cells.length > 0 ? (
              <LineMosaicCanvas
                mosaicData={mosaicData}
                normalization={normalization}
                onSelectCell={setSelectedCell}
              />
            ) : (
              <Empty description="表示可能なセルがありません。変数を指定してください。" />
            )}
          </FocusTarget>
        </div>

        {/* Right Details Card */}
        {!focused && (
          <Card
            size="small"
            title="セル詳細 & アクション"
            style={{ width: 310, flexShrink: 0, borderRadius: 8 }}
            data-testid="mosaic-cell-details"
          >
            {selectedCell ? (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>行条件 (Row Path):</Typography.Text>
                  <div>
                    <Typography.Text strong>{selectedCell.rowPath.join(' / ') || '(All)'}</Typography.Text>
                  </div>
                </div>

                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>列条件 (Column Path):</Typography.Text>
                  <div>
                    <Typography.Text strong>{selectedCell.colPath.join(' / ') || '(All)'}</Typography.Text>
                  </div>
                </div>

                <div style={{ marginTop: 4 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>セル度数:</Typography.Text>
                  <div style={{ fontSize: 16, fontWeight: 'bold' }}>
                    {selectedCell.totalCount} 行
                    <span style={{ fontSize: 12, fontWeight: 'normal', color: '#888', marginLeft: 6 }}>
                      ({((selectedCell.totalCount / (mosaicData?.maxCellFrequency || 1)) * 100).toFixed(1)}% of max)
                    </span>
                  </div>
                </div>

                {mosaicData?.target && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #f0f0f0' }}>
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      <ColumnQuestionTooltip nameOrId={mosaicData.target.name}>{mosaicData.target.name}</ColumnQuestionTooltip> 比率:
                    </Typography.Text>
                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {mosaicData.target.categories.map((cat, idx) => {
                        const count = selectedCell.targetCounts[cat] || 0
                        const pct = selectedCell.totalCount > 0 ? (count / selectedCell.totalCount) * 100 : 0
                        const color = mosaicData.target!.colors[idx % mosaicData.target!.colors.length]

                        return (
                          <div key={cat}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                              <span style={{ color }}>{cat}</span>
                              <span>{count} ({pct.toFixed(1)}%)</span>
                            </div>
                            <Progress
                              percent={Number(pct.toFixed(1))}
                              strokeColor={color}
                              size="small"
                              showInfo={false}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </Space>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                セルをクリックすると、そのセルの条件・度数・目的変数の内訳が表示され、データセットの該当行が選択されます。
              </Typography.Text>
            )}


            {/* Action Buttons */}
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Button
                size="small"
                icon={<FilterOutlined />}
                disabled={selectedCount === 0}
                onClick={() => dispatch(focusSelected())}
              >
                Focus Selected ({selectedCount}行)
              </Button>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={selectedCount === 0}
                onClick={() => dispatch(deleteSelected())}
              >
                Delete Selected
              </Button>
              <Button
                size="small"
                icon={<ClearOutlined />}
                disabled={selectedCount === 0}
                onClick={() => dispatch(selectionCleared())}
              >
                選択解除
              </Button>
            </div>
          </Card>
        )}
      </div>

      {!focused && (
        <div style={{ fontSize: 11, color: '#888', flexShrink: 0 }}>
          ※ Line Mosaic Plot: 面積ではなく整列された水平線の長さでセル度数を定量比較。ドラッグで矩形範囲選択、右クリックで Focus / Delete。
        </div>
      )}
    </div>
  )
}
