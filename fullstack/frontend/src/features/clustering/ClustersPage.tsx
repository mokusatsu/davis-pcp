import { SELECTION_LABELS } from '../selection/selectionLabels'
import { useScopedRun, AnalysisScopeSummary } from '../selection/analysisScope'
import { pointRadius } from '../charts/markerStyle'
import EChartSurface from '../charts/EChartSurface'
import { Select as AntSelect } from 'antd'
import Select from '../common/ColumnSelect'
import { AnalysisField, AnalysisRunRow, AnalysisSettings } from '../common/AnalysisSetup'
import { editorModalOpened } from '../dataset/codebookSlice'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Alert, Button, Card, Col, Descriptions, Dropdown, InputNumber, Radio, Row, Space, Spin, Statistic, Tag, Typography, message,
} from 'antd'
import { AppstoreOutlined, BranchesOutlined, CheckCircleOutlined, PlayCircleOutlined } from '@ant-design/icons'
import React from 'react'
import type { RootState } from '../../app/store'
import { groupsReplaced, selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, clusterResultStored } from '../../app/store'
import { selectEffectiveRowIds, selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import MaAxisPicker from '../pcp/MaAxisPicker'
import { useCodebook } from '../dataset/useCodebookColumn'
import { graphEngine } from '../../engine/graphClient'
import { api } from '../../api/client'
import { useRowColorResolver } from '../../theme/useRowColor'
import L1Legend from '../common/L1Legend'
import { vizTheme, composedColor } from '../../theme/viz'
import SelectionMenu, { getBrushOp, useBrushOp } from '../selection/SelectionMenu'
import GraphPanel, { useGraphPopupContainer, useGraphViewport } from '../common/GraphPanel'
import { getSvgPoint } from '../../utils/svgCoordinates'

import CobwebTreeViewer from './CobwebTreeViewer'
import DiscCategoryMatrix from './DiscCategoryMatrix'
import { dendrogramLeafOrder } from './dendrogramLayout'

/** Finite min/max over a coordinate array (NaN skipped), engine-parity helper. */
function finiteRange(values: number[]): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (Number.isFinite(v)) {
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (min === Infinity) return { min: -0.5, max: 0.5 }
  if (min === max) return { min: min - 0.5, max: max + 0.5 }
  return { min, max }
}

interface ClusterResponse {
  scopeCount?: number
  usedColumns?: string[]
  excludedRowCount?: number
  resultId: string
  method: string
  k: number
  evidenceClass: string
  rowIds: string[]
  labels: number[]
  diagnostics: Record<string, unknown>
  linkageMatrix: number[][] | null
  silhouette?: { byRow: number[]; mean: number; byCluster: { label: number; mean: number; count: number }[] } | null
  pcaProjection?: { pc1: number[]; pc2: number[]; varianceRatio: number[] } | null
  conceptTree?: any | null
  categoryMatrices?: Record<string, Record<string, { categories: string[]; matrix: number[][] }>> | null
}

const CLUSTER_METHODS = [
  { label: 'KMeans', value: 'kmeans' },
  { label: 'KMedoids', value: 'kmedoids' },
  { label: 'Divisive', value: 'divisive' },
  { label: 'EM(GMM)', value: 'gmm' },
  { label: '階層的', value: 'agglomerative' },
  { label: 'Cobweb', value: 'cobweb' },
  { label: 'DISC (AAAI 2026)', value: 'disc' },
  { label: 'Class変数', value: 'class_variable' },
]

function inRange(value: number | null, min: number, max = Infinity): value is number {
  return value !== null && Number.isFinite(value) && value >= min && value <= max
}

/** Keep empty and out-of-range drafts explicit, including before Run receives a click. */
function ClusterNumberField({ id, label, help, value, onChange, min, max, step = 1, invalid }: {
  id: string; label: string; help: string; value: number | null; onChange: (value: number | null) => void
  min: number; max?: number; step?: number; invalid: boolean
}) {
  return <AnalysisField label={label} htmlFor={id} help={help}>
    <InputNumber id={id} data-testid={id} aria-describedby={`${id}-help`} aria-invalid={invalid || undefined}
      size="small" style={{ width: '100%' }} value={value} min={min} max={max} step={step}
      status={invalid ? 'error' : undefined} changeOnBlur={false} onChange={onChange}
      onInput={text => {
        // InputNumber does not emit onChange for every out-of-range draft.
        const parsed = text.trim() === '' ? NaN : Number(text)
        onChange(Number.isFinite(parsed) ? parsed : null)
      }} />
  </AnalysisField>
}

export default function ClustersPage() {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const stored = selection.clusterResult
  const activeRowIds = useSelector(selectEffectiveRowIds)
  const variables = useSelector(selectOrdinaryVariables)
  const entities = useSelector(selectVariableEntities)
  const [added, setAdded] = useState<{ datasetId: string | null; names: string[] }>({ datasetId: null, names: [] })
  const { columns: definitions, schemaRevision } = useCodebook()
  const [method, setMethod] = useState('kmeans')
  const [k, setK] = useState<number | null>(3)
  const [seed, setSeed] = useState<number | null>(42)
  const [linkage, setLinkage] = useState('average')
  const [distance, setDistance] = useState('euclidean')
  const [acuity, setAcuity] = useState<number | null>(0.1)
  const [cutoff, setCutoff] = useState<number | null>(0.001)
  const [alphaSmooth, setAlphaSmooth] = useState<number | null>(0.6)
  const [numWeight, setNumWeight] = useState<number | null>(1.0)
  const [error, setError] = useState<{ message: string } | null>(null)
  const [running, setRunning] = useState(false)

  const candidates = definitions.filter(column => !column.multiResponseGroup && ['question', 'attribute'].includes(column.role)
    && variables.activeVariableIds.includes(column.name))
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key))
    .map(item => ({ groupId: item.name, label: item.label }))
  const maColumns = definitions.filter(column => ['question', 'attribute'].includes(column.role)
    && column.multiResponseGroup && groups.some(group => group.groupId === column.multiResponseGroup)
    && added.datasetId === selection.datasetId && added.names.includes(column.name)).map(column => column.name)
  const mixed = method === 'cobweb' || method === 'disc'
  const numericCandidates = candidates.filter(column => ['ordinal', 'interval', 'ratio'].includes(column.scaleType)).map(column => column.name)
  const nominalCandidates = candidates.filter(column => column.scaleType === 'nominal').map(column => column.name)
  const [chosenNumeric, setChosenNumeric] = useState<string[] | null>(null)
  const [chosenNominal, setChosenNominal] = useState<string[] | null>(null)
  const numericKey = numericCandidates.join(',')
  const nominalKey = nominalCandidates.join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const numericBase = useMemo(() => method === 'class_variable' ? [] as string[] : numericCandidates, [method, numericKey])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nominalBase = useMemo(() => method === 'class_variable' ? [] as string[] : nominalCandidates, [method, nominalKey])
  const selectedNumeric = useMemo(() => (chosenNumeric ?? numericBase).filter(name => numericBase.includes(name)), [chosenNumeric, numericBase])
  const selectedNominal = useMemo(() => mixed ? (chosenNominal ?? nominalBase).filter(name => nominalBase.includes(name)) : [], [mixed, chosenNominal, nominalBase])
  const numericColumns = method === 'class_variable' ? [] : [
    ...selectedNumeric,
    ...(mixed ? [] : maColumns)]
  const classCandidates = [...nominalCandidates, ...maColumns]
  const categoricalColumns = mixed ? [...selectedNominal, ...maColumns] : []
  const [requestedClass, setClassColumn] = useState<string | null>(null)
  const classColumn = classCandidates.includes(requestedClass ?? '') ? requestedClass : null
  const usesSeed = ['kmeans', 'divisive', 'gmm', 'disc'].includes(method)
  // The sklearn-backed methods require uint32 seeds; DISC uses NumPy's Generator.
  const seedMax = method === 'disc' ? Number.MAX_SAFE_INTEGER : 4294967295
  const validK = inRange(k, 2, 20) && Number.isInteger(k)
  const validSeed = inRange(seed, 0, seedMax) && Number.isSafeInteger(seed)
  const validAcuity = inRange(acuity, 0.01)
  const validCutoff = inRange(cutoff, 0.0001)
  const validAlpha = inRange(alphaSmooth, 0.01, 5)
  const validWeight = inRange(numWeight, 0.1, 10)
  const invalidSettings = [
    method !== 'class_variable' && !validK && 'クラスタ数 k（2〜20の整数）',
    usesSeed && !validSeed && `乱数 seed（0〜${seedMax}の整数）`,
    method === 'cobweb' && !validAcuity && 'Acuity（0.01以上）',
    method === 'cobweb' && !validCutoff && 'Cutoff（0.0001以上）',
    method === 'disc' && !validAlpha && 'Alpha平滑化（0.01〜5）',
    method === 'disc' && !validWeight && '数値重み（0.1〜10）',
  ].filter(Boolean)
  const hasInputs = method === 'class_variable' ? Boolean(classColumn) : numericColumns.length + categoricalColumns.length > 0
  const canRun = hasInputs && invalidSettings.length === 0
  const settingsSummary = method === 'class_variable' ? 'クラス列の値で分類（k・乱数は不使用）'
    : `k: ${k ?? '未入力'}${usesSeed ? ` / seed: ${seed ?? '未入力'}` : ''}`
      + (method === 'agglomerative' ? ` / 連結法: ${linkage}` : '')
      + (['agglomerative', 'kmedoids'].includes(method) ? ` / 距離: ${distance}` : '')
      + (method === 'cobweb' ? ` / Acuity: ${acuity ?? '未入力'} / Cutoff: ${cutoff ?? '未入力'}` : '')
      + (method === 'disc' ? ` / Alpha: ${alphaSmooth ?? '未入力'} / 数値重み: ${numWeight ?? '未入力'}` : '')
  const inputKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, activeRowIds,
    numericColumns, categoricalColumns, classColumn, method, k, seed, linkage, distance, acuity, cutoff, alphaSmooth, numWeight])
  const [resultInput, setResultInput] = useState<{ resultId: string; key: string } | null>(null)
  const resultMatchesInput = stored && resultInput?.resultId === stored.resultId && resultInput.key === inputKey
  const runScope = useScopedRun(inputKey)
  useEffect(() => {
    setRunning(false)
    setError(null)
  }, [runScope.identity])

  const theme = vizTheme(false)

  const runClustering = async () => {
    if (!selection.datasetId || !canRun) return
    const ticket = runScope.begin()
    setRunning(true)
    setError(null)
    try {
      const response = await api.post<ClusterResponse>('/clusters', {
        datasetId: selection.datasetId,
        activeRowIds: ticket.scope.rowIds,
        expectedDataRevision: selection.dataRevision,
        expectedSchemaRevision: schemaRevision,
        method,
        // Unused invalid drafts remain editable, but cannot send null to the API's numeric fields.
        k: validK ? k : 3,
        seed: validSeed ? seed : 42,
        linkage,
        distance,
        classColumn: method === 'class_variable' ? classColumn : undefined,
        columns: numericColumns,
        categoricalColumns: categoricalColumns.length > 0 ? categoricalColumns : undefined,
        scaling: 'zscore',
        acuity: validAcuity ? acuity : 0.1,
        cutoff: validCutoff ? cutoff : 0.001,
        alphaSmooth: validAlpha ? alphaSmooth : 0.6,
        numWeight: validWeight ? numWeight : 1.0,
      })
      if (!ticket.isCurrent()) return
      ticket.commit()
      // Stable group slots: cluster label -> fixed color slot (entity-stable).
      const clusters = Array.from({ length: response.k }, (_, label) => ({
        groupId: `cluster-${response.resultId}-${label}`,
        name: `${response.method} cluster ${label}`,
        rowIds: response.rowIds.filter((_, index) => response.labels[index] === label),
        color: composedColor(theme, { l2Group: label }),
        source: `clustering:${response.method}`,
        evidenceClass: response.evidenceClass,
      }))
      dispatch(groupsReplaced(clusters))
      setResultInput({ resultId: response.resultId, key: inputKey })
      dispatch(clusterResultStored(response))
      message.success(`クラスタリング完了 (${response.k}クラスタ、平均シルエット ${response.silhouette?.mean?.toFixed(3) ?? '—'})`)
    } catch (err) {
      if (ticket.isCurrent()) setError(err as { message: string })
    } finally {
      if (ticket.isCurrent()) setRunning(false)
    }
  }

  const selectCluster = (label: number) => {
    if (!stored) return
    const rowIds = stored.rowIds.filter((_, index) => stored.labels[index] === label)
    dispatch(selectionApplied({ rowIds, operation: getBrushOp(), label: `cluster ${label}選択` }))
  }

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div
      data-testid="clusters-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowX: 'hidden' }}
    >
      <AnalysisScopeSummary snapshot={runScope.snapshot} />
      {runScope.dirty && <Typography.Text type="warning">現在の入力と異なる実行済み結果です。再実行すると更新されます。</Typography.Text>}

      <Card title="クラスタリングの設定" size="small" className="analysis-setup">
        <div className="analysis-form-stack">
          <Typography.Text type="secondary">変数と手法を選び、クラスタリングを実行します。変数・詳細設定の変更は次回の実行に適用されます。</Typography.Text>
          <div className="analysis-variable-grid">
            {method === 'class_variable' ? (
              <AnalysisField label="正解ラベル列" htmlFor="cluster-class-column" help="名義尺度の列、または追加したMA選択肢を1つ選び、その値で分類します。">
                <Select id="cluster-class-column" aria-label="クラスタリングの正解ラベル列" aria-describedby="cluster-class-column-help"
                  roleName="クラスタリングの正解ラベル列" data-testid="class-column" size="small" placeholder="クラス列を選択"
                  style={{ width: '100%' }} value={classColumn} onChange={setClassColumn}
                  options={classCandidates.map(name => ({ value: name, label: name }))}
                  emptyHint={{ roleLabel: '正解ラベル', reason: '正解ラベル列の候補がありません。',
                    guidance: '共通の有効変数で名義尺度の質問・属性を選択してください。MA選択肢は下の追加ボタンから候補に追加できます。',
                    onOpenCodebook: () => dispatch(editorModalOpened()) }} />
              </AnalysisField>
            ) : (
              <AnalysisField label="数値列" htmlFor="cluster-numeric-columns" help="共通の有効変数から順序・間隔・比率尺度の列を選びます。数値列はz-score標準化します。">
                <Select id="cluster-numeric-columns" aria-label="クラスタリングの数値列" aria-describedby="cluster-numeric-columns-help"
                  roleName="クラスタリングの数値列" data-testid="cluster-numeric-columns" mode="multiple" size="small" placeholder="投入する数値列を選択"
                  style={{ width: '100%' }} value={selectedNumeric}
                  options={numericCandidates.map(name => ({ value: name, label: `${name}: ${definitions.find(column => column.name === name)?.label || name}` }))}
                  onChange={names => setChosenNumeric(names)}
                  emptyHint={{ roleLabel: '数値', reason: '数値列の候補がありません。',
                    guidance: '共通の有効変数を確認してください。コードブックで質問・属性の役割と順序・間隔・比率尺度を確認できます。MA選択肢は下の追加ボタンから追加します。',
                    onOpenCodebook: () => dispatch(editorModalOpened()) }} />
              </AnalysisField>
            )}
            {mixed && (
              <AnalysisField label="カテゴリ列" htmlFor="cluster-categorical-columns" help="名義尺度の列を選びます。Cobweb・DISCでは数値列なしでもカテゴリ列だけで実行できます。">
                <Select id="cluster-categorical-columns" aria-label="クラスタリングのカテゴリ列" aria-describedby="cluster-categorical-columns-help"
                  roleName="クラスタリングのカテゴリ列" data-testid="cluster-categorical-columns" mode="multiple" size="small" placeholder="投入するカテゴリ列を選択"
                  style={{ width: '100%' }} value={selectedNominal}
                  options={nominalCandidates.map(name => ({ value: name, label: `${name}: ${definitions.find(column => column.name === name)?.label || name}` }))}
                  onChange={names => setChosenNominal(names)}
                  emptyHint={{ roleLabel: 'カテゴリ', reason: 'カテゴリ列の候補がありません。',
                    guidance: '共通の有効変数で名義尺度の質問・属性を選択してください。MA選択肢は下の追加ボタンから追加できます。',
                    onOpenCodebook: () => dispatch(editorModalOpened()) }} />
              </AnalysisField>
            )}
          </div>
          <div className="analysis-variable-grid">
            <AnalysisField label="追加したMA選択肢" htmlFor="cluster-ma-columns"
              help={method === 'class_variable' ? '追加した選択肢は正解ラベル列の候補になります。' : mixed ? '追加した選択肢はカテゴリ列として投入します。' : '追加した選択肢は数値列（0/1）として投入します。'}>
              <Select id="cluster-ma-columns" aria-label="クラスタリングに追加したMA選択肢" aria-describedby="cluster-ma-columns-help"
                roleName="クラスタリングに追加したMA選択肢" data-testid="cluster-ma-columns" mode="multiple" size="small" placeholder="追加したMA選択肢"
                value={maColumns} style={{ width: '100%' }}
                options={maColumns.map(name => ({ value: name, label: definitions.find(column => column.name === name)?.multiResponseOptionLabel || name }))}
                onChange={names => setAdded({ datasetId: selection.datasetId, names })}
                emptyHint={{ roleLabel: 'MA選択肢', reason: 'MA選択肢はまだ追加されていません。',
                  guidance: '共通の有効変数でMA設問を選び、「MA軸を追加」から選択肢を追加してください。コードブックでMA設問の定義を確認できます。',
                  onOpenCodebook: () => dispatch(editorModalOpened()) }} />
            </AnalysisField>
          </div>
          <div className="analysis-inline-fields">
            <MaAxisPicker allowCount={false} groups={groups} columns={definitions} onAdd={axes => {
              const names = definitions.filter(column => axes.some(axis => axis.columnId === column.columnId)).map(column => column.name)
              setAdded({ datasetId: selection.datasetId, names: [...new Set([...(added.datasetId === selection.datasetId ? added.names : []), ...names])] })
            }} />
          </div>
          <AnalysisField label="クラスタリング手法">
            <div role="radiogroup" aria-label="クラスタリング手法" className="analysis-method-switch">
              <Radio.Group name="cluster-method" data-testid="cluster-method" size="small"
                value={method} onChange={event => setMethod(event.target.value)}>
                {CLUSTER_METHODS.map(option => <Radio.Button key={option.value} value={option.value}>{option.label}</Radio.Button>)}
              </Radio.Group>
            </div>
          </AnalysisField>
          {method !== 'class_variable' && (
            <AnalysisSettings title="クラスタリングの詳細設定" summary={settingsSummary} attention={invalidSettings.length > 0}>
              <div className="analysis-variable-grid">
                <ClusterNumberField id="cluster-k" label="クラスタ数 k" help="2〜20の整数を指定します。標準値は3です。実際に使える対象行数の確認は実行時に行います。"
                  min={2} max={20} value={k} onChange={setK} invalid={!validK} />
                {usesSeed && <ClusterNumberField id="cluster-seed" label="乱数 seed" help={`0〜${seedMax}の整数を指定します。標準値は42です。`}
                  min={0} max={seedMax} value={seed} onChange={setSeed} invalid={!validSeed} />}
                {method === 'agglomerative' && (
                  <AnalysisField label="連結法" htmlFor="cluster-linkage" help="標準設定はAverageです。">
                    <AntSelect id="cluster-linkage" aria-describedby="cluster-linkage-help" data-testid="linkage" size="small"
                      value={linkage} onChange={setLinkage} style={{ width: '100%' }} options={[
                        { value: 'nearest', label: 'Nearest（最短距離法）' },
                        { value: 'farthest', label: 'Farthest（最長距離法）' },
                        { value: 'average', label: 'Average' },
                        { value: 'group_average', label: 'Group Average' },
                      ]} />
                  </AnalysisField>
                )}
                {['agglomerative', 'kmedoids'].includes(method) && (
                  <AnalysisField label="距離尺度" htmlFor="cluster-distance" help="標準設定はEuclideanです。">
                    <AntSelect id="cluster-distance" aria-describedby="cluster-distance-help" data-testid="distance" size="small"
                      value={distance} onChange={setDistance} style={{ width: '100%' }} options={[
                        { value: 'euclidean', label: 'Euclidean' },
                        { value: 'standard_euclidean', label: 'Standard Euclidean' },
                        { value: 'city_block', label: 'City-block' },
                      ]} />
                  </AnalysisField>
                )}
                {method === 'cobweb' && <>
                  <ClusterNumberField id="cobweb-acuity" label="Acuity" help="0.01以上を指定します。標準値は0.1です。"
                    min={0.01} step={0.05} value={acuity} onChange={setAcuity} invalid={!validAcuity} />
                  <ClusterNumberField id="cobweb-cutoff" label="Cutoff" help="0.0001以上を指定します。標準値は0.001です。"
                    min={0.0001} step={0.001} value={cutoff} onChange={setCutoff} invalid={!validCutoff} />
                </>}
                {method === 'disc' && <>
                  <ClusterNumberField id="disc-alpha" label="Alpha平滑化" help="0.01〜5を指定します。標準値は0.6です。"
                    min={0.01} max={5} step={0.1} value={alphaSmooth} onChange={setAlphaSmooth} invalid={!validAlpha} />
                  <ClusterNumberField id="disc-num-weight" label="数値重み" help="0.1〜10を指定します。標準値は1です。"
                    min={0.1} max={10} step={0.5} value={numWeight} onChange={setNumWeight} invalid={!validWeight} />
                </>}
              </div>
            </AnalysisSettings>
          )}
          <AnalysisSettings title="手法と結果の見方" summary="変数・MA選択肢と実行済み結果について">
            <Typography.Text>Cobweb・DISCは数値列とカテゴリ列を扱います。Class変数は選んだ列の値で分類し、クラスタ数や乱数は使いません。</Typography.Text>
            <Typography.Text>MA選択肢は有効回答を0/1として使い、MA回答状態による行除外を行います。数値列の定数・全欠損の列は除外し、残る数値の欠損は対象行の平均で補完します。</Typography.Text>
            <Typography.Text>実行後のグループ選択やグラフ操作は表示中の結果に対して行います。分類は共通の色分け・選択に反映されます。</Typography.Text>
          </AnalysisSettings>
          {error && <Alert type="error" showIcon message={error.message} />}
          <AnalysisRunRow>
            <Typography.Text type={canRun ? 'secondary' : 'warning'} role="status" id="cluster-run-guidance">
              {invalidSettings.length > 0 ? `詳細設定を確認してください: ${invalidSettings.join('、')}`
                : !hasInputs ? method === 'class_variable' ? '正解ラベル列を1つ選択してください。'
                  : mixed ? '数値列・カテゴリ列・MA選択肢のいずれかを1つ以上選択してください。'
                    : '数値列またはMA選択肢を1つ以上選択してください。'
                  : method === 'class_variable' ? `正解ラベル列: ${classColumn}`
                    : `分析対象: 数値列 ${numericColumns.length}本${categoricalColumns.length > 0 ? ` + カテゴリ列 ${categoricalColumns.length}本` : ''}（z-score標準化）`}
            </Typography.Text>
            <Button data-testid="run-clustering" type="primary" icon={<PlayCircleOutlined />} loading={running}
              disabled={!canRun} aria-describedby="cluster-run-guidance" onClick={() => void runClustering()}
              style={{ whiteSpace: 'normal', height: 'auto', minHeight: 32, maxWidth: '100%' }}>
              クラスタリング実行
            </Button>
          </AnalysisRunRow>
        </div>
      </Card>

      {stored && !resultMatchesInput && <Alert type="info" showIcon data-testid="cluster-previous-result"
        message="表示中の結果は現在の入力と異なるか、入力条件を確認できません。現在の条件で分類するには再実行してください。" />}

      {/* Summary KPI Cards */}
      {stored && (
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="クラスタ数 k"
                value={stored.k}
                prefix={<AppstoreOutlined />}
                suffix="グループ"
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>平均シルエット係数</div>
              {stored.silhouette?.mean !== undefined ? (
                <Space align="baseline">
                  <span style={{ fontSize: 20, fontWeight: 600, color: stored.silhouette.mean > 0.5 ? '#52c41a' : stored.silhouette.mean > 0.25 ? '#1677ff' : '#faad14' }}>
                    {stored.silhouette.mean.toFixed(3)}
                  </span>
                  <Tag color={stored.silhouette.mean > 0.5 ? 'green' : stored.silhouette.mean > 0.25 ? 'blue' : 'orange'}>
                    {stored.silhouette.mean > 0.5 ? '良好' : stored.silhouette.mean > 0.25 ? '標準的' : '重複あり'}
                  </Tag>
                </Space>
              ) : (
                <span style={{ fontSize: 18, color: '#8c8c8c' }}>—</span>
              )}
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="手法 / エビデンス"
                value={`${stored.method}`}
                prefix={<BranchesOutlined />}
                valueStyle={{ fontSize: 14 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="分類済みデータ件数"
                value={stored.rowIds.length}
                prefix={<CheckCircleOutlined />}
                suffix="行"
              />
            </Card>
          </Col>
        </Row>
      )}

      {/* Loading Indicator */}
      {running && (
        <Card size="small" style={{ textAlign: 'center', padding: '40px 20px', background: '#fafafa', borderRadius: 8 }}>
          <Spin size="large" tip={`クラスタリング (${method}) を計算中...`} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12, marginBottom: 0 }}>
            距離行列の計算およびクラスタ割り当て・シルエット分析を行っています
          </Typography.Paragraph>
        </Card>
      )}

      {stored && !running && (
        <>
          <ClusterSummaryPanel result={stored} onSelect={selectCluster} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            クラスタボタン/凡例/シルエット/樹形図クリック=集合演算で反映
          </Typography.Text>
          {stored.pcaProjection && (
            <PcaScatterPlot result={stored} onSelect={selectCluster} />
          )}
          {stored.silhouette && (
            <SilhouettePlot result={stored} onSelect={selectCluster} />
          )}
          {stored.linkageMatrix && (
            <DendrogramPanel linkageMatrix={stored.linkageMatrix} rowIds={stored.rowIds} />
          )}
          {stored.conceptTree && (
            <CobwebTreeViewer
              conceptTree={stored.conceptTree}
              rowIds={stored.rowIds}
              onSelectRows={(ids) =>
                dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: 'Cobweb概念選択' }))
              }
            />
          )}
          {stored.categoryMatrices && (
            <DiscCategoryMatrix
              categoryMatrices={stored.categoryMatrices}
              clusterCount={stored.k}
            />
          )}
        </>
      )}
    </div>
  )
}

