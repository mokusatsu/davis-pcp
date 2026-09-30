import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Radio, Select, Space, Spin, Table, Tabs, Tag, Typography, message } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetValuesUpdated, selectionApplied, selectOrdinaryVariables } from '../../app/store'
import { fetchCodebookThunk } from '../dataset/codebookSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'
import { api } from '../../api/client'
import { useCodebook } from '../dataset/useCodebookColumn'
import GraphPanel from '../common/GraphPanel'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'
import SelectColumn from '../common/ColumnSelect'
import L1Legend from '../common/L1Legend'
import { useRowColorResolver } from '../../theme/useRowColor'
import type { FAMDResponse } from './famdTypes'
import { exportFamdTable, fetchFamdRows, runFamd, selectFamd, type FAMDContext } from './famdApi'
import { downloadPng, downloadSvg } from './mcaApi'
import FamdFigure, { CorrelationCircle, famdAxisLabel, famdCategoryPoints } from './FamdFigure'
import { truncateText } from '../../utils/textUtils'

function apiErrorMessage(err: unknown, fallback: string): string {
  const { message: msg, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof msg !== 'string' || !msg) return fallback
  return typeof code === 'string' && code ? `${msg}（${code}）` : msg
}

const VAR_COLORS = ['#1890ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2', '#fadb14', '#2f54eb', '#a0d911', '#fa541c']
const NUMERIC_COLOR = '#fa8c16'

