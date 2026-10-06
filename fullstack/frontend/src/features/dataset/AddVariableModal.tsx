import CategoryBars from '../charts/CategoryBars'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import { useEffect, useRef, useState } from 'react'
import Modal from '../common/ActiveModal'
import MutationProgress from '../common/MutationProgress'
import { useRequestIdentity } from '../common/useRequestIdentity'
import { useAnalysisViewActive } from '../selection/analysisScope'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  ConfigProvider,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import { api } from '../../api/client'

interface AddVariableModalProps {
  open: boolean
  datasetId: string
  dataRevision?: number
  schemaRevision?: number
  datasetName?: string
  columns: string[]
  onClose: () => void
  onSuccess: (committedDatasetId: string) => void
}

type CalculationMode = 'create' | 'replace'

interface CalculatePreviewResponse {
  mode: CalculationMode
  targetExists: boolean
  columnId: string | null
  dataRevision: number
  schemaRevision: number
  rowCount: number
  previewScope: 'first_rows'
  previewRowCount: number
  previewRowLimit: number
  valid: boolean
  error: string | null
  column: string
  previewValues: (number | string | null)[]
  stats: {
    count?: number
    nullCount?: number
    min?: number
    max?: number
    mean?: number
    std?: number
  }
  histogram: { bin: string; count: number }[]
}

const PRESET_TEMPLATES = [
  { label: '比率計算', expr: (c: string[]) => (c.length >= 2 ? `${c[0]} / (${c[1]} + 1e-6)` : 'col1 / (col2 + 1e-6)') },
  { label: '対数変換 (log1p)', expr: (c: string[]) => (c.length >= 1 ? `log(${c[0]} + 1)` : 'log(x + 1)') },
  { label: 'Zスコア標準化', expr: (c: string[]) => (c.length >= 1 ? `zscore(${c[0]})` : 'zscore(x)') },
  { label: 'Min-Max正規化', expr: (c: string[]) => (c.length >= 1 ? `minmax(${c[0]})` : 'minmax(x)') },
  { label: '交互作用項', expr: (c: string[]) => (c.length >= 2 ? `${c[0]} * ${c[1]}` : 'col1 * col2') },
  { label: '条件分岐 (where)', expr: (c: string[]) => (c.length >= 1 ? `where(${c[0]} > 0, 1, 0)` : 'where(x > 0, 1, 0)') },
]