/** PCA 2D scatter of the clustering: PC1×PC2 with cluster colors and
 *  selection highlight; click a point to toggle that row in the shared selection. */
function PcaScatterPlot({ result, onSelect }: { result: ClusterResponse; onSelect: (label: number) => void }) {
  const size = Math.max(360, Math.min(760, window.innerWidth - 220))
  const pca = result.pcaProjection!
  return <div data-testid="pca-panel">
    <GraphPanel graphId="clusters/pca" title="主成分散布図 (PCA)" available sizing="intrinsic"
      style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, userSelect: 'none' }}
      intrinsicSize={{ width: size, height: size }}
      controls={<>
        <Space wrap>
          <Typography.Text strong>主成分散布図（PC1 {(pca.varianceRatio[0] * 100).toFixed(1)}% ／ PC2 {(pca.varianceRatio[1] * 100).toFixed(1)}% 分散）</Typography.Text>
          <SelectionMenu testId="clusters-pca-selection" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>ドラッグ=矩形選択 · 点クリック=toggle · 右クリックで操作</Typography.Text>
        </Space>
        <L1Legend />
      </>}>
      <PcaScatterSurface result={result} onSelect={onSelect} size={size} />
    </GraphPanel>
  </div>
}

function PcaScatterSurface({ result, onSelect, size }: { result: ClusterResponse; onSelect: (label: number) => void; size: number }) {
  const { getColor, selectionColor } = useRowColorResolver()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const rowScope = useSelector(selectEffectiveRowIds)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const viewport = useGraphViewport()
  const getPopupContainer = useGraphPopupContainer()
  const context = useMemo(() => ({}), [selection.datasetId, selection.dataRevision, schemaRevision,
    selection.activeRowIds, rowScope, result, size, viewport.scale, viewport.zoom, viewport.dpr, viewport.revision])
  const currentContext = useRef(context)
  currentContext.current = context
  const selectionVersion = useRef(0)
  const theme = vizTheme(false)
  const pca = result.pcaProjection!
  const selectedSet = new Set(selection.selectedRowIds)
  const hoveredId = selection.hoveredRowId

  // Rect brush (AGENTS.md R3): drag selects rows inside the rect in PC space.
  const svgRef = useRef<SVGSVGElement>(null)
  const [brushOpOp] = useBrushOp() as ['add' | 'replace' | 'subtract' | 'toggle', (v: never) => void]
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const dragRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

  useEffect(() => {
    dragRef.current = null
    setDrag(null)
    return () => { selectionVersion.current++ }
  }, [context])
  const cancelDrag = () => { dragRef.current = null; setDrag(null) }

  const xs = pca.pc1
  const ys = pca.pc2
  const { min: xMin, max: xMax } = useMemo(() => finiteRange(xs), [xs])
  const { min: yMin, max: yMax } = useMemo(() => finiteRange(ys), [ys])
  const pad = 40
  const scaleX = (v: number) => pad + ((v - xMin) / (xMax - xMin || 1)) * (size - pad * 2)
  const scaleY = (v: number) => size - pad - ((v - yMin) / (yMax - yMin || 1)) * (size - pad * 2)
  const invScaleX = (px: number) => xMin + ((px - pad) / (size - pad * 2)) * (xMax - xMin)
  const invScaleY = (py: number) => yMin + ((size - pad - py) / (size - pad * 2)) * (yMax - yMin)

  const eventPoint = (event: React.PointerEvent): { x: number; y: number } => {
    return getSvgPoint(svgRef.current, event, { width: size, height: size })
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (!svgRef.current || event.button !== 0) return
    selectionVersion.current++
    const target = event.target as Element
    if (target.closest('circle, rect[data-selectable], rect.bar-hit')) {
      // Click on a selectable mark: let its own onClick handle it (audit #1).
      return
    }
    const pt = eventPoint(event)
    dragRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
    setDrag(dragRef.current)
    try { svgRef.current.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current || !svgRef.current) return
    const pt = eventPoint(event)
    dragRef.current = { ...dragRef.current, x2: pt.x, y2: pt.y }
    setDrag(dragRef.current)
  }

  const onPointerUp = async (event: React.PointerEvent) => {
    const end = eventPoint(event)
    const cur = dragRef.current ? { ...dragRef.current, x2: end.x, y2: end.y } : null
    const version = selectionVersion.current
    dragRef.current = null
    setDrag(null)
    if (!cur) return
    if (Math.abs(cur.x2 - cur.x1) * viewport.scale < 5 && Math.abs(cur.y2 - cur.y1) * viewport.scale < 5) return
    const pxLo = Math.min(cur.x1, cur.x2), pxHi = Math.max(cur.x1, cur.x2)
    const pyLo = Math.min(cur.y1, cur.y2), pyHi = Math.max(cur.y1, cur.y2)
    const vxLo = invScaleX(pxLo), vxHi = invScaleX(pxHi)
    const vyLo = invScaleY(pyHi), vyHi = invScaleY(pyLo)
    const nRows = result.rowIds.length
    if (!nRows) return
    // Active filter + finite values as [row][x,y] for the engine.
    const activeRowIdSet = new Set(selection.activeRowIds)
    const keep: number[] = []
    for (let i = 0; i < nRows; i += 1) {
      if (activeRowIdSet.has(result.rowIds[i]) && Number.isFinite(xs[i]) && Number.isFinite(ys[i])) keep.push(i)
    }
    const values = new Float64Array(keep.length * 2)
    const active = new Uint8Array(keep.length).fill(1)
    for (let i = 0; i < keep.length; i += 1) {
      values[i * 2] = xs[keep[i]]
      values[i * 2 + 1] = ys[keep[i]]
    }
    try {
      const hitIdxs = await graphEngine.scatterHit(values, keep.length,
        { x1: Math.min(vxLo, vxHi), y1: Math.min(vyLo, vyHi), x2: Math.max(vxLo, vxHi), y2: Math.max(vyLo, vyHi) }, active)
      if (version !== selectionVersion.current || currentContext.current !== context) return
      dispatch(selectionApplied({ rowIds: hitIdxs.map((i) => result.rowIds[keep[i]]), operation: brushOpOp, label: 'PCA矩形選択' }))
    } catch (error) {
      if (version === selectionVersion.current && currentContext.current === context)
        message.error(error instanceof Error ? error.message : '矩形選択に失敗しました。')
    }
  }

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

  return (
      <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={getPopupContainer}>
      <EChartSurface
        ref={svgRef}
        data-testid="pca-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        style={{ width: '100%', height: 'auto', aspectRatio: '1 / 1', display: 'block', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
      >
        {/* recessive hairline axes */}
        <line x1={pad} y1={size - pad} x2={size - pad} y2={size - pad} stroke={theme.axis} strokeWidth={1} />
        <line x1={pad} y1={pad} x2={pad} y2={size - pad} stroke={theme.axis} strokeWidth={1} />
        <text x={size / 2} y={size - 10} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151">PC1</text>
        <text x={12} y={size / 2} fontSize={12} fontWeight={600} fill="#374151" textAnchor="middle" transform={`rotate(-90 12 ${size / 2})`}>PC2</text>
        {result.rowIds.map((id, index) => {
          const label = result.labels[index]
          const isSelected = selectedSet.has(id)
          const isHovered = hoveredId === id
          return (
            <circle data-selectable="true" data-row-id={id}
              key={id}
              cx={scaleX(xs[index])}
              cy={scaleY(ys[index])}
              data-chart-marker="point" r={pointRadius(isSelected, isHovered)}
              fill={getColor(id)}
              opacity={isSelected ? 1 : 0.55}
              stroke={isSelected ? selectionColor : theme.surface}
              strokeWidth={isSelected ? 1.5 : 1}
              style={{ cursor: 'pointer' }}
              onClick={() => dispatch(selectionApplied({ rowIds: [id], operation: 'toggle', label: 'PCA点クリック' }))}
              onMouseEnter={() => dispatch({ type: 'selection/hovered', payload: id })}
              onMouseLeave={() => dispatch({ type: 'selection/hovered', payload: null })}
            >
              <title>{`${id}: cluster ${label}`}</title>
            </circle>
          )
        })}
        {/* cluster legend swatches */}
        {Array.from({ length: result.k }, (_, label) => {
          const count = result.labels.filter((l) => l === label).length
          return (
            <g key={`legend-${label}`} style={{ cursor: 'pointer' }} onClick={() => onSelect(label)}>
              <rect x={size - 130} y={pad + label * 18} width={10} height={10} fill={composedColor(theme, { l2Group: label })} rx={2} />
              <text x={size - 116} y={pad + label * 18 + 9} fontSize={11} fill="#52514e">{`cluster ${label} (${count})`}</text>
            </g>
          )
        })}
        {/* drag rect on top (AGENTS.md 5.2) */}
        {drag && (
          <rect
            x={Math.min(drag.x1, drag.x2)}
            y={Math.min(drag.y1, drag.y2)}
            width={Math.abs(drag.x2 - drag.x1)}
            height={Math.abs(drag.y2 - drag.y1)}
            fill="rgba(42,120,214,0.15)"
            stroke="#2a78d6"
            strokeWidth={1.5}
            style={{ pointerEvents: 'none' }}
          />
        )}
      </EChartSurface>
      </Dropdown>
  )
}

