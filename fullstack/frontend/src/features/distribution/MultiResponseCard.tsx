import React, { useMemo, useState } from 'react'
import { Button, Card, Segmented, Space, Tag, Tooltip, Typography, theme, Progress } from 'antd'
import Select from '../common/ColumnSelect'
import type { MultiResponseSummary, MultiResponseWeight } from '../../api/client'
import WeightUnsupportedAlert from '../common/WeightUnsupportedAlert'

const { Text } = Typography

interface MultiResponseCardProps {
  summary: MultiResponseSummary
  onSelect: (optionIds: string[], predicate: 'any' | 'all' | 'unselected' | 'status', status?: string, goToPcp?: boolean) => void
  loading?: boolean
  /** Survey-weight block of the response this summary came from (WEIGHT-03). */
  weight?: MultiResponseWeight | null
}

const PAGE_SIZE = 20

const toNumberText = (value: number): string => value.toLocaleString()

const formatWeight = (value: number): string =>
  Number.isInteger(value) ? toNumberText(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 })

const MultiResponseCard: React.FC<MultiResponseCardProps> = ({ summary, onSelect, loading = false, weight = null }) => {
  const { token } = theme.useToken()
  const [base, setBase] = useState<'respondent' | 'response'>('respondent')
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([])
  const [page, setPage] = useState(1)

  const optionRows = summary.items
  const denomForBase = base === 'respondent' ? summary.denominators.valid : summary.totalResponses
  const isRateUnavailable = denomForBase <= 0
  const weighted = weight?.weightStatus === 'applied'
  const weightNotes = weighted
    ? [
        `回答者重み ${weight?.weightColumn ?? ''} で加重集計しています。`,
        `加重N ${formatWeight(weight?.weightedN ?? 0)}（有効回答者の重み合計 ${formatWeight(summary.weightedValidN ?? 0)}）`,
        (weight?.weightMissingCount ?? 0) > 0 ? `重み欠損 ${toNumberText(weight?.weightMissingCount ?? 0)}人` : '',
        (weight?.weightZeroCount ?? 0) > 0 ? `重み0 ${toNumberText(weight?.weightZeroCount ?? 0)}人` : '',
        '設計効果は考慮しません。',
      ].filter(Boolean).join(' / ')
    : ''

  const optionChoices = useMemo(
    () =>
      optionRows.map((item) => ({
        value: item.columnId,
        label: item.label ? `${item.name} ${item.label}` : item.name,
      })),
    [optionRows],
  )

  const pagedItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return optionRows.slice(start, start + PAGE_SIZE)
  }, [optionRows, page])

  const totalPages = Math.max(1, Math.ceil(optionRows.length / PAGE_SIZE))

  const getRateText = (value: number | null): string => {
    if (isRateUnavailable || value == null) return '—'
    return `${value.toFixed(1)}%`
  }

  const getProgressPercent = (value: number | null): number => {
    if (isRateUnavailable || value == null) return 0
    return Math.max(0, Math.min(100, value))
  }

  const triggerAny = (optionIds: string[], goToPcp = false) => onSelect(optionIds, 'any', undefined, goToPcp)
  const triggerStatus = (status: 'partial' | 'missing' | 'invalid' | 'notApplicable') => onSelect([], 'status', status)

  const applySelection = (predicate: 'any' | 'all' | 'unselected') => {
    onSelect(selectedOptionIds, predicate)
  }

  const onPageChange = (nextPage: number) => setPage(nextPage)

  return (
    <Card
      size="small"
      data-testid={`ma-card-${summary.groupId}`}
      title={
        <Space wrap align="center">
          <Tooltip mouseEnterDelay={0.2} title={summary.label}>
            <Text strong style={{ fontSize: 14 }}>
              {summary.label}
            </Text>
          </Tooltip>
          <Tag color="blue">MA</Tag>
          <Tag color="default">選択肢 {toNumberText(optionRows.length)}</Tag>
          {weighted ? (
            <Tooltip mouseEnterDelay={0.2} title={weightNotes}>
              <Tag color="green" data-testid={`ma-weighted-${summary.groupId}`}>加重</Tag>
            </Tooltip>
          ) : null}
          {summary.groupId !== summary.label ? <Text type="secondary">({summary.groupId})</Text> : null}
        </Space>
      }
      extra={
        <Segmented
          size="small"
          aria-label="選択ベース"
          value={base}
          disabled={loading}
          onChange={(value) => {
            setBase(value as 'respondent' | 'response')
          }}
          options={[
            { label: '回答者ベース', value: 'respondent' },
            { label: '延べ回答ベース', value: 'response' },
          ]}
        />
      }
      style={{ marginBottom: 16, borderRadius: 6, border: `1px solid ${token.colorSplit}` }}
    >
      <WeightUnsupportedAlert weightColumnName={weight?.weightStatus === 'unsupported' ? weight?.weightColumn : null} />
      <div
        style={{
          background: token.colorFillAlter,
          borderRadius: 4,
          border: `1px solid ${token.colorBorderSecondary}`,
          padding: '8px 10px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          marginBottom: 12,
          fontSize: 12,
        }}
      >
        <Text type="secondary">全:</Text>
        <Text strong>{toNumberText(summary.denominators.total)}</Text>
        <span>|</span>
        <Text type="secondary">対象:</Text>
        <Text strong>{toNumberText(summary.denominators.target)}</Text>
        <span>|</span>
        <Text type="secondary">有効:</Text>
        <Text strong>{toNumberText(summary.denominators.valid)}</Text>
        <span>|</span>
        <Button
          type="text"
          size="small"
          disabled={loading || summary.denominators.partial === 0}
          onClick={() => triggerStatus('partial')}
          title="部分回答を確認"
        >
          部分 {toNumberText(summary.denominators.partial)}
        </Button>
        <span>|</span>
        <Button
          type="text"
          size="small"
          disabled={loading || summary.denominators.missing === 0}
          onClick={() => triggerStatus('missing')}
          title="無回答の回答者を選択"
        >
          無回答 {toNumberText(summary.denominators.missing)}
        </Button>
        <span>|</span>
        <Button
          type="text"
          size="small"
          disabled={loading || summary.denominators.invalid === 0}
          onClick={() => triggerStatus('invalid')}
          title="回答の不整合を確認"
        >
          不正 {toNumberText(summary.denominators.invalid)}
        </Button>
        <span>|</span>
        <Button
          type="text"
          size="small"
          disabled={loading || summary.denominators.notApplicable === 0}
          onClick={() => triggerStatus('notApplicable')}
          title="非該当の回答者を選択"
        >
          非該当 {toNumberText(summary.denominators.notApplicable)}
        </Button>
        <span>|</span>
        <Text type="secondary">未選択:</Text>
        <Text strong>{toNumberText(summary.allUnselectedN)}</Text>
        <span>|</span>
        <Text type="secondary">延べ:</Text>
        <Text strong>{toNumberText(summary.totalResponses)}</Text>
        {weighted ? (
          <>
            <span>|</span>
            <Tooltip mouseEnterDelay={0.2} title={weightNotes}>
              <Text type="secondary">加重N:</Text>
            </Tooltip>
            <Text strong data-testid={`ma-weighted-denominator-${summary.groupId}`}>
              {formatWeight(summary.weightedValidN ?? 0)}
            </Text>
          </>
        ) : null}
        {isRateUnavailable ? <Text type="secondary">分母0のため割合は—</Text> : null}
      </div>

      <Space size={8} direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
        <Select
          style={{ width: '100%' }}
          showSearch
          mode="multiple"
          allowClear
          disabled={loading}
          placeholder="条件項目を選択"
          aria-label="MAの選択条件"
          value={selectedOptionIds}
          onChange={(values) => {
            setSelectedOptionIds(values)
            setPage(1)
          }}
          options={optionChoices}
          maxTagCount="responsive"
        />
        <Space size={4} wrap>
          <Button
            size="small"
            type="default"
            disabled={loading || selectedOptionIds.length === 0}
            onClick={() => applySelection('any')}
          >
            いずれか
          </Button>
          <Button
            size="small"
            type="default"
            disabled={loading || selectedOptionIds.length === 0}
            onClick={() => applySelection('all')}
          >
            すべて
          </Button>
          <Button
            size="small"
            type="default"
            disabled={loading || selectedOptionIds.length === 0}
            onClick={() => applySelection('unselected')}
          >
            未選択
          </Button>
        </Space>
      </Space>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {pagedItems.map((item) => {
          const pct = base === 'respondent' ? item.pctRespondent : item.pctResponse
          const pctUnweighted = base === 'respondent'
            ? item.pctRespondentUnweighted ?? null
            : item.pctResponseUnweighted ?? null
          const isSelected = item.selectedInSelection > 0
          const showLabel = item.label ? `${item.name} ${item.label}` : item.name

          return (
            <div
              key={item.columnId}
              data-testid={`ma-item-${summary.groupId}-${item.columnId}`}
              style={{
                borderRadius: 6,
                border: `1px solid ${isSelected ? token.colorInfoBorder : token.colorSplit}`,
                background: isSelected ? token.colorInfoBg : undefined,
                padding: '8px 10px',
                minWidth: 0,
              }}
            >
              <Space wrap align="center" style={{ width: '100%' }}>
                <Tooltip mouseEnterDelay={0.2} title={<div><div>{item.name}</div><div>{item.label}</div></div>}>
                  <Text
                    tabIndex={0}
                    style={{
                      flex: '1 1 40%',
                      minWidth: 0,
                      fontSize: 12,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                    ellipsis={{ tooltip: showLabel }}
                  >
                    {showLabel}
                  </Text>
                </Tooltip>

                <Button
                  type="text"
                  size="small"
                  block
                  style={{
                    flex: '1 1 35%',
                    minWidth: 140,
                    textAlign: 'left',
                    border: `1px solid ${token.colorBorderSecondary}`,
                    padding: 4,
                  }}
                  disabled={loading || item.selectedN === 0}
                  aria-label={`${showLabel}の回答者を選択`}
                  onClick={() => triggerAny([item.columnId])}
                >
                  <Progress
                    percent={getProgressPercent(pct)}
                    size="small"
                    showInfo={false}
                    strokeColor={token.colorPrimary}
                  />
                </Button>

                <Space size={8} align="center" wrap style={{ minWidth: 220, justifyContent: 'flex-end' }}>
                  <Tooltip mouseEnterDelay={0.2} title={weighted ? weightNotes : undefined}>
                    <Text style={{ fontSize: 12, fontFamily: 'monospace' }}>
                      {getRateText(pct)} ({toNumberText(item.selectedN)})
                    </Text>
                  </Tooltip>
                  {weighted ? (
                    <Text type="secondary" style={{ fontSize: 11 }}
                      data-testid={`ma-item-unweighted-${summary.groupId}-${item.columnId}`}>
                      非加重 {getRateText(pctUnweighted)}
                      （加重計 {formatWeight(item.selectedWeighted ?? 0)}）
                    </Text>
                  ) : null}
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    選択中人数 {toNumberText(item.selectedInSelection)}
                  </Text>
                  <Button
                    size="small"
                    type="default"
                    disabled={loading}
                    onClick={() => triggerAny([item.columnId])}
                  >
                    選択
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    disabled={loading}
                    onClick={() => triggerAny([item.columnId], true)}
                  >
                    PCP
                  </Button>
                </Space>
              </Space>
            </div>
          )
        })}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <Space size={8}>
            <Button
              size="small"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={loading || page === 1}
            >
              前へ
            </Button>
            <Text type="secondary">
              {toNumberText(page)} / {toNumberText(totalPages)}
            </Text>
            <Button
              size="small"
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={loading || page === totalPages}
            >
              次へ
            </Button>
          </Space>
        </div>
      )}
    </Card>
  )
}

export default MultiResponseCard
