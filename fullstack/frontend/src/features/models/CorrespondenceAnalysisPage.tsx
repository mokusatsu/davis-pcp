import AsyncExportButton from '../common/AsyncExportButton'
import { useAnalysisScope, AnalysisScopeSummary, captureAnalysisRunContext, type AnalysisScopeSnapshot } from '../selection/analysisScope'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Alert, Button, Card, Radio, Select, Space, Spin, Tag, Typography, message,
} from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectOrdinaryVariables } from '../../app/store'
import { api } from '../../api/client'
import { useCodebook } from '../dataset/useCodebookColumn'
import GraphPanel from '../common/GraphPanel'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'
import SelectColumn from '../common/ColumnSelect'
import type { CAResponse } from './caTypes'
import type { MapScaling } from './caMap'
import { runCa, selectCaCategories, type CAContext } from './caApi'
import CaHelp from './caHelp'
import CaFigure from './caFigure'
import { CategoryTable, EigenvalueTable } from './caTables'
import { exportCaTable } from './caExport'

function apiErrorMessage(err: unknown, fallback: string): string {
  const { message: msg, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof msg !== 'string' || !msg) return fallback
  return typeof code === 'string' && code ? `${msg}（${code}）` : msg
}

export default function CorrespondenceAnalysisPage(): JSX.Element {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const analysisScope = useAnalysisScope()
  const codebook = useCodebook()
  const { columns, schemaRevision } = codebook
  const datasetId = selection.datasetId

  const globalVars = useSelector(selectOrdinaryVariables)
  const hasGlobalSignal = globalVars.allVariables.length > 0
  const activeSet = useMemo(() => new Set(globalVars.activeVariableIds), [globalVars.activeVariableIds])
  const weightConfig = codebook.weightConfig
  const categoricalOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal', 'binary'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name, name: c.name })),
    [columns, activeSet, hasGlobalSignal],
  )
  const rowLabelOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal', 'binary', 'text', 'id'].includes(c.scaleType) && !c.multiResponseGroup)
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )
  const numericOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns, activeSet, hasGlobalSignal],
  )

  const [inputKind, setInputKind] = useState<'respondents' | 'contingency'>('respondents')
  const [rowVar, setRowVar] = useState<string | null>(null)
  const [colVar, setColVar] = useState<string | null>(null)
  const [rowLabelCol, setRowLabelCol] = useState<string | null>(null)
  const [valueCols, setValueCols] = useState<string[]>([])
  const [cellSemantics, setCellSemantics] = useState<'frequency' | 'mass'>('frequency')
  const [ack, setAck] = useState(false)
  const [mapScaling, setMapScaling] = useState<MapScaling>('symmetric')
  const [missingPolicy, setMissingPolicy] = useState('exclude')
  const [weightChoice, setWeightChoice] = useState<'dataset' | 'none'>('dataset')

  const savedWeightColumnId = weightConfig?.weightColumnId ?? null
  const savedWeightType = weightConfig?.weightType ?? null
  const effectiveMissing = inputKind === 'contingency' ? 'exclude' : missingPolicy

  const [completed, setCompleted] = useState<{ result: CAResponse; context: CAContext; snapshot: AnalysisScopeSnapshot } | null>(null)
  const result = completed?.result ?? null
  const resultContext = completed?.context
  const resultRef = useRef(result)
  resultRef.current = result
  const [submittedKey, setSubmittedKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set())
  const [between, setBetween] = useState<'and' | 'or'>('and')
  const [selecting, setSelecting] = useState(false)
  const [selectInfo, setSelectInfo] = useState<string | null>(null)
  const runSequence = useRef(0)
  const selectionSequence = useRef(0)
  useEffect(() => () => {
    runSequence.current += 1
    selectionSequence.current += 1
  }, [])
  const svgRef = useRef<SVGSVGElement | null>(null)

  const unavailableVariables = inputKind === 'respondents'
    ? [rowVar, colVar].filter((id): id is string => Boolean(id) && !categoricalOptions.some(option => option.value === id))
    : valueCols.filter(id => !numericOptions.some(option => option.value === id))
  const draftKey = JSON.stringify([datasetId, inputKind, rowVar, colVar, rowLabelCol, valueCols,
    cellSemantics, ack, mapScaling, analysisScope.scopeKey, effectiveMissing, weightChoice,
    selection.dataRevision, schemaRevision, unavailableVariables])
  const dirty = result !== null && submittedKey !== '' && draftKey !== submittedKey

  useEffect(() => {
    runSequence.current += 1
    selectionSequence.current += 1
    setCompleted(null)
    setSubmittedKey('')
    setError(null)
    setLoading(false)
    setSelecting(false)
    setSelectedCats(new Set())
    setSelectInfo(null)
    setLinkedCategoryIds(new Set())
    setWeightChoice('dataset')
    setMissingPolicy('exclude')
  }, [datasetId])

  const buildContext = (): CAContext => ({
    datasetId: datasetId ?? '',
    expectedDataRevision: selection.dataRevision,
    expectedSchemaRevision: schemaRevision,
    ...analysisScope.contextRows,
    weightMode: weightChoice,
    missingPolicy: effectiveMissing,
  })

  const canRun = unavailableVariables.length === 0 && (inputKind === 'respondents'
    ? Boolean(datasetId && rowVar && colVar && rowVar !== colVar)
    : Boolean(datasetId && rowLabelCol && valueCols.length >= 2
      && rowLabelOptions.some(option => option.value === rowLabelCol)
      && !valueCols.includes(rowLabelCol ?? '') && (cellSemantics === 'mass' || ack)))

  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const schemaRef = useRef(schemaRevision)
  schemaRef.current = schemaRevision

  const handleRun = async (): Promise<void> => {
    if (!datasetId || !canRun) return
    const seq = ++runSequence.current
    const startedDataset = datasetId
    const startedContext = captureAnalysisRunContext(buildContext())
    const startedScope = analysisScope
    selectionSequence.current += 1
    setSelecting(false)
    const startedDataRev = selectionRef.current.dataRevision
    const startedSchemaRev = schemaRef.current
    const startedKey = draftKey
    setLoading(true)
    setError(null)
    try {
      const input = inputKind === 'respondents'
        ? { kind: 'respondents' as const, rowVariable: rowVar ?? '', columnVariable: colVar ?? '' }
        : {
            kind: 'contingency' as const,
            rowLabelColumn: rowLabelCol ?? '',
            valueColumns: valueCols,
            cellSemantics,
            independentCountsAcknowledged: cellSemantics === 'frequency' ? ack : false,
          }
      const res = await runCa(startedContext, input, mapScaling)
      if (seq !== runSequence.current) return
      if (selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRev
        || schemaRef.current !== startedSchemaRev) return
      setCompleted({ result: res, context: startedContext, snapshot: startedScope })
      setSubmittedKey(startedKey)
      setMapScaling((res.details.mapScaling as MapScaling) ?? 'symmetric')
      setSelectedCats(new Set())
      setSelectInfo(null)
      message.success('コレスポンデンス分析を実行しました。')
    } catch (err) {
      if (seq !== runSequence.current) return
      if (selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRev
        || schemaRef.current !== startedSchemaRev) return
      setError(apiErrorMessage(err, '分析に失敗しました。'))
    } finally {
      if (seq === runSequence.current) setLoading(false)
    }
  }

  const toggleCat = (id: string): void => {
    setSelectedCats((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSelect = async (): Promise<void> => {
    if (!result || !resultContext || loading || shownStale || selectedCats.size === 0) return
    const ids = [...selectedCats]
    const isContingency = (result.config as { input?: { kind?: string } })?.input?.kind === 'contingency'
    if (isContingency) {
      const colIds = new Set(result.details.columnCategories.map((c) => c.categoryId))
      const onlyCols = ids.every((id) => colIds.has(id))
      if (onlyCols) {
        message.info('列カテゴリは列強調のみです。行カテゴリを選択してください。')
        return
      }
      const rowOnly = ids.filter((id) => !colIds.has(id))
      if (rowOnly.length !== ids.length) {
        message.info('列カテゴリは列強調のみのため、行カテゴリだけを選択します。')
      }
      ids.splice(0, ids.length, ...rowOnly)
      if (ids.length === 0) return
    }
    setSelecting(true)
    setSelectInfo(null)
    // Preserve the interaction's operation while row IDs are resolved.
    const operation = getBrushOp()
    const seq = ++selectionSequence.current
    const startedDataset = datasetId
    const startedDataRev = selectionRef.current.dataRevision
    const startedSchemaRev = schemaRef.current
    try {
      const res = await selectCaCategories(result.resultId, resultContext, ids, between)
      if (seq !== selectionSequence.current || resultRef.current?.resultId !== result.resultId) return
      if (selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRev
        || schemaRef.current !== startedSchemaRev) return
      const active = new Set(selectionRef.current.activeRowIds)
      const eligibleRows = res.rowIds.filter(id => active.has(id))
      const outsideActive = res.rowIds.length - eligibleRows.length
      dispatch(selectionApplied({
        rowIds: eligibleRows,
        operation,
        label: `CA選択 (${eligibleRows.length}行, ${between === 'and' ? 'AND' : 'OR'})`,
      }))
      setSelectInfo(`一致 ${res.matchedCount} / 適用 ${eligibleRows.length}${outsideActive ? ` / Active外 ${outsideActive}行` : ''}`)
    } catch (err) {
      if (seq !== selectionSequence.current || resultRef.current?.resultId !== result.resultId) return
      if (selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRev
        || schemaRef.current !== startedSchemaRev) return
      message.error(apiErrorMessage(err, '選択の解決に失敗しました。'))
    } finally {
      if (seq === selectionSequence.current) setSelecting(false)
    }
  }

  const rank = result?.summary.rank ?? 0

  const [linkedCategoryIds, setLinkedCategoryIds] = useState<Set<string>>(new Set())

  const resultStale = result !== null
    && (result.meta.dataRevision !== selection.dataRevision || result.meta.schemaRevision !== schemaRevision)

  const [liveRevisions, setLiveRevisions] = useState<{ data: number; schema: number } | null>(null)

  useEffect(() => {
    if (!result || !datasetId) {
      setLiveRevisions(null)
      return
    }
    let cancelled = false
    const startedDataset = datasetId
    const check = (): void => {
      void api.get<{ dataRevision: number; schemaRevision: number }>(`/datasets/${startedDataset}`)
        .then((meta) => {
          if (!cancelled && datasetId === startedDataset) {
            setLiveRevisions({ data: meta.dataRevision, schema: meta.schemaRevision })
          }
        }).catch(() => { /* 版確認の失敗はstale判定に使わない */ })
    }
    check()
    const timer = setInterval(check, 10000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [result?.resultId, datasetId])

  const effectiveStale = result !== null && liveRevisions !== null
    && (result.meta.dataRevision !== liveRevisions.data || result.meta.schemaRevision !== liveRevisions.schema)
  const shownStale = resultStale || effectiveStale

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
            `/analysis-results/${resultId}/export`,
            { format: 'json', table: 'members', offset, limit: 5000 },
          )
          if (cancelled || selectionRef.current.datasetId !== startedDataset) return
          let rows: [string, string, string][] = []
          try {
            rows = JSON.parse(res.payload)?.rows ?? []
          } catch {
            rows = []
          }
          for (const [cid, rid] of rows) {
            if (selSet.has(String(rid))) hit.add(String(cid))
          }
          if (res.nextOffset === null || res.nextOffset === undefined) break
          offset = res.nextOffset
        }
        if (!cancelled && selectionRef.current.datasetId === startedDataset) setLinkedCategoryIds(hit)
      } catch {
        if (!cancelled && selectionRef.current.datasetId === startedDataset) {
          setLinkedCategoryIds(new Set())
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, selection.selectedRowIds, datasetId, selection.dataRevision])

  if (!datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="correspondence-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {(
        <Card size="small" title="コレスポンデンス分析 (CA)">
          <Space wrap align="center">
            <Radio.Group value={inputKind} onChange={(e) => setInputKind(e.target.value)}>
              <Radio.Button value="respondents">回答者データ</Radio.Button>
              <Radio.Button value="contingency">分割表</Radio.Button>
            </Radio.Group>
            {inputKind === 'respondents' ? (
              <>
                <span>行変数</span>
                <SelectColumn
                  style={{ minWidth: 200 }}
                  placeholder="行変数"
                  value={rowVar}
                  onChange={(v) => setRowVar(v as string)}
                  options={categoricalOptions}
                />
                <span>列変数</span>
                <SelectColumn
                  style={{ minWidth: 200 }}
                  placeholder="列変数"
                  value={colVar}
                  onChange={(v) => setColVar(v as string)}
                  options={categoricalOptions}
                />
              </>
            ) : (
              <>
                <span>行ラベル列</span>
                <SelectColumn
                  style={{ minWidth: 180 }}
                  placeholder="行ラベル"
                  value={rowLabelCol}
                  onChange={(v) => setRowLabelCol(v as string)}
                  options={rowLabelOptions}
                />
                <span>セル列</span>
                <SelectColumn
                  mode="multiple"
                  style={{ minWidth: 240 }}
                  placeholder="数値セル列（2列以上）"
                  value={valueCols}
                  onChange={(v) => setValueCols(v as string[])}
                  options={numericOptions}
                />
                <Radio.Group value={cellSemantics} onChange={(e) => setCellSemantics(e.target.value)}>
                  <Radio.Button value="frequency">frequency</Radio.Button>
                  <Radio.Button value="mass">mass</Radio.Button>
                </Radio.Group>
                {cellSemantics === 'frequency' && (
                  <label>
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    セルが独立した観測の度数であることを確認する
                  </label>
                )}
              </>
            )}
            <AnalysisScopeSummary snapshot={completed?.snapshot} />
            <Select
              style={{ minWidth: 140 }}
              value={inputKind === 'contingency' ? 'exclude' : missingPolicy}
              onChange={(v) => setMissingPolicy(v)}
              options={[
                { value: 'exclude', label: '欠損を除外' },
                { value: 'include_missing', label: '欠損を含める' },
                { value: 'separate_not_applicable', label: '非該当を分離' },
              ]}
              disabled={inputKind === 'contingency'}
            />
            <Select
              style={{ minWidth: 170 }}
              value={weightChoice}
              onChange={(v) => setWeightChoice(v)}
              options={[
                { value: 'dataset', label: savedWeightColumnId ? `重み: データ設定 (${savedWeightType ?? '未宣言'})` : '重み: データ設定（なし）' },
                { value: 'none', label: '重みなし' },
              ]}
            />
            <Radio.Group value={mapScaling} onChange={(e) => setMapScaling(e.target.value)}>
              <Radio.Button value="symmetric">対称</Radio.Button>
              <Radio.Button value="row_principal">行主</Radio.Button>
              <Radio.Button value="column_principal">列主</Radio.Button>
            </Radio.Group>
            <Button type="primary" data-testid="ca-run" loading={loading} disabled={!canRun} onClick={() => void handleRun()}>
              実行
            </Button>
            <SelectionMenu />
          </Space>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            重み: {weightChoice === 'dataset' ? (savedWeightColumnId ? `データ設定（${savedWeightType ?? '種類未宣言'}）` : 'データ設定（なし）') : 'なし'}。分割表モードではdataset重みがあると二重ウェイトで実行できません。カテゴリ点に回答者のL1色は割り当てません。
          </Typography.Text>
          {unavailableVariables.length > 0 && <Alert type="warning" message="使用列が共通選択から外れました。再指定してください。" />}
          {inputKind === 'contingency' && <Typography.Text type="secondary">分割表の対象件数はカテゴリ行数です（回答者数ではありません）。</Typography.Text>}
          {dirty && <Alert type="warning" style={{ marginTop: 8 }} message="対象または設定が変更されています。結果は前回実行分です。" />}
        </Card>
      )}
      {error && <Alert type="error" message={error} />}
      {loading && <Spin tip="CAを計算中…" />}
      {result && (
        <>
          <Card
            size="small"
            title={
              <Space>
                <Tag>この結果の対象: {completed?.snapshot.label} / rev {result.meta.dataRevision} (n={result.meta.scopeCount} {(result.config as { input?: { kind?: string } }).input?.kind === 'contingency' ? 'カテゴリ行' : '行'})</Tag>
                <Tag>有効 {result.meta.fitCount}</Tag>
                <Tag>{result.meta.weightApplied ? `加重 (${result.meta.weightType ?? ''})` : '非加重'}</Tag>
                {(result.meta.resultState === 'stale' || shownStale) && <Tag color="orange">stale（古い版）</Tag>}
                <Tag>rank {rank}</Tag>
              </Space>
            }
          >
            <CaHelp />
            <GraphPanel
              graphId="ca/map"
              title="行・列カテゴリ配置図"
              available={Boolean(result)}
              sizing="intrinsic"
              intrinsicSize={{ width: 560, height: 420 }}
            >
            <div style={{ marginTop: 8 }}>
              <CaFigure
                rows={result.details.rowCategories}
                cols={result.details.columnCategories}
                rank={rank}
                ratio={result.summary.inertiaRatio}
                scaling={mapScaling}
                selected={selectedCats}
                highlighted={linkedCategoryIds}
                onToggle={toggleCat}
                svgRef={svgRef}
              />
            </div>
            </GraphPanel>
            <Space wrap style={{ marginTop: 8 }}>
              <Radio.Group value={between} onChange={(e) => setBetween(e.target.value)}>
                <Radio.Button value="and">両側AND</Radio.Button>
                <Radio.Button value="or">両側OR</Radio.Button>
              </Radio.Group>
              {shownStale && (
                <Alert
                  type="warning"
                  showIcon
                  message="結果の版が古くなっています。選択の適用はできません。再実行してください。"
                />
              )}
              <Button loading={selecting} disabled={selectedCats.size === 0 || shownStale} onClick={() => void handleSelect()}>
                原行IDへ解決して選択 ({selectedCats.size})
              </Button>
              {selectInfo && <Tag>{selectInfo}</Tag>}
              <AsyncExportButton exportKey={result.resultId} statusLabel="固有値CSV" onExport={() => exportCaTable(result.resultId, 'eigenvalues', 'csv')}>固有値CSV</AsyncExportButton>
              <AsyncExportButton exportKey={result.resultId} statusLabel="固有値JSON" onExport={() => exportCaTable(result.resultId, 'eigenvalues', 'json')}>固有値JSON</AsyncExportButton>
              <AsyncExportButton exportKey={result.resultId} statusLabel="カテゴリCSV" onExport={() => exportCaTable(result.resultId, 'categories', 'csv')}>カテゴリCSV</AsyncExportButton>
              <AsyncExportButton exportKey={result.resultId} statusLabel="分割表CSV" onExport={() => exportCaTable(result.resultId, 'table', 'csv')}>分割表CSV</AsyncExportButton>
              <AsyncExportButton exportKey={result.resultId} statusLabel="分割表JSON" onExport={() => exportCaTable(result.resultId, 'table', 'json')}>分割表JSON</AsyncExportButton>
              <AsyncExportButton exportKey={result.resultId} statusLabel="設定JSON" onExport={() => exportCaTable(result.resultId, 'manifest', 'json')}>設定JSON</AsyncExportButton>
            </Space>
            <div style={{ marginTop: 12 }}>
              <EigenvalueTable
                eigenvalues={result.summary.eigenvalues}
                ratio={result.summary.inertiaRatio}
                cumulative={result.summary.cumulativeInertiaRatio}
              />
              <Typography.Text type="secondary">
                全慣性 {result.summary.totalInertia.toFixed(6)} ／ 2軸表示の寄与率は全慣性を分母とします（表示軸内での再正規化なし）。
              </Typography.Text>
            </div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <CategoryTable title="行カテゴリ" rows={result.details.rowCategories} rank={rank} />
              <CategoryTable title="列カテゴリ" rows={result.details.columnCategories} rank={rank} />
            </div>
            <div style={{ marginTop: 12 }}>
              <Typography.Text strong>元の二元表</Typography.Text>
              <table style={{ borderCollapse: 'collapse', marginTop: 4 }}>
                <tbody>
                  {result.details.table.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} style={{ border: '1px solid #d9d9d9', padding: '2px 8px', textAlign: 'right' }}>
                          {v.toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12 }}>
              <Typography.Text strong>診断</Typography.Text>
              <div>
                {result.summary.pearson.status === 'available' ? (
                  <Typography.Text>
                    参考検定 χ²={result.summary.pearson.statistic?.toFixed(3)} df={result.summary.pearson.df} p=
                    {result.summary.pearson.pValue === null ? '—' : result.summary.pearson.pValue.toExponential(2)}
                    （独立度数と宣言された表のみ。軸の有意性検定ではありません）
                  </Typography.Text>
                ) : (
                  <Typography.Text>参考p値は非適用（{result.summary.pearson.reason}）。survey・mass入力には通常Pearson p値を付けません。</Typography.Text>
                )}
              </div>
              <div>
                <Typography.Text type="secondary">
                  除外: {Object.entries(result.meta.exclusionCounts).map(([k, v]) => `${k}=${v}`).join(', ')} ／
                  質量0除外 {result.details.omittedCategories.length}件 ／ 個体座標保存・予測は未対応
                </Typography.Text>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