export default function AddVariableModal({
  open,
  datasetId,
  columns,
  dataRevision = 0,
  schemaRevision = 0,
  datasetName = datasetId,
  onClose,
  onSuccess,
}: AddVariableModalProps) {
  const [columnName, setColumnName] = useState<string>('')
  const [expression, setExpression] = useState<string>('')
  const [mode, setMode] = useState<CalculationMode>('create')
  const [targetHint, setTargetHint] = useState<{ key: string; exists: boolean } | null>(null)
  const [preview, setPreview] = useState<CalculatePreviewResponse | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [confirmation, setConfirmation] = useState<{
    preview: CalculatePreviewResponse; current: () => boolean
  } | null>(null)

  const busy = useRef(false)
  const active = useAnalysisViewActive()
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [previewGuard, setPreviewGuard] = useState<(() => boolean) | null>(null)
  const canonicalName = columnName.trim()
  const targetContextKey = JSON.stringify([open, active, datasetId, dataRevision,
    schemaRevision, columns, canonicalName])
  // Conflict metadata can be newer than Overview's columns. It only guides the
  // mode control; a fresh successful preview still authorizes every mutation.
  const targetExists = targetHint?.key === targetContextKey ? targetHint.exists : columns.includes(canonicalName)
  const validTarget = Boolean(canonicalName && canonicalName !== '__rowId__' &&
    (mode === 'create' ? !targetExists : targetExists))
  // Compare contents, not array identity: equivalent parent renders keep the draft.
  const inputKey = JSON.stringify([open, active, datasetId, datasetName, dataRevision,
    schemaRevision, columns, canonicalName, expression, mode, targetExists])
  const previewRequest = useRequestIdentity(inputKey)
  const confirmationRequest = useRequestIdentity(inputKey)
  const saveRequest = useRequestIdentity(JSON.stringify([datasetId, open, active]))
  const canPreview = Boolean(open && active && validTarget && expression.trim())
  const canSave = Boolean(canPreview && preview?.valid && previewKey === inputKey &&
    previewGuard?.() && preview.column === canonicalName && preview.mode === mode &&
    preview.targetExists === targetExists &&
    Number.isInteger(preview.dataRevision) && preview.dataRevision > 0 &&
    Number.isInteger(preview.schemaRevision) && preview.schemaRevision > 0 && !loading)

  // columns is intentionally excluded: a parent render must not erase this draft.
  useEffect(() => {
    if (open) {
      let name = 'new_feature'
      for (let suffix = 2; columns.includes(name); suffix++) name = `new_feature_${suffix}`
      setColumnName(name)
      setExpression(columns.length >= 2 ? `${columns[0]} / (${columns[1]} + 1e-6)` : '')
      setMode('create')
    }
  }, [open, datasetId])

  useEffect(() => { setTargetHint(null) }, [targetContextKey])

  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    setPreviewKey(null)
    setPreviewGuard(null)
    setConfirmation(null)
    setLoading(false)
  }, [inputKey])

  const invalidatePreview = () => {
    previewRequest.invalidate()
    confirmationRequest.invalidate()
    setPreview(null)
    setPreviewError(null)
    setPreviewKey(null)
    setPreviewGuard(null)
    setConfirmation(null)
    setLoading(false)
  }
  const observeTargetConflict = (error: any) => {
    if (error?.code === 'CALCULATION_TARGET_CONFLICT' &&
      error.details?.column === canonicalName && error.details?.mode === mode &&
      typeof error.details?.targetExists === 'boolean') {
      setTargetHint({ key: targetContextKey, exists: error.details.targetExists })
    }
  }
  const editExpression = (next: string) => {
    if (busy.current) return
    invalidatePreview()
    setExpression(next)
  }
  const handlePreview = async () => {
    if (busy.current || !canPreview) return
    invalidatePreview()
    const current = previewRequest.begin()
    const requestedKey = inputKey
    setLoading(true)
    try {
      const res = await api.post<CalculatePreviewResponse>(`/datasets/${datasetId}/calculate/preview`, {
        expression, columnName: canonicalName, mode,
      })
      if (!current()) return
      setPreview(res)
      setPreviewKey(requestedKey)
      setPreviewGuard(() => current)
    } catch (err: any) {
      if (!current()) return
      setPreviewKey(requestedKey)
      setPreviewError(err.message || String(err))
      observeTargetConflict(err)
    } finally {
      if (current()) setLoading(false)
    }
  }

  const handleApply = async (confirmed?: typeof confirmation) => {
    if (busy.current || !canSave || !preview || !previewGuard?.()) return
    if (mode === 'replace' && (!confirmed?.current() || confirmed.preview !== preview)) return
    busy.current = true
    setConfirmation(null)
    const current = saveRequest.begin()
    setSubmitting(true)
    try {
      const result = await api.post<{ column: string; operation: 'created' | 'replaced' }>(
        `/datasets/${datasetId}/calculate`, {
          expression, columnName: preview.column, mode: preview.mode,
          expectedDataRevision: preview.dataRevision,
          expectedSchemaRevision: preview.schemaRevision,
        })
      message.success(`変数 '${result.column}' を${result.operation === 'replaced' ? '置換' : '追加'}しました。`)
      onSuccess(datasetId)
      if (current()) { invalidatePreview(); onClose() }
    } catch (err: any) {
      if (current()) {
        invalidatePreview()
        setPreviewKey(inputKey)
        setPreviewError(`${err.message || err} 列名と計算式を確認し、再度プレビューしてください。`)
        observeTargetConflict(err)
      }
      message.error(`計算変数の保存エラー: ${err.message || err}`)
    } finally {
      busy.current = false
      setSubmitting(false)
    }
  }
  const cancelConfirmation = () => {
    confirmationRequest.invalidate()
    setConfirmation(null)
  }
  const handleAdd = () => {
    if (busy.current || !canSave || !preview) return
    if (mode === 'replace') {
      setConfirmation({ preview, current: confirmationRequest.begin() })
    } else void handleApply()
  }

  const appendToExpr = (text: string) => editExpression(`${expression} ${text}`.trim())

  return (
    <>
    <Modal
      open={open}
      title={
        <Space>
          <Typography.Title level={5} style={{ margin: 0 }}>
            変数の動的追加・変換 (Add Calculated Variable)
          </Typography.Title>
          <Tag color="cyan">AST Expression Engine</Tag>
        </Space>
      }
      width={780}
      onCancel={() => { if (!busy.current) onClose() }}
      onDeactivate={onClose}
      closable={!submitting}
      keyboard={!submitting}
      maskClosable={!submitting}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={submitting}>
          キャンセル
        </Button>,
        <Button key="preview" onClick={() => void handlePreview()} loading={loading} disabled={submitting || !canPreview}>
          プレビュー検証
        </Button>,
        <Button
          key="submit"
          type="primary"
          onClick={() => void handleAdd()}
          loading={submitting}
          disabled={!canSave || submitting}
          data-testid="btn-add-variable-submit"
        >
          {mode === 'replace' ? '既存の変数を置換' : '変数をデータセットに追加'}
        </Button>,
      ]}
    >
      <MutationProgress busy={submitting} />
      <ConfigProvider componentDisabled={submitting}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '68vh', overflowY: 'auto' }}>
        {/* Section 1: Name and Expression */}
        <Card size="small" title="1. 変数名 &amp; 計算式" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
                計算先の変数（列名）:
              </Typography.Text>
              <Input
                data-testid="input-new-variable-name"
                placeholder="例: petal_ratio, log_income, score_scaled"
                value={columnName}
                onChange={(e) => { if (!busy.current) { invalidatePreview(); setColumnName(e.target.value); setMode('create') } }}
                style={{ maxWidth: 320 }}
              />
              {canonicalName === '__rowId__' && <Alert type="error" message="'__rowId__' はシステム列のため指定できません。" />}
              {(targetExists || mode === 'replace') && canonicalName !== '__rowId__' && <>
                <Alert type="warning" message={targetExists
                  ? `'${canonicalName}' は既に存在します。別の列名を指定するか、置換を選択してください。`
                  : `'${canonicalName}' は存在しなくなりました。置換を解除し、新しい列として再度プレビューしてください。`} />
                <Checkbox checked={mode === 'replace'} data-testid="replace-calculated-column"
                  onChange={event => {
                    if (busy.current) return
                    invalidatePreview()
                    setMode(event.target.checked ? 'replace' : 'create')
                  }}>
                  既存の列 '{canonicalName}' の全行の値を置換する
                </Checkbox>
              </>}
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  計算式 (Formula):
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  Python ASTセキュア評価（四則演算, log, sqrt, zscore, minmax, where対応）
                </Typography.Text>
              </div>
              <Input.TextArea
                data-testid="input-variable-expression"
                rows={3}
                placeholder="例: colA + colB * 2, log(colA + 1), zscore(colA), where(colA > 50, 1, 0)"
                value={expression}
                onChange={(e) => editExpression(e.target.value)}
                style={{ fontFamily: 'monospace', fontSize: 13 }}
              />
            </div>

            {/* Helper Token Chips */}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                クリックして式に挿入:
              </Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                <Typography.Text style={{ fontSize: 11, color: '#64748b', alignSelf: 'center', marginRight: 4 }}>
                  列名:
                </Typography.Text>
                {columns.slice(0, 10).map((c) => (
                  <Tag
                    key={c}
                    color="blue"
                    style={{ cursor: 'pointer', margin: 0, fontSize: 11 }}
                    onClick={() => appendToExpr(c)}
                  >
                    <ColumnQuestionTooltip nameOrId={c}>{c}</ColumnQuestionTooltip>
                  </Tag>
                ))}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                <Typography.Text style={{ fontSize: 11, color: '#64748b', alignSelf: 'center', marginRight: 4 }}>
                  演算子:
                </Typography.Text>
                {['+', '-', '*', '/', '**', '%', '>', '<', '>=', '<=', '==', '!=', '&', '|'].map((op) => (
                  <Tag
                    key={op}
                    style={{ cursor: 'pointer', margin: 0, fontSize: 11, background: '#f1f5f9', border: '1px solid #cbd5e1' }}
                    onClick={() => appendToExpr(op)}
                  >
                    {op}
                  </Tag>
                ))}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <Typography.Text style={{ fontSize: 11, color: '#64748b', alignSelf: 'center', marginRight: 4 }}>
                  関数:
                </Typography.Text>
                {['log()', 'sqrt()', 'exp()', 'abs()', 'zscore()', 'minmax()', 'sigmoid()', 'where()'].map((fn) => (
                  <Tag
                    key={fn}
                    color="purple"
                    style={{ cursor: 'pointer', margin: 0, fontSize: 11 }}
                    onClick={() => appendToExpr(fn.replace(')', ''))}
                  >
                    {fn}
                  </Tag>
                ))}
              </div>
            </div>

            {/* Presets */}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                テンプレート定型変換:
              </Typography.Text>
              <Space wrap size="small">
                {PRESET_TEMPLATES.map((tpl) => (
                  <Button
                    key={tpl.label}
                    size="small"
                    onClick={() => {
                      const newExp = tpl.expr(columns)
                      editExpression(newExp)
                    }}
                  >
                    {tpl.label}
                  </Button>
                ))}
              </Space>
            </div>
          </Space>
        </Card>

        {/* Section 2: Validation & Preview */}
        <Card size="small" title="2. 計算プレビュー &amp; 診断" style={{ borderRadius: 6, borderColor: '#e5e7eb' }}>
          {previewError && previewKey === inputKey && <Alert type="error" showIcon message="プレビューが必要です" description={previewError} />}
          {preview && previewKey === inputKey && previewGuard?.() ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {preview.valid ? (
                <Alert
                  type="success"
                  showIcon
                  message={`数式検証成功: '${preview.column}' が正常に計算されました。`}
                />
              ) : (
                <Alert
                  type="error"
                  showIcon
                  message="数式エラー"
                  description={preview.error}
                />
              )}

              {preview.valid && (
                <>
                  <Alert type={preview.mode === 'replace' ? 'warning' : 'info'} showIcon
                    message={preview.mode === 'replace'
                      ? `'${preview.column}' の全 ${preview.rowCount} 行の値を置換します。`
                      : `'${preview.column}' を新しい列として追加します。`}
                    description={`検証時のデータ世代: ${preview.dataRevision} / スキーマ世代: ${preview.schemaRevision}。プレビューは先頭 ${preview.previewRowCount} 行（最大 ${preview.previewRowLimit} 行）で計算しています。保存時は全 ${preview.rowCount} 行で計算するため、zscore・minmax などの値はプレビューと異なる場合があります。`} />
                  {/* Summary Stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                    <div style={{ background: '#f8fafc', padding: '6px 10px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                      <span style={{ fontSize: 11, color: '#64748b' }}>件数 / 欠損</span>
                      <div style={{ fontWeight: 600 }}>
                        {preview.stats.count} / {preview.stats.nullCount ?? 0}
                      </div>
                    </div>
                    {preview.stats.mean !== undefined && (
                      <div style={{ background: '#f8fafc', padding: '6px 10px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                        <span style={{ fontSize: 11, color: '#64748b' }}>平均値 (Mean)</span>
                        <div style={{ fontWeight: 600 }}>{preview.stats.mean}</div>
                      </div>
                    )}
                    {preview.stats.std !== undefined && (
                      <div style={{ background: '#f8fafc', padding: '6px 10px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                        <span style={{ fontSize: 11, color: '#64748b' }}>標準偏差 (Std)</span>
                        <div style={{ fontWeight: 600 }}>{preview.stats.std}</div>
                      </div>
                    )}
                    {preview.stats.min !== undefined && (
                      <div style={{ background: '#f8fafc', padding: '6px 10px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                        <span style={{ fontSize: 11, color: '#64748b' }}>最小〜最大</span>
                        <div style={{ fontWeight: 600 }}>
                          {preview.stats.min} 〜 {preview.stats.max}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Sample Values Chips */}
                  <div>
                    <Typography.Text style={{ fontSize: 12, color: '#475569', display: 'block', marginBottom: 4 }}>
                      先頭 10 行の計算サンプル:
                    </Typography.Text>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {preview.previewValues.map((v, i) => (
                        <Tag key={i} style={{ margin: 0, fontFamily: 'monospace', fontSize: 12 }}>
                          行{i + 1}: {v ?? 'null'}
                        </Tag>
                      ))}
                    </div>
                  </div>

                  {/* Histogram */}
                  {preview.histogram && preview.histogram.length > 0 && (
                    <div>
                      <Typography.Text style={{ fontSize: 12, color: '#475569', display: 'block', marginBottom: 4 }}>
                        分布プレビュー:
                      </Typography.Text>
                      <CategoryBars testId="calculated-variable-histogram" axisName="件数"
                        height={Math.max(180, preview.histogram.length * 30 + 70)}
                        items={preview.histogram.map((bin, index) => ({ id: String(index), label: bin.bin, value: bin.count, color: '#06b6d4' }))} />
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 14, color: '#64748b' }}>
              式を入力後、「プレビュー検証」をクリックすると構文チェックと先頭サンプルの計算結果が表示されます。
            </div>
          )}
        </Card>
      </div>
      </ConfigProvider>
    </Modal>
    <Modal open={Boolean(confirmation && canSave && confirmation.current())}
      title="既存の列を置換しますか？"
      onCancel={cancelConfirmation}
      onDeactivate={cancelConfirmation}
      footer={[
        <Button key="cancel" onClick={cancelConfirmation}>置換をキャンセル</Button>,
        <Button key="replace" danger type="primary" data-testid="confirm-replace-calculated-column"
          onClick={() => void handleApply(confirmation)}>全行の値を置換</Button>,
      ]}>
      <Typography.Paragraph>
        データセット '{datasetName}' の既存の列 '{confirmation?.preview.column}' の全 {confirmation?.preview.rowCount} 行の値を、計算結果で置換します。
      </Typography.Paragraph>
    </Modal>
    </>
  )
}
