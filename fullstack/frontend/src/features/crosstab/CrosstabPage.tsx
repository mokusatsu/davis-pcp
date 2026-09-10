import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Alert, Button, Card, Col, Row, Segmented, Select, Space, Statistic, Tag, Typography, message,
} from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied } from '../../app/store'
import { api } from '../../api/client'
import SelectColumn from '../common/ColumnSelect'
import { useCodebook } from '../dataset/useCodebookColumn'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import CrosstabTable, { type CrosstabCell, type DisplayMode } from './CrosstabTable'

interface CrosstabMeta {
  datasetId: string
  dataRevision: number
  schemaRevision: number
  scope: string
  scopeHash: string
  scopeCount: number
  effectiveN: number
  missingCount: number
  weightApplied: boolean
  weightColumn: string | null
  algorithmVersion: string
  isExplorative: boolean
  warnings: { code: string; message: string }[]
}

interface CrosstabResponse {
  meta: CrosstabMeta
  rowCategories: { id: string; label: string; order: number }[]
  colCategories: { id: string; label: string; order: number }[]
  cells: CrosstabCell[]
  rowTotals: { categoryId: string; label: string; unweightedCount: number; count: number }[]
  colTotals: { categoryId: string; label: string; unweightedCount: number; count: number }[]
  grandTotal: { unweightedCount: number; count: number }
  statistics: {
    chi2: number | null
    df: number
    pValue: number | null
    cramersV: number | null
    inferenceMethod: string
    expectedLt5Count: number
    expectedLt5Ratio: number | null
    smallMarginalWarnings: { axis: string; categoryId: string; unweightedN: number }[]
  }
  warnings: { code: string; message: string }[]
  weightStatus: string
  weightMissingCount: number
  weightedN: number | null
}

function escapeFormulaPrefix(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value
}

export function crosstabToCsv(result: CrosstabResponse): string {
  const header = ['rowCategoryId', 'rowLabel', 'colCategoryId', 'colLabel', 'unweightedCount',
    'count', 'rowPct', 'colPct', 'totalPct', 'expectedCount', 'asr', 'significance', 'rowIdCount']
  const lines = [header.join(',')]
  for (const cell of result.cells) {
    const row = [cell.rowCategoryId, cell.rowLabel, cell.colCategoryId, cell.colLabel,
      cell.unweightedCount, cell.count, cell.rowPct ?? '', cell.colPct ?? '',
      cell.totalPct ?? '', cell.expectedCount, cell.asr ?? '', cell.significance, cell.rowIdCount]
    lines.push(row.map((v) => escapeFormulaPrefix(String(v))).join(','))
  }
  lines.push('')
  lines.push(`# datasetId,${result.meta.datasetId}`)
  lines.push(`# dataRevision,${result.meta.dataRevision}`)
  lines.push(`# schemaRevision,${result.meta.schemaRevision}`)
  lines.push(`# scope,${result.meta.scope}`)
  lines.push(`# scopeHash,${result.meta.scopeHash}`)
  lines.push(`# weightApplied,${result.meta.weightApplied}`)
  lines.push(`# missingPolicy,`)
  return lines.join('\n')
}

