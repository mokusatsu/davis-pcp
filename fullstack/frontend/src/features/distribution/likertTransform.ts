/** Pure Diverging Stacked Bar transform for ordinal Likert items (Feature 22).

- Category order comes from the codebook `categoryOrder` (valid codes only).
  No label-text guessing: the neutral slot is the middle index of an odd-length
  ordered list, purely positional.
- Counts/pcts are computed over the valid denominator; missing/notApplicable/
  invalid rows never enter bar widths.
- Zero-count categories keep their order slot with width 0.
*/
export interface LikertCategoryInput {
  code: string
  label: string
  count: number
  pct: number | null
}

export interface LikertItemInput {
  columnId: string
  title: string
  categories: LikertCategoryInput[]
  validN: number
  top2Pct: number | null
  mean: number | null
}

export type LikertSort = 'top2-desc' | 'mean-desc' | 'original'

export interface LikertSegment {
  code: string
  label: string
  count: number
  pct: number
  side: 'negative' | 'neutral' | 'positive'
  widthPct: number
}

export interface LikertRow {
  columnId: string
  title: string
  negative: LikertSegment[]
  neutral: LikertSegment | null
  positive: LikertSegment[]
  negativePct: number
  neutralPct: number
  positivePct: number
  top2Pct: number | null
  mean: number | null
  validN: number
}

export function neutralIndex(count: number): number | null {
  if (count <= 0 || count % 2 === 0) return null
  return Math.floor(count / 2)
}

export function toLikertRow(item: LikertItemInput): LikertRow {
  const neutralIdx = neutralIndex(item.categories.length)
  const negative: LikertSegment[] = []
  const positive: LikertSegment[] = []
  let neutral: LikertSegment | null = null
  let negativePct = 0
  let neutralPct = 0
  let positivePct = 0
  item.categories.forEach((cat, index) => {
    const pct = cat.pct ?? 0
    const side: LikertSegment['side'] =
      neutralIdx === null ? (index < item.categories.length / 2 ? 'negative' : 'positive')
      : index < (neutralIdx as number) ? 'negative'
      : index === neutralIdx ? 'neutral'
      : 'positive'
    const segment: LikertSegment = {
      code: cat.code, label: cat.label, count: cat.count, pct,
      side, widthPct: pct,
    }
    if (side === 'negative') { negative.push(segment); negativePct += pct }
    else if (side === 'neutral') { neutral = segment; neutralPct += pct }
    else { positive.push(segment); positivePct += pct }
  })
  return {
    columnId: item.columnId, title: item.title,
    negative, neutral, positive,
    negativePct: Math.round(negativePct * 1e4) / 1e4, neutralPct: Math.round(neutralPct * 1e4) / 1e4,
    positivePct: Math.round(positivePct * 1e4) / 1e4,
    top2Pct: item.top2Pct, mean: item.mean, validN: item.validN,
  }
}

export function sortLikertRows(rows: LikertRow[], sort: LikertSort, order: string[]): LikertRow[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  const keyed = rows.map((row) => ({ row, tiebreak: rank.get(row.columnId) ?? Number.MAX_SAFE_INTEGER }))
  const valueOf = (entry: (typeof keyed)[number]): number => {
    if (sort === 'top2-desc') return entry.row.top2Pct ?? Number.NEGATIVE_INFINITY
    if (sort === 'mean-desc') return entry.row.mean ?? Number.NEGATIVE_INFINITY
    return Number.POSITIVE_INFINITY
  }
  return keyed
    .sort((a, b) => sort === 'original'
      ? a.tiebreak - b.tiebreak
      : (valueOf(b) - valueOf(a)) || (a.tiebreak - b.tiebreak) || (a.row.columnId < b.row.columnId ? -1 : 1))
    .map((entry) => entry.row)
}

export type LikertMode = 'stacked100' | 'diverging'
export interface LikertInterval extends LikertSegment { rowIndex: number; columnId: string; start: number; end: number; color: string }
/** Ordered intervals avoid reversed low-side stacking and represent the neutral
 * category once, straddling zero. Selection always uses its original code. */
export function likertIntervals(rows: LikertRow[], mode: LikertMode): LikertInterval[] {
  const low = ['#2166ac', '#4393c3', '#92c5de'], high = ['#f4a582', '#d6604d', '#b2182b']
  return rows.flatMap((row, rowIndex) => {
    const ordered = [...row.negative, ...(row.neutral ? [row.neutral] : []), ...row.positive]
    let cursor = mode === 'diverging' ? -row.negative.reduce((sum, s) => sum + s.pct, 0) - (row.neutral?.pct ?? 0) / 2 : 0
    return ordered.map(segment => {
      const start = cursor
      cursor += segment.pct
      const index = segment.side === 'negative' ? row.negative.indexOf(segment) : row.positive.indexOf(segment)
      return { ...segment, rowIndex, columnId: row.columnId, start, end: cursor,
        color: segment.side === 'neutral' ? '#bdbdbd' : segment.side === 'negative' ? low[Math.min(index, low.length - 1)] : high[Math.min(index, high.length - 1)] }
    })
  })
}

/** Missing sentinels must not become zero-count scale slots. Valid unobserved
 * categories remain to preserve the codebook's ordinal meaning. */
export function validLikertOrder(column: { categoryOrder?: string[]; missingCodes?: string[]; missingReasons?: Record<string, string> }, distribution: { code: string; isMissing?: boolean; isInvalid?: boolean }[]): string[] {
  const missing = new Set([...(column.missingCodes ?? []).map(String), ...Object.keys(column.missingReasons ?? {}),
    ...distribution.filter(d => d.isMissing || d.isInvalid).map(d => String(d.code)), '__missing__', '__null__', '__not_applicable__'])
  const order = column.categoryOrder?.length ? column.categoryOrder : distribution.map(d => d.code)
  return [...new Set(order.map(String).filter(code => !missing.has(code)))]
}