function ClusterSummaryPanel({ result, onSelect }: { result: ClusterResponse; onSelect: (label: number) => void }) {
  const dropped = Array.isArray(result.diagnostics.droppedColumns) ? result.diagnostics.droppedColumns.map(String) : []
  const imputed = result.diagnostics.imputedCounts && typeof result.diagnostics.imputedCounts === 'object'
    ? Object.entries(result.diagnostics.imputedCounts).filter(([, count]) => typeof count === 'number' && count > 0) : []
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14 }}>
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>結果（クリックで選択・全ビューへ伝播）</Typography.Title>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="method">{result.method}</Descriptions.Item>
        <Descriptions.Item label="evidence">{result.evidenceClass}</Descriptions.Item>
        <Descriptions.Item label="平均シルエット">
          {result.silhouette ? result.silhouette.mean.toFixed(3) : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="使用行">{result.rowIds.length}行{result.scopeCount !== undefined ? ` / 対象 ${result.scopeCount}行` : ''}</Descriptions.Item>
        {result.usedColumns && <Descriptions.Item label="使用列">{result.usedColumns.join('、')}</Descriptions.Item>}
        {result.excludedRowCount !== undefined && <Descriptions.Item label="MA回答状態による行除外">{result.excludedRowCount}行</Descriptions.Item>}
        {dropped.length > 0 && <Descriptions.Item label="定数・全欠損のため除外した列">{dropped.join('、')}</Descriptions.Item>}
        {imputed.length > 0 && <Descriptions.Item label="数値の欠損補完">{imputed.map(([name, count]) => `${name}: ${count}件`).join('、')}（対象行の有効値の平均）</Descriptions.Item>}
        <Descriptions.Item label="diagnostics">
          <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{JSON.stringify(result.diagnostics).slice(0, 200)}</code>
        </Descriptions.Item>
      </Descriptions>
      <Space wrap>
        {Array.from({ length: result.k }, (_, label) => {
          const count = result.labels.filter((l) => l === label).length
          return (
            <Button key={label} data-testid={`cluster-${label}`} onClick={() => onSelect(label)}>
              <span style={{ display: 'inline-block', width: 10, height: 10, background: composedColor(vizTheme(false), { l2Group: label }), marginRight: 6, borderRadius: 2 }} />
              cluster {label} ({count})
            </Button>
          )
        })}
      </Space>
    </Space>
    </div>
  )
}

