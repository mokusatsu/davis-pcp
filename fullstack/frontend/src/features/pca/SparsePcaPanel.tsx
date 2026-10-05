import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Checkbox, InputNumber, Radio, Select, Space, Table, Typography } from 'antd'
import { hovered, selectOrdinaryVariables, selectionApplied, type RootState } from '../../app/store'
import ColumnSelect from '../common/ColumnSelect'
import { AnalysisField, AnalysisRunRow } from '../common/AnalysisSetup'
import { editorModalOpened } from '../dataset/codebookSlice'
import AsyncExportButton from '../common/AsyncExportButton'
import { useRequestIdentity } from '../common/useRequestIdentity'
import { useCodebook } from '../dataset/useCodebookColumn'
import { AnalysisScopeSummary, captureAnalysisRunContext, useAnalysisScope, useAnalysisViewActive, type AnalysisScopeSnapshot } from '../selection/analysisScope'
import { exportSparsePcaTable, fetchSparsePcaRows, isSparsePcaFitPending, runSparsePca, subscribeSparsePcaFit } from './sparsePcaApi'
import { DEFAULT_SPARSE_PCA_SETTINGS, sparsePcaColumnEligible, sparsePcaHasWeight, sparsePcaSettingsError, type SparsePcaSettings } from './sparsePcaSettings'
import SparsePcaResultTables from './SparsePcaResultTables'
import SparsePcaScorePlot from './SparsePcaScorePlot'
import type { SparsePcaExportTable, SparsePcaRequest, SparsePcaResponse, SparsePcaRow } from './sparsePcaTypes'

const EXPORT_LABELS: Record<SparsePcaExportTable, string> = {
  manifest: '保存結果', coefficients: 'B/W係数', variables: '変数–得点相関', diagnostics: '診断', rows: '全行の得点',
}
function failureMessage(failure: unknown): string {
  if (failure && typeof failure === 'object' && 'message' in failure) {
    return `${String(failure.message)}${'code' in failure && failure.code ? `（${String(failure.code)}）` : ''}`
  }
  return 'SparsePCAの処理に失敗しました。'
}
interface Completed {
  identity: string
  result: SparsePcaResponse
  request: SparsePcaRequest
  scope: AnalysisScopeSnapshot
  draftKey: string
}

