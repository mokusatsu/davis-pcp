import { useAnalysisResultLifecycle } from './useAnalysisResultLifecycle'
import AsyncExportButton from '../common/AsyncExportButton'
import { AnalysisField, AnalysisSettings, AnalysisRunRow } from '../common/AnalysisSetup'
import { editorModalOpened } from '../dataset/codebookSlice'
import { useAnalysisScope, AnalysisScopeSummary, captureAnalysisRunContext, type AnalysisScopeSnapshot } from '../selection/analysisScope'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Alert, Button, Card, Radio, Select, Space, Spin, Tag, Typography, message,
} from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectOrdinaryVariables } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import GraphPanel from '../common/GraphPanel'
import { getBrushOp } from '../selection/SelectionMenu'
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
      .map((c) => ({ value: c.name, label: c.name, name: c.name, questionName: c.name, questionText: c.label })),
    [columns, activeSet, hasGlobalSignal],
  )
  const rowLabelOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal', 'binary', 'text', 'id'].includes(c.scaleType) && !c.multiResponseGroup)
      .map((c) => ({ value: c.name, label: c.name, questionName: c.name, questionText: c.label })),
    [columns],
  )
  const numericOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.name, label: c.name, questionName: c.name, questionText: c.label })),
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
    cellSemantics, ack, analysisScope.scopeKey, effectiveMissing, weightChoice,
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

  const weightConflict = inputKind === 'contingency' && weightChoice === 'dataset' && Boolean(savedWeightColumnId)
  const canRun = !weightConflict && unavailableVariables.length === 0 && (inputKind === 'respondents'
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

  const resultStale = result !== null
    && (result.meta.dataRevision !== selection.dataRevision || result.meta.schemaRevision !== schemaRevision)

  const { liveRevisions, linkedCategoryIds } = useAnalysisResultLifecycle(
    result, datasetId, selection.selectedRowIds, selection.dataRevision, schemaRevision,
  )

  const effectiveStale = result !== null && liveRevisions !== null
    && (result.meta.dataRevision !== liveRevisions.data || result.meta.schemaRevision !== liveRevisions.schema)
  const shownStale = resultStale || effectiveStale

  const openCodebook = () => dispatch(editorModalOpened())
  const categoricalHint = (side: string) => ({
    roleLabel: side,
    reason: '現在の共通選択内に使えるカテゴリ変数がありません。',
    guidance: '共通選択で対象列を含め、コードブックで尺度が名義・順序・二値のいずれかか確認してください。MA選択肢列は使用できません。',
    onOpenCodebook: openCodebook,
  })
  const missingOptions = [
    { value: 'exclude', label: '欠損を除外' },
    { value: 'include_missing', label: '欠損を含める' },
    { value: 'separate_not_applicable', label: '非該当を分離' },
  ]
  const missingLabel = missingOptions.find(option => option.value === effectiveMissing)?.label
  const weightSummary = weightChoice === 'dataset'
    ? (savedWeightColumnId ? `重み: データ設定（${savedWeightType ?? '種類未宣言'}）` : '重み: データ設定（なし）') : '重みなし'

  if (!datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="correspondence-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card size="small" title="コレスポンデンス分析 (CA)" className="analysis-setup">
        <div className="analysis-form-stack">
          <Typography.Text type="secondary">変数と入力形式を選び、必要に応じて次回の分析設定を変更してください。</Typography.Text>
          <AnalysisField label="入力形式">
            <Radio.Group aria-label="CAの入力形式" value={inputKind} onChange={(e) => setInputKind(e.target.value)}>
              <Radio.Button value="respondents">回答者データ</Radio.Button>
              <Radio.Button value="contingency">分割表</Radio.Button>
            </Radio.Group>
          </AnalysisField>
          <div className="analysis-variable-grid">
            {inputKind === 'respondents' ? <>
              <AnalysisField label="行変数（必須）" htmlFor="ca-row-variable" help="共通選択内のカテゴリ変数から選択します。">
                <SelectColumn id="ca-row-variable" aria-describedby="ca-row-variable-help" aria-label="CAの行変数" roleName="CAの行変数"
                  style={{ width: '100%', minWidth: 0 }} placeholder="行変数" value={rowVar}
                  onChange={(v) => setRowVar(v as string)} options={categoricalOptions}
                  emptyHint={categoricalHint('行')} />
              </AnalysisField>
              <AnalysisField label="列変数（必須）" htmlFor="ca-column-variable" help="行変数とは異なるカテゴリ変数を選択します。">
                <SelectColumn id="ca-column-variable" aria-describedby="ca-column-variable-help" aria-label="CAの列変数" roleName="CAの列変数"
                  style={{ width: '100%', minWidth: 0 }} placeholder="列変数" value={colVar}
                  onChange={(v) => setColVar(v as string)} options={categoricalOptions}
                  emptyHint={categoricalHint('列')} />
              </AnalysisField>
            </> : <>
              <AnalysisField label="行ラベル列（必須）" htmlFor="ca-row-label" help="カテゴリ・文字列・IDの列を選択します。">
                <SelectColumn id="ca-row-label" aria-describedby="ca-row-label-help" aria-label="CAの行ラベル列" roleName="CAの行ラベル列"
                  style={{ width: '100%', minWidth: 0 }} placeholder="行ラベル" value={rowLabelCol}
                  onChange={(v) => setRowLabelCol(v as string)} options={rowLabelOptions}
                  emptyHint={{ roleLabel: '行ラベル', reason: '行ラベルに使えるカテゴリ・文字列・ID列がありません。',
                    guidance: 'コードブックで列の尺度を確認してください。MA選択肢列は使用できません。', onOpenCodebook: openCodebook }} />
              </AnalysisField>
              <AnalysisField label="数値セル列（必須・2列以上）" htmlFor="ca-value-columns" help="共通選択内の間隔・比例尺度の列を選択します。">
                <SelectColumn id="ca-value-columns" aria-describedby="ca-value-columns-help" aria-label="CAの数値セル列" roleName="CAの数値セル列" mode="multiple"
                  style={{ width: '100%', minWidth: 0 }} placeholder="数値セル列（2列以上）" value={valueCols}
                  onChange={(v) => setValueCols(v as string[])} options={numericOptions}
                  emptyHint={{ roleLabel: '数値セル', reason: '現在の共通選択内に使える間隔・比例尺度の列がありません。',
                    guidance: '共通選択で対象列を含め、コードブックで尺度を確認してください。MA選択肢列は使用できません。', onOpenCodebook: openCodebook }} />
              </AnalysisField>
            </>}
          </div>
          {inputKind === 'contingency' && <>
            <AnalysisField label="セル値の意味">
              <Radio.Group aria-label="CAのセル値の意味" value={cellSemantics} onChange={(e) => setCellSemantics(e.target.value)}>
                <Radio.Button value="frequency">度数 (frequency)</Radio.Button>
                <Radio.Button value="mass">質量 (mass)</Radio.Button>
              </Radio.Group>
            </AnalysisField>
            {cellSemantics === 'frequency' && <label>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              セルが独立した観測の度数であることを確認する
            </label>}
            <Typography.Text type="secondary">分割表の対象件数はカテゴリ行数です（回答者数ではありません）。</Typography.Text>
          </>}
          <AnalysisScopeSummary snapshot={completed?.snapshot} />
          <AnalysisSettings title="重み・欠損値（次回の分析）" attention={weightConflict}
            summary={`${weightSummary} ／ ${missingLabel}`}>
            <div className="analysis-variable-grid">
              <AnalysisField label="欠損値の扱い" htmlFor="ca-missing-policy" help={inputKind === 'contingency' ? '分割表では欠損を除外します。' : undefined}>
                <Select id="ca-missing-policy" aria-describedby={inputKind === 'contingency' ? 'ca-missing-policy-help' : undefined} aria-label="CAの欠損値の扱い" style={{ width: '100%' }}
                  value={effectiveMissing} onChange={(v) => setMissingPolicy(v)}
                  options={missingOptions} disabled={inputKind === 'contingency'} />
              </AnalysisField>
              <AnalysisField label="重み" htmlFor="ca-weight" help="分割表にデータ設定の重みを重ねて適用することはできません。">
                <Select id="ca-weight" aria-describedby="ca-weight-help" aria-label="CAの重み" style={{ width: '100%' }} value={weightChoice}
                  onChange={(v) => setWeightChoice(v)} options={[
                    { value: 'dataset', label: savedWeightColumnId ? `データ設定 (${savedWeightType ?? '未宣言'})` : 'データ設定（なし）' },
                    { value: 'none', label: '重みなし' },
                  ]} />
              </AnalysisField>
            </div>
          </AnalysisSettings>
          <AnalysisSettings title="入力・配置図のヘルプ" summary="入力形式、重みと配置図の読み方">
            <Typography.Text>回答者データでは異なる2つのカテゴリ変数を選択します。分割表では行ラベル列と2列以上の数値セル列を選択し、セル値が独立した観測の度数か質量かを指定します。</Typography.Text>
            <Typography.Text>カテゴリ点に回答者のL1色は割り当てません。配置方法は結果の表示設定で、再推定せずに切り替えられます。</Typography.Text>
            <CaHelp />
          </AnalysisSettings>
          {unavailableVariables.length > 0 && <Alert type="warning" message="使用列が共通選択から外れました。再指定してください。" />}
          {weightConflict && <Alert type="warning" message="分割表にはデータ設定の重みを適用できません。「重み・欠損値」で「重みなし」を選択してください。" />}
          {dirty && <Alert type="warning" message="対象または次回の分析設定が変更されています。表示中の結果は前回実行分です。" />}
          <AnalysisRunRow>
            {!canRun && !weightConflict && <Typography.Text type="secondary">{inputKind === 'respondents'
              ? '異なる行変数と列変数を選択してください。'
              : '行ラベル列と数値セル列を2列以上選択し、度数の場合は確認してください。'}</Typography.Text>}
            <Button type="primary" data-testid="ca-run" loading={loading} disabled={!canRun} onClick={() => void handleRun()}>実行</Button>
          </AnalysisRunRow>
        </div>
      </Card>
      {error && <Alert type="error" message={error} />}
      {loading && <Spin tip="CAを計算中…" />}
      {result && (
        <>
          <Card
            size="small"
            title={
              <Space wrap>
                <Tag className="analysis-status-tag">この結果の対象: {completed?.snapshot.label} / rev {result.meta.dataRevision} (n={result.meta.scopeCount} {(result.config as { input?: { kind?: string } }).input?.kind === 'contingency' ? 'カテゴリ行' : '行'})</Tag>
                <Tag>有効 {result.meta.fitCount}</Tag>
                <Tag>{result.meta.weightApplied ? `加重 (${result.meta.weightType ?? ''})` : '非加重'}</Tag>
                {(result.meta.resultState === 'stale' || shownStale) && <Tag color="orange">stale（古い版）</Tag>}
                <Tag>rank {rank}</Tag>
              </Space>
            }
          >
            <div className="analysis-setup analysis-form-stack" style={{ marginBottom: 12 }}>
              <AnalysisField label="配置図の表示設定" htmlFor="ca-map-scaling" help="表示中の結果にすぐ反映します。再推定は不要です。設定JSONは実行時の設定を出力します。">
                <Radio.Group id="ca-map-scaling" aria-describedby="ca-map-scaling-help" aria-label="CAの配置方法" value={mapScaling} onChange={(e) => setMapScaling(e.target.value)}>
                  <Radio.Button value="symmetric">対称</Radio.Button>
                  <Radio.Button value="row_principal">行主</Radio.Button>
                  <Radio.Button value="column_principal">列主</Radio.Button>
                </Radio.Group>
              </AnalysisField>
            </div>
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
            <div style={{ marginTop: 12, overflowX: 'auto' }}>
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