/** Silhouette-width plot: each bar = one row, sorted within its cluster.
 *  Width = how confidently the row belongs to its cluster (1 = strong).
 *  Row ordering comes from the engine's silhouetteOrder (WASM in worker). */
function SilhouettePlot({ result, onSelect }: { result: ClusterResponse; onSelect: (label: number) => void }) {
  const dispatch = useDispatch()
  const { getColor, isSelected, selectionColor } = useRowColorResolver()
  const width = Math.max(760, Math.min(1200, window.innerWidth - 220))
  const rowHeight = Math.max(1.5, Math.min(5, 420 / result.rowIds.length))
  const height = result.k * 40 + result.rowIds.length * rowHeight + 60
  const [orderedRows, setOrderedRows] = useState<{ id: string; label: number; s: number }[]>([])

  useEffect(() => {
    if (!result.silhouette) { setOrderedRows([]); return }
    let cancelled = false
    ;(async () => {
      const labels = Int32Array.from(result.labels)
      const sil = Float64Array.from(result.silhouette!.byRow)
      // Engine returns a permutation grouped by label asc, s desc within label.
      const order = await graphEngine.silhouetteOrder(labels, sil)
      if (cancelled) return
      setOrderedRows(order.map((i) => ({ id: result.rowIds[i], label: result.labels[i], s: result.silhouette!.byRow[i] })))
    })().catch(() => undefined)
    return () => { cancelled = true }
  }, [result])

  const clusters = useMemo(() => {
    if (!result.silhouette || !orderedRows.length) return []
    return Array.from({ length: result.k }, (_, label) => ({
      label,
      rows: orderedRows.filter((row) => row.label === label),
    }))
  }, [result, orderedRows])

  if (!result.silhouette) return null

  let yCursor = 30
  const bars: React.ReactNode[] = []
  for (const cluster of clusters) {
    const mean = result.silhouette.byCluster.find((c) => c.label === cluster.label)?.mean ?? 0
    bars.push(
      <text key={`label-${cluster.label}`} x={4} y={yCursor - 8} fontSize={11} fill="#52514e">
        {`cluster ${cluster.label}`}（平均シルエット {mean.toFixed(3)}）
      </text>,
    )
    const zeroX = 100 + (width - 120) / 2
    const halfSpan = (width - 120) / 2
    for (const row of cluster.rows) {
      const sClamped = Math.max(-1, Math.min(1, row.s))
      const barWidth = Math.max(1, Math.abs(sClamped) * halfSpan)
      const barX = sClamped >= 0 ? zeroX : zeroX - barWidth
      bars.push(
        <rect
          key={`${cluster.label}-${row.id}`}
          data-row-id={row.id}
          x={barX}
          y={yCursor}
          width={barWidth}
          height={rowHeight - 0.4}
          fill={getColor(row.id)}
          opacity={isSelected(row.id) ? 1 : 0.85}
          stroke={isSelected(row.id) ? selectionColor : undefined}
          strokeWidth={isSelected(row.id) ? 1.5 : 0}
          style={{ cursor: 'pointer' }}
          onClick={() => onSelect(cluster.label)}
          onMouseEnter={() => dispatch({ type: 'selection/hovered', payload: row.id })}
          onMouseLeave={() => dispatch({ type: 'selection/hovered', payload: null })}
        >
          <title>{`${row.id}: シルエット ${row.s.toFixed(3)}`}</title>
        </rect>,
      )
      yCursor += rowHeight
    }
    yCursor += 24
  }


  const zeroX = 100 + (width - 120) / 2
  const meanX = 100 + ((result.silhouette.mean + 1) / 2) * (width - 120)
  return (
    <div data-testid="silhouette-panel">
      <GraphPanel graphId="clusters/silhouette" title="シルエット図" available sizing="intrinsic"
      style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, userSelect: 'none' }}
        intrinsicSize={{ width, height }} controls={<>
          <Space wrap>
            <Typography.Text strong>シルエット幅図（平均 {result.silhouette.mean.toFixed(3)}）</Typography.Text>
            <SelectionMenu testId="clusters-silhouette-selection" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>幅が広いほどそのクラスタへの所属確からしさが高い · クリックで選択</Typography.Text>
          </Space>
          <L1Legend />
        </>}>
        <EChartSurface data-testid="silhouette-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, display: 'block', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
          {/* reference lines: -1, 0, mean, +1 */}
          <line x1={100} y1={20} x2={100} y2={height - 10} stroke="#e5e7eb" strokeWidth={1} />
          <text x={100} y={14} textAnchor="middle" fontSize={10} fill="#898781">s=-1</text>
          <line x1={zeroX} y1={20} x2={zeroX} y2={height - 10} stroke="#c3c2b7" strokeWidth={1.5} />
          <text x={zeroX} y={14} textAnchor="middle" fontSize={10} fill="#52514e" fontWeight={700}>s=0</text>
          <line x1={width - 20} y1={20} x2={width - 20} y2={height - 10} stroke="#e5e7eb" strokeWidth={1} />
          <text x={width - 20} y={14} textAnchor="middle" fontSize={10} fill="#898781">s=+1</text>
          <line x1={meanX} y1={20} x2={meanX} y2={height - 10} stroke="#eb6834" strokeWidth={1} strokeDasharray="4 3" />
          <text x={meanX} y={14} textAnchor="middle" fontSize={10} fill="#eb6834">平均</text>
          {bars}
        </EChartSurface>
      </GraphPanel>
    </div>
  )
}