export default function FamdPage(): JSX.Element {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const obs = useSelector((s: RootState) => s.globalObservations)
  const codebook = useCodebook()
  const { columns, schemaRevision } = codebook
  const datasetId = selection.datasetId
  const { getColor } = useRowColorResolver()

  const globalVars = useSelector(selectOrdinaryVariables)
  const hasGlobalSignal = globalVars.allVariables.length > 0
  const activeSet = useMemo(() => new Set(globalVars.activeVariableIds), [globalVars.activeVariableIds])
  const numericOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name, name: c.name })),
    [columns, activeSet, hasGlobalSignal],
  )
  const categoricalOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name, name: c.name })),
    [columns, activeSet, hasGlobalSignal],
  )
  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of columns) m.set(c.columnId, c.name)
    return m
  }, [columns])

  const [numericVars, setNumericVars] = useState<string[]>([])
  const [categoricalVars, setCategoricalVars] = useState<string[]>([])
  const [scope, setScope] = useState<'all' | 'active' | 'selected' | 'sampled'>('active')
  const [missingPolicy, setMissingPolicy] = useState('exclude')
  const [weightChoice, setWeightChoice] = useState<'dataset' | 'none'>('dataset')
  const [axisX, setAxisX] = useState(1)
  const [axisY, setAxisY] = useState(2)
  const [overlay, setOverlay] = useState(false)
  const [tab, setTab] = useState('individuals')

  const [result, setResult] = useState<FAMDResponse | null>(null)
  const [submittedKey, setSubmittedKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set())
  const [between, setBetween] = useState<'and' | 'or'>('and')
  const [selecting, setSelecting] = useState(false)
  const [selectInfo, setSelectInfo] = useState<string | null>(null)
  const [rows, setRows] = useState<{ rowId: string; coordinates: number[] }[]>([])
  const [rowsTotal, setRowsTotal] = useState(0)
  const [linkedCategoryIds, setLinkedCategoryIds] = useState<Set<string>>(new Set())
  const [matAxis, setMatAxis] = useState(1)
  const [predictScope, setPredictScope] = useState<'all' | 'active' | 'selected' | 'sampled'>('all')
  const [predicting, setPredicting] = useState(false)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [predictInfo, setPredictInfo] = useState<string | null>(null)
  const [predictWarnings, setPredictWarnings] = useState<{ code: string; message: string }[]>([])
  const [predictRows, setPredictRows] = useState<{ rowId: string; coordinates: (number | null)[]; predictionStatus: string }[]>([])
  const [predictTotal, setPredictTotal] = useState(0)
  const [predictOk, setPredictOk] = useState(0)
  const [predictMeta, setPredictMeta] = useState<{ datasetId: string; resultId: string; axes: number[] } | null>(null)
  const runSequence = useRef(0)
  const svgIndRef = useRef<SVGSVGElement | null>(null)
  const svgCatRef = useRef<SVGSVGElement | null>(null)

  const draftKey = JSON.stringify([datasetId, numericVars, categoricalVars, scope, missingPolicy,
    weightChoice, selection.dataRevision, schemaRevision])
  const dirty = result !== null && submittedKey !== '' && draftKey !== submittedKey

  const clearPredictState = (): void => {
    setPredicting(false)
    setPredictError(null)
    setPredictInfo(null)
    setPredictWarnings([])
    setPredictRows([])
    setPredictTotal(0)
    setPredictOk(0)
    setPredictMeta(null)
  }

  useEffect(() => {
    runSequence.current += 1
    setResult(null)
    setSubmittedKey('')
    setError(null)
    setLoading(false)
    setSelecting(false)
    setSelectedCats(new Set())
    setSelectInfo(null)
    setRows([])
    setRowsTotal(0)
    setLinkedCategoryIds(new Set())
    setNumericVars([])
    setCategoricalVars([])
    clearPredictState()
  }, [datasetId])

  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const schemaRef = useRef(schemaRevision)
  schemaRef.current = schemaRevision

  const buildContext = (): FAMDContext => ({
    datasetId: datasetId ?? '',
    expectedDataRevision: selection.dataRevision,
    expectedSchemaRevision: schemaRevision,
    scope,
    activeRowIds: scope === 'active' ? selection.activeRowIds : undefined,
    selectedRowIds: scope === 'selected' ? selection.selectedRowIds : undefined,
    sampledRowIds: scope === 'sampled' ? obs.sampling.sampledRowIds : undefined,
    weightMode: weightChoice,
    missingPolicy,
  })

  const canRun = Boolean(datasetId && numericVars.length >= 1 && categoricalVars.length >= 1)

  const buildPredictContext = (): FAMDContext => ({
    datasetId: datasetId ?? '',
    expectedDataRevision: selection.dataRevision,
    expectedSchemaRevision: schemaRevision,
    scope: predictScope,
    activeRowIds: predictScope === 'active' ? selection.activeRowIds : undefined,
    selectedRowIds: predictScope === 'selected' ? selection.selectedRowIds : undefined,
    sampledRowIds: predictScope === 'sampled' ? obs.sampling.sampledRowIds : undefined,
    weightMode: weightChoice,
    missingPolicy,
  })

  const handlePredict = async (): Promise<void> => {
    if (!datasetId || !result) return
    const seq = ++runSequence.current
    const startedDataset = datasetId
    const startedResultId = result.resultId
    const requestedAxes = [...wantAxes]
    setPredicting(true)
    setPredictError(null)
    setPredictInfo(null)
    setPredictWarnings([])
    setPredictRows([])
    setPredictMeta(null)
    try {
      const res = await api.post<{
        predictionId: string
        summary: { requestedCount: number; successfulPredictions: number; statusCounts: Record<string, number> }
        meta: { warnings?: { code: string; message: string }[] }
      }>(
        `/analysis-results/${startedResultId}/predict`,
        { context: buildPredictContext(), options: {} },
      )
      if (seq !== runSequence.current || selectionRef.current.datasetId !== startedDataset) {
        setPredicting(false)
        return
      }
      const summary = res.summary
      setPredictTotal(summary.requestedCount)
      setPredictOk(summary.successfulPredictions)
      setPredictInfo(`成功 ${summary.successfulPredictions}/${summary.requestedCount}`)
      setPredictWarnings(res.meta?.warnings ?? [])
      const all: { rowId: string; coordinates: (number | null)[]; predictionStatus: string }[] = []
      let offset = 0
      for (;;) {
        const page = await api.get<{
          rows: { rowId: string; coordinates: (number | null)[]; predictionStatus: string }[]
          nextOffset: number | null
        }>(`/analysis-results/${startedResultId}/predictions/${res.predictionId}/rows?offset=${offset}&limit=5000&axes=${requestedAxes.join(',')}`)
        if (seq !== runSequence.current || selectionRef.current.datasetId !== startedDataset) {
          setPredicting(false)
          return
        }
        all.push(...page.rows)
        if (page.nextOffset === null || page.nextOffset === undefined) break
        offset = page.nextOffset
      }
      if (seq !== runSequence.current || selectionRef.current.datasetId !== startedDataset) {
        setPredicting(false)
        return
      }
      setPredictRows(all)
      setPredictMeta({ datasetId: startedDataset, resultId: startedResultId, axes: requestedAxes })
    } catch (err) {
      if (seq !== runSequence.current) return
      setPredictError(apiErrorMessage(err, '射影に失敗しました。'))
    } finally {
      if (seq === runSequence.current) setPredicting(false)
    }
  }

  const handleRun = async (): Promise<void> => {
    if (!datasetId || !canRun) return
    const seq = ++runSequence.current
    const startedDataset = datasetId
    const startedDataRev = selectionRef.current.dataRevision
    const startedSchemaRev = schemaRef.current
    const startedKey = draftKey
    setLoading(true)
    setError(null)
    try {
      const res = await runFamd(buildContext(), numericVars, categoricalVars)
      if (seq !== runSequence.current) return
      if (selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRev
        || schemaRef.current !== startedSchemaRev) return
      setResult(res)
      setSubmittedKey(startedKey)
      setSelectedCats(new Set())
      setSelectInfo(null)
      setAxisX(1)
      setAxisY(Math.min(2, res.summary.rank))
      clearPredictState()
      message.success('混合データ因子分析を実行しました。')
    } catch (err) {
      if (seq !== runSequence.current) return
      setError(apiErrorMessage(err, '分析に失敗しました。'))
    } finally {
      if (seq === runSequence.current) setLoading(false)
    }
  }
  const rank = result?.summary.rank ?? 0
  const ratio = result?.summary.inertiaRatio ?? []
  const effAxisY = rank >= 2 ? (axisY === axisX ? (axisX === 1 ? 2 : 1) : axisY) : axisX
  const dispRank = rank >= 2 ? 2 : 1
  const wantAxes = rank >= 2 ? [axisX, effAxisY] : [axisX]
  const [rowsMeta, setRowsMeta] = useState<{ resultId: string; axes: number[] } | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const rowsReady = !rowsLoading && !rowsError && rowsMeta !== null
    && rowsMeta.resultId === (result?.resultId ?? '')
    && rowsMeta.axes.join(',') === wantAxes.join(',')
  const guardRows = (): boolean => {
    if (!result || !rowsReady) {
      message.info('個体座標の取得完了後に選択してください。')
      return false
    }
    return true
  }
  useEffect(() => {
    if (!result || !datasetId) return
    const resultId = result.resultId
    const startedDataset = datasetId
    const wantAxesLocal = rank >= 2 ? [axisX, effAxisY] : [axisX]
    let cancelled = false
    setRowsLoading(true)
    setRowsError(null)
    void (async () => {
      const all: { rowId: string; coordinates: number[] }[] = []
      let offset = 0
      for (;;) {
        const page = await fetchFamdRows(resultId, offset, 5000, wantAxesLocal)
        if (cancelled || selectionRef.current.datasetId !== startedDataset) return
        all.push(...page.rows)
        if (page.nextOffset === null || page.nextOffset === undefined) break
        offset = page.nextOffset
      }
      if (cancelled || selectionRef.current.datasetId !== startedDataset) return
      setRows(all)
      setRowsTotal(all.length)
      setRowsMeta({ resultId, axes: wantAxesLocal })
      setRowsLoading(false)
    })().catch((err) => {
      if (cancelled) return
      setRowsError(apiErrorMessage(err, '個体座標の取得に失敗しました。'))
      setRowsLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.resultId, datasetId, axisX, effAxisY, rank])
  const toggleCat = (id: string): void => {
    setSelectedCats((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const handleSelect = async (selector: { kind: 'categories'; categoryIds: string[]; betweenVariables: 'and' | 'or' } | { kind: 'rectangle'; axes: number[]; bounds: [number, number][] } | { kind: 'row_ids'; rowIds: string[] }): Promise<void> => {
    if (!result) return
    setSelecting(true)
    setSelectInfo(null)
    const seq = ++runSequence.current
    const startedDataset = datasetId
    const startedDataRev = selectionRef.current.dataRevision
    const startedSchemaRev = schemaRef.current
    try {
      const res = await selectFamd(result.resultId, buildContext(), selector)
      if (seq !== runSequence.current) return
      if (selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRev
        || schemaRef.current !== startedSchemaRev) return
      dispatch(selectionApplied({
        rowIds: res.rowIds,
        operation: getBrushOp(),
        label: `${res.selectionLabel} (${res.contextIntersectionCount}行)`,
      }))
      setSelectInfo(`一致 ${res.matchedCount} / 適用 ${res.contextIntersectionCount}`)
    } catch (err) {
      if (seq !== runSequence.current) return
      message.error(apiErrorMessage(err, '選択の解決に失敗しました。'))
    } finally {
      if (seq === runSequence.current) setSelecting(false)
    }
  }
  const resultStale = result !== null
    && (result.meta.dataRevision !== selection.dataRevision || result.meta.schemaRevision !== schemaRevision)
  const [liveRevisions, setLiveRevisions] = useState<{ data: number; schema: number } | null>(null)
  useEffect(() => {
    if (!result || !datasetId) { setLiveRevisions(null); return }
    let cancelled = false
    const startedDataset = datasetId
    const check = (): void => {
      void api.get<{ dataRevision: number; schemaRevision: number }>(`/datasets/${startedDataset}`)
        .then((meta) => {
          if (!cancelled && datasetId === startedDataset) setLiveRevisions({ data: meta.dataRevision, schema: meta.schemaRevision })
        }).catch(() => undefined)
    }
    check()
    const timer = setInterval(check, 10000)
    return () => { cancelled = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.resultId, datasetId])
  const shownStale = resultStale || (result !== null && liveRevisions !== null
    && (result.meta.dataRevision !== liveRevisions.data || result.meta.schemaRevision !== liveRevisions.schema))
  useEffect(() => {
    if (!result || !datasetId || selection.selectedRowIds.length === 0) {
      if (selection.selectedRowIds.length === 0) setLinkedCategoryIds(new Set())
      return
    }
    const resultId = result.resultId
    let cancelled = false
    const startedDataset = datasetId
    const selSet = new Set(selection.selectedRowIds)
    void (async () => {
      try {
        const hit = new Set<string>()
        let offset = 0
        for (;;) {
          const res = await api.post<{ payload: string; nextOffset: number | null }>(
            `/analysis-results/${resultId}/export`, { format: 'json', table: 'members', offset, limit: 5000 },
          )
          if (cancelled || selectionRef.current.datasetId !== startedDataset) return
          let rowsParsed: [string, string, string][] = []
          try { rowsParsed = JSON.parse(res.payload)?.rows ?? [] } catch { rowsParsed = [] }
          for (const [cid, rid] of rowsParsed) {
            if (selSet.has(String(rid))) hit.add(String(cid))
          }
          if (res.nextOffset === null || res.nextOffset === undefined) break
          offset = res.nextOffset
        }
        if (!cancelled && selectionRef.current.datasetId === startedDataset) setLinkedCategoryIds(hit)
      } catch {
        if (!cancelled && selectionRef.current.datasetId === startedDataset) setLinkedCategoryIds(new Set())
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, selection.selectedRowIds, datasetId, selection.dataRevision])
  const varColor = useMemo(() => {
    const map = new Map<string, string>()
    const vars = result?.details.categoricalVariables ?? []
    vars.forEach((v, i) => map.set(v.variableId, VAR_COLORS[i % VAR_COLORS.length]))
    return (id: string): string => map.get(id) ?? '#8c8c8c'
  }, [result])
  const indPoints = useMemo(() => rows.map((r) => ({
    id: r.rowId,
    rowId: r.rowId,
    label: '',
    x: r.coordinates[0] ?? 0,
    y: r.coordinates.length >= 2 ? r.coordinates[1] : null,
    title: r.rowId,
  })), [rows])
  const catPoints = useMemo(() => famdCategoryPoints(result?.details.categories ?? [], varColor, axisX, effAxisY), [result, varColor, axisX, effAxisY])
  const corrPoints = useMemo(() => (result?.details.numericVariables ?? []).map((v) => ({
    id: v.variableId,
    label: v.label,
    x: v.correlations[axisX - 1] ?? 0,
    y: rank >= 2 ? v.correlations[effAxisY - 1] ?? null : null,
    title: v.variableId,
    color: NUMERIC_COLOR,
  })), [result, axisX, effAxisY, rank])
  const selectedRowIds = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])
  const configIncomplete = datasetId !== null && (numericVars.length < 1 || categoricalVars.length < 1)

  if (!datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="famd-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {(
        <Card size="small" title="混合データ因子分析（FAMD）">
          <Space wrap align="center">
            <span>数値列</span>
            <SelectColumn
              mode="multiple"
              style={{ minWidth: 280 }}
              placeholder="interval/ratioを選択"
              value={numericVars}
              onChange={(v) => setNumericVars(v as string[])}
              options={numericOptions}
            />
            <span>カテゴリ列</span>
            <SelectColumn
              mode="multiple"
              style={{ minWidth: 280 }}
              placeholder="nominal/ordinalを選択"
              value={categoricalVars}
              onChange={(v) => setCategoricalVars(v as string[])}
              options={categoricalOptions}
            />
            <Select
              style={{ minWidth: 150 }}
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
              style={{ minWidth: 150 }}
              value={missingPolicy}
              onChange={(v) => setMissingPolicy(v)}
              options={[
                { value: 'exclude', label: '欠損を除外' },
                { value: 'include_missing', label: '欠損を含める' },
                { value: 'separate_not_applicable', label: '非該当を分離' },
              ]}
            />
            <Select
              style={{ minWidth: 130 }}
              value={weightChoice}
              onChange={(v) => setWeightChoice(v)}
              options={[
                { value: 'dataset', label: '重み:データ設定' },
                { value: 'none', label: '重み:なし' },
              ]}
            />
            <Button type="primary" data-testid="famd-run" loading={loading} disabled={!canRun} onClick={() => void handleRun()}>
              実行
            </Button>
            <SelectionMenu />
          </Space>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            ordinalは等間隔得点に変換しません。数値化が必要な場合は既存変換で派生列を作成してください。MA親・子・countは指定できません。
          </Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
            数値のみ・カテゴリのみはPCA/MCAへ案内します。
          </Typography.Text>
          {configIncomplete && (
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
              数値列とカテゴリ列をそれぞれ1つ以上選択してください。
            </Typography.Text>
          )}
          {dirty && <Alert type="warning" style={{ marginTop: 8 }} message="設定が変更されています。結果は前回実行分です。" />}
        </Card>
      )}
      {error && <Alert type="error" message={error} />}
      {loading && <Spin tip="FAMDを計算中…" />}
      {result && (
        <>
          <Card
            size="small"
            title={
              <Space>
                <Tag>rev {result.meta.dataRevision} / scope {result.meta.scope} (n={result.meta.scopeCount})</Tag>
                <Tag>有効 {result.meta.fitCount}</Tag>
                <Tag>{result.meta.weightApplied ? `加重(${result.meta.weightType})` : '非加重'}</Tag>
                {shownStale && <Tag color="orange">stale（古い版）</Tag>}
                <Tag>p{result.summary.nNumericVariables} m{result.summary.nCategoricalVariables} K{result.summary.nCategories} rank {rank}</Tag>
              </Space>
            }
          >
            <Space wrap>
              {result.meta.warnings.map((w, i) => (
                <Alert key={i} type="warning" message={`${w.code}: ${w.message}`} showIcon />
              ))}
            </Space>
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                {
                  key: 'individuals',
                  label: `個体図（${rowsTotal}）`,
                  children: (
                    <div>
                      <Typography.Text type="secondary">個体座標F。加重中心0。L1色分け。</Typography.Text>
                      <L1Legend />
                      {rowsLoading && <Spin tip="個体座標を取得中…" />}
                      {rowsError && <Alert type="error" message={rowsError} />}
                      {rowsMeta && (rowsMeta.resultId !== result.resultId || rowsMeta.axes.join(',') !== [axisX, effAxisY].slice(0, dispRank).join(',')) && (
                        <Alert type="warning" message="表示中の個体座標は取得中です。選択は取得完了後に行ってください。" />
                      )}
                      <GraphPanel
                        graphId="famd/individuals"
                        title="FAMD個体図"
                        available={tab === 'individuals'}
                        sizing="intrinsic"
                        intrinsicSize={{ width: 560, height: 420 }}
                      >
                      <FamdFigure
                        points={overlay ? [...indPoints, ...catPoints.map((c) => ({ ...c, rowId: undefined }))] : indPoints}
                        rank={rank}
                        dispRank={dispRank}
                        xAxis={axisX}
                        yAxis={effAxisY}
                        ratio={ratio}
                        selected={selectedRowIds}
                        highlighted={new Set<string>()}
                        getColor={getColor}
                        onToggle={(id) => {
                          if (!guardRows()) return
                          void handleSelect({ kind: 'row_ids', rowIds: [id] })
                        }}
                        onBrush={(axes, bounds) => {
                          if (!guardRows()) return
                          const mapAxis = (a: number): number => (a === 1 ? axisX : effAxisY)
                          void handleSelect({ kind: 'rectangle', axes: axes.map(mapAxis), bounds })
                        }}
                        svgRef={svgIndRef as React.RefObject<SVGSVGElement>}
                        testId="famd-individual-svg"
                        overlayNote={overlay ? 'カテゴリ点を重ねて表示中（距離の解釈注意）' : undefined}
                      />
                      </GraphPanel>
                      <Space wrap style={{ marginTop: 8 }}>
                        <span>X軸</span>
                        <Select value={axisX} onChange={setAxisX} options={Array.from({ length: rank }, (_, i) => ({ value: i + 1, label: famdAxisLabel(rank, ratio, i + 1) }))} style={{ minWidth: 160 }} />
                        {rank >= 2 && (
                          <>
                            <span>Y軸</span>
                            <Select value={axisY} onChange={(v) => setAxisY(v === axisX ? effAxisY : v)} options={Array.from({ length: rank }, (_, i) => ({ value: i + 1, label: famdAxisLabel(rank, ratio, i + 1) }))} style={{ minWidth: 160 }} />
                          </>
                        )}
                        <Button onClick={() => setOverlay((v) => !v)}>{overlay ? '重ね合わせを解除' : 'カテゴリ点を重ねる'}</Button>
                      </Space>
                    </div>
                  ),
                },
                {
                  key: 'categories',
                  label: `カテゴリ重心図（${result.details.categories.length}）`,
                  children: (
                    <div>
                      <Typography.Text type="secondary">カテゴリ重心図。変数ごとに色分けします。</Typography.Text>
                      <Space wrap style={{ marginTop: 4, marginBottom: 4 }}>
                        {result.details.categoricalVariables.map((v) => (
                          <Tag key={v.variableId} color={varColor(v.variableId)}>{v.label ?? nameById.get(v.variableId) ?? v.variableId}</Tag>
                        ))}
                      </Space>
                      <GraphPanel
                        graphId="famd/categories"
                        title="FAMDカテゴリ重心図"
                        available={tab === 'categories'}
                        sizing="intrinsic"
                        intrinsicSize={{ width: 560, height: 420 }}
                      >
                      <FamdFigure
                        points={catPoints}
                        rank={rank}
                        dispRank={dispRank}
                        xAxis={axisX}
                        yAxis={effAxisY}
                        ratio={ratio}
                        selected={selectedCats}
                        highlighted={linkedCategoryIds}
                        onToggle={toggleCat}
                        onCategoryBrush={(bounds) => {
                          const inX = (v: number): boolean => v >= bounds.x[0] && v <= bounds.x[1]
                          const inY = (v: number | null): boolean => bounds.y === null || (v !== null && v >= bounds.y[0] && v <= bounds.y[1])
                          const ids = (result?.details.categories ?? [])
                            .filter((c) => {
                              const x = c.barycenterCoordinates[axisX - 1] ?? 0
                              const y = c.barycenterCoordinates.length >= effAxisY ? c.barycenterCoordinates[effAxisY - 1] : null
                              return inX(x) && inY(y)
                            })
                            .map((c) => c.categoryId)
                          if (ids.length === 0) {
                            message.info('囲まれたカテゴリがありません。')
                            return
                          }
                          setSelectedCats(new Set(ids))
                          void handleSelect({ kind: 'categories', categoryIds: ids, betweenVariables: between })
                        }}
                        svgRef={svgCatRef as React.RefObject<SVGSVGElement>}
                        testId="famd-category-svg"
                      />
                      </GraphPanel>
                      <Space wrap style={{ marginTop: 8 }}>
                        <Radio.Group value={between} onChange={(e) => setBetween(e.target.value)}>
                          <Radio.Button value="and">変数間AND</Radio.Button>
                          <Radio.Button value="or">変数間OR</Radio.Button>
                        </Radio.Group>
                        <Button loading={selecting} disabled={selectedCats.size === 0 || shownStale} onClick={() => void handleSelect({ kind: 'categories', categoryIds: [...selectedCats], betweenVariables: between })}>
                          原行IDへ解決して選択 ({selectedCats.size})
                        </Button>
                        {selectInfo && <Tag>{selectInfo}</Tag>}
                      </Space>
                    </div>
                  ),
                },
                {
                  key: 'correlation',
                  label: '相関円',
                  children: (
                    <div>
                      <Typography.Text type="secondary">相関円は[-1,1]同一縮尺。個体空間と重ねません。</Typography.Text>
                      <GraphPanel
                        graphId="famd/correlation"
                        title="FAMD相関円"
                        available={tab === 'correlation'}
                        sizing="intrinsic"
                        intrinsicSize={{ width: 420, height: 420 }}
                      >
                      <CorrelationCircle points={corrPoints} testId="famd-correlation-svg" axisX={axisX} axisY={effAxisY} rank={rank} />
                      </GraphPanel>
                    </div>
                  ),
                },
                {
                  key: 'relation',
                  label: '変数関係',
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <Typography.Text type="secondary">数値はr²、カテゴリはη²。因果的重要度ではありません。寄与ランキングは別列。</Typography.Text>
                      <GraphPanel
                        graphId="famd/relations"
                        title="FAMD変数関係図"
                        available={tab === 'relation'}
                        sizing="intrinsic"
                        intrinsicSize={{ width: 560, height: 300 }}
                      >
                      <svg data-testid="famd-relation-svg" viewBox="0 0 560 300" width="560" height="300" style={{ background: '#fafafa', borderRadius: 4, userSelect: 'none' }}>
                        {(() => {
                          const rows = result.details.variableRelation
                          const W = 560
                          const H = 300
                          const PAD = { left: 150, right: 24, top: 16, bottom: 28 }
                          const rh = rows.length > 0 ? Math.min(28, (H - PAD.top - PAD.bottom) / rows.length) : 28
                          return (
                            <g>
                              {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                                const x = PAD.left + t * (W - PAD.left - PAD.right)
                                return (
                                  <g key={t}>
                                    <line x1={x} y1={PAD.top} x2={x} y2={H - PAD.bottom} stroke="#e5e7eb" />
                                    <text x={x} y={H - 8} textAnchor="middle" fontSize={10} fill="#666">{t.toFixed(2)}</text>
                                  </g>
                                )
                              })}
                              {rows.map((v, i) => {
                                const y = PAD.top + i * rh + rh / 2
                                const relX = Math.max(0, Math.min(1, v.relationStrength[axisX - 1] ?? 0))
                                const relY = rank >= 2 ? Math.max(0, Math.min(1, v.relationStrength[effAxisY - 1] ?? 0)) : null
                                const wX = relX * (W - PAD.left - PAD.right)
                                const wY = relY === null ? 0 : relY * (W - PAD.left - PAD.right)
                                const label = nameById.get(v.variableId) ?? v.variableId
                                const relationLabel = `${label}（${v.kind === 'numeric' ? 'r²' : 'η²'}）`
                                return (
                                  <g key={v.variableId}>
                                    <text x={PAD.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill="#333">
                                      {truncateText(relationLabel, 12)}
                                      <title>{`${label} kind=${v.kind} 第${axisX}軸=${(v.relationStrength[axisX - 1] ?? 0).toFixed(4)}`}</title>
                                    </text>
                                    <rect x={PAD.left} y={y - 8} width={W - PAD.left - PAD.right} height={7} fill="#f0f0f0" />
                                    <rect x={PAD.left} y={y - 8} width={wX} height={7} fill="#1890ff">
                                      <title>{`${label} 第${axisX}軸 ${v.kind === 'numeric' ? 'r²' : 'η²'}=${(v.relationStrength[axisX - 1] ?? 0).toFixed(4)}`}</title>
                                    </rect>
                                    {relY !== null && (
                                      <rect x={PAD.left} y={y - 1} width={wY} height={7} fill="#fa8c16" fillOpacity={0.75}>
                                        <title>{`${label} 第${effAxisY}軸 ${v.kind === 'numeric' ? 'r²' : 'η²'}=${(v.relationStrength[effAxisY - 1] ?? 0).toFixed(4)}`}</title>
                                      </rect>
                                    )}
                                  </g>
                                )
                              })}
                              <text x={PAD.left} y={H - 8 - 12} fontSize={10} fill="#1890ff">{`■ 第${axisX}軸`}</text>
                              {rank >= 2 && (
                                <text x={PAD.left + 90} y={H - 8 - 12} fontSize={10} fill="#fa8c16">{`■ 第${effAxisY}軸`}</text>
                              )}
                            </g>
                          )
                        })()}
                      </svg>
                      </GraphPanel>
                      <Table
                        size="small"
                        dataSource={result.details.variableRelation.map((v) => ({ ...v, key: v.variableId }))}
                        columns={[
                          { title: '変数', dataIndex: 'variableId', key: 'variableId', render: (value: string) => nameById.get(value) ?? value },
                          { title: 'kind', dataIndex: 'kind', key: 'kind' },
                          { title: `関係強度 第${axisX}軸`, key: 'relX', render: (_v: unknown, r: { relationStrength: number[] }) => (r.relationStrength[axisX - 1] ?? 0).toFixed(4) },
                          { title: `関係強度 第${effAxisY}軸`, key: 'relY', render: (_v: unknown, r: { relationStrength: number[] }) => (r.relationStrength[effAxisY - 1] ?? 0).toFixed(4) },
                          { title: `寄与 第${axisX}軸`, key: 'ctrX', render: (_v: unknown, r: { relationStrength: number[]; contributions: number[] }) => (r.contributions[axisX - 1] ?? 0).toFixed(4) },
                          { title: `寄与 第${effAxisY}軸`, key: 'ctrY', render: (_v: unknown, r: { relationStrength: number[]; contributions: number[] }) => (r.contributions[effAxisY - 1] ?? 0).toFixed(4) },
                        ]}
                        pagination={false}
                      />
                    </div>
                  ),
                },
                {
                  key: 'tables',
                  label: '表・診断',
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <Table
                        size="small"
                        title={() => '固有値'}
                        dataSource={result.summary.eigenvalues.map((v, i) => ({
                          key: i + 1,
                          axis: i + 1,
                          value: v,
                          ratio: result.summary.inertiaRatio[i] ?? 0,
                          cumulative: result.summary.cumulativeInertiaRatio[i] ?? 0,
                        }))}
                        columns={[
                          { title: '軸', dataIndex: 'axis', key: 'axis' },
                          { title: '固有値', dataIndex: 'value', key: 'value', render: (v: number) => v.toFixed(6) },
                          { title: '寄与率', dataIndex: 'ratio', key: 'ratio', render: (v: number) => `${(v * 100).toFixed(2)}%` },
                          { title: '累積寄与率', dataIndex: 'cumulative', key: 'cumulative', render: (v: number) => `${(v * 100).toFixed(2)}%` },
                        ]}
                        pagination={false}
                      />
                      <Typography.Text type="secondary">
                        全慣性 {result.summary.totalInertia.toFixed(6)} = p+Σ(Kj-1)。水準数の違いに注意。「全元変数が同じ総寄与」とは表示しません。
                      </Typography.Text>
                      <Table
                        size="small"
                        title={() => 'カテゴリ'}
                        dataSource={result.details.categories.map((c) => ({ ...c, key: c.categoryId }))}
                        columns={[
                          { title: '変数', dataIndex: 'variableId', key: 'variableId', render: (value: string) => nameById.get(value) ?? value },
                          { title: 'ラベル', dataIndex: 'label', key: 'label' },
                          { title: '人数', dataIndex: 'physicalCount', key: 'physicalCount' },
                          { title: '確率', dataIndex: 'probability', key: 'probability', render: (value: number) => value.toFixed(4) },
                          { title: `重心 第${axisX}軸`, key: 'ctx', render: (_v: unknown, r: { barycenterCoordinates: number[] }) => (r.barycenterCoordinates[axisX - 1] ?? 0).toFixed(3) },
                          { title: `寄与 第${axisX}軸`, key: 'ctrx', render: (_v: unknown, r: { barycenterCoordinates: number[]; contributions: number[] }) => (r.contributions[axisX - 1] ?? 0).toFixed(4) },
                        ]}
                        pagination={{ pageSize: 20 }}
                        onRow={(record) => ({ onClick: () => toggleCat((record as unknown as { categoryId: string }).categoryId) })}
                        rowSelection={{ selectedRowKeys: [...selectedCats], onChange: (keys) => setSelectedCats(new Set(keys as string[])) }}
                      />
                      <div>
                        <Typography.Text strong>診断</Typography.Text>
                        <div>
                          <Typography.Text type="secondary">
                            除外: {Object.entries(result.meta.exclusionCounts).map(([k, v]) => `${k}=${v}`).join(', ')} ／
                            除外 {result.details.omittedCategories.length}件
                          </Typography.Text>
                        </div>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'predict',
                  label: '射影',
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <Typography.Text type="secondary">
                        学習時の平均・標準偏差・カテゴリ確率・列順を固定して新規行を射影します。再学習は行いません。未知カテゴリ・欠損行は未計算として返します。
                      </Typography.Text>
                      <Space wrap align="center">
                        <span>対象</span>
                        <Select
                          style={{ minWidth: 130 }}
                          value={predictScope}
                          onChange={(v) => setPredictScope(v)}
                          options={[
                            { value: 'all', label: 'All' },
                            { value: 'active', label: 'Active' },
                            { value: 'selected', label: 'Selected' },
                            { value: 'sampled', label: 'Sampled' },
                          ]}
                        />
                        <Button type="primary" loading={predicting} disabled={!result || shownStale} onClick={() => void handlePredict()}>
                          射影を実行
                        </Button>
                        {predictInfo && <Tag>{predictInfo}</Tag>}
                      </Space>
                      {predictError && <Alert type="error" message={predictError} />}
                      {predictWarnings.length > 0 && (
                        <Space wrap>
                          {predictWarnings.map((w, i) => (
                            <Alert key={i} type="warning" message={`${w.code}: ${w.message}`} showIcon />
                          ))}
                        </Space>
                      )}
                      {predictMeta && (predictMeta.datasetId !== datasetId || predictMeta.resultId !== result?.resultId) ? (
                        <Alert type="warning" message="表示中の射影は別の分析・データセットの結果です。再実行してください。" />
                      ) : (
                        <>
                          {predictMeta && (
                            <Typography.Text type="secondary">
                              {`取得軸：第${predictMeta.axes.join('・第')}軸（表示軸と異なる場合は取得時の軸名で表示します）`}
                            </Typography.Text>
                          )}
                          <Table
                            size="small"
                            title={() => '射影結果（先頭20行）'}
                            dataSource={predictRows.slice(0, 20).map((r) => ({ ...r, key: r.rowId }))}
                            columns={[
                              { title: 'rowId', dataIndex: 'rowId', key: 'rowId' },
                              { title: '状態', dataIndex: 'predictionStatus', key: 'predictionStatus' },
                              {
                                title: predictMeta ? `座標 第${predictMeta.axes[0]}軸` : '座標', key: 'pcx',
                                render: (_v: unknown, r: { coordinates: (number | null)[] }) => {
                                  const v = r.coordinates[0]
                                  return v === null || v === undefined ? '—' : Number(v).toFixed(3)
                                },
                              },
                            ]}
                            pagination={false}
                          />
                          <Typography.Text type="secondary">{`対象 ${predictTotal}行・成功 ${predictOk}行`}</Typography.Text>
                        </>
                      )}
                    </div>
                  ),
                },
                {
                  key: 'save',
                  label: '保存・出力',
                  children: (
                    <Space wrap>
                      <span>軸</span>
                      <Select value={matAxis} onChange={setMatAxis} options={Array.from({ length: rank }, (_, i) => ({ value: i + 1, label: `第${i + 1}軸` }))} style={{ minWidth: 120 }} />
                      <Button
                        disabled={shownStale}
                        onClick={() => {
                          void (async () => {
                            try {
                              const res = await api.post<{ createdColumns: { name: string }[]; writtenRowCount: number; dataRevision: number; schemaRevision: number }>(
                                `/analysis-results/${result!.resultId}/materialize`,
                                {
                                  context: buildContext(),
                                  source: 'fit',
                                  columns: [{ sourceField: `coordinate:${matAxis}`, name: `FAMD${matAxis}`, label: `FAMD第${matAxis}軸` }],
                                  idempotencyKey: `${result!.resultId}-fit-${matAxis}`,
                                },
                              )
                              if (datasetId) {
                                invalidateColumnarCache()
                                dispatch(datasetValuesUpdated({ datasetId, dataRevision: res.dataRevision }))
                                await dispatch(fetchCodebookThunk(datasetId))
                              }
                              message.success(`FAMD${matAxis}を保存しました（${res.writtenRowCount}行）。新列がTableに表示されます。`)
                            } catch (err) {
                              message.error(apiErrorMessage(err, '保存に失敗しました。'))
                            }
                          })()
                        }}
                      >
                        FAMD{matAxis}を派生列へ保存
                      </Button>
                      <Button onClick={() => void exportFamdTable(result.resultId, 'eigenvalues', 'csv')}>固有値CSV</Button>
                      <Button onClick={() => void exportFamdTable(result.resultId, 'categories', 'csv')}>カテゴリCSV</Button>
                      <Button onClick={() => void exportFamdTable(result.resultId, 'variables', 'csv')}>変数CSV</Button>
                      <Button onClick={() => void exportFamdTable(result.resultId, 'rows', 'csv')}>個体CSV（全件）</Button>
                      <Button onClick={() => void exportFamdTable(result.resultId, 'manifest', 'json')}>設定JSON</Button>
                      <Button onClick={() => { if (svgIndRef.current) downloadSvg(svgIndRef.current, `famd-ind-${result.resultId}.svg`) }}>個体図SVG</Button>
                      <Button onClick={() => { if (svgCatRef.current) downloadSvg(svgCatRef.current, `famd-cat-${result.resultId}.svg`) }}>カテゴリ図SVG</Button>
                      <Button onClick={() => { if (svgIndRef.current) downloadPng(svgIndRef.current, `famd-ind-${result.resultId}.png`) }}>個体図PNG</Button>
                    </Space>
                  ),
                },
              ]}
            />
            {shownStale && <Alert type="warning" style={{ marginTop: 8 }} message="データ版が更新されました。表示は旧版のままです。選択・保存・予測はできません。" />}
          </Card>
        </>
      )}
    </div>
  )
}
