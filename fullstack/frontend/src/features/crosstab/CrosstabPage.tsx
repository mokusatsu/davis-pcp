import { useAnalysisScope, AnalysisScopeSummary, captureAnalysisRunContext } from '../selection/analysisScope'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
  Alert, Button, Card, Col, Radio, Row, Segmented, Select, Space, Statistic, Tag, Typography, message,
} from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectOrdinaryVariables } from '../../app/store'
import { api } from '../../api/client'
import type { WeightType } from '../../api/client'
import SelectColumn from '../common/ColumnSelect'
import { useCodebook } from '../dataset/useCodebookColumn'
import { saveWeightConfigThunk } from '../dataset/codebookSlice'
import { useGraphExpansion } from '../common/GraphExpansion'
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

/**
 * Descriptive quantities and the test are separate blocks.
 *
 * `descriptiveAssociation` is what the table itself says; `inference` is a
 * claim about a population and may legitimately be absent (a survey weight with
 * the test switched off). Conflating the two is what let a weight multiplier
 * move a p-value while the descriptive numbers stayed put.
 */
interface CrosstabResponse {
  meta: CrosstabMeta
  rowCategories: { id: string; label: string; order: number }[]
  colCategories: { id: string; label: string; order: number }[]
  cells: CrosstabCell[]
  rowTotals: { categoryId: string; label: string; unweightedCount: number; count: number }[]
  colTotals: { categoryId: string; label: string; unweightedCount: number; count: number }[]
  grandTotal: { unweightedCount: number; count: number }
  descriptiveAssociation: {
    pearsonChi2: number | null
    pearsonChi2Status?: 'out_of_range'
    df: number
    cramersV: number | null
    weightedCramersV: number | null
    weighted: boolean
  }
  inference: {
    requested: boolean
    status: 'not_requested' | 'ok' | 'unavailable'
    method: string | null
    statisticType: string | null
    statistic: number | null
    statisticStatus?: 'finite' | 'infinite' | 'undefined' | 'out_of_range' | null
    numeratorDf: number | null
    denominatorDf: number | null
    pValue: number | null
    designAssumption: string | null
    approximate: boolean | null
  }
  weightDiagnostics: {
    weightColumnId: string | null
    weightType: WeightType | null
    unweightedN: number
    weightMissingCount: number
    weightZeroCount: number
    weightSum: number | null
    kishEffectiveN: number | null
    weightCv: number | null
    weightingDeff: number | null
    positiveWeightN: number
    numberOfPSUs: number | null
    numberOfStrata: number | null
    designDf: number | null
  } | null
  diagnostics: {
    expectedLt5Count: number
    expectedLt5Ratio: number | null
    smallMarginalWarnings: { axis: string; categoryId: string; unweightedN: number }[]
  }
  analysisProvenance: Record<string, unknown> | null
  warnings: { code: string; message: string }[]
  weightStatus: string
}

/**
 * The API layer throws a plain error object, not an `Error`, so a rejection
 * like WEIGHT_TYPE_REQUIRED would otherwise collapse into a generic message and
 * lose the one sentence that tells the user what to do.
 */
function apiErrorMessage(err: unknown, fallback: string): string {
  const { message, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof message !== 'string' || !message) return fallback
  return typeof code === 'string' && code ? `${message}（${code}）` : message
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
  // Provenance travels with the export: which weight *meaning* produced these
  // numbers is not recoverable from the numbers themselves.
  const provenance = result.analysisProvenance
  for (const [key, value] of Object.entries(provenance ?? {})) {
    lines.push(`# ${key},${value ?? ''}`)
  }
  return lines.join('\n')
}

function formatPValue(value: number | null): string {
  if (value === null) return '—'
  return value < 0.0001 ? value.toExponential(2) : value.toFixed(4)
}

