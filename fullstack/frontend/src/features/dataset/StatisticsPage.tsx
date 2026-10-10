import { SELECTION_LABELS } from '../selection/selectionLabels'
import { useAnalysisScope, AnalysisScopeSummary, useAnalysisViewActive } from '../selection/analysisScope'
import { pointRadius } from '../charts/markerStyle'
import EChartSurface from '../charts/EChartSurface'
import { selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import { useQuestionText } from '../common/ColumnQuestionTooltip'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { l1Index, useL1ColorDomains } from '../../theme/useL1ColorDomain'
import L1Legend from '../common/L1Legend'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Col, Dropdown, Empty, Pagination, Row, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { BarChartOutlined, CheckCircleOutlined, FilterOutlined, TableOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, selectEffectiveRowIds } from '../../app/store'
import { useRowColorResolver } from '../../theme/useRowColor'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { graphEngine } from '../../engine/graphClient'
import { vizTheme, l1Color, signedNoiseViz } from '../../theme/viz'
import { getBrushOp } from '../selection/SelectionMenu'
import GraphPanel from '../common/GraphPanel'
import { useGraphExpansion } from '../common/GraphExpansion'
import { getSvgPoint } from '../../utils/svgCoordinates'
import { normalizeCode, useCodebook } from './useCodebookColumn'
import { QuestionCard, type QuestionSummaryData, type WeightedSummary, type WeightMeta } from '../distribution/QuestionCard'
import { api } from '../../api/client'
import MultiResponseStatistics from './MultiResponseStatistics'

interface StatsRow {
  key: string
  column: string
  type: string
  count: number
  missing: number
  mean?: string
  std?: string
  min?: string
  q1?: string
  median?: string
  q3?: string
  max?: string
  mode?: string
  unique?: string
}

type ColumnSummary = Pick<QuestionSummaryData, 'denominators' | 'distribution' | 'weighted'>

interface StatisticsSummaryResponse {
  datasetId: string
  dataRevision: number
  schemaRevision: number
  weightStatus: WeightMeta['status']
  warnings?: WeightedSummary['warnings']
  columns: Record<string, ColumnSummary>
}

interface NumericWeightRow {
  key: string
  column: string
  valid?: number
  weighted?: WeightedSummary | null
}

const finiteValue = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value)
const weightMass = (weighted: WeightedSummary | null | undefined) => weighted?.weightedNStatus === 'out_of_range'
  ? '範囲外' : finiteValue(weighted?.weightedN) ? weighted!.weightedN!.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : '—'
const weightedMean = (weighted: WeightedSummary | null | undefined) => {
  if (!weighted) return '—（加重データを取得できません）'
  if (finiteValue(weighted.weightedMean)) return weighted.weightedMean!.toFixed(3)
  return weighted.weightedN === 0 ? '—（この変数の有効回答に正のウェイトがありません）' : '—（加重平均を取得できません）'
}

function CategoricalWeightTable({ name, label, summary }: { name: string; label?: string; summary?: ColumnSummary }) {
  const denominators = summary?.denominators
  const distribution = summary?.distribution
  const weighted = summary?.weighted
  const weightedByCode = new Map((weighted?.distribution ?? []).map(item => [normalizeCode(item.code), item]))
  const unavailable = '—（取得できません）'
  const count = (value: number | undefined) => finiteValue(value) ? value : unavailable
  return <Card size="small" title={label && label !== name ? `${name} — ${label}` : name}
    data-testid={`statistics-category-weight-${name}`}>
    {!denominators || !distribution ? <Typography.Text>この変数の集計データを取得できません。</Typography.Text> : <>
      <Space wrap data-testid={`statistics-category-denominators-${name}`}>
        <span>全対象 n: {count(denominators.total)}</span><span>設問対象 n: {count(denominators.target)}</span>
        <span>有効回答 n: {count(denominators.valid)}</span><span>無回答 n: {count(denominators.missing)}</span>
        <span>非該当 n: {count(denominators.notApplicable)}</span><span>無効 n: {count(denominators.invalid === undefined ? 0 : denominators.invalid)}</span>
      </Space>
      <Typography.Paragraph>
        有効回答の加重対象 Σw: {weightMass(weighted)} ／ 有効回答内のウェイト欠損: {finiteValue(weighted?.weightMissingCount) ? weighted!.weightMissingCount : '—'}
      </Typography.Paragraph>
      {!weighted && <Typography.Paragraph>この変数の加重データを取得できません。</Typography.Paragraph>}
      {weighted?.weightedN === 0 && <Typography.Paragraph>この変数の有効回答に正のウェイトがありません。加重割合は利用できません。</Typography.Paragraph>}
      <Table size="small" pagination={false} dataSource={distribution}
        rowKey={item => JSON.stringify([normalizeCode(item.code), !!item.isMissing, !!item.isInvalid])} columns={[
        { title: 'コード・ラベル', key: 'category', render: (_, item) => <Space wrap>
          <span>{item.code === null ? '空欄' : String(item.code)}{item.label && item.label !== String(item.code) ? ` — ${item.label}` : ''}</span>
          {item.isInvalid ? <Tag>無効</Tag> : item.isMissing ? <Tag>{item.missingReason === 'not_applicable' ? '非該当'
            : item.missingReason === 'missing' ? '無回答' : item.missingReason || '無回答'}</Tag> : null}
        </Space> },
        { title: '非加重 n', dataIndex: 'count', key: 'count', render: value => finiteValue(value) ? value : unavailable },
        { title: '加重度数 Σw', key: 'weightedCount', render: (_, item) => {
          if (item.isMissing || item.isInvalid) return '対象外'
          const entry = weightedByCode.get(normalizeCode(item.code))
          return entry?.weightedCountStatus === 'out_of_range' ? '範囲外'
            : finiteValue(entry?.weightedCount) ? entry!.weightedCount!.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : unavailable
        } },
        { title: '加重割合（有効回答ベース）', key: 'weightedPct', render: (_, item) => {
          if (item.isMissing || item.isInvalid) return '対象外'
          if (weighted?.weightedN === 0) return '—（正のウェイトなし）'
          const entry = weightedByCode.get(normalizeCode(item.code))
          return finiteValue(entry?.weightedPct) ? `${entry!.weightedPct!.toFixed(1)}%` : unavailable
        } },
      ]} scroll={{ x: 'max-content' }} />
    </>}
    {weighted?.warnings?.map(warning => <Typography.Paragraph type="warning" key={warning.code}>{warning.message}</Typography.Paragraph>)}
  </Card>
}