export default function SparsePcaPanel() {
  const dispatch = useDispatch()
  const controlId = useId()
  const columnsId = `${controlId}-columns`
  const selection = useSelector((state: RootState) => state.selection)
  const globalVariables = useSelector(selectOrdinaryVariables)
  const { columns, schemaRevision, weightConfig, surveyDesign, isLoading: codebookLoading } = useCodebook()
  const active = useAnalysisViewActive()
  const scope = useAnalysisScope()
  const datasetId = selection.datasetId
  const identity = JSON.stringify([datasetId, selection.dataRevision, schemaRevision])
  const runRequest = useRequestIdentity(JSON.stringify([identity, active]))
  const fitPending = useSyncExternalStore(subscribeSparsePcaFit, isSparsePcaFitPending)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [waitingForRun, setWaitingForRun] = useState(false)
  const [chosen, setChosen] = useState<{ datasetId: string; ids: string[] } | null>(null)
  const [ordinalAcknowledged, setOrdinalAcknowledged] = useState<Record<string, boolean>>({})
  const [settings, setSettings] = useState<SparsePcaSettings>({ ...DEFAULT_SPARSE_PCA_SETTINGS })
  const [preprocessing, setPreprocessing] = useState<SparsePcaRequest['preprocessing']>('correlation')
  const [weightChoice, setWeightChoice] = useState<'dataset' | 'none'>('dataset')
  const [completed, setCompleted] = useState<Completed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [axes, setAxes] = useState<number[]>([1, 2])
  const [rowsState, setRowsState] = useState<{ key: string; rows: SparsePcaRow[]; total: number } | null>(null)
  const [rowsFailure, setRowsFailure] = useState<{ key: string; message: string } | null>(null)
  const [rowsRetry, setRowsRetry] = useState(0)
  const [tablePage, setTablePage] = useState(1)
  const [exportTable, setExportTable] = useState<SparsePcaExportTable>('manifest')

  const candidates = useMemo(() => {
    const activeIds = new Set(globalVariables.activeVariableIds)
    return columns.filter(column => sparsePcaColumnEligible(column)
      && (!globalVariables.allVariables.length || activeIds.has(column.name)))
  }, [columns, globalVariables.activeVariableIds, globalVariables.allVariables.length])
  const selectedIds = chosen?.datasetId === datasetId ? chosen.ids
    : candidates.filter(column => column.scaleType !== 'ordinal').map(column => column.columnId)
  const columnById = new Map(columns.map(column => [column.columnId, column]))
  const selectedOrdinals = selectedIds.map(id => columnById.get(id)).filter(column => column?.scaleType === 'ordinal')
  const unavailableIds = selectedIds.filter(id => !candidates.some(column => column.columnId === id))
  const ordinalMissing = selectedOrdinals.some(column => !ordinalAcknowledged[column!.columnId])
  const unsupportedWeight = weightChoice === 'dataset' && sparsePcaHasWeight(weightConfig, surveyDesign)
  const settingsError = sparsePcaSettingsError(settings)
  const canRun = Boolean(datasetId && selectedIds.length >= 2 && !unavailableIds.length && !ordinalMissing
    && !unsupportedWeight && !settingsError && !codebookLoading && active)
  const draftKey = JSON.stringify([identity, scope.scopeKey, selectedIds, ordinalAcknowledged, settings, preprocessing,
    weightChoice, weightConfig, surveyDesign, unavailableIds])
  // Hide an old dataset/revision synchronously, before the reset effect runs.
  const result = completed?.identity === identity ? completed.result : null
  const dirty = Boolean(result && completed?.draftKey !== draftKey)
  const rowsKey = JSON.stringify([identity, result?.resultId, axes])
  const rowsRequest = useRequestIdentity(JSON.stringify([rowsKey, active]))
  const rows = rowsState?.key === rowsKey ? rowsState.rows : []
  const rowsError = rowsFailure?.key === rowsKey ? rowsFailure.message : null
  // Derive pending state synchronously: an axis change must hide the previous
  // coordinates before the fetching effect starts, without closing the graph.
  const rowsLoading = Boolean(active && result && rowsState?.key !== rowsKey && !rowsError)
  const currentView = useRef({ identity, active, resultId: result?.resultId, exportTable })
  currentView.current = { identity, active, resultId: result?.resultId, exportTable }

  useEffect(() => {
    setChosen(null); setOrdinalAcknowledged({}); setWeightChoice('dataset')
    setCompleted(null); setRowsState(null); setError(null); setNotice(null)
  }, [datasetId])
  useEffect(() => {
    setWaitingForRun(false); setRowsFailure(null)
    if (!active) runRequest.invalidate()
  }, [identity, active])

  useEffect(() => {
    if (!active || !result || rowsState?.key === rowsKey) return
    const isCurrent = rowsRequest.begin()
    setRowsFailure(null); setTablePage(1)
    const load = async () => {
      const collected: SparsePcaRow[] = []
      let offset = 0, expectedTotal: number | null = null
      try {
        for (;;) {
          const page = await fetchSparsePcaRows(result.resultId, offset, 5000, axes)
          if (!isCurrent()) return
          if (page.resultId !== result.resultId || JSON.stringify(page.axes) !== JSON.stringify(axes)) throw new Error('得点応答の結果・軸が一致しません。')
          if (expectedTotal !== null && expectedTotal !== page.total) throw new Error('得点の件数が途中で変更されました。')
          expectedTotal = page.total
          collected.push(...page.rows)
          if (page.nextOffset == null) break
          if (page.nextOffset <= offset) throw new Error('得点のページ位置が不正です。')
          offset = page.nextOffset
        }
        if (collected.length !== expectedTotal || new Set(collected.map(row => row.rowId)).size !== collected.length) throw new Error('得点の全行を取得できませんでした。再取得してください。')
        if (isCurrent()) setRowsState({ key: rowsKey, rows: collected, total: expectedTotal })
      } catch (failure) { if (isCurrent()) setRowsFailure({ key: rowsKey, message: failureMessage(failure) }) }
    }
    void load()
    return () => rowsRequest.invalidate()
    // Request identity and rowsKey guard every page, without restarting on brush changes.
  }, [active, rowsKey, rowsRetry])

  const cancel = () => {
    runRequest.invalidate(); setWaitingForRun(false)
    setNotice('結果の受け取りを取り消しました。実行中のPython計算は停止しません。終了までは再実行できません。')
  }
  const run = async () => {
    if (!canRun || isSparsePcaFitPending()) return
    const isCurrent = runRequest.begin()
    const capturedScope = captureAnalysisRunContext(scope)
    const request: SparsePcaRequest = captureAnalysisRunContext({
      context: { datasetId: datasetId!, expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
        ...capturedScope.contextRows, weightMode: weightChoice, missingPolicy: 'exclude', imputationPolicy: 'use_current_values' },
      variables: selectedIds.map(columnId => ({ columnId, kind: 'numeric',
        ordinalAsNumericAcknowledged: columnById.get(columnId)?.scaleType === 'ordinal' && !!ordinalAcknowledged[columnId],
        score: columnById.get(columnId)?.scaleType === 'ordinal' ? 'ordered_rank' : null })),
      preprocessing, nComponents: settings.nComponents!, alpha: settings.alpha!, ridgeAlpha: settings.ridgeAlpha!,
      tolerance: settings.tolerance!, maxIterations: settings.maxIterations!, seed: settings.seed!,
    })
    setWaitingForRun(true); setError(null); setNotice(null)
    try {
      const response = await runSparsePca(request)
      if (!isCurrent()) return
      setCompleted({ identity, result: response, request, scope: capturedScope, draftKey })
      setAxes(response.summary.nComponents === 1 ? [1] : [1, 2])
      setRowsState(null); setRowsFailure(null); setExportTable('manifest')
    } catch (failure) { if (isCurrent()) setError(failureMessage(failure)) }
    finally { if (mounted.current && isCurrent()) setWaitingForRun(false) }
  }
  const exportResult = async (format: 'csv' | 'json') => {
    if (!result) return
    const started = currentView.current
    await exportSparsePcaTable(result.resultId, exportTable, format, () => mounted.current
      && currentView.current.active && currentView.current.identity === started.identity
      && currentView.current.resultId === started.resultId && currentView.current.exportTable === started.exportTable)
  }
  const field = (key: keyof SparsePcaSettings, label: string, min: number, max?: number, step?: number) =>
    <label style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
      <span style={{ overflowWrap: 'anywhere' }}>{label}</span>
      <InputNumber data-testid={`sparse-pca-${key}`} aria-label={label} value={settings[key]} min={min} max={max} step={step}
        onChange={value => setSettings(previous => ({ ...previous, [key]: value }))} />
    </label>

  return <div data-testid="sparse-pca-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4, minWidth: 0 }}>
    <Card size="small" className="analysis-setup" title="SparsePCA 設定">
      <div className="analysis-form-stack">
        <AnalysisField label="分析変数" htmlFor={columnsId}
          help="共通の有効変数とコードブックを確認してください。役割が質問・属性、尺度が順序・間隔・比例の非MA列が対象です。初期選択は間隔・比例尺度で、順序尺度を選ぶと数値得点として扱う確認が必要です。">
          <ColumnSelect id={columnsId} aria-label="SparsePCAの分析変数" aria-describedby={`${columnsId}-help`} roleName="SparsePCAの分析変数"
            mode="multiple" data-testid="sparse-pca-columns" value={selectedIds} style={{ width: '100%' }}
            emptyHint={{ roleLabel: 'SparsePCAの分析', reason: 'SparsePCAの分析変数の候補がありません。',
              guidance: '共通の有効変数とコードブックの役割・尺度・MAグループを確認してください。質問・属性の順序・間隔・比例尺度の非MA列が対象です。',
              onOpenCodebook: () => dispatch(editorModalOpened()) }}
            options={candidates.map(column => ({ value: column.columnId, label: column.name, questionName: column.name, questionText: column.label }))}
            onChange={ids => setChosen({ datasetId: datasetId!, ids })} placeholder="2つ以上の数値変数" />
        </AnalysisField>
        {selectedOrdinals.map(column => <Checkbox key={column!.columnId} checked={!!ordinalAcknowledged[column!.columnId]}
          onChange={event => setOrdinalAcknowledged(previous => ({ ...previous, [column!.columnId]: event.target.checked }))}>
          {column!.label || column!.name}: 固定したカテゴリ順の1..mを数値得点として扱うことを確認（逆転を適用、polychoricではありません）
        </Checkbox>)}
        <Space wrap><Typography.Text strong>前処理</Typography.Text>
          <div role="radiogroup" aria-label="SparsePCAの前処理" className="analysis-method-switch">
            <Radio.Group name={`${controlId}-preprocessing`} data-testid="sparse-pca-preprocessing" value={preprocessing} onChange={event => setPreprocessing(event.target.value)}>
              <Radio.Button value="correlation">標準化（相関）</Radio.Button>
              <Radio.Button value="covariance">中心化のみ（共分散）</Radio.Button>
            </Radio.Group>
          </div>
          {field('nComponents', '成分数 k', 1, 20)} {field('alpha', 'alpha（Bの疎性）', 0, undefined, .1)}
          {field('ridgeAlpha', 'ridgeAlpha（得点の安定化）', 0, undefined, .01)}
        </Space>
        <Typography.Text type="secondary">alphaは変数の単位・標本数・前処理に依存します。成分数を変えると全成分を同時に再学習します。</Typography.Text>
        {settings.alpha === 0 && <Alert type="info" message="alpha=0でも通常PCAへの切替ではありません。ridgeAlphaによる得点の縮小や収束条件の影響が残ります。" />}
        <details style={{ minWidth: 0, overflowWrap: 'anywhere' }}><summary>詳細設定・計算上限</summary><Space wrap style={{ marginTop: 8 }}>
          {field('seed', 'seed', 0, 4294967295)} {field('tolerance', '許容誤差', 0, .1)}
          {field('maxIterations', '最大反復', 1, 5000)}
        </Space><p>solver: lars。上限: complete-case行数 n≤10,000、定数除外後の変数数 p≤100、k≤20、max(n,500)×p×k×最大反復≤150,000,000。超過時はエラーとなります。対象行・変数・成分・最大反復を減らしてください。</p></details>
        <Space wrap><Typography.Text strong>ウェイト</Typography.Text>
          <div role="radiogroup" aria-label="SparsePCAのウェイト" className="analysis-method-switch">
            <Radio.Group name={`${controlId}-weight`} data-testid="sparse-pca-weight" value={weightChoice} onChange={event => setWeightChoice(event.target.value)}>
              <Radio.Button value="dataset">データセット設定に従う</Radio.Button>
              <Radio.Button value="none">明示的に非加重</Radio.Button>
            </Radio.Group>
          </div>
        </Space>
        <Typography.Text type="secondary">欠損は選択変数のcomplete-caseで除外します。現在の補完値・欠損コード・逆転を使用します。frequency / surveyの加重SparsePCAは未対応です。</Typography.Text>
        {unsupportedWeight && <Alert type="error" message="設定されたウェイトはSparsePCAで未対応です。無視・頻度展開は行いません。実行するには「明示的に非加重」を選択してください。" />}
        {settingsError && <Alert type="error" message={settingsError} />}
        {unavailableIds.length > 0 && <Alert type="error" message="使用できなくなった変数があります。分析変数を選び直してください。" />}
        <AnalysisRunRow>
          <Button type="primary" data-testid="sparse-pca-run" disabled={!canRun || fitPending} loading={waitingForRun}
            onClick={() => void run()}>SparsePCA実行</Button>
          {waitingForRun && <Button data-testid="sparse-pca-cancel" onClick={cancel}>受け取りを取消</Button>}
          {fitPending && !waitingForRun && <Typography.Text role="status">前の計算の終了を待っています。Python計算の強制停止は行いません。</Typography.Text>}
        </AnalysisRunRow>
      </div>
    </Card>
    <AnalysisScopeSummary snapshot={result ? completed?.scope : null} />
    {dirty && <Alert data-testid="sparse-pca-dirty" type="info" message="実行時の対象・設定・ラベルを保持しています。現在の入力を反映するには再実行してください。" />}
    {notice && <Alert type="info" message={notice} closable onClose={() => setNotice(null)} />}
    {error && <Alert type="error" message="SparsePCA計算エラー" description={error} closable onClose={() => setError(null)} />}
    {result && <>
      <Space wrap><Typography.Text type="secondary">保存結果 ID: {result.resultId}</Typography.Text>
        <Button size="small" data-testid="sparse-pca-close" onClick={() => {
          runRequest.invalidate(); rowsRequest.invalidate(); setWaitingForRun(false); setCompleted(null); setRowsState(null)
        }}>結果を閉じる</Button>
      </Space>
      <SparsePcaResultTables result={result} />
      <SparsePcaScorePlot result={result} rows={rows} axes={axes} onAxes={setAxes} available={active}
        loading={rowsLoading} error={rowsError} onRetry={() => { setRowsFailure(null); setRowsRetry(previous => previous + 1) }} />
      <Card size="small" title={`得点一覧（${rowsState?.key === rowsKey ? rowsState.total : 0}行・表示軸）`}>
        <Table<SparsePcaRow> data-testid="sparse-pca-rows" size="small" rowKey="rowId" dataSource={rows} loading={rowsLoading}
          columns={[{ title: 'rowId', dataIndex: 'rowId' }, ...axes.map((axis, index) => ({ title: `SP${axis}`, key: `SP${axis}`,
            render: (_: unknown, row: SparsePcaRow) => String(row.coordinates[index]) }))]}
          pagination={{ current: tablePage, pageSize: 50, showSizeChanger: false, onChange: setTablePage }}
          rowSelection={{ selectedRowKeys: selection.selectedRowIds, preserveSelectedRowKeys: true,
            onSelect: row => dispatch(selectionApplied({ rowIds: [row.rowId], operation: 'toggle', label: 'SparsePCA 得点一覧' })),
            onSelectAll: (selected, _selectedRows, changedRows) => dispatch(selectionApplied({ rowIds: changedRows.map(row => row.rowId), operation: selected ? 'add' : 'subtract', label: 'SparsePCA 得点一覧' })) }}
          onRow={row => ({ onMouseEnter: () => dispatch(hovered(row.rowId)), onMouseLeave: () => dispatch(hovered(null)),
            style: selection.hoveredRowId === row.rowId ? { outline: '1px solid #fa8c16' } : undefined })} />
      </Card>
      <Card size="small" title="CSV / JSON エクスポート">
        <Space wrap><Select data-testid="sparse-pca-export-table" value={exportTable} onChange={setExportTable} style={{ width: 180 }}
          options={result.capabilities.exportTables.map(table => ({ value: table, label: EXPORT_LABELS[table] }))} />
          {(['csv', 'json'] as const).map(format => <AsyncExportButton key={format} exportKey={`${identity}:${active}:${result.resultId}:${exportTable}`}
            disabled={!active || (exportTable === 'manifest' && format === 'csv')} statusLabel={`${EXPORT_LABELS[exportTable]} ${format.toUpperCase()}`} onExport={() => exportResult(format)}>
            {format.toUpperCase()}</AsyncExportButton>)}
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>全行の得点はすべての学習成分を出力します。表示丸めを適用せず、保存時の設定・ラベルを使います。</Typography.Paragraph>
      </Card>
    </>}
  </div>
}
