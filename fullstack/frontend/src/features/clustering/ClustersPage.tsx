import { Select as AntSelect } from 'antd'
import Select from '../common/ColumnSelect'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Alert, Button, Card, Col, Descriptions, Dropdown, InputNumber, Row, Segmented, Space, Spin, Statistic, Tag, Typography, message,
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
import { getBrushOp, useBrushOp } from '../selection/SelectionMenu'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { getSvgPoint } from '../../utils/svgCoordinates'

import CobwebTreeViewer from './CobwebTreeViewer'
import DiscCategoryMatrix from './DiscCategoryMatrix'

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

export default function ClustersPage() {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const stored = selection.clusterResult
  const { focused, isTargetActive } = useFocusMode()
  const activeRowIds = useSelector(selectEffectiveRowIds)
  const variables = useSelector(selectOrdinaryVariables)
  const entities = useSelector(selectVariableEntities)
  const [added, setAdded] = useState<{ datasetId: string | null; names: string[] }>({ datasetId: null, names: [] })
  const { columns: definitions, schemaRevision } = useCodebook()
  const [method, setMethod] = useState('kmeans')
  const [k, setK] = useState(3)
  const [seed, setSeed] = useState(42)
  const [linkage, setLinkage] = useState('average')
  const [distance, setDistance] = useState('euclidean')
  const [acuity, setAcuity] = useState(0.1)
  const [cutoff, setCutoff] = useState(0.001)
  const [alphaSmooth, setAlphaSmooth] = useState(0.6)
  const [numWeight, setNumWeight] = useState(1.0)
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
  const numericColumns = method === 'class_variable' ? [] : [
    ...candidates.filter(column => ['ordinal', 'interval', 'ratio'].includes(column.scaleType)).map(column => column.name),
    ...(mixed ? [] : maColumns)]
  const classCandidates = [...candidates.filter(column => column.scaleType === 'nominal').map(column => column.name), ...maColumns]
  const categoricalColumns = mixed ? classCandidates : []
  const [requestedClass, setClassColumn] = useState<string | null>(null)
  const classColumn = classCandidates.includes(requestedClass ?? '') ? requestedClass : null
  const inputKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, activeRowIds,
    numericColumns, categoricalColumns, classColumn, method, k, seed, linkage, distance, acuity, cutoff, alphaSmooth, numWeight])
  const [resultInput, setResultInput] = useState<{ resultId: string; key: string } | null>(null)
  const resultMatchesInput = stored && resultInput?.resultId === stored.resultId && resultInput.key === inputKey
  const currentInput = useRef(inputKey)
  currentInput.current = inputKey
  const runVersion = useRef(0)
  useEffect(() => {
    setRunning(false)
    setError(null)
    return () => { runVersion.current++ }
  }, [inputKey])

  const theme = vizTheme(false)

  const runClustering = async () => {
    if (!selection.datasetId) return
    const version = ++runVersion.current
    setRunning(true)
    setError(null)
    try {
      const response = await api.post<ClusterResponse>('/clusters', {
        datasetId: selection.datasetId,
        activeRowIds,
        expectedDataRevision: selection.dataRevision,
        expectedSchemaRevision: schemaRevision,
        method,
        k,
        seed,
        linkage,
        distance,
        classColumn: method === 'class_variable' ? classColumn : undefined,
        columns: numericColumns,
        categoricalColumns: categoricalColumns.length > 0 ? categoricalColumns : undefined,
        scaling: 'zscore',
        acuity,
        cutoff,
        alphaSmooth,
        numWeight,
      })
      if (version !== runVersion.current || currentInput.current !== inputKey) return
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
      if (version === runVersion.current && currentInput.current === inputKey) setError(err as { message: string })
    } finally {
      if (version === runVersion.current) setRunning(false)
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : 'none',
        minHeight: focused ? 0 : undefined,
        overflowX: 'hidden',
      }}
    >
      {!focused && (
        <Card size="small" style={{ background: '#fafafa' }}>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>クラスタリング手法:</Typography.Text>
              <Button
                data-testid="run-clustering"
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={running}
                onClick={() => void runClustering()}
              >
                クラスタリング実行
              </Button>
            </div>
            <Segmented
              data-testid="cluster-method"
              options={[
                { label: 'KMeans', value: 'kmeans' },
                { label: 'KMedoids', value: 'kmedoids' },
                { label: 'Divisive', value: 'divisive' },
                { label: 'EM(GMM)', value: 'gmm' },
                { label: '階層的', value: 'agglomerative' },
                { label: 'Cobweb', value: 'cobweb' },
                { label: 'DISC (AAAI 2026)', value: 'disc' },
                { label: 'Class変数', value: 'class_variable' },
              ]}
              value={method}
              onChange={(v) => setMethod(String(v))}
            />
            <Space wrap>
              <MaAxisPicker allowCount={false} groups={groups} columns={definitions} onAdd={axes => {
                const names = definitions.filter(column => axes.some(axis => axis.columnId === column.columnId)).map(column => column.name)
                setAdded({ datasetId: selection.datasetId, names: [...new Set([...(added.datasetId === selection.datasetId ? added.names : []), ...names])] })
              }} />
              <Select data-testid="cluster-ma-columns" mode="multiple" size="small" placeholder="追加したMA選択肢" value={maColumns}
                style={{ minWidth: 220 }} options={maColumns.map(name => ({ value: name, label: definitions.find(column => column.name === name)?.multiResponseOptionLabel || name }))}
                onChange={names => setAdded({ datasetId: selection.datasetId, names })} />
            </Space>
            {method !== 'class_variable' ? (
              <Row gutter={[16, 8]} align="middle">
                <Col>
                  <Space size={6}>
                    <Typography.Text style={{ fontSize: 12 }}>クラスタ数 k:</Typography.Text>
                    <InputNumber data-testid="cluster-k" size="small" min={2} max={20} value={k} onChange={(v) => setK(Number(v) ?? 2)} />
                  </Space>
                </Col>
                <Col>
                  <Space size={6}>
                    <Typography.Text style={{ fontSize: 12 }}>乱数 seed:</Typography.Text>
                    <InputNumber data-testid="cluster-seed" size="small" min={0} value={seed} onChange={(v) => setSeed(Number(v) ?? 0)} />
                  </Space>
                </Col>
                {method === 'agglomerative' && (
                  <Col>
                    <Space size={6} wrap>
                      <Typography.Text style={{ fontSize: 12 }}>連結法:</Typography.Text>
                      <AntSelect data-testid="linkage" size="small" value={linkage} onChange={setLinkage} style={{ width: 170 }}
                        options={[
                          { value: 'nearest', label: 'Nearest（最短距離法）' },
                          { value: 'farthest', label: 'Farthest（最長距離法）' },
                          { value: 'average', label: 'Average' },
                          { value: 'group_average', label: 'Group Average' },
                        ]} />
                      <Typography.Text style={{ fontSize: 12 }}>距離尺度:</Typography.Text>
                      <AntSelect data-testid="distance" size="small" value={distance} onChange={setDistance} style={{ width: 160 }}
                        options={[
                          { value: 'euclidean', label: 'Euclidean' },
                          { value: 'standard_euclidean', label: 'Standard Euclidean' },
                          { value: 'city_block', label: 'City-block' },
                        ]} />
                    </Space>
                  </Col>
                )}
                {method === 'cobweb' && (
                  <Col>
                    <Space size={6} wrap>
                      <Typography.Text style={{ fontSize: 12 }}>Acuity:</Typography.Text>
                      <InputNumber data-testid="cobweb-acuity" size="small" min={0.01} step={0.05} value={acuity} onChange={(v) => setAcuity(Number(v) ?? 0.1)} />
                      <Typography.Text style={{ fontSize: 12 }}>Cutoff:</Typography.Text>
                      <InputNumber data-testid="cobweb-cutoff" size="small" min={0.0001} step={0.001} value={cutoff} onChange={(v) => setCutoff(Number(v) ?? 0.001)} />
                    </Space>
                  </Col>
                )}
                {method === 'disc' && (
                  <Col>
                    <Space size={6} wrap>
                      <Typography.Text style={{ fontSize: 12 }}>Alpha平滑化:</Typography.Text>
                      <InputNumber data-testid="disc-alpha" size="small" min={0.01} max={5.0} step={0.1} value={alphaSmooth} onChange={(v) => setAlphaSmooth(Number(v) ?? 0.6)} />
                      <Typography.Text style={{ fontSize: 12 }}>数値重み:</Typography.Text>
                      <InputNumber data-testid="disc-num-weight" size="small" min={0.1} max={10.0} step={0.5} value={numWeight} onChange={(v) => setNumWeight(Number(v) ?? 1.0)} />
                    </Space>
                  </Col>
                )}
                <Col>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    分析対象: 数値列 {numericColumns.length}本{categoricalColumns.length > 0 ? ` + カテゴリ列 ${categoricalColumns.length}本` : ''}（z-score標準化）
                  </Typography.Text>
                </Col>
              </Row>
            ) : (
              <Space>
                <Typography.Text style={{ fontSize: 12 }}>正解ラベル列:</Typography.Text>
                <Select data-testid="class-column" size="small" placeholder="クラス列" style={{ width: 200 }} value={classColumn} onChange={setClassColumn}
                  options={classCandidates.map((c) => ({ value: c, label: c }))} />
              </Space>
            )}
            {error && <Alert type="error" showIcon message={error.message} style={{ marginTop: 6 }} />}
          </Space>
        </Card>
      )}

      {stored && !resultMatchesInput && <Alert type="info" showIcon data-testid="cluster-previous-result"
        message="表示中の結果は現在の入力と異なるか、入力条件を確認できません。現在の条件で分類するには再実行してください。" />}

      {/* Summary KPI Cards */}
      {!focused && stored && (
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
          {!focused && <ClusterSummaryPanel result={stored} onSelect={selectCluster} />}
          {!focused && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              クラスタボタン/凡例/シルエット/樹形図クリック=集合演算で反映
            </Typography.Text>
          )}
          {stored.pcaProjection && (!focused || isTargetActive('pca')) && (
            <FocusTarget id="pca" title="主成分散布図 (PCA)">
              <PcaScatterPlot result={stored} onSelect={selectCluster} />
            </FocusTarget>
          )}
          {stored.silhouette && (!focused || isTargetActive('silhouette')) && (
            <FocusTarget id="silhouette" title="シルエット図">
              <SilhouettePlot result={stored} onSelect={selectCluster} />
            </FocusTarget>
          )}
          {stored.linkageMatrix && (!focused || isTargetActive('dendrogram')) && (
            <FocusTarget id="dendrogram" title="樹形図 (デンドログラム)">
              <DendrogramPanel linkageMatrix={stored.linkageMatrix} rowIds={stored.rowIds} />
            </FocusTarget>
          )}
          {stored.conceptTree && (!focused || isTargetActive('cobweb-tree')) && (
            <FocusTarget id="cobweb-tree" title="Cobweb 概念木">
              <CobwebTreeViewer
                conceptTree={stored.conceptTree}
                rowIds={stored.rowIds}
                onSelectRows={(ids) =>
                  dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: 'Cobweb概念選択' }))
                }
              />
            </FocusTarget>
          )}
          {stored.categoryMatrices && (!focused || isTargetActive('disc-matrix')) && (
            <FocusTarget id="disc-matrix" title="DISC カテゴリ関係行列">
              <DiscCategoryMatrix
                categoryMatrices={stored.categoryMatrices}
                clusterCount={stored.k}
              />
            </FocusTarget>
          )}
        </>
      )}
    </div>
  )
}