function formatNumber(value: number | null, digits = 2): string {
  if (value === null) return '—'
  return value.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function inferenceTitle(inference: CrosstabResponse['inference']): string {
  if (inference.statisticType === 'F') return 'Rao–Scott 第2次補正 F'
  if (inference.statisticType === 'chi2') return 'χ²（検定）'
  if (inference.method === 'fisher_exact') return 'Fisher 正確検定 (OR)'
  return '検定統計量'
}

export default function CrosstabPage() {
  const { session } = useGraphExpansion()
  const focused = session !== null
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const selection = useSelector((s: RootState) => s.selection)
  const analysisScope = useAnalysisScope()
  const { columns, schemaRevision, weightConfig, surveyDesign } = useCodebook()
  const [rowVariable, setRowVariable] = useState<string | null>(null)
  const [colVariable, setColVariable] = useState<string | null>(null)
  const [weightColumn, setWeightColumn] = useState<string | null>(null)
  const [inference, setInference] = useState<'auto' | 'rao_scott'>('auto')
  const [missingPolicy, setMissingPolicy] = useState('exclude')
  const [mode, setMode] = useState<DisplayMode>('rowPct')
  const [result, setResult] = useState<CrosstabResponse | null>(null)
  const [resultInput, setResultInput] = useState<{
    context: Record<string, unknown>; rowVariableId: string; colVariableId: string;
    inputKey: string; label: string; count: number; dataKey: string;
  } | null>(null)
  const resultInputRef = useRef(resultInput)
  resultInputRef.current = resultInput
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cellLoading, setCellLoading] = useState(false)
  const requestVersion = useRef(0)
  const selectionSequence = useRef(0)
  const dataKeyRef = useRef('')
  const datasetId = selection.datasetId

  const globalVars = useSelector(selectOrdinaryVariables)
  // selectOrdinaryVariables derives its lists from the codebook, which the
  // crosstab tests mock without the dataset's columns — in that case there is
  // no global signal, so fall back to the unfiltered column list.
  const hasGlobalSignal = globalVars.allVariables.length > 0
  const categoricalOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal', 'binary'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || globalVars.activeVariableIds.includes(c.name)))
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns, globalVars.activeVariableIds, hasGlobalSignal],
  )
  const weightOptions = useMemo(
    () => columns
      .filter((c) => c.role === 'weight' && ['interval', 'ratio'].includes(c.scaleType))
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )
  const designOptions = useMemo(
    () => columns
      .filter((c) => !c.multiResponseGroup)
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )

  const selectedWeight = useMemo(
    () => columns.find((c) => c.name === weightColumn || c.columnId === weightColumn) ?? null,
    [columns, weightColumn],
  )
  // A weight whose meaning nobody declared cannot be used at all, so the page
  // asks once and stores the answer on the dataset.
  const declaredType = useMemo<WeightType | null>(() => {
    if (!selectedWeight || !weightConfig) return null
    return weightConfig.weightColumnId === selectedWeight.columnId ? weightConfig.weightType : null
  }, [selectedWeight, weightConfig])
  const designForWeight = useMemo(() => {
    if (!selectedWeight || !surveyDesign) return null
    return surveyDesign.weightColumnId === selectedWeight.columnId ? surveyDesign : null
  }, [selectedWeight, surveyDesign])

  const declareWeightType = useCallback(async (weightType: WeightType) => {
    if (!selectedWeight) return
    const result = await dispatch(saveWeightConfigThunk({
      weightConfig: { weightColumnId: selectedWeight.columnId, weightType },
      ...(weightType === 'survey' && !designForWeight
        ? { surveyDesign: { weightColumnId: selectedWeight.columnId } }
        : {}),
    }))
    if (saveWeightConfigThunk.rejected.match(result)) {
      message.error('ウェイトの種類を保存できませんでした。')
      return
    }
    if (weightType === 'survey') setInference('auto')
  }, [dispatch, selectedWeight, designForWeight])

  const setDesignColumn = useCallback(async (key: 'strataColumnId' | 'psuColumnId', name: string | null) => {
    if (!selectedWeight) return
    const columnId = name ? columns.find((c) => c.name === name)?.columnId ?? null : null
    const result = await dispatch(saveWeightConfigThunk({
      weightConfig: { weightColumnId: selectedWeight.columnId, weightType: 'survey' },
      surveyDesign: { ...(designForWeight ?? {}), weightColumnId: selectedWeight.columnId, [key]: columnId },
    }))
    if (saveWeightConfigThunk.rejected.match(result)) {
      message.error('調査設計を保存できませんでした。')
    }
  }, [dispatch, selectedWeight, columns, designForWeight])

  const dataKey = JSON.stringify([datasetId, selection.dataRevision, schemaRevision])
  dataKeyRef.current = dataKey
  const inputContext = JSON.stringify([datasetId, rowVariable, colVariable, weightColumn,
    analysisScope.scopeKey, missingPolicy, selection.dataRevision, schemaRevision, inference])
  const dirty = resultInput !== null && resultInput.inputKey !== inputContext
  const stale = result !== null && (result.meta.datasetId !== datasetId
    || result.meta.dataRevision !== selection.dataRevision || result.meta.schemaRevision !== schemaRevision)
  const runCrosstab = useCallback(async () => {
    if (!datasetId || !rowVariable || !colVariable || analysisScope.count === 0) return
    const version = ++requestVersion.current
    selectionSequence.current += 1
    setCellLoading(false)
    const input = {
      context: captureAnalysisRunContext({ datasetId, expectedDataRevision: selection.dataRevision,
        expectedSchemaRevision: schemaRevision, ...analysisScope.contextRows,
        weightMode: weightColumn ? 'column' : 'none', weightColumn, missingPolicy }),
      rowVariableId: rowVariable, colVariableId: colVariable,
      inputKey: inputContext, label: analysisScope.label, count: analysisScope.count, dataKey,
    }
    setLoading(true)
    setError(null)
    try {
      const res = await api.post<CrosstabResponse>('/summaries/crosstab', {
        context: input.context,
        rowVariableId: input.rowVariableId,
        colVariableId: input.colVariableId,
        includeRowIds: true,
        maxRowIdsPerCell: 10000,
        // 'auto' lets the server decide from the weight's declared meaning; a
        // survey weight silently gets no p-value rather than a wrong one.
        inference,
      })
      if (version !== requestVersion.current || input.dataKey !== dataKeyRef.current) return
      setResult(res)
      setResultInput(input)
    } catch (err) {
      if (version !== requestVersion.current || input.dataKey !== dataKeyRef.current) return
      setError(apiErrorMessage(err, '集計に失敗しました。'))
      setResult(null)
      setResultInput(null)
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [datasetId, rowVariable, colVariable, weightColumn, missingPolicy,
    selection.dataRevision, schemaRevision, analysisScope.contextRows, analysisScope.scopeKey,
    analysisScope.label, analysisScope.count, inputContext, inference, dataKey])

  // Switching the test on must actually run it — the button's whole promise is
  // that the design-based result appears, and the request now differs.
  const lastInference = useRef(inference)
  useEffect(() => {
    if (lastInference.current === inference) return
    lastInference.current = inference
    if (result && rowVariable && colVariable) void runCrosstab()
  }, [inference, result, rowVariable, colVariable, runCrosstab])

  useEffect(() => {
    requestVersion.current += 1
    selectionSequence.current += 1
    setResult(null)
    setResultInput(null)
    setLoading(false)
    setCellLoading(false)
    setError(null)
    return () => { requestVersion.current += 1; selectionSequence.current += 1; resultInputRef.current = null }
  }, [datasetId])

  useEffect(() => {
    selectionSequence.current += 1
    setCellLoading(false)
  }, [selection.dataRevision, schemaRevision])

  // An undo/revert can remove columns, and the global active variables can
  // exclude them; drop selections that no longer exist instead of letting
  // the request fail with a stale column id.
  useEffect(() => {
    const valid = new Set(categoricalOptions.map((c) => c.value))
    if (rowVariable && !valid.has(rowVariable)) setRowVariable(null)
    if (colVariable && !valid.has(colVariable)) setColVariable(null)
    const names = new Set(columns.map((c) => c.name))
    if (weightColumn && !names.has(weightColumn)) setWeightColumn(null)
  }, [categoricalOptions, columns, rowVariable, colVariable, weightColumn])

  const diagnostics = result?.weightDiagnostics ?? null
  const isSurveyWeight = diagnostics?.weightType === 'survey'

  const cellMap = useMemo(() => {
    const map = new Map<string, CrosstabCell>()
    for (const cell of result?.cells ?? []) map.set(`${cell.rowCategoryId}::${cell.colCategoryId}`, cell)
    return map
  }, [result])

  const handleCellClick = useCallback(async (cell: CrosstabCell, operation: 'add' | 'replace' | 'toggle') => {
    if (!datasetId || !result || !resultInput || loading) return
    if (stale) { message.warning('古い版の結果です。再集計してから選択してください。'); return }
    const input = resultInput
    const version = requestVersion.current
    const selectionSeq = ++selectionSequence.current
    setCellLoading(true)
    try {
      let rowIds = cell.rowIds
      if (cell.rowIdsTruncated) {
        const full = await api.post<{ rowIds: string[] }>('/summaries/crosstab/cell-row-ids', {
          context: input.context,
          rowVariableId: input.rowVariableId,
          colVariableId: input.colVariableId,
          rowCategoryId: cell.rowCategoryId,
          colCategoryId: cell.colCategoryId,
        })
        rowIds = full.rowIds
      }
      if (selectionSequence.current !== selectionSeq || version !== requestVersion.current || input !== resultInputRef.current || input.dataKey !== dataKeyRef.current) return
      dispatch(selectionApplied({
        rowIds,
        operation,
        label: `Crosstab ${cell.rowLabel} × ${cell.colLabel} (${rowIds.length}行)`,
      }))
    } catch (err) {
      if (selectionSequence.current !== selectionSeq || version !== requestVersion.current || input !== resultInputRef.current || input.dataKey !== dataKeyRef.current) return
      message.error(err instanceof Error ? err.message : '行IDの取得に失敗しました。')
    } finally {
      if (selectionSequence.current === selectionSeq) setCellLoading(false)
    }
  }, [datasetId, result, resultInput, stale, loading, dispatch])

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
              onChange={(v) => { setWeightColumn(v ?? null); setResult(null); setResultInput(null); if (!v) setInference('auto') }}
              options={weightOptions}
            />
            <AnalysisScopeSummary label="次回の集計対象" />
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
            <Button
              type="primary"
              data-testid="crosstab-run"
              loading={loading}
              // An undeclared weight cannot be used at all, so asking the server
              // only to be told so would waste the round trip.
              disabled={!rowVariable || !colVariable || analysisScope.count === 0 || Boolean(selectedWeight && !declaredType)}
              onClick={() => void runCrosstab()}
            >
              集計実行
            </Button>
            <Button data-testid="crosstab-export" disabled={!result} onClick={handleExport}>CSV出力</Button>
            <Button disabled={!result} onClick={() => navigate('/pcp')}>PCPへ移動</Button>
          </Space>
          {!rowVariable || !colVariable ? (
            <Alert type="info" message="行変数と列変数を選択してください。" style={{ marginTop: 8 }} />
          ) : null}
          {selectedWeight && !declaredType ? (
            <Alert
              type="warning"
              style={{ marginTop: 8 }}
              message="このウェイトの種類が未設定です"
              description={
                <Space direction="vertical">
                  <Typography.Text type="secondary">
                    調査ウェイトを通常の χ² 検定に使うと、ウェイトの倍率だけで p 値が変わります。先に種類を指定してください。
                  </Typography.Text>
                  <Radio.Group
                    data-testid="crosstab-weight-type"
                    value={declaredType}
                    onChange={(e) => void declareWeightType(e.target.value as WeightType)}
                  >
                    <Radio value="survey">調査ウェイト（母集団代表性の補正）</Radio>
                    <Radio value="frequency">頻度ウェイト（1行が複数件を代表する件数）</Radio>
                  </Radio.Group>
                </Space>
              }
            />
          ) : null}
          {declaredType === 'survey' ? (
            <Space wrap align="center" style={{ marginTop: 8 }}>
              <Tag color="blue">調査ウェイト</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                検定は Rao–Scott 第2次補正のみ利用可（Pearson χ² は不可）
              </Typography.Text>
              <span>層（strata）</span>
              <Select
                data-testid="crosstab-strata"
                style={{ minWidth: 180 }}
                placeholder="未指定"
                allowClear
                value={designForWeight?.strataColumnId
                  ? columns.find((c) => c.columnId === designForWeight.strataColumnId)?.name
                  : undefined}
                onChange={(v) => void setDesignColumn('strataColumnId', v ?? null)}
                options={designOptions}
              />
              <span>PSU</span>
              <Select
                data-testid="crosstab-psu"
                style={{ minWidth: 180 }}
                placeholder="未指定"
                allowClear
                value={designForWeight?.psuColumnId
                  ? columns.find((c) => c.columnId === designForWeight.psuColumnId)?.name
                  : undefined}
                onChange={(v) => void setDesignColumn('psuColumnId', v ?? null)}
                options={designOptions}
              />
              <Typography.Text type="secondary">
                未指定の場合は各回答者を独立した一次抽出単位として近似します。
              </Typography.Text>
            </Space>
          ) : null}
        </Card>
      )}
      {error && <Alert type="error" message={error} />}
      {result && (
        <>
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
                {resultInput && <Tag data-testid="crosstab-result-scope">この結果の対象: {resultInput.label} {resultInput.count}行（実行時）</Tag>}
                {dirty && <Tag color="orange">対象・設定が変更されています。結果は前回実行分です</Tag>}
                {stale && <Tag color="red">古い版の結果です。再集計してください</Tag>}
                <Tag>rev {result.meta.dataRevision} / scope {result.meta.scope} (n={result.meta.scopeCount})</Tag>
                {result.meta.weightApplied
                  ? (
                    <Tag color="blue">
                      {isSurveyWeight ? '調査ウェイト' : '頻度ウェイト'}
                      {' '}(非加重n={result.grandTotal.unweightedCount})
                    </Tag>
                  )
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
          <Card size="small" title="関連の強さと統計的検定" style={{ marginTop: 12 }}>
            {isSurveyWeight ? (
              <Space wrap style={{ marginBottom: 8 }} data-testid="crosstab-weight-diagnostics">
                <Tag>回答者数 {formatNumber(diagnostics?.unweightedN ?? result.meta.effectiveN, 0)}</Tag>
                <Tag>加重合計 {formatNumber(diagnostics?.weightSum ?? null, 1)}</Tag>
                <Tag>Kish 実効サンプル数 {formatNumber(diagnostics?.kishEffectiveN ?? null, 1)}</Tag>
                <Tag>Weighting DEFF {formatNumber(diagnostics?.weightingDeff ?? null)}</Tag>
                <Tag>Weight CV {formatNumber(diagnostics?.weightCv ?? null)}</Tag>
              </Space>
            ) : null}
            <Row gutter={[16, 8]}>
              <Col span={6}>
                <Statistic
                  title={isSurveyWeight ? '加重 χ²（記述）' : 'χ²（記述）'}
                  value={result.descriptiveAssociation.pearsonChi2Status === 'out_of_range' ? '範囲外' : formatNumber(result.descriptiveAssociation.pearsonChi2)}
                  suffix={`df=${result.descriptiveAssociation.df}`}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title={isSurveyWeight ? "加重 Cramér's V" : "Cramér's V"}
                  value={formatNumber(isSurveyWeight
                    ? result.descriptiveAssociation.weightedCramersV
                    : result.descriptiveAssociation.cramersV, 4)}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title={inferenceTitle(result.inference)}
                  value={result.inference.statistic === null
                    ? result.inference.statisticStatus === 'infinite' ? '∞' : result.inference.statisticStatus === 'out_of_range' ? '範囲外' : '—'
                    : result.inference.statistic.toFixed(4)}
                  suffix={result.inference.numeratorDf !== null
                    ? `df=${result.inference.numeratorDf.toFixed(2)}${result.inference.denominatorDf != null ? `, ${result.inference.denominatorDf.toFixed(2)}` : ''}`
                    : undefined}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="p値"
                  value={formatPValue(result.inference.pValue)}
                />
              </Col>
            </Row>
            <Space direction="vertical" style={{ marginTop: 8, width: '100%' }}>
              {isSurveyWeight && result.inference.status === 'not_requested' ? (
                <Alert
                  type="info"
                  message="調査ウェイトを使用しているため、推測統計は既定では表示していません。"
                  description={
                    <Space direction="vertical">
                      <Typography.Text type="secondary">
                        EDA では記述量を優先します。母集団についての検定が必要なときだけ実行してください。
                        通常の Pearson χ² 検定は調査ウェイトでは使用できません（ウェイトの倍率だけでp値が変わるため）。
                        検定を行う場合は下のボタンで Rao–Scott 第2次補正を指定してください。
                      </Typography.Text>
                      <Button
                        data-testid="crosstab-rao-scott"
                        size="small"
                        onClick={() => setInference('rao_scott')}
                      >
                        調査設計を考慮した検定を表示（Rao–Scott）
                      </Button>
                    </Space>
                  }
                />
              ) : null}
              {result.inference.status === 'unavailable' ? (
                <Alert
                  type="warning"
                  data-testid="crosstab-inference-unavailable"
                  message="指定した検定を実行できませんでした。"
                />
              ) : null}
              {isSurveyWeight && result.inference.status === 'ok' ? (
                <Typography.Text type="secondary" data-testid="crosstab-design-assumption">
                  {result.inference.designAssumption === 'independent_rows'
                    ? '近似条件: 各回答者を独立 PSU として扱っています。層化・クラスタ情報は反映されていません。'
                    : `調査設計: 層 ${diagnostics?.numberOfStrata ?? '—'} / PSU ${diagnostics?.numberOfPSUs ?? '—'} / 設計自由度 ${formatNumber(diagnostics?.designDf ?? null, 0)}`}
                </Typography.Text>
              ) : null}
              {isSurveyWeight ? (
                <Typography.Text type="secondary">
                  セル別の ★ は調査ウェイトでは表示しません（全体の検定結果をセルへ流用しないため）。
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">
                  凡例: * p&lt;.05（|ASR|≥1.96） ** p&lt;.01（|ASR|≥2.58） *** p&lt;.001（|ASR|≥3.29）。赤＝過剰代表、青＝過少代表。
                </Typography.Text>
              )}
              <Space wrap>
                {result.warnings.map((w) => <Alert key={w.code} type="warning" message={`${w.code}: ${w.message}`} />)}
                {result.diagnostics.smallMarginalWarnings.map((w) => (
                  <Tag key={`${w.axis}-${w.categoryId}`} color="orange">
                    SMALL_MARGINAL_N: {w.categoryId} (n={w.unweightedN})
                  </Tag>
                ))}
              </Space>
            </Space>
          </Card>
        </>
      )}
    </div>
  )
}
