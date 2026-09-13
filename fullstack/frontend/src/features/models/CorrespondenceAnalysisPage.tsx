import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Alert, Button, Card, Radio, Select, Space, Spin, Tag, Typography, message,
} from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectOrdinaryVariables } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'
import SelectColumn from '../common/ColumnSelect'
import type { CAResponse } from './caTypes'
import type { MapScaling } from './caMap'
import { runCa, selectCaCategories, type CAContext } from './caApi'
import CaHelp from './caHelp'
import CaFigure from './caFigure'
import { CategoryTable, EigenvalueTable } from './caTables'
import { downloadPng, downloadSvg, exportCaTable } from './caExport'

function apiErrorMessage(err: unknown, fallback: string): string {
  const { message: msg, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof msg !== 'string' || !msg) return fallback
  return typeof code === 'string' && code ? `${msg}（${code}）` : msg
}

export default function CorrespondenceAnalysisPage(): JSX.Element {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const obs = useSelector((s: RootState) => s.globalObservations)
  const { columns, schemaRevision } = useCodebook()
  const datasetId = selection.datasetId

  const globalVars = useSelector(selectOrdinaryVariables)
  const hasGlobalSignal = globalVars.allVariables.length > 0
  const categoricalOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal', 'binary'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || globalVars.activeVariableIds.includes(c.name)))
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name, name: c.name })),
    [columns, globalVars.activeVariableIds, hasGlobalSignal],
  )
  const numericOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup)
      .map((c) => ({ value: c.name, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )

  const [inputKind, setInputKind] = useState<'respondents' | 'contingency'>('respondents')
  const [rowVar, setRowVar] = useState<string | null>(null)
  const [colVar, setColVar] = useState<string | null>(null)
  const [rowLabelCol, setRowLabelCol] = useState<string | null>(null)
  const [valueCols, setValueCols] = useState<string[]>([])
  const [cellSemantics, setCellSemantics] = useState<'frequency' | 'mass'>('frequency')
  const [ack, setAck] = useState(false)
  const [mapScaling, setMapScaling] = useState<MapScaling>('symmetric')
  const [scope, setScope] = useState<'all' | 'active' | 'selected' | 'sampled'>('active')
  const [missingPolicy, setMissingPolicy] = useState('exclude')

  const [result, setResult] = useState<CAResponse | null>(null)
  const [submittedKey, setSubmittedKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set())
  const [between, setBetween] = useState<'and' | 'or'>('and')
  const [selecting, setSelecting] = useState(false)
  const [selectInfo, setSelectInfo] = useState<string | null>(null)
  const runSequence = useRef(0)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const draftKey = JSON.stringify([datasetId, inputKind, rowVar, colVar, rowLabelCol, valueCols,
    cellSemantics, ack, mapScaling, scope, missingPolicy, selection.dataRevision, schemaRevision])
  const dirty = result !== null && submittedKey !== '' && draftKey !== submittedKey

  useEffect(() => {
    setResult(null)
    setSubmittedKey('')
    setError(null)
    setSelectedCats(new Set())
    setSelectInfo(null)
  }, [datasetId])

  const buildContext = (): CAContext => ({
    datasetId: datasetId ?? '',
    expectedDataRevision: selection.dataRevision,
    expectedSchemaRevision: schemaRevision,
    scope,
    activeRowIds: scope === 'active' ? selection.activeRowIds : undefined,
    selectedRowIds: scope === 'selected' ? selection.selectedRowIds : undefined,
    sampledRowIds: scope === 'sampled' ? obs.sampling.sampledRowIds : undefined,
    weightMode: 'none',
    missingPolicy,
  })

  const canRun = inputKind === 'respondents'
    ? Boolean(datasetId && rowVar && colVar && rowVar !== colVar)
    : Boolean(datasetId && rowLabelCol && valueCols.length >= 2
      && !valueCols.includes(rowLabelCol ?? '') && (cellSemantics === 'mass' || ack))

  const handleRun = async (): Promise<void> => {
    if (!datasetId || !canRun) return
    const seq = ++runSequence.current
    const epoch = `${datasetId}:${selection.dataRevision}`
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
      const res = await runCa(buildContext(), input, mapScaling)
      if (seq !== runSequence.current) return
      void epoch
      setResult(res)
      setSubmittedKey(startedKey)
      setMapScaling((res.details.mapScaling as MapScaling) ?? 'symmetric')
      setSelectedCats(new Set())
      setSelectInfo(null)
      message.success('コレスポンデンス分析を実行しました。')
    } catch (err) {
      if (seq !== runSequence.current) return
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
    if (!result || selectedCats.size === 0) return
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
    try {
      const res = await selectCaCategories(result.resultId, buildContext(), ids, between)
      dispatch(selectionApplied({
        rowIds: res.rowIds,
        operation: getBrushOp(),
        label: `CA選択 (${res.contextIntersectionCount}行, ${between === 'and' ? 'AND' : 'OR'})`,
      }))
      setSelectInfo(`一致 ${res.matchedCount} / 適用 ${res.contextIntersectionCount}`)
    } catch (err) {
      message.error(apiErrorMessage(err, '選択の解決に失敗しました。'))
    } finally {
      setSelecting(false)
    }
  }

  const rank = result?.summary.rank ?? 0

  if (!datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="correspondence-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!focused && (
        <Card size="small" title="コレスポンデンス分析 (CA)" extra={<FocusEnterButton targetId="ca" title="CA" />}>
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
                  options={categoricalOptions.map((c) => ({ value: c.value, label: c.label }))}
                />
                <span>セル列</span>
                <Select
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
            <Select
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
              style={{ minWidth: 140 }}
              value={missingPolicy}
              onChange={(v) => setMissingPolicy(v)}
              options={[
                { value: 'exclude', label: '欠損を除外' },
                { value: 'include_missing', label: '欠損を含める' },
                { value: 'separate_not_applicable', label: '非該当を分離' },
              ]}
              disabled={inputKind === 'contingency' && missingPolicy !== 'exclude'}
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
            重み: なし（dataset適用表示は共通バー参照）。分割表モードではweightModeを変更しません。カテゴリ点に回答者のL1色は割り当てません。
          </Typography.Text>
          {dirty && <Alert type="warning" style={{ marginTop: 8 }} message="設定が変更されています。結果は前回実行分です。" />}
        </Card>
      )}
      {error && <Alert type="error" message={error} />}
      {loading && <Spin tip="CAを計算中…" />}
      {result && (
        <FocusTarget id="ca" title="CA結果">
          <Card
            size="small"
            title={
              <Space>
                <Tag>rev {result.meta.dataRevision} / scope {result.meta.scope} (n={result.meta.scopeCount})</Tag>
                <Tag>有効 {result.meta.fitCount}</Tag>
                <Tag>非加重</Tag>
                {result.meta.resultState === 'stale' && <Tag color="orange">stale（古い版）</Tag>}
                <Tag>rank {rank}</Tag>
              </Space>
            }
          >
            <CaHelp />
            <div style={{ marginTop: 8 }}>
              <CaFigure
                rows={result.details.rowCategories}
                cols={result.details.columnCategories}
                rank={rank}
                ratio={result.summary.inertiaRatio}
                scaling={mapScaling}
                selected={selectedCats}
                onToggle={toggleCat}
                svgRef={svgRef}
              />
            </div>
            <Space wrap style={{ marginTop: 8 }}>
              <Radio.Group value={between} onChange={(e) => setBetween(e.target.value)}>
                <Radio.Button value="and">両側AND</Radio.Button>
                <Radio.Button value="or">両側OR</Radio.Button>
              </Radio.Group>
              <Button loading={selecting} disabled={selectedCats.size === 0} onClick={() => void handleSelect()}>
                原行IDへ解決して選択 ({selectedCats.size})
              </Button>
              {selectInfo && <Tag>{selectInfo}</Tag>}
              <Button onClick={() => void exportCaTable(result.resultId, 'eigenvalues', 'csv')}>固有値CSV</Button>
              <Button onClick={() => void exportCaTable(result.resultId, 'eigenvalues', 'json')}>固有値JSON</Button>
              <Button onClick={() => void exportCaTable(result.resultId, 'categories', 'csv')}>カテゴリCSV</Button>
              <Button onClick={() => void exportCaTable(result.resultId, 'manifest', 'json')}>設定JSON</Button>
              <Button
                onClick={() => {
                  if (svgRef.current) downloadSvg(svgRef.current, `ca-${result.resultId}.svg`)
                }}
              >
                図SVG
              </Button>
              <Button
                onClick={() => {
                  if (svgRef.current) downloadPng(svgRef.current, `ca-${result.resultId}.png`)
                }}
              >
                図PNG
              </Button>
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
        </FocusTarget>
      )}
    </div>
  )
}
