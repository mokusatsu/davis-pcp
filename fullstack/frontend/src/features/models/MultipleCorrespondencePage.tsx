import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Radio, Select, Space, Spin, Table, Tabs, Tag, Typography, message } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetValuesUpdated, selectionApplied, selectOrdinaryVariables } from '../../app/store'
import { fetchCodebookThunk } from '../dataset/codebookSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'
import { api } from '../../api/client'
import { useCodebook } from '../dataset/useCodebookColumn'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'
import SelectColumn from '../common/ColumnSelect'
import L1Legend from '../common/L1Legend'
import { useRowColorResolver } from '../../theme/useRowColor'
import type { MCAResponse } from './mcaTypes'
import { exportMcaTable, fetchMcaRows, runMca, selectMca, downloadPng, downloadSvg, type MCAContext } from './mcaApi'
import McaFigure, { axisLabel, categoryPoints } from './McaFigure'

function apiErrorMessage(err: unknown, fallback: string): string {
  const { message: msg, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof msg !== 'string' || !msg) return fallback
  return typeof code === 'string' && code ? `${msg}（${code}）` : msg
}

const VAR_COLORS = ['#1890ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2', '#fadb14', '#2f54eb', '#a0d911', '#fa541c']

export default function MultipleCorrespondencePage(): JSX.Element {
  const { focused } = useFocusMode()
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
  const ordinaryOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal', 'binary'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name, name: c.name })),
    [columns, activeSet, hasGlobalSignal],
  )
  const maOptions = useMemo(
    () => columns
      .filter((c) => c.multiResponseGroup && c.scaleType === 'nominal')
      .map((c) => ({ value: c.columnId, label: `${c.label ?? c.name} [MA]` })),
    [columns],
  )
  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of columns) m.set(c.columnId, c.name)
    return m
  }, [columns])

  const [variables, setVariables] = useState<string[]>([])
  const [maMode, setMaMode] = useState<'ordinary_only' | 'explicit_binary_options'>('ordinary_only')
  const [inertiaAdjustment, setInertiaAdjustment] = useState<'raw' | 'benzecri'>('raw')
  const [scope, setScope] = useState<'all' | 'active' | 'selected' | 'sampled'>('active')
  const [missingPolicy, setMissingPolicy] = useState('exclude')
  const [weightChoice, setWeightChoice] = useState<'dataset' | 'none'>('dataset')
  const [axisX, setAxisX] = useState(1)
  const [axisY, setAxisY] = useState(2)
  const [overlay, setOverlay] = useState(false)
  const [tab, setTab] = useState('individuals')

  const [result, setResult] = useState<MCAResponse | null>(null)
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
  const runSequence = useRef(0)
  const svgIndRef = useRef<SVGSVGElement | null>(null)
  const svgCatRef = useRef<SVGSVGElement | null>(null)

  const draftKey = JSON.stringify([datasetId, variables, maMode, inertiaAdjustment, scope, missingPolicy,
    weightChoice, selection.dataRevision, schemaRevision])
  const dirty = result !== null && submittedKey !== '' && draftKey !== submittedKey

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
    setVariables([])
    setMaMode('ordinary_only')
  }, [datasetId])

  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const schemaRef = useRef(schemaRevision)
  schemaRef.current = schemaRevision

  const buildContext = (): MCAContext => ({
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

  const canRun = Boolean(datasetId && variables.length >= 2)

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
      const res = await runMca(buildContext(), variables, maMode, inertiaAdjustment)
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
      message.success('多重対応分析を実行しました。')
    } catch (err) {
      if (seq !== runSequence.current) return
      setError(apiErrorMessage(err, '分析に失敗しました。'))
    } finally {
      if (seq === runSequence.current) setLoading(false)
    }
  }

  const rank = result?.summary.rank ?? 0
  const ratio = result?.summary.rawInertiaRatio ?? []

  const effAxisY = rank >= 2 ? (axisY === axisX ? (axisX === 1 ? 2 : 1) : axisY) : axisX
  const dispRank = rank >= 2 ? 2 : 1
  const wantAxes = rank >= 2 ? [axisX, effAxisY] : [axisX]
  const [rowsMeta, setRowsMeta] = useState<{ resultId: string; axes: number[] } | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)
  // M008: selection is allowed only when the displayed rows match resultId+axes and are not loading.
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
        const page = await fetchMcaRows(resultId, offset, 5000, wantAxesLocal)
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
      const res = await selectMca(result.resultId, buildContext(), selector)
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
        }).catch(() => { /* 版確認の失敗はstale判定に使わない */ })
    }
    check()
    const timer = setInterval(check, 10000)
    return () => { cancelled = true; clearInterval(timer) }
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
    const vars = result?.details.variables ?? []
    vars.forEach((v, i) => map.set(v.variableId, VAR_COLORS[i % VAR_COLORS.length]))
    return (id: string): string => map.get(id) ?? '#8c8c8c'
  }, [result])

  const indPoints = useMemo(() => rows.map((r) => ({
    id: r.rowId,
    label: '',
    x: r.coordinates[0] ?? 0,
    y: r.coordinates.length >= 2 ? r.coordinates[1] : null,
    title: `${r.rowId} 座標=(${(r.coordinates[0] ?? 0).toFixed(3)}${r.coordinates.length >= 2 ? `, ${(r.coordinates[1] ?? 0).toFixed(3)}` : ''})`,
    rowId: r.rowId,
  })), [rows])

  const catPoints = useMemo(() => categoryPoints(result?.details.categories ?? [], varColor, axisX, effAxisY), [result, varColor, axisX, effAxisY])

  const selectedRowIds = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])

  if (!datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="mca-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!focused && (
        <Card size="small" title="多重対応分析（MCA）" extra={<FocusEnterButton targetId="mca" title="MCA" />}>
          <Space wrap align="center">
            <span>分析変数（2つ以上）</span>
            <SelectColumn
              mode="multiple"
              style={{ minWidth: 280 }}
              placeholder="nominal/ordinalを選択"
              value={variables}
              onChange={(v) => setVariables(v as string[])}
              options={ordinaryOptions}
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
            <Select
              style={{ minWidth: 120 }}
              value={inertiaAdjustment}
              onChange={(v) => setInertiaAdjustment(v)}
              options={[
                { value: 'raw', label: 'raw慣性' },
                { value: 'benzecri', label: 'Benzécri補正' },
              ]}
            />
            <Button type="primary" data-testid="mca-run" loading={loading} disabled={!canRun} onClick={() => void handleRun()}>
              実行
            </Button>
            <SelectionMenu />
          </Space>
          <Space wrap align="center" style={{ marginTop: 8 }}>
            <span>MA詳細設定</span>
            <Radio.Group value={maMode} onChange={(e) => setMaMode(e.target.value)}>
              <Radio.Button value="ordinary_only">通常のみ</Radio.Button>
              <Radio.Button value="explicit_binary_options">MA子を含める</Radio.Button>
            </Radio.Group>
            {maMode === 'explicit_binary_options' && (
              <Select
                mode="multiple"
                style={{ minWidth: 240 }}
                placeholder="MA子を選択（明示採用のみ）"
                value={variables.filter((v) => maOptions.some((o) => o.value === v))}
                onChange={(ids) => {
                  const idSet = new Set(ids as string[])
                  setVariables((prev) => [...prev.filter((v) => !maOptions.some((o) => o.value === v)), ...(ids as string[])].filter((v, i, a) => a.indexOf(v) === i && (ordinaryOptions.some((o) => o.value === v) || idSet.has(v))))
                }}
                options={maOptions}
              />
            )}
          </Space>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            ordinalは数値間隔を仮定しないカテゴリとして扱います。MA親・count・未解決仮想列は拒否します。MA子は明示選択のみ採用し、非選択もカテゴリです。surveyの推測統計・有意軸は表示しません。
          </Typography.Text>
          {dirty && <Alert type="warning" style={{ marginTop: 8 }} message="設定が変更されています。結果は前回実行分です。" />}
        </Card>
      )}
      {error && <Alert type="error" message={error} />}
      {loading && <Spin tip="MCAを計算中…" />}
      {result && (
        <FocusTarget id="mca" title="MCA結果">
          <Card
            size="small"
            title={
              <Space>
                <Tag>rev {result.meta.dataRevision} / scope {result.meta.scope} (n={result.meta.scopeCount})</Tag>
                <Tag>有効 {result.meta.fitCount}</Tag>
                <Tag>{result.meta.weightApplied ? `加重(${result.meta.weightType})` : '非加重'}</Tag>
                {shownStale && <Tag color="orange">stale（古い版）</Tag>}
                <Tag>m={result.summary.nVariables} K={result.summary.nCategories}</Tag>
                <Tag>rank {rank}</Tag>
              </Space>
            }
          >
            <Space wrap>
              {result.meta.warnings.map((w, i) => (
                <Alert key={i} type={w.code === 'MA_OPTION_BLOCK_WEIGHTING' ? 'info' : 'warning'} message={`${w.code}: ${w.message}`} showIcon />
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
                      <Typography.Text type="secondary">個体主座標の散布図。カテゴリ点との距離は解釈しません。L1色分けに従います。</Typography.Text>
                      <L1Legend />
                      {rowsLoading && <Spin tip="個体座標を取得中…" />}
                      {rowsError && <Alert type="error" message={rowsError} />}
                      {rowsMeta && (rowsMeta.resultId !== result.resultId || rowsMeta.axes.join(',') !== [axisX, effAxisY].slice(0, dispRank).join(',')) && (
                        <Alert type="warning" message="表示中の個体座標は取得中です。選択は取得完了後に行ってください。" />
                      )}
                      <McaFigure
                        points={overlay ? [...indPoints, ...catPoints.map((c) => ({ ...c, rowId: undefined }))] : indPoints}
                        rank={rank}
                        dispRank={dispRank}
                        xAxis={axisX}
                        yAxis={effAxisY}
                        ratio={ratio}
                        selected={selectedRowIds}
                        highlighted={new Set()}
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
                        svgRef={svgIndRef}
                        testId="mca-individual-svg"
                        overlayNote={overlay ? 'カテゴリ点を重ねて表示中（距離の解釈注意）' : undefined}
                      />
                      <Space wrap style={{ marginTop: 8 }}>
                        <span>X軸</span>
                        <Select value={axisX} onChange={setAxisX} options={Array.from({ length: rank }, (_, i) => ({ value: i + 1, label: axisLabel(rank, ratio, i + 1) }))} style={{ minWidth: 160 }} />
                        {rank >= 2 && (
                          <>
                            <span>Y軸</span>
                            <Select value={axisY} onChange={(v) => setAxisY(v === axisX ? effAxisY : v)} options={Array.from({ length: rank }, (_, i) => ({ value: i + 1, label: axisLabel(rank, ratio, i + 1) }))} style={{ minWidth: 160 }} />
                          </>
                        )}
                        <Button onClick={() => setOverlay((v) => !v)}>{overlay ? '重ね合わせを解除' : 'カテゴリ点を重ねる'}</Button>
                      </Space>
                    </div>
                  ),
                },
                {
                  key: 'categories',
                  label: `カテゴリ図（${result.details.categories.length}）`,
                  children: (
                    <div>
                      <Typography.Text type="secondary">カテゴリ主座標。変数ごとに色分けします。個人間距離として説明しません。</Typography.Text>
                      <Space wrap style={{ marginTop: 4, marginBottom: 4 }}>
                        {result.details.variables.map((v) => (
                          <Tag key={v.variableId} color={varColor(v.variableId)}>{v.label ?? nameById.get(v.variableId) ?? v.variableId}</Tag>
                        ))}
                      </Space>
                      <McaFigure
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
                          // M005: enclosed category IDs resolve to a categories selector (M005).
                          const inX = (v: number): boolean => v >= bounds.x[0] && v <= bounds.x[1]
                          const inY = (v: number | null): boolean => bounds.y === null || (v !== null && v >= bounds.y[0] && v <= bounds.y[1])
                          const ids = (result?.details.categories ?? [])
                            .filter((c) => {
                              const x = c.principalCoordinates[axisX - 1] ?? 0
                              const y = c.principalCoordinates.length >= effAxisY ? c.principalCoordinates[effAxisY - 1] : null
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
                        svgRef={svgCatRef}
                        testId="mca-category-svg"
                      />
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
                  key: 'tables',
                  label: '表・診断',
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <Table
                        size="small"
                        title={() => '固有値（raw / Benzécri別系列）'}
                        dataSource={result.summary.eigenvalues.map((v, i) => ({
                          key: i + 1,
                          axis: i + 1,
                          raw: v,
                          rawRatio: result.summary.rawInertiaRatio[i],
                          adj: result.summary.adjustedEigenvalues?.[i] ?? null,
                          adjRatio: result.summary.adjustedInertiaRatio?.[i] ?? null,
                        }))}
                        columns={[
                          { title: '軸', dataIndex: 'axis', key: 'axis' },
                          { title: 'raw固有値', dataIndex: 'raw', key: 'raw', render: (v: number) => v.toFixed(6) },
                          { title: 'raw比率', dataIndex: 'rawRatio', key: 'rawRatio', render: (v: number) => `${(v * 100).toFixed(2)}%` },
                          { title: 'Benzécri固有値', dataIndex: 'adj', key: 'adj', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(6)) },
                          { title: 'Benzécri比率', dataIndex: 'adjRatio', key: 'adjRatio', render: (v: number | null) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`) },
                        ]}
                        pagination={false}
                      />
                      {result.summary.adjustedReason && (
                        <Alert type="info" message={`Benzécri比率なし: ${result.summary.adjustedReason}（1/mを超える固有値がありません）`} />
                      )}
                      <Typography.Text type="secondary">
                        全慣性 {result.summary.totalInertia.toFixed(6)} ＝ (K−m)/m。比率の分母は全慣性で、表示軸内での再正規化はしません。
                      </Typography.Text>
                      <Table
                        size="small"
                        title={() => 'カテゴリ'}
                        dataSource={result.details.categories.map((c) => ({ ...c, key: c.categoryId }))}
                        columns={[
                          { title: '変数', dataIndex: 'variableId', key: 'variableId', render: (value: string) => nameById.get(value) ?? value },
                          { title: 'ラベル', dataIndex: 'label', key: 'label' },
                          { title: '人数', dataIndex: 'physicalCount', key: 'physicalCount' },
                          { title: '質量', dataIndex: 'categoryMass', key: 'categoryMass', render: (value: number) => value.toFixed(4) },
                          { title: `主座標${axisX}`, key: 'pcx', render: (_value: unknown, record: { principalCoordinates: number[] }) => (record.principalCoordinates[axisX - 1] ?? 0).toFixed(3) },
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
                            質量0除外 {result.details.omittedCategories.length}件 ／ MA診断 {result.details.maDiagnostics.length}件
                          </Typography.Text>
                        </div>
                      </div>
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
                                  columns: [{ sourceField: `coordinate:${matAxis}`, name: `MCA${matAxis}`, label: `MCA第${matAxis}軸` }],
                                  idempotencyKey: `${result!.resultId}-fit-${matAxis}`,
                                },
                              )
                              // M004: 中央の版・コードブック・Tableデータを更新する。
                              if (datasetId) {
                                invalidateColumnarCache()
                                dispatch(datasetValuesUpdated({ datasetId, dataRevision: res.dataRevision }))
                                await dispatch(fetchCodebookThunk(datasetId))
                              }
                              message.success(`MCA${matAxis}を保存しました（${res.writtenRowCount}行）。新列がTableに表示されます。`)
                            } catch (err) {
                              message.error(apiErrorMessage(err, '保存に失敗しました。'))
                            }
                          })()
                        }}
                      >
                        MCA{matAxis}を派生列へ保存
                      </Button>
                      <Button onClick={() => void exportMcaTable(result.resultId, 'eigenvalues', 'csv')}>固有値CSV</Button>
                      <Button onClick={() => void exportMcaTable(result.resultId, 'categories', 'csv')}>カテゴリCSV</Button>
                      <Button onClick={() => void exportMcaTable(result.resultId, 'rows', 'csv')}>個体CSV（全件）</Button>
                      <Button onClick={() => void exportMcaTable(result.resultId, 'manifest', 'json')}>設定JSON</Button>
                      <Button onClick={() => { if (svgIndRef.current) downloadSvg(svgIndRef.current, `mca-ind-${result.resultId}.svg`) }}>個体図SVG</Button>
                      <Button onClick={() => { if (svgCatRef.current) downloadSvg(svgCatRef.current, `mca-cat-${result.resultId}.svg`) }}>カテゴリ図SVG</Button>
                      <Button onClick={() => { if (svgIndRef.current) downloadPng(svgIndRef.current, `mca-ind-${result.resultId}.png`) }}>個体図PNG</Button>
                    </Space>
                  ),
                },
              ]}
            />
            {shownStale && <Alert type="warning" style={{ marginTop: 8 }} message="データ版が更新されました。表示は旧版のままです。選択・保存・予測はできません。" />}
          </Card>
        </FocusTarget>
      )}
    </div>
  )
}