/** Descriptive statistics page: per-axis summary table + histogram per axis. */
export default function StatisticsPage() {
  const questionText = useQuestionText()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const pcpColorBy = useSelector((s: RootState) => s.pcp.colorBy)
  const globalVars = useSelector(selectOrdinaryVariables)
  const entities = useSelector(selectVariableEntities)
  const maCount = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key)).length
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  // The shared selector recreates this array on weight changes. Keep ordinary
  // membership stable locally so a header toggle cannot clear/recompute raw stats.
  const ordinaryNamesKey = JSON.stringify(globalVars.activeVariableIds)
  const ordinaryNames = useMemo<string[]>(() => JSON.parse(ordinaryNamesKey), [ordinaryNamesKey])
  const data = useColumnarData(selection.datasetId, [...ordinaryNames, ...(pcpColorBy ? [pcpColorBy] : [])])
  const { columns: codebookColumns, schemaRevision, isLoading: isCodebookLoading,
    getColumn, formatValueLabel, getOrderedCategories } = useCodebook()
  const codebookDatasetId = useSelector((s: RootState) => s.codebook.datasetId)
  const weightColumnId = useSelector((s: RootState) => s.globalVariables.weightColumnId)
  const weightColumn = codebookColumns.find(column => column.columnId === weightColumnId)?.name
  const codebookReady = codebookDatasetId === selection.datasetId && !isCodebookLoading
  const theme = vizTheme(false)
  const { getColor } = useRowColorResolver()
  const { openWhenAvailable, session } = useGraphExpansion()

  const contextMenuItems = [
    {
      key: 'focus',
      label: SELECTION_LABELS.focus,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: SELECTION_LABELS.exclude,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: SELECTION_LABELS.clear,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      key: 'reset',
      label: SELECTION_LABELS.reset,
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]
  // Range brush over a histogram (AGENTS.md R3): drag horizontally to select
  // the value interval under the band. dragRef mirrors state for fresh reads.
  const [histDrag, setHistDrag] = useState<{ column: string; x1: number; x2: number } | null>(null)
  /** Last bin clicked per column (column → bin index) for exact self-highlight. */
  const [clickedBin, setClickedBin] = useState<{ column: string; bin: number } | null>(null)
  const [expandedColumn, setExpandedColumn] = useState<string | null>(null)
  const expandedHistogramWasActive = useRef(false)
  const histDragRef = useRef<{ column: string; x1: number; x2: number } | null>(null)
  const histSvgRefs = useRef(new Map<string, SVGSVGElement>())

  const analysisScope = useAnalysisScope()
  const viewActive = useAnalysisViewActive()
  const expandedHistogramGraphId = expandedColumn ? `statistics/histogram/${expandedColumn}` : null

  useEffect(() => {
    if (!expandedHistogramGraphId) {
      expandedHistogramWasActive.current = false
      return
    }
    if (session?.graphId === expandedHistogramGraphId) {
      expandedHistogramWasActive.current = true
      return
    }
    if (expandedHistogramWasActive.current) {
      expandedHistogramWasActive.current = false
      setExpandedColumn(null)
    }
  }, [expandedHistogramGraphId, session?.graphId])

  const openHistogramExpansion = (column: string) => {
    const graphId = `statistics/histogram/${column}`
    expandedHistogramWasActive.current = false
    setExpandedColumn(column)
    openWhenAvailable(graphId)
  }

  /** Scope-filtered row indexes (active or selected), shared by stats + histograms. */
  const scopedIndexes = useMemo(() => {
    if (!data) return []
    const effectiveSet = new Set(effectiveRowIds)
    const out: number[] = []
    for (let i = 0; i < data.rowIds.length; i += 1) {
      if (effectiveSet.has(data.rowIds[i])) out.push(i)
    }
    return out
  }, [data, effectiveRowIds])

  const targetSchema = useMemo(() => {
    if (!data) return []
    const activeVarSet = new Set(ordinaryNames)
    return data.schema.filter((c) => activeVarSet.has(c.name))
  }, [data, ordinaryNames])

  const columnValues = useMemo(() => Object.fromEntries(targetSchema.map(column => {
    const spec = getColumn(column.name)
    const missing = new Set(spec?.missingCodes ?? [])
    const numeric = spec ? ['interval', 'ratio'].includes(spec.scaleType) : column.semanticType === 'numeric'
    const values = (data?.columns[column.name] ?? []).map(raw => {
      const code = normalizeCode(raw)
      return code === null || missing.has(code) || (numeric && (code.trim() === '' || !Number.isFinite(Number(code)))) ? null : code
    })
    return [column.name, { numeric, values, numbers: numeric ? Float64Array.from(values, v => v === null ? NaN : Number(v)) : new Float64Array(0) }]
  })), [data, targetSchema, getColumn])

  const [statsAttempt, setStatsAttempt] = useState(0)
  // Bind every displayed value to the exact current input, including revisions,
  // codebook missing rules and column data. The render guard hides old values
  // immediately, before the next effect starts its replacement request.
  const statsInput = useMemo(() => ({ scopeKey: analysisScope.scopeKey, data, scopedIndexes, targetSchema, columnValues, getColumn, formatValueLabel, statsAttempt }),
    [analysisScope.scopeKey, data, scopedIndexes, targetSchema, columnValues, getColumn, formatValueLabel, statsAttempt])
  const [statsResult, setStatsResult] = useState<{ input: typeof statsInput; rows: StatsRow[]; error: string | null; pending: boolean } | null>(null)
  const currentStats = statsResult?.input === statsInput ? statsResult : null
  const stats = currentStats?.rows ?? []
  const statsError = currentStats?.error ?? null
  const loadingStats = viewActive && !!data && scopedIndexes.length > 0 && (!currentStats || currentStats.pending)
  useEffect(() => {
    if (!viewActive) return
    if (!data || !scopedIndexes.length) return
    let cancelled = false
    setStatsResult({ input: statsInput, rows: [], error: null, pending: true })
    ;(async () => {
      try {
        const f = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(3))
        const rows: StatsRow[] = []
        for (const column of targetSchema) {
          const spec = getColumn(column.name)
          const scaleNames: Record<string, string> = { nominal: '名義尺度', ordinal: '順序尺度', interval: '間隔尺度', ratio: '比例尺度', text: 'テキスト', id: '識別子' }
          const type = spec ? scaleNames[spec.scaleType] : (column.semanticType === 'numeric' ? '数値' : 'カテゴリ')
          if (columnValues[column.name].numeric) {
            const arr = columnValues[column.name].numbers
            const scoped = new Float64Array(scopedIndexes.length)
            for (let i = 0; i < scopedIndexes.length; i += 1) scoped[i] = arr[scopedIndexes[i]]
            // unique over finite values (host-side; hashing is cheap vs sorting)
            const unique = new Set<number>()
            let missing = 0
            for (let i = 0; i < scoped.length; i += 1) {
              const v = scoped[i]
              if (Number.isFinite(v)) unique.add(v)
              else missing += 1
            }
            const d = await graphEngine.describeNumeric(scoped)
            if (cancelled) return
            rows.push({
              key: column.name,
              column: column.name,
              type,
              count: d ? d[0] : 0,
              missing: d ? d[1] : missing,
              mean: d ? f(d[2]) : '—',
              std: d ? f(d[3]) : '—',
              min: d ? f(d[4]) : '—',
              q1: d ? f(d[5]) : '—',
              median: d ? f(d[6]) : '—',
              q3: d ? f(d[7]) : '—',
              max: d ? f(d[8]) : '—',
              unique: String(unique.size),
            })
          } else {
            const values = columnValues[column.name].values
            const strings = scopedIndexes.map((i) => values[i]).filter((v): v is string => v !== null && v !== undefined)
            const counts = new Map<string, number>()
            for (const v of strings) counts.set(v, (counts.get(v) ?? 0) + 1)
            const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
            rows.push({
              key: column.name,
              column: column.name,
              type,
              count: strings.length,
              missing: scopedIndexes.length - strings.length,
              mode: top ? `${formatValueLabel(column.name, top[0])} (${top[1]})` : '—',
              unique: String(counts.size),
            })
          }
        }
        if (!cancelled) setStatsResult({ input: statsInput, rows, error: null, pending: false })
      } catch (error) {
        if (!cancelled) setStatsResult({ input: statsInput, rows: [], pending: false,
          error: error instanceof Error && error.message ? error.message : '原因を確認できませんでした' })
      }
    })()
    return () => { cancelled = true }
  }, [viewActive, statsInput, data, scopedIndexes, targetSchema, columnValues, getColumn, formatValueLabel])

  const numericColumns = useMemo(
    () => targetSchema.filter((c) => columnValues[c.name].numeric).map((c) => c.name),
    [targetSchema, columnValues],
  )
  const categoricalColumns = useMemo(
    () => targetSchema.filter((c) => {
      const spec = getColumn(c.name)
      return spec ? ['nominal', 'ordinal'].includes(spec.scaleType) : !columnValues[c.name].numeric
    }).map((c) => c.name),
    [targetSchema, columnValues, getColumn],
  )
  const summaryColumns = useMemo(() => {
    const eligible = new Set([...numericColumns, ...categoricalColumns])
    return targetSchema.filter(column => eligible.has(column.name)).map(column => column.name)
  }, [targetSchema, numericColumns, categoricalColumns])
  const [weightAttempt, setWeightAttempt] = useState(0)
  // Independent ownership: weight changes replace only the weighted companions.
  // Codebook definitions and unresolved weight IDs are part of this identity too.
  const weightInput = useMemo(() => ({
    scopeKey: analysisScope.scopeKey, datasetId: selection.datasetId,
    dataRevision: selection.dataRevision, schemaRevision, rowIds: [...effectiveRowIds],
    columns: summaryColumns, codebookColumns, codebookReady, weightColumnId,
    weightColumn, weightMode: weightColumnId ? 'column' as const : 'none' as const,
    weightAttempt, viewActive,
  }), [analysisScope.scopeKey, selection.datasetId, selection.dataRevision, schemaRevision,
    effectiveRowIds, summaryColumns, codebookColumns, codebookReady, weightColumnId, weightColumn, weightAttempt, viewActive])
  const [weightResult, setWeightResult] = useState<{
    input: typeof weightInput; value: StatisticsSummaryResponse | null; error: string | null; pending: boolean
  } | null>(null)
  const hasNumericScope = effectiveRowIds.length > 0 && numericColumns.length > 0
  const hasSummaryScope = effectiveRowIds.length > 0 && summaryColumns.length > 0
  const currentWeight = viewActive && hasSummaryScope && weightResult?.input === weightInput ? weightResult : null
  const weightResponse = currentWeight?.value
  const unresolvedWeight = !!weightColumnId && !weightColumn
  useEffect(() => {
    if (!viewActive || !weightInput.datasetId || !hasSummaryScope || !codebookReady || unresolvedWeight) return
    let cancelled = false
    setWeightResult({ input: weightInput, value: null, error: null, pending: true })
    void api.post<StatisticsSummaryResponse>('/summaries', {
      datasetId: weightInput.datasetId, rowIds: weightInput.rowIds, columns: weightInput.columns,
      expectedDataRevision: weightInput.dataRevision, expectedSchemaRevision: weightInput.schemaRevision,
      weightMode: weightInput.weightMode,
      ...(weightInput.weightMode === 'column' ? { weightColumn: weightInput.weightColumn } : {}),
    }).then(value => {
      if (cancelled) return
      if (value.datasetId !== weightInput.datasetId || value.dataRevision !== weightInput.dataRevision
        || value.schemaRevision !== weightInput.schemaRevision) throw new Error('現在のデータと集計結果の版が一致しません')
      setWeightResult({ input: weightInput, value, error: null, pending: false })
    }).catch(error => {
      if (!cancelled) setWeightResult({ input: weightInput, value: null, pending: false,
        error: typeof error?.message === 'string' && error.message.trim() ? error.message : '原因を確認できませんでした' })
    })
    return () => { cancelled = true }
  }, [viewActive, weightInput, hasSummaryScope, codebookReady, unresolvedWeight])
  const weightRows: NumericWeightRow[] = weightResponse && weightColumnId && weightResponse.weightStatus !== 'omitted'
    ? numericColumns.map(column => ({ key: column, column,
      valid: weightResponse.columns[column]?.denominators?.valid, weighted: weightResponse.columns[column]?.weighted })) : []
  const weightWarnings = [...new Set([...(weightResponse?.warnings ?? []),
    ...weightRows.flatMap(row => row.weighted?.warnings ?? [])].map(warning => warning.message))]
  // Column-group pagination: render one slice of cards + histograms at a
  // time so hundreds of columns never mount simultaneously (max-depth guard).
  const PAGE_SIZE = 12
  const [columnPage, setColumnPage] = useState(1)
  useEffect(() => { setColumnPage(1) }, [selection.datasetId, analysisScope.scopeKey])
  const pageCount = Math.max(1, Math.ceil(targetSchema.length / PAGE_SIZE))
  const currentColumnPage = Math.min(columnPage, pageCount)
  const visibleColumnNames = useMemo(
    () => new Set(targetSchema.slice((currentColumnPage - 1) * PAGE_SIZE, currentColumnPage * PAGE_SIZE).map((c) => c.name)),
    [targetSchema, currentColumnPage],
  )
  const visibleCategoricalColumns = useMemo(
    () => categoricalColumns.filter((name) => visibleColumnNames.has(name)),
    [categoricalColumns, visibleColumnNames],
  )
  const visibleNumericColumns = useMemo(
    () => numericColumns.filter((name) => visibleColumnNames.has(name)),
    [numericColumns, visibleColumnNames],
  )

  const selectedSet = new Set(selection.selectedRowIds)
  const domains = useL1ColorDomains(data)
  const domain = domains.find(d => d.key === pcpColorBy)
  const categoriesOf = domain ? [...domain.codes, null] : null

  // Histogram layout.
  useEffect(() => {
    histDragRef.current = null
    setHistDrag(null)
    setClickedBin(null)
  }, [data, scopedIndexes, columnValues, currentColumnPage])

  const binsCount = 20
  const histWidth = 560
  const histHeight = 300

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="statistics-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top Toolbar Card */}
        <Card size="small" style={{ background: '#fafafa' }}>
          <Row gutter={[12, 8]} align="middle" justify="space-between">
            <Col>
              <Space wrap align="center">
                <AnalysisScopeSummary />
              </Space>
            </Col>
            <Col>
              <Space size={6}>
                <Tag style={{ margin: 0 }}>{analysisScope.label} {analysisScope.count}行を集計</Tag>
                {pcpColorBy && (
                  <Tag color="purple" style={{ margin: 0 }}>
                    色分け: <ColumnQuestionTooltip nameOrId={pcpColorBy!}>{pcpColorBy}</ColumnQuestionTooltip>
                  </Tag>
                )}
              </Space>
            </Col>
          </Row>
        </Card>

      {/* Summary KPI Cards */}
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="集計対象の変数"
                value={targetSchema.length + maCount}
                prefix={<TableOutlined />}
                suffix={`項目 (通常 ${targetSchema.length}・MA ${maCount})`}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="集計対象データ"
                value={scopedIndexes.length}
                prefix={<CheckCircleOutlined />}
                suffix={`/ ${data?.rowIds.length ?? 0} 行`}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="集計スコープ"
                value={analysisScope.label}
                prefix={<FilterOutlined />}
                valueStyle={{ fontSize: 15 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="可視化ヒストグラム"
                value={numericColumns.length}
                prefix={<BarChartOutlined />}
                suffix="グラフ"
              />
            </Card>
          </Col>
        </Row>

      <L1Legend />
      <MultiResponseStatistics rowIds={effectiveRowIds} />
      {statsError && <Alert type="error" showIcon message="記述統計量の集計に失敗しました"
        description={`現在の対象の統計量は表示していません。再試行してください。詳細: ${statsError}`}
        action={<Button onClick={() => setStatsAttempt(attempt => attempt + 1)}>再試行</Button>} />}
      {loadingStats && (
        <Card size="small" style={{ textAlign: 'center', padding: '30px 20px', background: '#fafafa', borderRadius: 8 }}>
          <Space role="status" aria-live="polite"><Spin size="large" /><Typography.Text>記述統計量を集計中...</Typography.Text></Space>
        </Card>
      )}

      {effectiveRowIds.length === 0 ? (
        <Empty
          data-testid="stats-empty-selected"
          style={{ marginTop: 40 }}
          description="共通対象が0行です。上部の対象設定または行選択をご確認ください。"
        />
      ) : (
        <>
          {targetSchema.length > PAGE_SIZE && (
            <Card size="small" style={{ background: '#fafafa' }}>
              <Space wrap align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  表示列 {targetSchema.length}列中 {(currentColumnPage - 1) * PAGE_SIZE + 1}–{Math.min(currentColumnPage * PAGE_SIZE, targetSchema.length)}列目
                </Typography.Text>
                <Pagination data-testid="stats-column-page" size="small" current={currentColumnPage} pageSize={PAGE_SIZE} total={targetSchema.length} showSizeChanger={false} onChange={setColumnPage} />
              </Space>
            </Card>
          )}
          <Card
              data-testid="statistics-raw-summary"
              size="small"
              title={<span style={{ fontSize: 13, fontWeight: 600 }}>記述統計量サマリー（非加重・{analysisScope.label}）</span>}
              style={{ boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.03)' }}
            >
              <Table<StatsRow>
                size="small"
                pagination={false}
                loading={loadingStats}
                dataSource={stats}
                columns={[
                  { title: '列', dataIndex: 'column', key: 'column', fixed: 'left' },
                  { title: '型', dataIndex: 'type', key: 'type', width: 70 },
                  { title: 'count', dataIndex: 'count', key: 'count', width: 70 },
                  { title: 'missing', dataIndex: 'missing', key: 'missing', width: 70 },
                  { title: 'mean', dataIndex: 'mean', key: 'mean', width: 80, render: (v) => v ?? '—' },
                  { title: 'std', dataIndex: 'std', key: 'std', width: 80, render: (v) => v ?? '—' },
                  { title: 'min', dataIndex: 'min', key: 'min', width: 80, render: (v) => v ?? '—' },
                  { title: 'q1', dataIndex: 'q1', key: 'q1', width: 80, render: (v) => v ?? '—' },
                  { title: 'median', dataIndex: 'median', key: 'median', width: 80, render: (v) => v ?? '—' },
                  { title: 'q3', dataIndex: 'q3', key: 'q3', width: 80, render: (v) => v ?? '—' },
                  { title: 'max', dataIndex: 'max', key: 'max', width: 80, render: (v) => v ?? '—' },
                  { title: '最頻値', dataIndex: 'mode', key: 'mode', render: (v) => v ?? '—' },
                  { title: 'unique', dataIndex: 'unique', key: 'unique', width: 70 },
                ]}
                scroll={{ x: 'max-content' }}
              />
            </Card>

          <Typography.Text type="secondary" data-testid="statistics-raw-basis">
            記述統計量とヒストグラムは非加重の観測値です。欠損コードを除外し、定義域による除外・逆転得点化は行いません。
            カテゴリカードも非加重です。標準偏差・分位点・ヒストグラムへのウェイト適用はありません。
            コードブック基準の加重カテゴリ集計は、非加重カテゴリカードの下に別枠で表示します。
          </Typography.Text>
          {hasNumericScope && viewActive && <Card size="small" title="数値変数の加重集計" data-testid="statistics-weight-companion">
            {!codebookReady ? <Typography.Text role="status">現在のコードブックを読み込み中...</Typography.Text>
              : unresolvedWeight ? <Alert type="warning" showIcon message="選択したウェイト列を確認できません"
                description="上部のウェイト選択を確認してください。数値加重集計は表示していません。" />
              : currentWeight?.error ? <Alert type="error" showIcon message="数値加重集計に失敗しました"
                description={`非加重の統計量は引き続き利用できます。詳細: ${currentWeight.error}`}
                action={<Button onClick={() => setWeightAttempt(attempt => attempt + 1)}>加重集計を再試行</Button>} />
              : !currentWeight || currentWeight.pending ? <Space role="status"><Spin size="small" />数値加重集計を確認中...</Space>
              : <>
                <Typography.Paragraph data-testid="statistics-weight-status">
                  {!weightColumnId ? '数値加重集計: ウェイト未選択（非加重）'
                    : weightResponse?.weightStatus === 'applied' ? `数値加重集計: ウェイト適用中（${weightColumn}）`
                    : weightResponse?.weightStatus === 'no_positive_weight' ? `数値加重集計: 正のウェイトがありません（${weightColumn}）`
                    : '数値加重集計: ウェイトが適用されていません。加重値は利用できません。'}
                </Typography.Paragraph>
                {weightRows.length > 0 && <>
                  <Table<NumericWeightRow> size="small" pagination={false} dataSource={weightRows} columns={[
                    { title: '列', dataIndex: 'column', key: 'column' },
                    { title: '加重平均', key: 'weightedMean', render: (_, row) => weightedMean(row.weighted) },
                    { title: '有効回答 n', dataIndex: 'valid', key: 'valid', render: value => finiteValue(value) ? value : '—' },
                    { title: '加重対象 Σw', key: 'weightedN', render: (_, row) => weightMass(row.weighted) },
                    { title: '有効回答内のウェイト欠損', key: 'weightMissingCount', render: (_, row) => finiteValue(row.weighted?.weightMissingCount) ? row.weighted!.weightMissingCount : '—' },
                    { title: '集計基準', key: 'basis', render: (_, row) => {
                      const spec = getColumn(row.column)
                      return `${spec?.categoryOrder.length ? '定義域外を除外' : '有効回答'}${spec?.isReversed ? '・逆転得点化' : ''}`
                    } },
                  ]} scroll={{ x: 'max-content' }} />
                  <Typography.Paragraph type="secondary">
                    有効回答 n はゼロ・欠損ウェイトの回答を含みます。加重対象 Σw は変数ごとの有効回答の正のウェイト合計で、人数ではありません。
                    加重平均はコードブックの定義域・逆転得点化を適用します。非加重の観測値とは集計基準が異なる場合があります。
                  </Typography.Paragraph>
                  <Typography.Paragraph type="secondary">標準誤差は非加重n基準。母集団推論には調査設計情報が必要。</Typography.Paragraph>
                </>}
                {weightWarnings.map(warning => <Typography.Paragraph type="warning" key={warning}>{warning}</Typography.Paragraph>)}
              </>}
          </Card>}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {visibleCategoricalColumns.map((name) => targetSchema.find((c) => c.name === name)!).filter(Boolean).map(column => {
              const values = columnValues[column.name].values
              const counts = new Map<string, number>()
              const selectedCounts: Record<string, number> = Object.create(null)
              for (const index of scopedIndexes) {
                const code = values[index]
                if (code === null || code === undefined) continue
                counts.set(code, (counts.get(code) ?? 0) + 1)
                if (selectedSet.has(data!.rowIds[index])) selectedCounts[code] = (selectedCounts[code] ?? 0) + 1
              }
              const valid = [...counts.values()].reduce((a, b) => a + b, 0)
              return <div key={column.name} style={{ flex: '1 1 420px', minWidth: 0, maxWidth: '100%' }}>
                <QuestionCard codebookColumn={getColumn(column.name)} summary={{
                  columnId: column.name,
                  denominators: { total: scopedIndexes.length, target: scopedIndexes.length, valid, missing: scopedIndexes.length - valid, notApplicable: 0 },
                  distribution: getOrderedCategories(column.name, [...counts.keys()]).map(code => ({ code, label: formatValueLabel(column.name, code), count: counts.get(code) ?? 0, percentageValid: valid ? (counts.get(code) ?? 0) / valid * 100 : 0, percentageTotal: scopedIndexes.length ? (counts.get(code) ?? 0) / scopedIndexes.length * 100 : 0 })),
                }} selectedCountByCode={selectedCounts} onSelectCategory={(code) => {
                  const ids = scopedIndexes.filter(i => values[i] === normalizeCode(code)).map(i => data!.rowIds[i])
                  dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: `カテゴリ選択（${column.name}）` }))
                }} />
              </div>
            })}
          </div>
          {visibleCategoricalColumns.length > 0 && viewActive && <Card size="small" title="コードブック基準の加重カテゴリ集計"
            data-testid="statistics-categorical-weight-companion">
            <Typography.Paragraph type="secondary">
              コードブックの非該当・欠損・定義域に基づく集計です。上の非加重カテゴリカードとは有効回答の範囲が異なる場合があります。
            </Typography.Paragraph>
            {!codebookReady ? <Typography.Text role="status">現在のコードブックを読み込み中...</Typography.Text>
              : unresolvedWeight ? <Alert type="warning" showIcon message="選択したウェイト列を確認できません"
                description="上部のウェイト選択を確認してください。カテゴリ加重集計は表示していません。" />
              : currentWeight?.error ? <Alert type="error" showIcon message="カテゴリ加重集計に失敗しました"
                description={`非加重の統計量は引き続き利用できます。詳細: ${currentWeight.error}`}
                action={<Button onClick={() => setWeightAttempt(attempt => attempt + 1)}>加重集計を再試行</Button>} />
              : !currentWeight || currentWeight.pending ? <Space role="status"><Spin size="small" />カテゴリ加重集計を確認中...</Space>
              : <>
                <Typography.Paragraph data-testid="statistics-categorical-weight-status">
                  {!weightColumnId ? 'カテゴリ加重集計: ウェイト未選択（非加重）'
                    : weightResponse?.weightStatus === 'applied' ? `カテゴリ加重集計: ウェイト適用中（${weightColumn}）`
                    : weightResponse?.weightStatus === 'no_positive_weight' ? `カテゴリ加重集計: 正のウェイトがありません（${weightColumn}）`
                    : 'カテゴリ加重集計: ウェイトが適用されていません。加重値は利用できません。'}
                </Typography.Paragraph>
                {weightColumnId && weightResponse && weightResponse.weightStatus !== 'omitted' &&
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    {visibleCategoricalColumns.map(name => <CategoricalWeightTable key={name} name={name}
                      label={getColumn(name)?.label} summary={weightResponse.columns[name]} />)}
                  </Space>}
                {weightResponse?.warnings?.map(warning => <Typography.Paragraph type="warning" key={warning.code}>{warning.message}</Typography.Paragraph>)}
              </>}
            <Typography.Paragraph type="secondary">
              加重割合は、この変数の有効回答のうち正のウェイトを持つ回答のΣwを分母にします。非加重nにはゼロ・欠損ウェイトの有効回答も含みます。Σwは人数ではありません。
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary">非加重カテゴリカードの分母切替は、この加重割合を変更しません。</Typography.Paragraph>
            <Typography.Paragraph type="secondary">標準誤差は非加重n基準。母集団推論には調査設計情報が必要。</Typography.Paragraph>
          </Card>}
          {(() => {
            const renderHistCard = (column: string) => {
              const rows = scopedIndexes
                .map((index) => ({ id: data!.rowIds[index], index, v: columnValues[column].numbers[index] ?? NaN }))
                .filter(({ v }) => Number.isFinite(v))
              if (!rows.length) return null
              const min = Math.min(...rows.map((r) => r.v))
              const max = Math.max(...rows.map((r) => r.v))
              const binEdges = Array.from({ length: binsCount + 1 }, (_, i) => min + ((max - min) / binsCount) * i)
              const groupBins = categoriesOf
                ? categoriesOf.map(() => new Array(binsCount).fill(0))
                : [new Array(binsCount).fill(0)]
              for (const row of rows) {
                let bin = Math.floor(((row.v - min) / (max - min || 1)) * binsCount)
                bin = Math.min(binsCount - 1, bin)
                if (categoriesOf && pcpColorBy && data!.columns[pcpColorBy]) {
                  const ci = l1Index(domain, data!.columns[pcpColorBy][row.index]) ?? domain!.codes.length
                  if (ci >= 0) groupBins[ci][bin] += 1
                } else {
                  groupBins[0][bin] += 1
                }
              }
              const maxCount = Math.max(...groupBins.flat(), 1)
              const barW = (histWidth - 30) / binsCount
              const selectedRows = rows.filter(({ id }) => selectedSet.has(id))
              const selectedBinFlags = new Array<boolean>(binsCount).fill(false)
              for (const { v } of selectedRows) {
                let bin = Math.floor(((v - min) / (max - min || 1)) * binsCount)
                bin = Math.min(binsCount - 1, Math.max(0, bin))
                selectedBinFlags[bin] = true
              }
              const isBinHighlighted = (bi: number) =>
                (clickedBin?.column === column && clickedBin?.bin === bi)
                || selectedBinFlags[bi]
              const selectBinRange = (bin: number) => {
                const lo = binEdges[bin]
                const hi = binEdges[bin + 1]
                const ids = rows
                  .filter(({ v }) => bin === binsCount - 1 ? v >= lo && v <= hi : v >= lo && v < hi)
                  .map(({ id }) => id)
                dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: `ヒストグラム選択（${column}）` }))
                setClickedBin({ column, bin })
              }
              const histOnPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
                if (event.button !== 0) return
                const target = event.target as Element
                if (target.closest('circle, rect[data-selectable], g[data-selectable]')) {
                  return
                }
                const svg = event.currentTarget
                const pt = getSvgPoint(svg, event, { width: histWidth, height: histHeight })
                histDragRef.current = { column, x1: pt.x, x2: pt.x }
                setHistDrag(histDragRef.current)
                try { svg.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
              }
              const histOnPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
                if (!histDragRef.current || histDragRef.current.column !== column) return
                const svg = histSvgRefs.current.get(column)
                if (!svg) return
                const pt = getSvgPoint(svg, event, { width: histWidth, height: histHeight })
                histDragRef.current = { ...histDragRef.current, x2: pt.x }
                setHistDrag(histDragRef.current)
              }
              const histOnPointerUp = () => {
                const cur = histDragRef.current
                histDragRef.current = null
                setHistDrag(null)
                if (!cur || cur.column !== column || Math.abs(cur.x2 - cur.x1) < 4) return
                const xLoPx = Math.min(cur.x1, cur.x2)
                const xHiPx = Math.max(cur.x1, cur.x2)
                const plotL = 22
                const plotR = histWidth - 8
                const vLo = min + ((xLoPx - plotL) / (plotR - plotL)) * (max - min)
                const vHi = min + ((xHiPx - plotL) / (plotR - plotL)) * (max - min)
                const ids = rows.filter(({ v }) => v >= Math.min(vLo, vHi) && v <= Math.max(vLo, vHi)).map(({ id }) => id)
                dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: `ヒストグラム範囲選択（${column}）` }))
              }
              const activeHistDrag = histDrag?.column === column ? histDrag : null

              return (
                <div
                  key={column}
                  style={{ userSelect: 'none', flex: '0 0 auto', maxWidth: histWidth, width: '100%' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: '#f8fafc', border: '1px solid #e5e7eb', borderBottom: 'none', borderRadius: '6px 6px 0 0' }}>
                    <Typography.Text strong style={{ fontSize: 13, color: '#334155' }}><ColumnQuestionTooltip nameOrId={column}>{column}</ColumnQuestionTooltip></Typography.Text>
                    <Button size="small" onClick={() => openHistogramExpansion(column)}>拡大表示</Button>
                  </div>
                  <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
                  <div>
                  <EChartSurface
                    onViewportChange={() => { histDragRef.current = null; setHistDrag(null) }}
                    ref={(el) => { if (el) histSvgRefs.current.set(column, el) }}
                    data-testid={`histogram-${column}`}
                    viewBox={`0 0 ${histWidth} ${histHeight}`}
                    width={histWidth}
                    height={histHeight}
                      style={{
                        width: '100%',
                        height: 'auto',
                        display: 'block',
                        boxSizing: 'border-box',
                        border: '1px solid #e5e7eb',
                      borderTop: 'none',
                      borderRadius: 0,
                      background: '#fff',
                      touchAction: 'none',
                    }}
                    onPointerDown={histOnPointerDown}
                    onPointerMove={histOnPointerMove}
                    onPointerUp={histOnPointerUp}
                  >
                    <ColumnQuestionTooltip nameOrId={column} svg><text data-label-width={histWidth - 32} data-label-lines={2} x={histWidth / 2} y={32} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151">{column}</text></ColumnQuestionTooltip>
                    {groupBins.map((bins, gi) =>
                      bins.map((count, bi) => {
                        if (!count) return null
                        const h = (count / maxCount) * (histHeight - 64)
                        const x = 22 + bi * barW
                        const color = domain && gi < domain.codes.length ? l1Color(theme, gi) : theme.contextLine
                        const isSelectedBin = isBinHighlighted(bi)
                        return (
                          <rect
                            key={`${gi}-${bi}`}
                            data-selectable="true"
                            x={x}
                            y={histHeight - 26 - h}
                            width={Math.max(1, barW - 2)}
                            height={h}
                            fill={color}
                            opacity={isSelectedBin ? 0.95 : 0.55}
                            style={{ cursor: 'pointer' }}
                            onClick={() => selectBinRange(bi)}
                          >
                            <title>{`${questionText(column)} [${binEdges[bi].toFixed(2)}–${binEdges[bi + 1].toFixed(2)}): ${count}`}</title>
                          </rect>
                        )
                      }))}
                    {activeHistDrag && (
                      <rect
                        x={Math.min(activeHistDrag.x1, activeHistDrag.x2)}
                        y={10}
                        width={Math.abs(activeHistDrag.x2 - activeHistDrag.x1)}
                        height={histHeight - 36}
                        fill="rgba(42,120,214,0.15)"
                        stroke="#2a78d6"
                        strokeWidth={1.5}
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                    <line x1={20} y1={histHeight - 26} x2={histWidth - 8} y2={histHeight - 26} stroke="#c3c2b7" />
                    {[min, (min + max) / 2, max].map((tick, ti) => (
                      <text key={ti} x={22 + ((tick - min) / (max - min || 1)) * (histWidth - 38)} y={histHeight - 10}
                        textAnchor="middle" fontSize={10} fill="#6b7280">{Number(tick).toFixed(1)}</text>
                    ))}
                  </EChartSurface>
                  {/* jittered strip under the histogram */}
                  <EChartSurface
                    viewBox={`0 0 ${histWidth} 40`}
                    width={histWidth}
                    height={40}
                      style={{
                        width: '100%',
                        height: 'auto',
                        display: 'block',
                        boxSizing: 'border-box',
                        background: '#fff',
                      border: '1px solid #e5e7eb',
                      borderTop: 'none',
                      borderRadius: '0 0 6px 6px',
                    }}
                  >
                    {rows.map(({ id, v }) => {
                      const isSelected = selectedSet.has(id)
                      const color = isSelected
                        ? theme.selection
                        : getColor(id)
                      const cx = 22 + ((v - min) / (max - min || 1)) * (histWidth - 38)
                      const cy = 20 + signedNoiseViz(id, `${column}-strip`) * 12
                      return (
                        <g key={id} data-selectable="true"
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); dispatch(selectionApplied({ rowIds: [id], operation: getBrushOp(), label: 'ヒストグラム点クリック' })) }}>
                          <circle cx={cx} cy={cy}
                            data-chart-marker="point" r={pointRadius(isSelected)}
                            fill={color} opacity={isSelected ? 0.95 : 0.45}
                            stroke={isSelected ? '#fff' : 'none'} strokeWidth={isSelected ? 1.5 : 0}>
                            <title>{`${id}: ${v.toFixed(3)} — クリックで選択`}</title>
                          </circle>
                        </g>
                      )
                    })}
                  </EChartSurface>
                  </div>
                  </Dropdown>
                </div>
              )
            }

            return (
              <>
                <Card
                  size="small"
                  title={<span style={{ fontSize: 13, fontWeight: 600 }}>各変数のヒストグラム分布（棒クリック＝値域選択 · 下段stripは選択値域を強調）</span>}
                  style={{
                    boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.03)',
                  }}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                    {visibleNumericColumns.map((col) => renderHistCard(col))}
                  </div>
                </Card>
                {expandedColumn && visibleNumericColumns.includes(expandedColumn) && (
                  <GraphPanel
                    graphId={`statistics/histogram/${expandedColumn}`}
                    title={`${expandedColumn} ヒストグラム`}
                    available
                    sizing="intrinsic"
                    intrinsicSize={{ width: histWidth, height: histHeight + 40 }}
                  >
                    {renderHistCard(expandedColumn)}
                  </GraphPanel>
                )}
              </>
            )
          })()}
        </>
      )}
    </div>
  )
}
