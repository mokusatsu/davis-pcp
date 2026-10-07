/** Pure Diverging Stacked Bar transform for ordinal Likert items (Feature 22).

- Category order comes from the completed result (valid codes only), with
  codebook order used only when no result distribution is available.
  No label-text guessing: the neutral slot is the middle index of an odd-length
  ordered list, purely positional.
- Counts/pcts are computed over the valid denominator; missing/notApplicable/
  invalid rows never enter bar widths.
- Zero-count categories keep their order slot with width 0.
*/
export interface LikertCategoryInput {
  code: string
  label: string
  count: number | null
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
  count: number | null
  pct: number | null
  side: 'negative' | 'neutral' | 'positive'
  widthPct: number
}

export interface LikertRow {
  columnId: string
  title: string
  negative: LikertSegment[]
  neutral: LikertSegment | null
  positive: LikertSegment[]
  negativePct: number | null
  neutralPct: number | null
  positivePct: number | null
  top2Pct: number | null
  mean: number | null
  validN: number
}

export function neutralIndex(count: number): number | null {
  if (count <= 0 || count % 2 === 0) return null
  return Math.floor(count / 2)
}

/** Top-2 is the last two ordered categories, including zero-count slots.
 * It is not the entire positive side of scales with more than five levels. */
export function likertTop2Pct(categories: LikertCategoryInput[]): number | null {
  if (categories.length < 2) return null
  const top = categories.slice(-2)
  if (top.some(category => category.pct === null || !Number.isFinite(category.pct))) return null
  return top.reduce((sum, category) => sum + category.pct!, 0)
}

export function toLikertRow(item: LikertItemInput): LikertRow {
  const neutralIdx = neutralIndex(item.categories.length)
  const negative: LikertSegment[] = []
  const positive: LikertSegment[] = []
  let neutral: LikertSegment | null = null
  let negativePct: number | null = 0
  let neutralPct: number | null = 0
  let positivePct: number | null = 0
  const addPct = (sum: number | null, value: number | null) => sum === null || value === null ? null : sum + value
  const roundedPct = (value: number | null) => value === null ? null : Math.round(value * 1e4) / 1e4
  item.categories.forEach((cat, index) => {
    const pct = cat.pct !== null && Number.isFinite(cat.pct) ? cat.pct : null
    const side: LikertSegment['side'] =
      neutralIdx === null ? (index < item.categories.length / 2 ? 'negative' : 'positive')
      : index < (neutralIdx as number) ? 'negative'
      : index === neutralIdx ? 'neutral'
      : 'positive'
    const segment: LikertSegment = {
      code: cat.code, label: cat.label, count: cat.count, pct,
      side, widthPct: pct ?? 0,
    }
    if (side === 'negative') { negative.push(segment); negativePct = addPct(negativePct, pct) }
    else if (side === 'neutral') { neutral = segment; neutralPct = addPct(neutralPct, pct) }
    else { positive.push(segment); positivePct = addPct(positivePct, pct) }
  })
  return {
    columnId: item.columnId, title: item.title,
    negative, neutral, positive,
    negativePct: roundedPct(negativePct), neutralPct: roundedPct(neutralPct),
    positivePct: roundedPct(positivePct),
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
    let cursor = mode === 'diverging' ? -row.negative.reduce((sum, s) => sum + s.widthPct, 0) - (row.neutral?.widthPct ?? 0) / 2 : 0
    return ordered.map(segment => {
      const start = cursor
      cursor += segment.widthPct
      const index = segment.side === 'negative' ? row.negative.indexOf(segment) : row.positive.indexOf(segment)
      return { ...segment, rowIndex, columnId: row.columnId, start, end: cursor,
        color: segment.side === 'neutral' ? '#bdbdbd' : segment.side === 'negative' ? low[Math.min(index, low.length - 1)] : high[Math.min(index, high.length - 1)] }
    })
  })
}

/** The completed distribution already includes valid zero-count slots and
 * reverse scoring. Keep its order and original codes; do not reverse it twice.
 * Reasons classify declared missing codes, rather than declaring new ones. */
export function validLikertOrder(column: { categoryOrder?: string[]; missingCodes?: string[]; missingReasons?: Record<string, string>; isReversed?: boolean }, distribution: { code: string | null; isMissing?: boolean; isInvalid?: boolean }[]): string[] {
  const missing = new Set((column.missingCodes ?? []).map(String))
  const order = distribution.length
    ? distribution.filter(d => d.code !== null && !d.isMissing && !d.isInvalid).map(d => d.code!)
    : column.isReversed ? [...(column.categoryOrder ?? [])].reverse() : column.categoryOrder ?? []
  return [...new Set(order.map(String).filter(code => !missing.has(code)))]
}
