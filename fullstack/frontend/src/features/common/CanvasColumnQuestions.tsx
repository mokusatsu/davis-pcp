import { useLayoutEffect, useState, type RefObject } from 'react'
import ColumnQuestionTooltip from './ColumnQuestionTooltip'

export interface CanvasColumnRegion { key: string; x: number; y: number; width: number; height: number }

/** Regions use the same logical coordinates as canvas text, including object-fit letterboxing. */
export default function CanvasColumnQuestions({ canvasRef, regions, width, height }: {
  canvasRef: RefObject<HTMLCanvasElement>; regions: CanvasColumnRegion[]; width: number; height: number
}) {
  const [box, setBox] = useState({ left: 0, top: 0, sx: 1, sy: 1 })
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const update = () => {
      const rect = canvas.getBoundingClientRect(), outer = parent.getBoundingClientRect()
      let sx = rect.width / width, sy = rect.height / height
      if (getComputedStyle(canvas).objectFit === 'contain') sx = sy = Math.min(sx, sy)
      const next = { left: rect.left - outer.left - parent.clientLeft + parent.scrollLeft + (rect.width - width * sx) / 2,
        top: rect.top - outer.top - parent.clientTop + parent.scrollTop + (rect.height - height * sy) / 2, sx, sy }
      setBox(old => Object.keys(next).every(k => old[k as keyof typeof old] === next[k as keyof typeof next]) ? old : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(canvas); observer.observe(parent)
    return () => observer.disconnect()
  }, [canvasRef, width, height])
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    {regions.map((region, index) => <div key={`${region.key}-${index}`} style={{ position: 'absolute',
      left: box.left + region.x * box.sx, top: box.top + region.y * box.sy,
      width: region.width * box.sx, height: region.height * box.sy, pointerEvents: 'auto' }}>
      <ColumnQuestionTooltip nameOrId={region.key}><span aria-label={region.key} style={{ display: 'block', width: '100%', height: '100%' }}>&#8203;</span></ColumnQuestionTooltip>
    </div>)}
  </div>
}
