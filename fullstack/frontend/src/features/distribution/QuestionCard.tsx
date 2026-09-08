import { QuestionTooltip } from '../common/ColumnQuestionTooltip'
import React, { useState } from 'react'
import { Card, Tag, Typography, Segmented, Progress, Row, Col, Button, Space } from 'antd'
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
  missingReason?: string | null
}

export interface AuxiliaryStats {
  mean?: number | null
  meanNote?: string | null
  median?: number | null
  top2Box?: { pct: number; n: number } | null
  bottom2Box?: { pct: number; n: number } | null
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
  }
  distribution?: CategoryDistItem[]
  auxiliaryStats?: AuxiliaryStats
  min?: number
  max?: number
  mean?: number
  median?: number
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
    <Card
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
        </Space>
      }
      extra={
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
        {denominators.notApplicable > 0 && (
          <>
            <span>|</span>
            <span>
              非該当: <strong>{denominators.notApplicable.toLocaleString()}</strong>
            </span>
          </>
        )}
      </div>

      {/* Distribution items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {distribution.map((item) => {
          const key = item.code === null ? '__null__' : String(item.code)
          const rowCodeText = item.code === null ? '空欄' : String(item.code)
          const pct = base === 'valid' ? item.percentageValid : item.percentageTotal
          const displayLabel = item.label || String(item.code)
          const selectedCount = selectedCountByCode?.[key] ?? 0
          const isSelected = selectedCount > 0
          const displayPct = item.isMissing && base === 'valid' ? '対象外' : `${pct.toFixed(1)}%`
          const titleParts = [
            `ラベル: ${displayLabel}`,
            `コード: ${rowCodeText}`,
            `件数: ${item.count.toLocaleString()}`,
          ]
          if (item.missingReason) titleParts.push(`欠損理由: ${item.missingReason}`)

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
                <Text ellipsis={{ tooltip: `${rowCodeText}. ${displayLabel}` }} style={{ fontSize: 13 }}>
                  {item.code !== null && <Text type="secondary">{rowCodeText}.</Text>} {displayLabel}
                </Text>
              </Col>
              <Col xs={24} sm={7} style={{ minWidth: 0 }}>
                <Progress
                  percent={Math.min(100, Math.max(0, pct))}
                  size="small"
                  showInfo={false}
                  strokeColor="#1677ff"
                />
              </Col>
              <Col xs={24} sm={9} style={{ textAlign: 'right', minWidth: 0 }}>
                <Space size={4} wrap style={{ justifyContent: 'flex-end' }}>
                  <Text ellipsis style={{ fontSize: 12, fontFamily: 'monospace' }}>
                    {displayPct} ({item.count.toLocaleString()})
                  </Text>
                  {item.isMissing && <Tag color="warning">{item.missingReason || '無回答'}</Tag>}
                  {isSelected && <Tag color="blue">{selectedCount}選択中</Tag>}
                  {onSelectCategory && (
                    <Button
                      size="small"
                      type="link"
                      icon={<SlidersOutlined />}
                      disabled={item.count === 0}
                      title="PCPでこのカテゴリを選択"
                      onClick={() => onSelectCategory(item.code, displayLabel)}
                      style={{ padding: '0 4px', height: 'auto', fontSize: 11 }}
                    >
                      PCP
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
          </Row>
        </div>
      )}
    </Card>
  )
}
export default QuestionCard