/** PCA 2D scatter of the clustering: PC1×PC2 with cluster colors and
 *  selection highlight; click a point to toggle that row in the shared selection. */
function PcaScatterPlot({ result, onSelect }: { result: ClusterResponse; onSelect: (label: number) => void }) {
  const { getColor, selectionColor } = useRowColorResolver()
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const rowScope = useSelector(selectEffectiveRowIds)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const { focused, zoom } = useFocusMode()
  const context = useMemo(() => ({}), [selection.datasetId, selection.dataRevision, schemaRevision,
    selection.activeRowIds, rowScope, result, focused, zoom])
  const currentContext = useRef(context)
  currentContext.current = context
  const selectionVersion = useRef(0)
  const theme = vizTheme(false)
  // Square plot sized to the viewport (fills available width, capped).
  const size = Math.max(360, Math.min(760, window.innerWidth - 220))
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
    if (Math.abs(cur.x2 - cur.x1) < 5 && Math.abs(cur.y2 - cur.y1) < 5) return
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
      label: 'Focus Selected (選択行のみに絞り込み)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: 'Delete Selected (選択行を一時除外)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: 'Clear Selection (選択解除)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      key: 'reset',
      label: 'Reset to Base Data (全データ復帰)',
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]

  const { isTargetActive } = useFocusMode()
  return (
    <div data-testid="pca-panel" style={{ maxWidth: '100%', height: isTargetActive('pca') ? '100%' : undefined, flex: isTargetActive('pca') ? 1 : 'none', flexShrink: 0, display: 'flex', flexDirection: 'column', border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14, userSelect: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <Space wrap align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            主成分散布図（PC1 {`${(pca.varianceRatio[0] * 100).toFixed(1)}%`} ／ PC2 {(pca.varianceRatio[1] * 100).toFixed(1)}% 分散）
          </Typography.Title>
          <FocusEnterButton targetId="pca" title="主成分散布図 (PCA)" />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>ドラッグ=矩形選択 · 点クリック=toggle · 右クリックで操作</Typography.Text>
      </div>
      <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
      <svg
        ref={svgRef}
        data-testid="pca-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        style={{ width: '100%', maxWidth: isTargetActive('pca') ? 'none' : size, height: isTargetActive('pca') ? '100%' : 'auto', display: 'block', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', touchAction: 'none' }}
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
              r={isSelected ? 5.0 : isHovered ? 4.5 : 3.5}
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
      </svg>
      </Dropdown>
      <L1Legend />
    </div>
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
        >
          <title>{`${row.id}: シルエット ${row.s.toFixed(3)}`}</title>
        </rect>,
      )
      yCursor += rowHeight
    }
    yCursor += 24
  }

  const { isTargetActive } = useFocusMode()
  const active = isTargetActive('silhouette')
  const zeroX = 100 + (width - 120) / 2
  const meanX = 100 + ((result.silhouette.mean + 1) / 2) * (width - 120)
  return (
    <div data-testid="silhouette-panel" style={{ minWidth: 0, overflow: active ? 'hidden' : 'visible', height: active ? '100%' : undefined, flex: active ? 1 : 'none', flexShrink: 0, display: 'flex', flexDirection: 'column', border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14, userSelect: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <Space wrap align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            シルエット幅図（平均 {result.silhouette.mean.toFixed(3)}）
          </Typography.Title>
          <FocusEnterButton targetId="silhouette" title="シルエット図" />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>幅が広いほどそのクラスタへの所属確からしさが高い · クリックで選択</Typography.Text>
      </div>
      <L1Legend />
      <div style={{ flex: active ? 1 : 'none', overflow: 'auto', minHeight: active ? 0 : 200, maxHeight: active ? undefined : 420 }}>
        <svg data-testid="silhouette-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxWidth: active ? 'none' : width, height: active ? '100%' : height, display: 'block', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
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
        </svg>
      </div>
    </div>
  )
}

function DendrogramPanel({ linkageMatrix, rowIds }: { linkageMatrix: number[][]; rowIds: string[] }) {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const theme = vizTheme(false)
  const width = Math.max(800, Math.min(1400, window.innerWidth - 220))
  const height = 360
  const n = linkageMatrix.length + 1
  const maxMerge = Math.max(...linkageMatrix.map((row) => row[2])) || 1
  const selectedSet = new Set(selection.selectedRowIds)
  const groupByRow = new Map<string, number>()
  selection.groups.forEach((group, index) => {
    group.rowIds.forEach((id) => { if (!groupByRow.has(id)) groupByRow.set(id, index) })
  })

  const xOf = new Map<number, number>()
  for (let i = 0; i < n; i += 1) xOf.set(i, 20 + (i / Math.max(1, n - 1)) * (width - 60))
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

  const { isTargetActive } = useFocusMode()
  const active = isTargetActive('dendrogram')
  return (
    <div data-testid="dendrogram-panel" style={{ minWidth: 0, overflow: active ? 'hidden' : 'visible', height: active ? '100%' : undefined, flex: active ? 1 : 'none', flexShrink: 0, display: 'flex', flexDirection: 'column', border: '1px solid #e5e7eb', borderRadius: 6, background: '#ffffff', padding: 14, userSelect: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <Space wrap align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>Dendrogram（樹形図）</Typography.Title>
          <FocusEnterButton targetId="dendrogram" title="樹形図 (デンドログラム)" />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>部分木クリックで選択</Typography.Text>
      </div>
      <div style={{ flex: active ? 1 : 'none', overflow: 'auto', minHeight: active ? 0 : 360, maxHeight: active ? undefined : 380 }}>
        <svg data-testid="dendrogram-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxWidth: active ? 'none' : width, height: active ? '100%' : height, display: 'block', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
          {linkageMatrix.map((merge, index) => {
            const node = n + index
            const x1 = xOf.get(merge[0]) ?? 0
            const x2 = xOf.get(merge[1]) ?? 0
            const y1 = yOf(merge[0] < n ? 0 : linkageMatrix[merge[0] - n][2])
            const y2 = yOf(merge[1] < n ? 0 : linkageMatrix[merge[1] - n][2])
            const yTop = yOf(merge[2])
            const leafIds = subtreeLeaves(node).map((i) => rowIds[i])
            const allSelected = leafIds.length > 0 && leafIds.every((id) => selectedSet.has(id))
            const groupColor = leafIds.length && leafIds.every((id) => groupByRow.has(id))
              ? composedColor(theme, { l2Group: groupByRow.get(leafIds[0])! })
              : undefined
            return (
              <g key={index} onClick={() => selectSubtree(node)} style={{ cursor: 'pointer' }}>
                <title>{`クラスタ ${index}: ${leafIds.length}行 (merge高さ ${merge[2].toFixed(2)}) — クリックで部分木を選択`}</title>
                <line x1={x1} y1={y1} x2={x1} y2={yTop} stroke={allSelected ? theme.selection : groupColor ?? '#64748b'} strokeWidth={allSelected ? 2 : 1} />
                <line x1={x2} y1={y2} x2={x2} y2={yTop} stroke={allSelected ? theme.selection : groupColor ?? '#64748b'} strokeWidth={allSelected ? 2 : 1} />
                <line x1={x1} y1={yTop} x2={x2} y2={yTop} stroke={allSelected ? theme.selection : groupColor ?? '#64748b'} strokeWidth={allSelected ? 2 : 1} />
                <rect x={Math.min(x1, x2)} y={yTop - 6} width={Math.abs(x2 - x1) + 2} height={12} fill="transparent" />
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
