import CategoryBars from '../charts/CategoryBars'
import { QuestionTooltip } from '../common/ColumnQuestionTooltip'
import React, { useLayoutEffect, useRef, useState } from 'react'
import GraphPanel from '../common/GraphPanel'
import { Card, Tag, Typography, Segmented, Row, Col, Button, Space } from 'antd'
import { SlidersOutlined } from '@ant-design/icons'
import type { CodebookColumn } from '../../api/client'

const { Text } = Typography

export interface CategoryDistItem {
  code: string | number | null
  label?: string
  count: number
  percentageValid: number
  percentageTotal: number
  isMissing?: boolean
  isInvalid?: boolean
  missingReason?: string | null
}

export interface AuxiliaryStats {
  mean?: number | null
  meanNote?: string | null
  median?: number | null
  top2Box?: { pct: number; n: number } | null
  bottom2Box?: { pct: number; n: number } | null
}

export interface WeightedDistItem {
  code: string
  weightedCount: number | null
  weightedCountStatus?: 'ok' | 'out_of_range'
  weightedPct: number | null
}

export interface WeightedSummary {
  weightedN: number | null
  weightedNStatus?: 'ok' | 'out_of_range'
  warnings?: { code: string; message: string }[]
  weightMissingCount: number
  distribution: WeightedDistItem[]
  weightedMean?: number | null
  meanNote?: string | null
}

export interface WeightMeta {
  status: 'omitted' | 'applied' | 'no_positive_weight'
  columnName?: string | null
  unweightedN?: number | null
  weightedN?: number | null
  weightedNStatus?: 'ok' | 'out_of_range'
  warnings?: { code: string; message: string }[]
  weightMissingCount?: number | null
}

export interface QuestionSummaryData {
  columnId: string
  semanticType?: string
  denominators?: {
    total: number
    target: number
    valid: number
    missing: number
    notApplicable: number
    invalid?: number
  }
  distribution?: CategoryDistItem[]
  auxiliaryStats?: AuxiliaryStats
  min?: number
  max?: number
  mean?: number
  median?: number
  weighted?: WeightedSummary | null
  weight?: WeightMeta | null
}

interface QuestionCardProps {
  summary: QuestionSummaryData
  codebookColumn?: CodebookColumn
  onSelectCategory?: (code: string | number | null, label?: string) => void
  selectedCountByCode?: Record<string, number>
}

