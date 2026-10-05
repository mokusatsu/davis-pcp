import Modal from '../common/ActiveModal'
import MutationProgress from '../common/MutationProgress'
import { useRequestIdentity } from '../common/useRequestIdentity'
import { useAnalysisViewActive } from '../selection/analysisScope'
import EChart from '../charts/EChart'
import { imputationHistogramOption } from './preprocessingCharts'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import GraphPanel from '../common/GraphPanel'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Checkbox,
  Input,
  InputNumber,
  Radio,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { api } from '../../api/client'
import SelectColumn from '../common/ColumnSelect'
import { useCodebook } from './useCodebookColumn'

export interface ColumnMissingInfo {
  name: string
  missing: number
  total: number
  semanticType?: string
}

interface ImputationModalProps {
  open: boolean
  datasetId: string
  targetColumn?: string | null
  columnsWithMissing: ColumnMissingInfo[]
  onClose: () => void
  onSuccess: (committedDatasetId: string) => void
}

interface PreviewStats {
  totalCount: number
  missingCount: number
  missingPercent: number
  mean?: number
  std?: number
  min?: number
  max?: number
  median?: number
}

interface PreviewHistogramItem {
  binLabel: string
  beforeCount: number
  afterCount: number
  imputedAdded: number
}

/** One target column of the plan. */
interface PreviewColumn {
  column: string
  beforeStats: PreviewStats
  afterStats: PreviewStats
  histogram: PreviewHistogramItem[]
  valuesHash: string
}

interface ExcludedColumn {
  column: string
  columnId: string | null
  reason: string
}

/**
 * The plan the preview was computed from. ``planHash`` is echoed back on apply
 * so the server can refuse to run it against a dataset that has moved since.
 */
interface ImputePreviewResponse {
  planHash: string
  strategy: string
  targetColumns: string[]
  predictorColumns: string[]
  excludedColumns: ExcludedColumn[]
  perColumn: PreviewColumn[]
  warnings?: { code: string; message: string }[]
  diagnostics?: any
}

const EXCLUDED_REASON_LABELS: Record<string, string> = {
  PREDICTOR_CATEGORICAL_IGNORED: '非数値のため条件付けに使用しません',
  PREDICTOR_MULTI_RESPONSE_EXCLUDED: 'MA設問のため除外',
  PREDICTOR_WEIGHT_EXCLUDED: 'ウェイト列のため除外',
  PREDICTOR_IS_TARGET: '補完対象のため除外',
}

function inRange(value: number | null, min: number, max = Infinity): value is number {
  return value !== null && Number.isFinite(value) && value >= min && value <= max
}

/** Preserve invalid drafts instead of silently clamping or rounding on blur. */
function ImputationNumberField({ label, value, onChange, min, max, step = 1, invalid, validationId }: {
  label: string; value: number | null; onChange: (value: number | null) => void
  min: number; max?: number; step?: number; invalid: boolean; validationId: string
}) {
  return <InputNumber aria-label={label} aria-invalid={invalid || undefined}
    aria-describedby={invalid ? validationId : undefined} status={invalid ? 'error' : undefined}
    value={value} min={min} max={max} step={step} changeOnBlur={false} onChange={onChange}
    onInput={text => {
      // InputNumber does not emit onChange for every out-of-range draft.
      const parsed = text.trim() === '' ? NaN : Number(text)
      onChange(Number.isFinite(parsed) ? parsed : null)
    }} />
}

