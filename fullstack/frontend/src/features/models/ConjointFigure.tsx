import { useMemo, useRef, useState } from 'react'

export interface ConjointFigurePoint {
  rowId: string
  x: number
  y: number | null
  title: string
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [lo]
  const step0 = (hi - lo) / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(step0))
  const norm = step0 / mag
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag
  const ticks: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) {
    ticks.push(Number(v.toPrecision(12)))
  }
  return ticks.length ? ticks : [lo]
}

export function conjointExtent(values: number[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  if (lo === hi) return [lo - 1, hi + 1]
  const pad = (hi - lo) * 0.05
  return [lo - pad, hi + pad]
}

export default function ConjointFigure({ points, xLabel, yLabel, selected, highlighted, getColor, onToggle, onBrush, svgRef, testId }: {
  points: ConjointFigurePoint[]
  xLabel: string
  yLabel: string
  selected: Set<string>
  highlighted: Set<string>
  getColor?: (rowId: string) => string
  onToggle: (rowId: string) => void
  onBrush?: (bounds: { x: [number, number]; y: [number, number] }) => void
  svgRef: React.RefObject<SVGSVGElement>
  testId: string
}): JSX.Element {
  const W = 560
  const H = 400
  const PAD = { top: 24, right: 24, bottom: 44, left: 56 }
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)

  const ext = useMemo(() => {
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y).filter((v): v is number => typeof v === 'number')
    return { x: conjointExtent(xs), y: conjointExtent(ys) }
  }, [points])
  const xTicks = useMemo(() => niceTicks(ext.x[0], ext.x[1], 5), [ext.x])
  const yTicks = useMemo(() => niceTicks(ext.y[0], ext.y[1], 5), [ext.y])

  const sx = (x: number): number => PAD.left + ((x - ext.x[0]) / (ext.x[1] - ext.x[0])) * (W - PAD.left - PAD.right)
  const sy = (y: number): number => H - PAD.bottom - ((y - ext.y[0]) / (ext.y[1] - ext.y[0])) * (H - PAD.top - PAD.bottom)
  const invX = (px: number): number => ext.x[0] + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (ext.x[1] - ext.x[0])
  const invY = (py: number): number => ext.y[0] + ((H - PAD.bottom - py) / (H - PAD.top - PAD.bottom)) * (ext.y[1] - ext.y[0])

  const toLocal = (e: React.PointerEvent): { x: number; y: number } => {
    // 実際の描画座標系の逆 CTM で変換する（ラッパー矩形への依存を除去）。
    const svg = svgRef.current
    if (!svg) return { x: NaN, y: NaN }
    try {
      if (typeof svg.getScreenCTM === 'function') {
        const ctm = svg.getScreenCTM()
        if (ctm) {
          const inv = ctm.inverse()
          if (typeof svg.createSVGPoint === 'function') {
            const pt = svg.createSVGPoint()
            pt.x = e.clientX
            pt.y = e.clientY
            const res = pt.matrixTransform(inv)
            if (Number.isFinite(res.x) && Number.isFinite(res.y)) return { x: res.x, y: res.y }
          }
        }
      }
    } catch { /* CTM が得られない場合は操作を無視する */ }
    return { x: NaN, y: NaN }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    const t = e.target as Element | null
    if (t && typeof (t as Element).closest === 'function' && (t as Element).closest('circle')) return
    const p = toLocal(e)
    startRef.current = p
    setRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!startRef.current) return
    const p = toLocal(e)
    setRect({ x0: startRef.current.x, y0: startRef.current.y, x1: p.x, y1: p.y })
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    if (!startRef.current || !rect) {
      startRef.current = null
      return
    }
    const p = toLocal(e)
    const x0 = Math.min(startRef.current.x, p.x)
    const x1 = Math.max(startRef.current.x, p.x)
    const y0 = Math.min(startRef.current.y, p.y)
    const y1 = Math.max(startRef.current.y, p.y)
    startRef.current = null
    setRect(null)
    if (Math.abs(x1 - x0) < 4 || Math.abs(y1 - y0) < 4) return
    const loX = invX(x0)
    const hiX = invX(x1)
    const loY = invY(y1)
    const hiY = invY(y0)
    onBrush?.({ x: [Math.min(loX, hiX), Math.max(loX, hiX)], y: [Math.min(loY, hiY), Math.max(loY, hiY)] })
  }

  return (
    <div ref={wrapRef} style={{ userSelect: 'none' }}>
      <svg
        ref={svgRef}
        data-testid={testId}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ background: '#fafafa', borderRadius: 4, userSelect: 'none', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <line x1={sx(ext.x[0])} y1={sy(0)} x2={sx(ext.x[1])} y2={sy(0)} stroke="#d9d9d9" />
        {xTicks.map((t) => (
          <g key={`x${t}`}>
            <line x1={sx(t)} y1={sy(ext.y[0])} x2={sx(t)} y2={sy(ext.y[0]) + 5} stroke="#8c8c8c" />
            <text x={sx(t)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize={10} fill="#595959">{t}</text>
          </g>
        ))}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={sx(ext.x[0]) - 5} y1={sy(t)} x2={sx(ext.x[0])} y2={sy(t)} stroke="#8c8c8c" />
            <text x={PAD.left - 8} y={sy(t) + 4} textAnchor="end" fontSize={10} fill="#595959">{t}</text>
          </g>
        ))}
        {points.map((p) => {
          // CJ-GUI-06: y 未提供の点は描かない（便宜座標に置かない）。
          if (p.y === null || p.y === undefined) return null
          const isSel = selected.has(p.rowId)
          const isHl = highlighted.has(p.rowId)
          const base = getColor ? getColor(p.rowId) : '#1890ff'
          const fill = isSel ? '#2a78d6' : base
          return (
            <circle
              key={p.rowId}
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={isSel ? 6 : 4}
              fill={fill}
              fillOpacity={isSel ? 1 : 0.75}
              stroke={isSel || isHl ? '#2a78d6' : '#fff'}
              strokeWidth={isSel || isHl ? 2 : 1}
              style={{ cursor: 'pointer' }}
              onClick={(ev) => { ev.stopPropagation(); onToggle(p.rowId) }}
            >
              <title>{p.title}</title>
            </circle>
          )
        })}
        {rect && (
          <rect
            x={Math.min(rect.x0, rect.x1)}
            y={Math.min(rect.y0, rect.y1)}
            width={Math.abs(rect.x1 - rect.x0)}
            height={Math.abs(rect.y1 - rect.y0)}
            fill="rgba(42,120,214,0.15)"
            stroke="#2a78d6"
            strokeWidth={1.5}
            pointerEvents="none"
          />
        )}
        <text x={W / 2} y={H - 8} textAnchor="middle" fontSize={12}>{xLabel}</text>
        <text x={12} y={H / 2} textAnchor="middle" fontSize={12} transform={`rotate(-90 12 ${H / 2})`}>{yLabel}</text>
      </svg>
    </div>
  )
}