function DendrogramPanel({ linkageMatrix, rowIds }: { linkageMatrix: number[][]; rowIds: string[] }) {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const { getColor, selectionColor } = useRowColorResolver()
  const width = Math.max(800, Math.min(1400, window.innerWidth - 220))
  const height = 360
  const n = linkageMatrix.length + 1
  const maxMerge = Math.max(...linkageMatrix.map((row) => row[2])) || 1
  const selectedSet = new Set(selection.selectedRowIds)
  const xOf = new Map<number, number>()
  dendrogramLeafOrder(linkageMatrix).forEach((leaf, position) => {
    xOf.set(leaf, 20 + (position / Math.max(1, n - 1)) * (width - 60))
  })
  linkageMatrix.forEach((merge, index) => {
    const node = n + index
    const x1 = xOf.get(merge[0]) ?? 0
    const x2 = xOf.get(merge[1]) ?? 0
    xOf.set(node, (x1 + x2) / 2)
  })
  const yOf = (heightValue: number) => height - 30 - (heightValue / maxMerge) * (height - 60)

  const subtreeLeaves = (node: number): number[] => {
    if (node < n) return [node]
    const merge = linkageMatrix[node - n]
    return [...subtreeLeaves(merge[0]), ...subtreeLeaves(merge[1])]
  }

  const selectSubtree = (node: number) => {
    const leafIndexes = subtreeLeaves(node)
    const ids = leafIndexes.map((i) => rowIds[i]).filter(Boolean)
    dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: 'Dendrogram部分木選択' }))
  }


  return (
    <div data-testid="dendrogram-panel">
      <GraphPanel graphId="clusters/dendrogram" title="樹形図 (デンドログラム)" available sizing="intrinsic"
      style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 14, userSelect: 'none' }}
        intrinsicSize={{ width, height }} controls={<Space wrap>
          <SelectionMenu testId="clusters-dendrogram-selection" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>部分木クリックで選択</Typography.Text>
        </Space>}>
        <EChartSurface data-testid="dendrogram-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, display: 'block', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
          {linkageMatrix.map((merge, index) => {
            const node = n + index
            const x1 = xOf.get(merge[0]) ?? 0
            const x2 = xOf.get(merge[1]) ?? 0
            const y1 = yOf(merge[0] < n ? 0 : linkageMatrix[merge[0] - n][2])
            const y2 = yOf(merge[1] < n ? 0 : linkageMatrix[merge[1] - n][2])
            const yTop = yOf(merge[2])
            const leafIds = subtreeLeaves(node).map((i) => rowIds[i])
            const allSelected = leafIds.length > 0 && leafIds.every((id) => selectedSet.has(id))
            const firstColor = leafIds.length ? getColor(leafIds[0]) : undefined
            const groupColor = leafIds.every(id => getColor(id) === firstColor) ? firstColor : undefined
            return (
              <g key={index} onClick={() => selectSubtree(node)} style={{ cursor: 'pointer' }}>
                <title>{`クラスタ ${index}: ${leafIds.length}行 (merge高さ ${merge[2].toFixed(2)}) — クリックで部分木を選択`}</title>
                <line x1={x1} y1={y1} x2={x1} y2={yTop} stroke={allSelected ? selectionColor : groupColor ?? '#64748b'} strokeWidth={allSelected ? 2 : 1} />
                <line x1={x2} y1={y2} x2={x2} y2={yTop} stroke={allSelected ? selectionColor : groupColor ?? '#64748b'} strokeWidth={allSelected ? 2 : 1} />
                <line x1={x1} y1={yTop} x2={x2} y2={yTop} stroke={allSelected ? selectionColor : groupColor ?? '#64748b'} strokeWidth={allSelected ? 2 : 1} />
                <rect x={Math.min(x1, x2)} y={yTop - 6} width={Math.abs(x2 - x1) + 2} height={12} fill="transparent" />
              </g>
            )
          })}
        </EChartSurface>
      </GraphPanel>
    </div>
  )
}
