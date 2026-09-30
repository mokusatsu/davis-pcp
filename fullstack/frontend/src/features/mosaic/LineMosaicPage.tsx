import CategoryBars from '../charts/CategoryBars'
import { selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Empty, Space, Spin, Typography } from 'antd'

import { ClearOutlined, DeleteOutlined, FilterOutlined } from '@ant-design/icons'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionCleared, focusSelected, deleteSelected, resetWorkingSet, selectEffectiveRowIds } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import MaAxisPicker from '../pcp/MaAxisPicker'
import { api } from '../../api/client'
import { MosaicControlPanel } from './MosaicControlPanel'
import { LineMosaicCanvas } from './LineMosaicCanvas'
import type { LineMosaicCell, LineMosaicResponse } from './types'
import { mosaicPathLabel } from './types'

export default function LineMosaicPage() {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector(selectOrdinaryVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const { columns: definitions, schemaRevision } = useCodebook()
  const entities = useSelector(selectVariableEntities)
  const [added, setAdded] = useState<{ datasetId: string | null; names: string[] }>({ datasetId: null, names: [] })
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key))
    .map(item => ({ groupId: item.name, label: item.label }))
  const allColumns = definitions.filter(column => ['question', 'attribute'].includes(column.role)
    && (column.multiResponseGroup ? added.datasetId === selection.datasetId && added.names.includes(column.name)
      && groups.some(group => group.groupId === column.multiResponseGroup)
      : globalVars.activeVariableIds.includes(column.name) && ['nominal', 'ordinal'].includes(column.scaleType))).map(column => column.name)
  const [inputs, setInputs] = useState<{ datasetId: string | null; columns: string[]; rows: string[]; target: string | null }>({ datasetId: null, columns: [], rows: [], target: null })
  const colVars = inputs.datasetId === selection.datasetId ? inputs.columns.filter(name => allColumns.includes(name)) : []
  const rowVars = inputs.datasetId === selection.datasetId ? inputs.rows.filter(name => allColumns.includes(name)) : []
  const targetVar = inputs.datasetId === selection.datasetId && allColumns.includes(inputs.target ?? '') ? inputs.target : null
  const setColVars = (columns: string[]) => setInputs({ datasetId: selection.datasetId, columns, rows: rowVars, target: targetVar })
  const setRowVars = (rows: string[]) => setInputs({ datasetId: selection.datasetId, columns: colVars, rows, target: targetVar })
  const setTargetVar = (target: string | null) => setInputs({ datasetId: selection.datasetId, columns: colVars, rows: rowVars, target })
  const [normalization, setNormalization] = useState<'global' | 'row'>('global')

  const [mosaicData, setMosaicData] = useState<LineMosaicResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCell, setSelectedCell] = useState<LineMosaicCell | null>(null)

  const inputKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, colVars, rowVars, targetVar, effectiveRowIds])
  const currentInput = useRef(inputKey)
  currentInput.current = inputKey
  const [resultKey, setResultKey] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSelectedCell(null)
    setError(null)
    if (!selection.datasetId || (colVars.length === 0 && rowVars.length === 0)) {
      setLoading(false)
      return
    }
    setLoading(true)
    void api.post<LineMosaicResponse>('/summaries/line_mosaic', {
        datasetId: selection.datasetId,
        columnVariables: colVars,
        rowVariables: rowVars,
        targetVariable: targetVar || undefined,
        rowIds: effectiveRowIds,
        expectedDataRevision: selection.dataRevision,
        expectedSchemaRevision: schemaRevision,
      }).then(res => {
      if (cancelled || currentInput.current !== inputKey) return
      setMosaicData(res)
      setResultKey(inputKey)
    }).catch(err => {
      if (cancelled || currentInput.current !== inputKey) return
      const e = err as { message: string }
      setError(e.message || 'モザイクプロットの集計に失敗しました。')
    }).finally(() => { if (!cancelled && currentInput.current === inputKey) setLoading(false) })
    return () => { cancelled = true }
  }, [inputKey])

  if (!selection.datasetId) {
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
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4, height: 'auto', minHeight: '100%', overflow: 'visible' }}
    >
      {/* Top Controls */}
      <Space wrap>
        <MaAxisPicker allowCount={false} groups={groups} columns={definitions} onAdd={axes => {
          const byId = new Map(definitions.map(column => [column.columnId, column.name]))
          const names = axes.map(axis => (axis.columnId ? byId.get(axis.columnId) : undefined)).filter((name): name is string => Boolean(name))
          if (!names.length) return
          setAdded({ datasetId: selection.datasetId, names: [...new Set([...(added.datasetId === selection.datasetId ? added.names : []), ...names])] })
        }} />
        <Typography.Text type="secondary">属性とMA選択肢の選択／非選択を比較できます。</Typography.Text>
      </Space>
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

      {error && (
        <Alert
          type="error"
          message="集計エラー"
          description={error}
          closable
          onClose={() => setError(null)}
        />
      )}

      {/* Action Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            ドラッグで矩形範囲選択 · 右クリックで Focus/Delete
          </Typography.Text>
          <Space>
            {resultKey === inputKey && mosaicData && (
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12 }}
                data-testid="mosaic-scope-summary"
              >
                対象{mosaicData.scopeCount ?? effectiveRowIds.length}行
                / 使用{mosaicData.usedRows ?? 0}行
                / 除外{mosaicData.excludedRowCount ?? 0}行
              </Typography.Text>
            )}
          </Space>
        </div>

      {/* Main Layout: Canvas on Left, Details & Legend on Right */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'stretch', minHeight: 0 }}>
        {/* Canvas Plot */}
        <div
          style={{
            flex: '1 1 720px', minWidth: 0, display: 'flex', flexDirection: 'column',
            background: '#fff', padding: 10, borderRadius: 8, border: '1px solid #f0f0f0', minHeight: 0,
          }}
        >
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <Spin tip="モザイククロス集計を計算中..." />
              </div>
            ) : resultKey === inputKey && mosaicData && mosaicData.cells.length > 0 ? (
              <LineMosaicCanvas
                key={resultKey}
                mosaicData={mosaicData}
                normalization={normalization}
                onSelectCell={setSelectedCell}
              />
            ) : (
              <Empty description={mosaicData && resultKey === inputKey ? '対象範囲に表示可能な行がありません。' : '表示可能なセルがありません。変数を指定してください。'} />
            )}
        </div>

        {/* Right Details Card */}
          <Card
            size="small"
            title="セル詳細 & アクション"
            style={{ width: 310, maxWidth: '100%', flex: '0 1 310px', borderRadius: 8 }}
            data-testid="mosaic-cell-details"
          >
            {selectedCell ? (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>行条件 (Row Path):</Typography.Text>
                  <div>
                    <Typography.Text strong>{mosaicData && mosaicPathLabel(mosaicData, 'row', selectedCell.rowPath) || '(All)'}</Typography.Text>
                  </div>
                </div>

                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>列条件 (Column Path):</Typography.Text>
                  <div>
                    <Typography.Text strong>{mosaicData && mosaicPathLabel(mosaicData, 'col', selectedCell.colPath) || '(All)'}</Typography.Text>
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
                    <CategoryBars axisName="セル内割合 (%)" max={100} testId="mosaic-cell-distribution" items={mosaicData.target.categories.map((category, index) => ({
                      id: category, label: mosaicData.target?.valueLabels?.[category] ?? category,
                      value: selectedCell.totalCount > 0 ? (selectedCell.targetCounts[category] || 0) / selectedCell.totalCount * 100 : null,
                      color: mosaicData.target!.colors[index % mosaicData.target!.colors.length], detail: `件数: ${selectedCell.targetCounts[category] || 0}`,
                    }))} />
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
                disabled={selectedCount === 0 || !(resultKey === inputKey && selectedCell)}
                onClick={() => dispatch(focusSelected())}
              >
                Focus Selected ({selectedCount}行)
              </Button>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={selectedCount === 0 || !(resultKey === inputKey && selectedCell)}
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
              <Button
                size="small"
                disabled={selectedCount === 0}
                onClick={() => dispatch(resetWorkingSet())}
              >
                Reset to Base Data
              </Button>
            </div>
          </Card>
      </div>

        <div style={{ fontSize: 11, color: '#888', flexShrink: 0 }}>
          ※ Line Mosaic Plot: 面積ではなく整列された水平線の長さでセル度数を定量比較。ドラッグで矩形範囲選択、右クリックで Focus / Delete。
        </div>
    </div>
  )
}