export default function ImputationModal({
  open,
  datasetId,
  targetColumn,
  columnsWithMissing,
  onClose,
  onSuccess,
}: ImputationModalProps) {
  const { columns, getColumn } = useCodebook()
  const [selectedCols, setSelectedCols] = useState<string[]>([])
  const [targetSearch, setTargetSearch] = useState('')
  const [strategy, setStrategy] = useState<string>('tabdiff')
  const [inPlace, setInPlace] = useState<boolean>(true)
  // Predictors: "auto" leaves the choice to the server (every usable column).
  const [predictorMode, setPredictorMode] = useState<'auto' | 'manual'>('auto')
  const [predictorCols, setPredictorCols] = useState<string[]>([])

  // Parameters
  const [tabdiffSteps, setTabdiffSteps] = useState<number | null>(20)
  const [temperature, setTemperature] = useState<number | null>(1.0)
  const [knnNeighbors, setKnnNeighbors] = useState<number | null>(5)
  const [constantVal, setConstantVal] = useState<string>('0')
  const [seed, setSeed] = useState<number | null>(42)
  const validationId = useId()
  const validSteps = inRange(tabdiffSteps, 5, 100) && Number.isInteger(tabdiffSteps)
  const validTemperature = inRange(temperature, 0.1, 2)
  const validNeighbors = inRange(knnNeighbors, 1, 50) && Number.isInteger(knnNeighbors)
  const validSeed = inRange(seed, 0, Number.MAX_SAFE_INTEGER) && Number.isSafeInteger(seed)
  const invalidSettings = [
    strategy === 'tabdiff' && !validSteps && '逆拡散ステップ数 T（5〜100の整数）',
    strategy === 'tabdiff' && !validTemperature && '温度（0.1〜2）',
    strategy === 'tabdiff' && !validSeed && `シード（0〜${Number.MAX_SAFE_INTEGER}の整数）`,
    strategy === 'knn' && !validNeighbors && '近傍数 k（1〜50の整数）',
  ].filter(Boolean)
  const canSubmit = selectedCols.length > 0 && invalidSettings.length === 0

  // Preview state
  const [previewLoading, setPreviewLoading] = useState<boolean>(false)
  const [previewData, setPreviewData] = useState<ImputePreviewResponse | null>(null)
  const [previewCol, setPreviewCol] = useState<string>('')
  // Settings the current preview was computed from; a stale hash must never be
  // sent with an apply built from different settings.
  const [previewedSettings, setPreviewedSettings] = useState<string | null>(null)

  // Execution state
  const [executing, setExecuting] = useState<boolean>(false)
  const busy = useRef(false)
  const active = useAnalysisViewActive()
  const mutationRequest = useRequestIdentity(JSON.stringify([datasetId, open, active]))

  /** Only numeric, non-MA, non-weight columns can condition the imputation. */
  const predictorOptions = useMemo(
    () =>
      columns
        .filter((c) => !selectedCols.includes(c.name) && !c.multiResponseGroup && c.role !== 'weight'
          && ['interval', 'ratio'].includes(c.scaleType))
        .map((c) => ({ value: c.name, label: c.name, questionName: c.name, questionText: c.label })),
    [columns, selectedCols],
  )
  // Use the same eligible, disjoint projection for the picker and both requests.
  // Search only changes visibility and must never remove a valid selection.
  const selectedPredictors = useMemo(() => predictorCols.filter(name => predictorOptions.some(option => option.value === name)),
    [predictorCols, predictorOptions])

  const buildOptions = useCallback((): Record<string, any> => {
    // Other strategies do not use the seed, but the plan still expects a number.
    // Keep an invalid hidden draft editable when returning to tabdiff.
    const options: Record<string, any> = { seed: strategy === 'tabdiff' || validSeed ? seed : 42 }
    if (strategy === 'tabdiff') {
      options.num_steps = tabdiffSteps
      options.temperature = temperature
    } else if (strategy === 'knn') {
      options.knn_neighbors = knnNeighbors
    } else if (strategy === 'constant') {
      options.constant_value = constantVal
    }
    return options
  }, [seed, validSeed, strategy, tabdiffSteps, temperature, knnNeighbors, constantVal])

  const buildBody = useCallback(() => ({
    columns: selectedCols,
    // "auto" means the server picks every usable column.
    predictorColumns: predictorMode === 'manual' ? selectedPredictors : undefined,
    strategy,
    options: buildOptions(),
  }), [selectedCols, predictorMode, selectedPredictors, strategy, buildOptions])

  const settingsKey = useMemo(() => JSON.stringify(buildBody()), [buildBody])
  const currentPreview = previewedSettings === settingsKey ? previewData : null
  const previewRequest = useRequestIdentity(JSON.stringify([datasetId, open, active, settingsKey]))

  // F005-G51: columnsWithMissingは親の再レンダーごとに新参照になるため、
  // 配列の中身が変わらない限り初期化effectを再実行しない。拡大開始の
  // Provider再レンダーでpreviewDataが消える回帰を防ぐ。
  const missingKey = columnsWithMissing.map((c) => c.name).join(',')
  useEffect(() => {
    if (targetColumn) {
      setSelectedCols([targetColumn])
      setPreviewCol(targetColumn)
    } else if (columnsWithMissing.length > 0) {
      const initial = columnsWithMissing.map((c) => c.name)
      setSelectedCols(initial)
      setPreviewCol(initial[0] || '')
    } else {
      setSelectedCols([])
      setPreviewCol('')
    }
    setTargetSearch('')
    setPreviewData(null)
    setPreviewedSettings(null)
    setPredictorMode('auto')
    setPredictorCols([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetColumn, missingKey, open, datasetId])

  useEffect(() => { setPreviewLoading(false) }, [datasetId, open, active, settingsKey])

  const fetchPreview = async () => {
    if (!open || !active || !canSubmit) return null
    const current = previewRequest.begin()
    setPreviewLoading(true)
    try {
      // Preview the *whole* target set — the same request the apply will send.
      const res = await api.post<ImputePreviewResponse>(`/datasets/${datasetId}/impute/preview`, buildBody())
      if (!current()) return null
      setPreviewData(res)
      setPreviewedSettings(JSON.stringify(buildBody()))
      setPreviewCol((prev) => (res.perColumn.some((c) => c.column === prev) ? prev : (res.perColumn[0]?.column ?? '')))
      return res
    } catch (err: any) {
      if (!current()) return null
      message.error(`プレビュー取得エラー: ${err.code ? `${err.code}: ` : ''}${err.message || err}`)
      return null
    } finally {
      if (current()) setPreviewLoading(false)
    }
  }

  const handleApply = async () => {
    if (busy.current || !open || !active) return
    if (selectedCols.length === 0) {
      message.warning('補完対象の列を1つ以上選択してください。')
      return
    }
    if (invalidSettings.length > 0) {
      message.warning(`設定を確認してください: ${invalidSettings.join('、')}`)
      return
    }
    busy.current = true
    const current = mutationRequest.begin()
    previewRequest.invalidate()
    setPreviewLoading(false)
    setExecuting(true)
    try {
      // Apply exactly what was previewed; if the settings moved on since, the
      // preview is not the thing being applied and no hash is asserted.
      const planHash = previewData && previewedSettings === settingsKey ? previewData.planHash : undefined
      await api.post(`/datasets/${datasetId}/impute`, {
        ...buildBody(),
        inPlace,
        planHash,
      })
      message.success(`欠損値補完完了 (${strategy})`)
      onSuccess(datasetId)
      if (current()) onClose()
    } catch (err: any) {
      if (current() && err?.code === 'IMPUTATION_PLAN_STALE') {
        message.warning('プレビュー後にデータが変わりました。再プレビューします。')
        await fetchPreview()
      } else {
        message.error(`補完エラー: ${err.code ? `${err.code}: ` : ''}${err.message || err}`)
      }
    } finally {
      busy.current = false
      setExecuting(false)
    }
  }

  const filteredTargets = columnsWithMissing.filter(col =>
    `${col.name} ${getColumn(col.name)?.label ?? ''}`.toLocaleLowerCase().includes(targetSearch.trim().toLocaleLowerCase()))
  const hiddenTargetCount = selectedCols.filter(name => !filteredTargets.some(col => col.name === name)).length

  const activePreview = currentPreview?.perColumn.find((c) => c.column === previewCol)
    ?? currentPreview?.perColumn[0]

  return (
    <Modal
      open={open}
      title={
        <Space>
          <Typography.Title level={5} style={{ margin: 0 }}>
            欠損値補完フィルター (Replace Missing Values)
          </Typography.Title>
          <Tag color="purple">実験的条件付き補完 / Statistical</Tag>
        </Space>
      }
      width={840}
      onCancel={() => { if (!busy.current) onClose() }}
      closable={!executing}
      keyboard={!executing}
      maskClosable={!executing}
      onDeactivate={onClose}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={executing}>
          キャンセル
        </Button>,
        <Button
          key="preview"
          onClick={() => void fetchPreview()}
          loading={previewLoading}
          disabled={executing || !canSubmit}
          aria-describedby={invalidSettings.length ? validationId : undefined}
        >
          プレビュー更新
        </Button>,
        <Button
          key="submit"
          type="primary"
          onClick={() => void handleApply()}
          loading={executing}
          disabled={executing || !canSubmit}
          aria-describedby={invalidSettings.length ? validationId : undefined}
          data-testid="btn-execute-imputation"
        >
          補完を適用
        </Button>,
      ]}
    >
      <MutationProgress busy={executing} />
      <ConfigProvider componentDisabled={executing}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '68vh', overflowY: 'auto' }}>
        {/* Section 1: Columns */}
        <Card size="small" title="1. 補完対象の列を選択" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          {columnsWithMissing.length === 0 ? (
            <Alert type="info" message="欠損値を含む列は見つかりませんでした。" showIcon />
          ) : (
            <>
              <Space wrap style={{ marginBottom: 12, width: '100%' }}>
                <Input aria-label="補完対象を変数名・質問文で検索" placeholder="変数名・質問文で絞り込み"
                  value={targetSearch} onChange={event => setTargetSearch(event.target.value)} allowClear disabled={executing} />
                <Button disabled={executing || !filteredTargets.length} onClick={() => setSelectedCols(previous => [...new Set([...previous, ...filteredTargets.map(col => col.name)])])}>
                  検索結果を全選択（{filteredTargets.length}件）
                </Button>
                <Button disabled={executing || !filteredTargets.some(col => selectedCols.includes(col.name))}
                  onClick={() => setSelectedCols(previous => previous.filter(name => !filteredTargets.some(col => col.name === name)))}>検索結果を全解除</Button>
                <Typography.Text role="status">{selectedCols.length}件選択中{hiddenTargetCount ? `（検索結果外 ${hiddenTargetCount}件）` : ''}</Typography.Text>
              </Space>
              <div role="group" aria-label="補完対象の検索結果" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {filteredTargets.map(col => {
                  const isChecked = selectedCols.includes(col.name)
                  const pct = ((col.missing / Math.max(1, col.total)) * 100).toFixed(1)
                  return <Checkbox key={col.name} checked={isChecked} disabled={executing}
                    style={{ marginInlineStart: 0, padding: '6px 10px', borderRadius: 6, border: `1px solid ${isChecked ? '#2563eb' : '#e5e7eb'}`, background: isChecked ? '#eff6ff' : '#fff' }}
                    onChange={event => {
                      setSelectedCols(previous => event.target.checked ? [...previous, col.name] : previous.filter(name => name !== col.name))
                      if (event.target.checked) setPreviewCol(col.name)
                    }}>
                    <Space size="small" wrap>
                      <Typography.Text strong><ColumnQuestionTooltip nameOrId={col.name} tabIndex={-1} passive>{col.name}</ColumnQuestionTooltip></Typography.Text>
                      <Tag color="red" style={{ margin: 0, fontSize: 11 }}>欠損 {col.missing} ({pct}%)</Tag>
                    </Space>
                  </Checkbox>
                })}
                {!filteredTargets.length && <Typography.Text type="secondary">該当する変数がありません</Typography.Text>}
              </div>
            </>
          )}
        </Card>

        {/* Section 2: Strategy */}
        <Card size="small" title="2. 補完アルゴリズム" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Segmented
              data-testid="impute-strategy"
              options={[
                { label: '実験的条件付き補完', value: 'tabdiff' },
                { label: 'KNN (k近傍)', value: 'knn' },
                { label: 'Mean (平均値)', value: 'mean' },
                { label: 'Median (中央値)', value: 'median' },
                { label: 'Mode (最頻値)', value: 'mode' },
                { label: 'Constant (定数)', value: 'constant' },
              ]}
              value={strategy}
              onChange={(v) => setStrategy(String(v))}
            />

            {strategy === 'tabdiff' && (
              <div style={{ background: '#f8fafc', padding: 12, borderRadius: 6, border: '1px solid #e2e8f0' }}>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                  <b>実験的条件付き補完:</b>{' '}
                  Gaussian条件付き平均と周辺頻度による近似（適用範囲：欠損補完の実験機能）。
                  <Tooltip
                    title="Gaussian条件付き平均と周辺頻度による近似（適用範囲：欠損補完の実験機能）"
                    aria-label="実験的条件付き補完の説明"
                  >
                    <span tabIndex={0} role="img" aria-label="実験的条件付き補完の説明" style={{ cursor: 'help', marginLeft: 4 }}>ⓘ</span>
                  </Tooltip>
                </Typography.Paragraph>
                <Space wrap size="middle">
                  <Space>
                    <Typography.Text style={{ fontSize: 12 }}>逆拡散ステップ数 T:</Typography.Text>
                    <ImputationNumberField label="逆拡散ステップ数 T" min={5} max={100} value={tabdiffSteps}
                      onChange={setTabdiffSteps} invalid={!validSteps} validationId={validationId} />
                  </Space>
                  <Space>
                    <Typography.Text style={{ fontSize: 12 }}>温度 (Temperature):</Typography.Text>
                    <ImputationNumberField label="温度 (Temperature)" min={0.1} max={2.0} step={0.1} value={temperature}
                      onChange={setTemperature} invalid={!validTemperature} validationId={validationId} />
                  </Space>
                  <Space>
                    <Typography.Text style={{ fontSize: 12 }}>シード:</Typography.Text>
                    <ImputationNumberField label="シード" min={0} max={Number.MAX_SAFE_INTEGER} value={seed}
                      onChange={setSeed} invalid={!validSeed} validationId={validationId} />
                  </Space>
                </Space>
              </div>
            )}

            {strategy === 'knn' && (
              <Space>
                <Typography.Text style={{ fontSize: 12 }}>近傍数 k:</Typography.Text>
                <ImputationNumberField label="近傍数 k" min={1} max={50} value={knnNeighbors}
                  onChange={setKnnNeighbors} invalid={!validNeighbors} validationId={validationId} />
              </Space>
            )}

            {strategy === 'constant' && (
              <Space>
                <Typography.Text style={{ fontSize: 12 }}>補完定数値:</Typography.Text>
                <Input aria-label="補完定数値" style={{ width: 160 }} value={constantVal} onChange={(e) => setConstantVal(e.target.value)} />
              </Space>
            )}
            {invalidSettings.length > 0 && <Alert id={validationId} type="warning" showIcon
              message={`設定を確認してください: ${invalidSettings.join('、')}`} />}
          </Space>
        </Card>

        {/* Section 3: Predictors */}
        <Card size="small" title="3. 説明変数（条件付け）" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Segmented
              data-testid="impute-predictor-mode"
              options={[
                { label: '自動（目的列以外の全列）', value: 'auto' },
                { label: '個別に指定', value: 'manual' },
              ]}
              value={predictorMode}
              onChange={(v) => setPredictorMode(String(v) as 'auto' | 'manual')}
            />
            {predictorMode === 'manual' && (
              <SelectColumn
                data-testid="impute-predictors"
                roleName="補完の説明変数"
                aria-label="補完の説明変数"
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="説明変数を選択"
                value={selectedPredictors}
                onChange={(v) => setPredictorCols((v as string[]) ?? [])}
                options={predictorOptions}
              />
            )}
            <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
              説明変数は補完の条件付けにのみ使われ、値は書き換えられません。目的列を説明変数に指定することはできません。
              非数値の列・MA設問・ウェイト列は自動選択から除外されます。
            </Typography.Paragraph>
            {currentPreview && currentPreview.excludedColumns.length > 0 && (
              <Space wrap size={[4, 4]}>
                {currentPreview.excludedColumns.map((e) => (
                  <Tag key={`${e.column}-${e.reason}`} color="default" style={{ margin: 0 }}>
                    {e.column}: {EXCLUDED_REASON_LABELS[e.reason] ?? e.reason}
                  </Tag>
                ))}
              </Space>
            )}
            {(currentPreview?.warnings ?? []).map((w) => (
              <Alert key={w.code} type="warning" message={`${w.code}: ${w.message}`} showIcon />
            ))}
          </Space>
        </Card>

        {/* Section 4: Preview Comparison */}
        <Card
          size="small"
          title={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>4. 補完プレビュー &amp; 分布比較</span>
              {currentPreview && currentPreview.perColumn.length > 1 && (
                <Space>
                  <Typography.Text style={{ fontSize: 12 }}>対象列:</Typography.Text>
                  <Radio.Group
                    size="small"
                    value={activePreview?.column}
                    onChange={(e) => setPreviewCol(e.target.value)}
                  >
                    {currentPreview.perColumn.map((c) => (
                      <Radio.Button key={c.column} value={c.column}>
                        <ColumnQuestionTooltip nameOrId={c.column}>{c.column}</ColumnQuestionTooltip>
                      </Radio.Button>
                    ))}
                  </Radio.Group>
                </Space>
              )}
            </div>
          }
          style={{ borderRadius: 6, borderColor: '#e5e7eb' }}
        >
          {previewLoading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin tip="プレビュー計算中..." />
            </div>
          ) : currentPreview && activePreview ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Comparison Stat Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>欠損数 変化</Typography.Text>
                  <div>
                    <Typography.Text delete type="danger">
                      {activePreview.beforeStats.missingCount}
                    </Typography.Text>
                    {' → '}
                    <Typography.Text strong type="success">
                      {activePreview.afterStats.missingCount} (0%)
                    </Typography.Text>
                  </div>
                </div>

                {activePreview.beforeStats.mean !== undefined && (
                  <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>平均値 (Mean)</Typography.Text>
                    <div>
                      <Typography.Text>{activePreview.beforeStats.mean?.toFixed(2)}</Typography.Text>
                      {' → '}
                      <Typography.Text strong style={{ color: '#2563eb' }}>
                        {activePreview.afterStats.mean?.toFixed(2)}
                      </Typography.Text>
                    </div>
                  </div>
                )}

                {activePreview.beforeStats.std !== undefined && (
                  <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>標準偏差 (Std)</Typography.Text>
                    <div>
                      <Typography.Text>{activePreview.beforeStats.std?.toFixed(2)}</Typography.Text>
                      {' → '}
                      <Typography.Text strong style={{ color: '#2563eb' }}>
                        {activePreview.afterStats.std?.toFixed(2)}
                      </Typography.Text>
                    </div>
                  </div>
                )}

                {activePreview.beforeStats.median !== undefined && (
                  <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>中央値 (Median)</Typography.Text>
                    <div>
                      <Typography.Text>{activePreview.beforeStats.median?.toFixed(2)}</Typography.Text>
                      {' → '}
                      <Typography.Text strong style={{ color: '#2563eb' }}>
                        {activePreview.afterStats.median?.toFixed(2)}
                      </Typography.Text>
                    </div>
                  </div>
                )}
              </div>

              {/* Distribution Bar Chart: 図だけを拡大。プレビュー更新・編集状態を保持 */}
              {activePreview && activePreview.histogram.length > 0 && (
                <GraphPanel
                  graphId={`preprocess/imputation/${previewCol || 'preview'}`}
                  title="補完前後の分布比較"
                  available={open && Boolean(activePreview)}
                  sizing="intrinsic"
                  intrinsicSize={{ width: 560, height: Math.max(200, 90 + activePreview.histogram.length * 30) }}
                >
                  <EChart testId="imputation-histogram" height={Math.max(200, 90 + activePreview.histogram.length * 30)}
                    ariaLabel="補完前観測値と補完追加分の度数分布" resetKey={previewCol}
                    option={imputationHistogramOption(activePreview.histogram)} />
                </GraphPanel>
              )}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 16, color: '#64748b' }}>
              {previewData && !currentPreview
                ? '設定が変更されています。「プレビュー更新」で現在の設定の分布を確認できます。'
                : '「プレビュー更新」をクリックすると、選択した補完アルゴリズムによる分布変化が視覚化されます。'}
            </div>
          )}
        </Card>

        {/* Section 4: Output target */}
        <Card size="small" title="4. 適用先" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          <Radio.Group value={inPlace} onChange={(e) => setInPlace(e.target.value)}>
            <Space direction="vertical">
              <Radio value={true}>
                <Typography.Text strong>現在のデータセットを更新 (In-place update)</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                  現在のデータセットのリビジョンをインクリメントし、PCPや全プロットを即座に更新します。
                </Typography.Paragraph>
              </Radio>
              <Radio value={false}>
                <Typography.Text strong>新しいデータセットとして保存 (Create derived dataset)</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                  元のデータセットを保持したまま、末尾に _imputed を付与した新しいデータセットを作成します。
                </Typography.Paragraph>
              </Radio>
            </Space>
          </Radio.Group>
        </Card>
      </div>
      </ConfigProvider>
    </Modal>
  )
}
