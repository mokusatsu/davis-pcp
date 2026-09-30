import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Card, Empty, Radio, Segmented, Space, Spin, Tooltip, Typography } from 'antd'
import type { RootState } from '../../app/store'
import { selectionApplied, selectEffectiveRowIds, selectOrdinaryVariables } from '../../app/store'
import { getBrushOp } from '../selection/SelectionMenu'
import GraphPanel from '../common/GraphPanel'
import { api } from '../../api/client'
import { normalizeCode, useCodebook } from '../dataset/useCodebookColumn'
import { neutralIndex, sortLikertRows, toLikertRow, type LikertRow, type LikertSort } from './likertTransform'

interface LikertColumnPayload {
  denominators?: { total: number; target: number; valid: number; missing: number; notApplicable: number }
  distribution?: { code: string; label: string; count: number; percentageValid: number }[]
  auxiliaryStats?: { mean?: number; meanNote?: string; top2Box?: { pct: number; n: number } | null }
  weighted?: { weightedN: number | null; distribution: { code: string; weightedCount: number; weightedPct: number | null }[] } | null
}

type Basis = 'unweighted' | 'weighted'

export default function LikertComparisonPage() {
  const dispatch = useDispatch()
  const selection = useSelector((s: RootState) => s.selection)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const weightColumnId = useSelector((s: RootState) => s.globalVariables.weightColumnId)
  const { columns: definitions, schemaRevision } = useCodebook()
  const [sort, setSort] = useState<LikertSort>('top2-desc')
  const [basis, setBasis] = useState<Basis>('unweighted')
  const [payload, setPayload] = useState<Record<string, LikertColumnPayload> | null>(null)
  const [weightMeta, setWeightMeta] = useState<{ status: string; columnName?: string | null; unweightedN?: number | null; weightedN?: number | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matchError, setMatchError] = useState<string | null>(null)

  const globalVars = useSelector(selectOrdinaryVariables)
  const ordinalColumns = useMemo(
    () => definitions.filter((c) => c.role === 'question' && c.scaleType === 'ordinal' && !c.multiResponseGroup
      && globalVars.activeVariableIds.includes(c.name)),
    [definitions, globalVars.activeVariableIds],
  )
  const weightName = definitions.find((c) => c.columnId === weightColumnId)?.name
  const columnNames = useMemo(() => ordinalColumns.map((c) => c.name), [ordinalColumns])
  const orderKey = JSON.stringify(columnNames)
  const inputKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, effectiveRowIds, orderKey, weightName ?? null])
  const currentInput = useRef(inputKey)
  currentInput.current = inputKey
  const [resultKey, setResultKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setMatchError(null)
    if (!selection.datasetId || !columnNames.length) {
      setLoading(false)
      setPayload(null)
      return
    }
    setLoading(true)
    void api.post<{ columns: Record<string, LikertColumnPayload>; weightStatus?: string; weightColumn?: string | null; unweightedN?: number; weightedN?: number | null }>(
      '/summaries',
      {
        datasetId: selection.datasetId, rowIds: effectiveRowIds, columns: columnNames,
        expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
        ...(weightName ? { weightColumn: weightName } : {}),
      },
    ).then((res) => {
      if (cancelled || currentInput.current !== inputKey) return
      setPayload(res.columns)
      setWeightMeta({ status: res.weightStatus ?? 'omitted', columnName: res.weightColumn ?? null,
        unweightedN: res.unweightedN ?? null, weightedN: res.weightedN ?? null })
      setResultKey(inputKey)
    }).catch((err: { message?: string }) => {
      if (cancelled || currentInput.current !== inputKey) return
      setError(err.message ?? 'Likert集計の取得に失敗しました。')
    }).finally(() => { if (!cancelled && currentInput.current === inputKey) setLoading(false) })
    return () => { cancelled = true }
  }, [inputKey])

  const rows: LikertRow[] = useMemo(() => {
    if (!payload || resultKey !== inputKey) return []
    const items = ordinalColumns.map((col) => {
      const data = payload[col.name]
      if (!data) return null
      const order = (col.categoryOrder?.length ? col.categoryOrder : (data.distribution ?? []).map((d) => String(d.code)))
        .map((c) => String(c))
      const distByCode = new Map((data.distribution ?? []).map((d) => [String(d.code), d]))
      const useWeighted = basis === 'weighted' && data.weighted
      const weightedByCode = new Map((data.weighted?.distribution ?? []).map((d) => [String(d.code), d]))
      const categories = order.map((code) => {
        if (useWeighted) {
          const w = weightedByCode.get(code)
          return { code, label: distByCode.get(code)?.label ?? code, count: Math.round(w?.weightedCount ?? 0), pct: w?.weightedPct ?? 0 }
        }
        const d = distByCode.get(code)
        return { code, label: d?.label ?? code, count: d?.count ?? 0, pct: d?.percentageValid ?? 0 }
      })
      const validN = data.denominators?.valid ?? 0
      return toLikertRow({
        columnId: col.name, title: col.label || col.name, categories, validN,
        top2Pct: data.auxiliaryStats?.top2Box?.pct ?? null,
        mean: data.auxiliaryStats?.mean ?? null,
      })
    }).filter((r): r is LikertRow => r !== null)
    return sortLikertRows(items, sort, columnNames)
  }, [payload, resultKey, inputKey, ordinalColumns, columnNames, sort, basis])

  const clickSegment = async (row: LikertRow, code: string) => {
    const column = definitions.find((c) => c.name === row.columnId)
    if (!column || !selection.datasetId) return
    setMatchError(null)
    try {
      const result = await api.post<{ rowIds: string[]; schemaRevision: number }>(
        `/datasets/${selection.datasetId}/column-matches`,
        { columnId: column.columnId, code: normalizeCode(code), rowIds: effectiveRowIds,
          expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision })
      if (currentInput.current !== inputKey || result.schemaRevision !== schemaRevision) return
      dispatch(selectionApplied({ rowIds: result.rowIds, operation: getBrushOp(), label: `Likert ${row.title} = ${code}` }))
    } catch (err) {
      if (currentInput.current === inputKey) setMatchError((err as { message?: string }).message ?? '回答者の選択に失敗しました。')
    }
  }

  if (!selection.datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="likert-page" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
        <Space wrap>
          <Typography.Text strong>Likert Comparison</Typography.Text>
          <Segmented
            size="small"
            aria-label="並べ替え"
            data-testid="likert-sort"
            options={[{ label: 'Top-2降順', value: 'top2-desc' }, { label: '平均降順', value: 'mean-desc' }, { label: '元順', value: 'original' }]}
            value={sort}
            onChange={(v) => setSort(v as LikertSort)}
          />
          <Radio.Group
            size="small"
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
            data-testid="likert-basis"
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="unweighted">非加重</Radio.Button>
            <Radio.Button value="weighted" disabled={!weightName}>加重</Radio.Button>
          </Radio.Group>
        </Space>
      {weightMeta && weightMeta.status !== 'omitted' && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="likert-weight-meta">
          表示基準: {basis === 'weighted' ? `加重（${weightMeta.columnName}）` : '非加重'}
          （非加重n={weightMeta.unweightedN ?? '—'} / 加重Σw={weightMeta.weightedN ?? '—'}）· 検定p値は加重しません
        </Typography.Text>
      )}
      {matchError && <Alert type="error" message={matchError} showIcon />}
      {error && <Alert type="error" message="集計エラー" description={error} showIcon />}
      <GraphPanel
        graphId="likert/comparison"
        title="Likert Comparison"
        available={rows.length > 0}
        sizing="intrinsic"
        intrinsicSize={{ width: 900, height: Math.max(300, 60 + rows.length * 110) }}
      >
        {loading ? <div style={{ padding: 40, textAlign: 'center' }}><Spin tip="Likert集計を計算中..." /></div>
          : !rows.length ? <Empty description={ordinalColumns.length ? '表示可能な行がありません。' : '順序尺度の質問列がありません。'} />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', fontSize: 11, color: '#666' }}>
                <span style={{ flex: 1, textAlign: 'center' }}>← Negative</span>
                <span style={{ width: 220 }} />
                <span style={{ flex: 1, textAlign: 'center' }}>Positive →</span>
                <span style={{ width: 90, textAlign: 'right' }}>Top-2</span>
              </div>
              {rows.map((row) => (
                <Card key={row.columnId} size="small" title={`${row.title}（n=${row.validN}）`}>
                  <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
                    <div style={{ flex: 1, display: 'flex', height: 26, background: '#f5f5f5', borderRadius: 4, overflow: 'hidden' }} role="img" aria-label={`${row.title} 分布`}>
                      {row.negative.map((seg) => (
                        <Tooltip key={seg.code} title={`${seg.label}: ${seg.count}（${seg.pct.toFixed(1)}%）`}>
                          <div
                            role="button"
                            tabIndex={0}
                            aria-label={`${row.title} ${seg.label} ${seg.count}`}
                            data-testid={`likert-seg-${row.columnId}-${seg.code}`}
                            onClick={() => void clickSegment(row, seg.code)}
                            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); void clickSegment(row, seg.code) } }}
                            style={{ width: `${seg.widthPct}%`, minWidth: seg.count > 0 ? 3 : 0, background: '#1677ff', opacity: 0.55 + (seg.widthPct / 200), cursor: 'pointer' }}
                          />
                        </Tooltip>
                      ))}
                      {row.neutral && (
                        <Tooltip title={`${row.neutral.label}: ${row.neutral.count}（${row.neutral.pct.toFixed(1)}%）`}>
                          <div
                            role="button"
                            tabIndex={0}
                            aria-label={`${row.title} ${row.neutral.label} ${row.neutral.count}`}
                            data-testid={`likert-seg-${row.columnId}-${row.neutral.code}`}
                            onClick={() => void clickSegment(row, row.neutral!.code)}
                            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); void clickSegment(row, row.neutral!.code) } }}
                            style={{ width: `${row.neutral.widthPct}%`, minWidth: row.neutral.count > 0 ? 3 : 0, background: '#d9d9d9', cursor: 'pointer' }}
                          />
                        </Tooltip>
                      )}
                      {row.positive.map((seg) => (
                        <Tooltip key={seg.code} title={`${seg.label}: ${seg.count}（${seg.pct.toFixed(1)}%）`}>
                          <div
                            role="button"
                            tabIndex={0}
                            aria-label={`${row.title} ${seg.label} ${seg.count}`}
                            data-testid={`likert-seg-${row.columnId}-${seg.code}`}
                            onClick={() => void clickSegment(row, seg.code)}
                            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); void clickSegment(row, seg.code) } }}
                            style={{ width: `${seg.widthPct}%`, minWidth: seg.count > 0 ? 3 : 0, background: '#52c41a', opacity: 0.55 + (seg.widthPct / 200), cursor: 'pointer' }}
                          />
                        </Tooltip>
                      ))}
                    </div>
                    <div style={{ width: 90, textAlign: 'right', fontSize: 12 }}>
                      {row.top2Pct == null ? '—' : `${row.top2Pct.toFixed(1)}%`}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    {(() => {
                      const idx = neutralIndex(row.negative.length + (row.neutral ? 1 : 0) + row.positive.length)
                      return idx === null ? '偶数カテゴリのため中立なし' : `中立カテゴリは順序中央（位置${idx + 1}）`
                    })()}
                    {row.mean != null && <span> · 平均{row.mean.toFixed(2)}（等間隔得点として計算）</span>}
                  </div>
                </Card>
              ))}
            </div>
          )}
      </GraphPanel>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          セグメントをクリックすると該当回答者を中央Selectionへ送ります。* 中立の意味は原票で確認してください。
        </Typography.Text>
    </div>
  )
}