export const QuestionCard: React.FC<QuestionCardProps> = ({
  summary,
  codebookColumn,
  onSelectCategory,
  selectedCountByCode,
}) => {
  // Measure untransformed HTML: GraphPanel fit must include wrapped detail rows.
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(320)
  useLayoutEffect(() => {
    const node = contentRef.current
    if (!node) return
    const measure = () => { if (node.offsetHeight > 0) setContentHeight(node.offsetHeight + 16) }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    measure()
    return () => observer?.disconnect()
  }, [])
  const [base, setBase] = useState<'valid' | 'total'>('valid')

  const title = codebookColumn?.label || summary.columnId
  const scaleType = codebookColumn?.scaleType || summary.semanticType || 'nominal'
  const role = codebookColumn?.role

  const denominators = summary.denominators || {
    total: 0,
    target: 0,
    valid: 0,
    missing: 0,
    notApplicable: 0,
  }

  const distribution = summary.distribution || []
  const aux = summary.auxiliaryStats
  const weighted = summary.weighted ?? null
  const weight = summary.weight ?? null
  const weightedByCode = new Map((weighted?.distribution ?? []).map((d) => [String(d.code), d]))

  const scaleTypeLabels: Record<string, string> = {
    nominal: '名義尺度',
    ordinal: '順序尺度',
    interval: '間隔尺度',
    ratio: '比率尺度',
    text: 'テキスト',
    id: 'ID',
    numeric: '数値',
    categorical: 'カテゴリ',
  }

  const roleLabels: Record<string, string> = {
    question: '質問',
    attribute: '属性',
    weight: 'ウェイト',
    id: 'ID',
    other: 'その他',
  }

  return (
    <GraphPanel
      graphId={`distribution/question/${summary.columnId}`}
      title={title}
      available
      sizing="intrinsic"
      intrinsicSize={{ width: 560, height: contentHeight }}
      normalWidth="viewport"
      controls={(
        <Segmented
          size="small"
          aria-label="分母"
          data-testid="question-denominator-toggle"
          options={[
            { label: '有効回答ベース', value: 'valid' },
            { label: '全対象者ベース', value: 'total' },
          ]}
          value={base}
          onChange={(val) => setBase(val as 'valid' | 'total')}
        />
      )}
    >
    <Card
      ref={contentRef}
      size="small"
      data-testid={`question-card-${summary.columnId}`}
      title={
        <Space wrap align="center">
          <Text strong style={{ fontSize: 14 }}>
            <QuestionTooltip nameOrId={summary.columnId} question={codebookColumn?.label}>{title}</QuestionTooltip>
          </Text>
          {summary.columnId !== title && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              (<QuestionTooltip nameOrId={summary.columnId} question={codebookColumn?.label}>{summary.columnId}</QuestionTooltip>)
            </Text>
          )}
          <Tag color="blue">{scaleTypeLabels[scaleType] || scaleType}</Tag>
          {role && <Tag color="default">{roleLabels[role] || role}</Tag>}
          {codebookColumn?.isReversed && <Tag color="warning">逆転</Tag>}
          {summary.weight?.status === 'applied' && <Tag color="green">ウェイト適用中</Tag>}
          {summary.weight?.status === 'no_positive_weight' && <Tag color="warning">加重値なし</Tag>}
        </Space>
      }
      style={{ marginBottom: 16, borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}
    >
      {/* Denominators bar */}
      <div
        data-testid="denominators-bar"
        style={{
          background: '#f8fafc',
          padding: '6px 12px',
          borderRadius: 4,
          marginBottom: 12,
          fontSize: 12,
          border: '1px solid #e2e8f0',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <span>
          <strong>対象者情報:</strong>
        </span>
        <span>
          全: <strong>{denominators.total.toLocaleString()}</strong>
        </span>
        <span>|</span>
        <span>
          設問対象: <strong>{denominators.target.toLocaleString()}</strong>
        </span>
        <span>|</span>
        <span>
          有効: <strong>{denominators.valid.toLocaleString()}</strong>
        </span>
        <span>|</span>
        <span>
          無回答: <strong>{denominators.missing.toLocaleString()}</strong>
        </span>
        {(denominators.invalid ?? 0) > 0 && (
          <>
            <span>|</span>
            <span>無効: <strong>{denominators.invalid!.toLocaleString()}</strong></span>
          </>
        )}
        {denominators.notApplicable > 0 && (
          <>
            <span>|</span>
            <span>
              非該当: <strong>{denominators.notApplicable.toLocaleString()}</strong>
            </span>
          </>
        )}
      </div>

      <CategoryBars axisName={`${base === 'valid' ? '有効回答' : '全対象者'}ベース (%)`} max={100} testId={`question-chart-${summary.columnId}`}
        items={distribution.map(item => ({ id: item.code === null ? '__null__' : String(item.code), label: item.label || String(item.code),
          value: base === 'valid' && (item.isMissing || item.isInvalid) ? null : base === 'valid' ? item.percentageValid : item.percentageTotal,
          selected: (selectedCountByCode?.[item.code === null ? '__null__' : String(item.code)] ?? 0) > 0,
          color: item.isInvalid ? '#d46b08' : item.isMissing ? '#bfbfbf' : undefined,
          detail: `件数: ${item.count} / コード: ${item.code ?? '空欄'}${item.isInvalid ? ' / 無効: 定義範囲外または数値として無効' : item.isMissing ? ` / 欠損: ${item.missingReason ?? '無回答'}` : ''}` }))}
        onSelect={key => { const item = distribution.find(d => (d.code === null ? '__null__' : String(d.code)) === key); if (item) onSelectCategory?.(item.code, item.label) }} />
      {/* Distribution items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {distribution.map((item) => {
          const key = item.code === null ? '__null__' : String(item.code)
          const rowCodeText = item.code === null ? '空欄' : String(item.code)
          const pct = base === 'valid' ? item.percentageValid : item.percentageTotal
          const displayLabel = item.label || String(item.code)
          const selectedCount = selectedCountByCode?.[key] ?? 0
          const isSelected = selectedCount > 0
          const displayPct = (item.isMissing || item.isInvalid) && base === 'valid' ? '対象外' : `${pct.toFixed(1)}%`
          const titleParts = [
            `ラベル: ${displayLabel}`,
            `コード: ${rowCodeText}`,
            `件数: ${item.count.toLocaleString()}`,
          ]
          if (item.isInvalid) titleParts.push('無効理由: 定義範囲外または数値として無効')
          else if (item.missingReason) titleParts.push(`欠損理由: ${item.missingReason}`)

          return (
            <Row
              key={key}
              align="middle"
              gutter={[8, 8]}
              title={titleParts.join(' / ')}
              data-testid={`category-${summary.columnId}-${key}`}
              style={{
                borderRadius: 4,
                border: isSelected ? '1px solid #91caff' : '1px solid transparent',
                background: isSelected ? '#e6f4ff' : undefined,
                padding: '2px 6px',
                minWidth: 0,
              }}
            >
              <Col xs={24} sm={8} style={{ minWidth: 0 }}>
                <Text ellipsis={{ tooltip: false }} title={`${rowCodeText}. ${displayLabel}`} style={{ fontSize: 13 }}>
                  {item.code !== null && <Text type="secondary">{rowCodeText}.</Text>} {displayLabel}
                </Text>
              </Col>
              <Col xs={24} sm={16} style={{ textAlign: 'right', minWidth: 0 }}>
                <Space size={4} wrap style={{ justifyContent: 'flex-end' }}>
                  <Text ellipsis={{ tooltip: false }} style={{ fontSize: 12, fontFamily: 'monospace' }}>
                    {displayPct} ({item.count.toLocaleString()})
                    {weight?.status === 'applied' && (() => {
                      const w = weightedByCode.get(key)
                      if (!w) return null
                      return <span> / 加重{w.weightedPct == null ? '—' : `${w.weightedPct.toFixed(1)}%`} ({w.weightedCountStatus === 'out_of_range' ? '範囲外' : w.weightedCount?.toLocaleString() ?? '—'})</span>
                    })()}
                  </Text>
                  {item.isInvalid && <Tag color="error">無効値（定義範囲外・数値不正）</Tag>}
                  {item.isMissing && <Tag color="warning">{item.missingReason || '無回答'}</Tag>}
                  {isSelected && <Tag color="blue">{selectedCount}選択中</Tag>}
                  {onSelectCategory && (
                    <Button
                      size="small"
                      type="link"
                      icon={<SlidersOutlined />}
                      disabled={item.count === 0}
                      title="このカテゴリの回答者を選択"
                      aria-label={`${displayLabel}の回答者を選択`}
                      onClick={() => onSelectCategory(item.code, displayLabel)}
                      style={{ padding: '0 4px', height: 'auto', fontSize: 11 }}
                    >
                      回答者を選択
                    </Button>
                  )}
                </Space>
              </Col>
            </Row>
          )
        })}
      </div>

      {/* Auxiliary Statistics (for ordinal / numeric) */}
      {aux && (aux.mean != null || aux.median != null || aux.top2Box != null || aux.bottom2Box != null) && (
        <div
          data-testid="auxiliary-stats-box"
          style={{
            background: '#fafafa',
            border: '1px solid #f0f0f0',
            borderRadius: 4,
            padding: '8px 12px',
            fontSize: 12,
          }}
        >
          <Text type="secondary" strong style={{ display: 'block', marginBottom: 4 }}>
            補助統計:
          </Text>
          <Row gutter={[16, 6]}>
            {aux.mean != null && (
              <Col span={12}>
                <span>
                  平均: <strong>{aux.mean.toFixed(2)}</strong>
                  {aux.meanNote && (
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                      (※{aux.meanNote})
                    </Text>
                  )}
                </span>
              </Col>
            )}
            {aux.median != null && (
              <Col span={12}>
                <span>
                  中央値: <strong>{aux.median}</strong>
                </span>
              </Col>
            )}
            {aux.top2Box && (
              <Col span={12}>
                <span>
                  Top-2-Box: <strong>{aux.top2Box.pct.toFixed(1)}%</strong> ({aux.top2Box.n.toLocaleString()})
                </span>
              </Col>
            )}
            {aux.bottom2Box && (
              <Col span={12}>
                <span>
                  Bottom-2-Box: <strong>{aux.bottom2Box.pct.toFixed(1)}%</strong> ({aux.bottom2Box.n.toLocaleString()})
                </span>
              </Col>
            )}
            {weight?.status === 'applied' && weighted?.weightedMean != null && (
              <Col span={12}>
                <span>
                  加重平均: <strong>{weighted.weightedMean.toFixed(2)}</strong>
                  {weighted.meanNote && (
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                      (※{weighted.meanNote})
                    </Text>
                  )}
                </span>
              </Col>
            )}
          </Row>
        </div>
      )}
      {weight?.status === 'applied' && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#666' }} data-testid="weight-note">
          非加重n={weight.unweightedN?.toLocaleString()} / 加重Σw={weight.weightedNStatus === 'out_of_range' ? '範囲外' : weight.weightedN?.toLocaleString() ?? '—'}
          {weight.weightMissingCount ? ` / ウェイト欠損${weight.weightMissingCount}` : ''} · 標準誤差は非加重n基準。母集団推論には調査設計情報が必要
        </div>
      )}
      {weight?.status === 'applied' && (weighted?.warnings ?? weight.warnings ?? []).map(warning => (
        <div key={warning.code} role="status" style={{ marginTop: 8, fontSize: 12, color: '#ad6800' }} data-testid="weight-range-warning">
          {warning.message}
        </div>
      ))}
      {weight?.status === 'no_positive_weight' && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#a00' }} data-testid="weight-note">
          正のウェイトがないため加重値を表示できません。非加重値を参照してください。
        </div>
      )}
    </Card>
    </GraphPanel>
  )
}
export default QuestionCard
