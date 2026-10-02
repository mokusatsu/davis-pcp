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
  columns: string[]
  onClose: () => void
  onSuccess: (committedDatasetId: string) => void
}

interface CalculatePreviewResponse {
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
  onClose,
  onSuccess,
}: AddVariableModalProps) {
  const [columnName, setColumnName] = useState<string>('')
  const [expression, setExpression] = useState<string>('')
  const [preview, setPreview] = useState<CalculatePreviewResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [submitting, setSubmitting] = useState<boolean>(false)

  const busy = useRef(false)
  const active = useAnalysisViewActive()
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const inputKey = JSON.stringify([open, active, datasetId, dataRevision, columnName.trim(), expression])
  const previewRequest = useRequestIdentity(inputKey)
  const saveRequest = useRequestIdentity(JSON.stringify([datasetId, open, active]))
  const canSave = Boolean(open && active && preview?.valid && previewKey === inputKey && !loading)

  // columns is intentionally excluded: a parent render must not erase this draft.
  useEffect(() => {
    if (open) {
      setColumnName('new_feature')
      setExpression(columns.length >= 2 ? `${columns[0]} / (${columns[1]} + 1e-6)` : '')
      setPreview(null)
      setPreviewKey(null)
      setLoading(false)
    }
  }, [open, datasetId])

  useEffect(() => {
    setPreview(null)
    setPreviewKey(null)
    setLoading(false)
  }, [dataRevision, active])

  const invalidatePreview = () => {
    previewRequest.invalidate()
    setPreview(null)
    setPreviewKey(null)
    setLoading(false)
  }
  const editExpression = (next: string) => {
    if (busy.current) return
    invalidatePreview()
    setExpression(next)
  }
  const handlePreview = async () => {
    if (busy.current || !open || !active || !expression.trim() || !columnName.trim()) return
    const current = previewRequest.begin()
    const requestedKey = inputKey
    setPreview(null)
    setPreviewKey(null)
    setLoading(true)
    try {
      const res = await api.post<CalculatePreviewResponse>(`/datasets/${datasetId}/calculate/preview`, {
        expression,
        columnName: columnName.trim(),
      })
      if (!current()) return
      setPreview(res)
      setPreviewKey(requestedKey)
    } catch (err: any) {
      if (!current()) return
      setPreviewKey(requestedKey)
      setPreview({ valid: false, error: err.message || String(err), column: columnName.trim(),
        previewValues: [], stats: {}, histogram: [] })
    } finally {
      if (current()) setLoading(false)
    }
  }

  const handleAdd = async () => {
    if (busy.current || !canSave) return
    busy.current = true
    const current = saveRequest.begin()
    setSubmitting(true)
    try {
      await api.post(`/datasets/${datasetId}/calculate`, { expression, columnName: columnName.trim() })
      message.success(`変数 '${columnName.trim()}' を追加しました。`)
      onSuccess(datasetId)
      if (current()) onClose()
    } catch (err: any) {
      message.error(`計算変数追加エラー: ${err.message || err}`)
    } finally {
      busy.current = false
      setSubmitting(false)
    }
  }

  const appendToExpr = (text: string) => editExpression(`${expression} ${text}`.trim())

  return (
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
        <Button key="preview" onClick={() => void handlePreview()} loading={loading} disabled={submitting}>
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
          変数をデータセットに追加
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
                新しい変数（列名）:
              </Typography.Text>
              <Input
                data-testid="input-new-variable-name"
                placeholder="例: petal_ratio, log_income, score_scaled"
                value={columnName}
                onChange={(e) => { if (!busy.current) { invalidatePreview(); setColumnName(e.target.value) } }}
                style={{ maxWidth: 320 }}
              />
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
          {preview && previewKey === inputKey ? (
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
  )
}