export default function CrosstabPage() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const selection = useSelector((s: RootState) => s.selection)
  const obs = useSelector((s: RootState) => s.globalObservations)
  const { columns, schemaRevision } = useCodebook()
  const [rowVariable, setRowVariable] = useState<string | null>(null)
  const [colVariable, setColVariable] = useState<string | null>(null)
  const [weightColumn, setWeightColumn] = useState<string | null>(null)
  const [scope, setScope] = useState<'all' | 'active' | 'selected' | 'sampled'>('active')
  const [missingPolicy, setMissingPolicy] = useState('exclude')
  const [mode, setMode] = useState<DisplayMode>('rowPct')
  const [result, setResult] = useState<CrosstabResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cellLoading, setCellLoading] = useState(false)
  const requestVersion = useRef(0)
  const contextRef = useRef('')
  const datasetId = selection.datasetId

  const categoricalOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal', 'binary'].includes(c.scaleType) && !c.multiResponseGroup)
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )
  const weightOptions = useMemo(
    () => columns
      .filter((c) => c.role === 'weight' && ['interval', 'ratio'].includes(c.scaleType))
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )

  const scopeIds = useMemo(() => {
    if (scope === 'all') return null
    if (scope === 'selected') return selection.selectedRowIds
    if (scope === 'sampled') return obs.sampling.sampledRowIds
    return null
  }, [scope, selection.selectedRowIds, obs.sampling.sampledRowIds])

  const inputContext = useMemo(() => JSON.stringify([
    datasetId, rowVariable, colVariable, weightColumn, scope, missingPolicy,
    selection.dataRevision, schemaRevision,
    scope === 'active' ? selection.activeRowIds : scopeIds,
    selection.selectedRowIds,
  ]), [datasetId, rowVariable, colVariable, weightColumn, scope, missingPolicy,
    selection.dataRevision, schemaRevision, selection.activeRowIds,
    selection.selectedRowIds, scopeIds])
  const runCrosstab = useCallback(async () => {
    if (!datasetId || !rowVariable || !colVariable) return
    const version = ++requestVersion.current
    const startedContext = inputContext
    contextRef.current = startedContext
    setLoading(true)
    setError(null)
    try {
      const res = await api.post<CrosstabResponse>('/summaries/crosstab', {
        context: {
          datasetId,
          expectedDataRevision: selection.dataRevision,
          expectedSchemaRevision: schemaRevision,
          scope,
          activeRowIds: scope === 'active' ? selection.activeRowIds : undefined,
          selectedRowIds: scope === 'selected' ? selection.selectedRowIds : undefined,
          sampledRowIds: scope === 'sampled' ? obs.sampling.sampledRowIds : undefined,
          weightColumn,
          missingPolicy,
        },
        rowVariableId: rowVariable,
        colVariableId: colVariable,
        includeRowIds: true,
        maxRowIdsPerCell: 10000,
        inference: 'pearson',
      })
      if (version !== requestVersion.current || startedContext !== contextRef.current) return
      setResult(res)
    } catch (err) {
      if (version !== requestVersion.current || startedContext !== contextRef.current) return
      setError(err instanceof Error ? err.message : '集計に失敗しました。')
      setResult(null)
    } finally {
      if (version === requestVersion.current && startedContext === contextRef.current) setLoading(false)
    }
  }, [datasetId, rowVariable, colVariable, weightColumn, scope, missingPolicy,
    selection.dataRevision, selection.activeRowIds, selection.selectedRowIds,
    obs.sampling.sampledRowIds, schemaRevision, scopeIds, inputContext])

  useEffect(() => {
    requestVersion.current += 1
    setResult(null)
    setError(null)
  }, [datasetId])

  const cellMap = useMemo(() => {
    const map = new Map<string, CrosstabCell>()
    for (const cell of result?.cells ?? []) map.set(`${cell.rowCategoryId}::${cell.colCategoryId}`, cell)
    return map
  }, [result])

  const handleCellClick = useCallback(async (cell: CrosstabCell, operation: 'add' | 'replace' | 'toggle') => {
    if (!datasetId || !result) return
    setCellLoading(true)
    try {
      let rowIds = cell.rowIds
      if (cell.rowIdsTruncated) {
        const full = await api.post<{ rowIds: string[] }>('/summaries/crosstab/cell-row-ids', {
          context: {
            datasetId,
            expectedDataRevision: result.meta.dataRevision,
            expectedSchemaRevision: result.meta.schemaRevision,
            scope: result.meta.scope,
            weightColumn: weightColumn ?? undefined,
            missingPolicy,
          },
          rowVariableId: rowVariable,
          colVariableId: colVariable,
          rowCategoryId: cell.rowCategoryId,
          colCategoryId: cell.colCategoryId,
        })
        rowIds = full.rowIds
      }
      dispatch(selectionApplied({
        rowIds,
        operation,
        label: `Crosstab ${cell.rowLabel} × ${cell.colLabel} (${rowIds.length}行)`,
      }))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '行IDの取得に失敗しました。')
    } finally {
      setCellLoading(false)
    }
  }, [datasetId, result, weightColumn, missingPolicy, rowVariable, colVariable, dispatch])

  const handleExport = useCallback(() => {
    if (!result) return
    const blob = new Blob([crosstabToCsv(result)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `crosstab-${result.meta.datasetId}-r${result.meta.dataRevision}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [result])

  if (!datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="crosstab-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!focused && (
        <Card
          size="small"
          title="クロス集計 (Crosstab)"
          extra={<FocusEnterButton targetId="crosstab" title="クロス集計" />}
        >
          <Space wrap align="center">
            <span>表側</span>
            <SelectColumn
              data-testid="crosstab-row-variable"
              style={{ minWidth: 220 }}
              placeholder="行変数を選択"
              value={rowVariable}
              onChange={(v) => setRowVariable(v as string)}
              options={categoricalOptions}
            />
            <span>表頭</span>
            <SelectColumn
              data-testid="crosstab-col-variable"
              style={{ minWidth: 220 }}
              placeholder="列変数を選択"
              value={colVariable}
              onChange={(v) => setColVariable(v as string)}
              options={categoricalOptions}
            />
            <Select
              data-testid="crosstab-weight"
              style={{ minWidth: 200 }}
              placeholder="ウェイトなし"
              allowClear
              value={weightColumn}
              onChange={(v) => setWeightColumn(v ?? null)}
              options={weightOptions}
            />
            <Select
              data-testid="crosstab-scope"
              style={{ minWidth: 140 }}
              value={scope}
              onChange={(v) => setScope(v)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'selected', label: 'Selected' },
                { value: 'sampled', label: 'Sampled' },
              ]}
            />
            <Select
              data-testid="crosstab-missing-policy"
              style={{ minWidth: 180 }}
              value={missingPolicy}
              onChange={(v) => setMissingPolicy(v)}
              options={[
                { value: 'exclude', label: '欠損を除外' },
                { value: 'include_missing', label: '欠損を含める' },
                { value: 'separate_not_applicable', label: '非該当を分離' },
              ]}
            />
            <Button type="primary" data-testid="crosstab-run" loading={loading} disabled={!rowVariable || !colVariable} onClick={() => void runCrosstab()}>
              集計実行
            </Button>
            <Button data-testid="crosstab-export" disabled={!result} onClick={handleExport}>CSV出力</Button>
            <Button disabled={!result} onClick={() => navigate('/pcp')}>PCPへ移動</Button>
          </Space>
          {!rowVariable || !colVariable ? (
            <Alert type="info" message="行変数と列変数を選択してください。" style={{ marginTop: 8 }} />
          ) : null}
        </Card>
      )}
      {error && <Alert type="error" message={error} />}
      {result && (
        <FocusTarget id="crosstab" title="クロス集計表">
          <Card
            size="small"
            title={
              <Space>
                <Segmented
                  data-testid="crosstab-display-mode"
                  value={mode}
                  onChange={(v) => setMode(v as DisplayMode)}
                  options={[
                    { value: 'count', label: 'Count' },
                    { value: 'rowPct', label: 'Row %' },
                    { value: 'colPct', label: 'Col %' },
                    { value: 'totalPct', label: 'Total %' },
                  ]}
                />
                <Tag>rev {result.meta.dataRevision} / scope {result.meta.scope} (n={result.meta.scopeCount})</Tag>
                {result.meta.weightApplied
                  ? <Tag color="blue">加重 (n={result.meta.effectiveN}, 非加重n={result.grandTotal.unweightedCount})</Tag>
                  : <Tag>非加重</Tag>}
              </Space>
            }
          >
            <CrosstabTable
              rows={result.rowCategories.map((c) => ({ id: c.id, label: c.label }))}
              columns={result.colCategories.map((c) => ({ id: c.id, label: c.label }))}
              cells={cellMap}
              mode={mode}
              onCellClick={(cell, op) => void handleCellClick(cell, op)}
            />
            {cellLoading && <Typography.Text type="secondary">行ID取得中…</Typography.Text>}
          </Card>
          <Card size="small" title="統計検定サマリー" style={{ marginTop: 12 }}>
            <Row gutter={[16, 8]}>
              <Col span={6}>
                <Statistic
                  title="χ²"
                  value={result.statistics.chi2 ?? '—'}
                  suffix={result.statistics.df !== null ? `df=${result.statistics.df}` : undefined}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="p値"
                  value={result.statistics.pValue === null ? '—' : result.statistics.pValue.toExponential(2)}
                />
              </Col>
              <Col span={6}>
                <Statistic title="Cramér's V" value={result.statistics.cramersV ?? '—'} />
              </Col>
              <Col span={6}>
                <Typography.Text type="secondary">推定方法: {result.statistics.inferenceMethod}</Typography.Text>
              </Col>
            </Row>
            <Space wrap style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">
                凡例: * p&lt;.05（|ASR|≥1.96） ** p&lt;.01（|ASR|≥2.58） *** p&lt;.001（|ASR|≥3.29）。赤＝過剰代表、青＝過少代表。
              </Typography.Text>
              {result.warnings.map((w) => <Alert key={w.code} type="warning" message={`${w.code}: ${w.message}`} />)}
              {result.statistics.smallMarginalWarnings.map((w) => (
                <Tag key={`${w.axis}-${w.categoryId}`} color="orange">
                  SMALL_MARGINAL_N: {w.categoryId} (n={w.unweightedN})
                </Tag>
              ))}
            </Space>
          </Card>
        </FocusTarget>
      )}
    </div>
  )
}
