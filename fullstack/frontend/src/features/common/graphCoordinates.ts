/**
 * Feature 035: client座標から描画論理座標への変換。
 * SVG は実際の描画座標系（getScreenCTM の逆行列）を優先し、
 * Canvas は Canvas 自体の表示矩形と論理寸法を基準にする。
 * scroll や DPR を二重適用しない。
 */

export interface ClientPoint { clientX: number; clientY: number }

/** SVG の描画座標系（svg または g 要素）へ client 座標を一度だけ変換する。 */
export function clientToSvg(
  target: SVGGraphicsElement | null | undefined,
  event: ClientPoint,
): { x: number; y: number } {
  if (!target) return { x: NaN, y: NaN }
  try {
    if (typeof target.getScreenCTM === 'function') {
      const ctm = target.getScreenCTM()
      if (ctm) {
        const inv = ctm.inverse()
        const owner = target.ownerSVGElement ?? (target as unknown as SVGSVGElement)
        if (owner && typeof owner.createSVGPoint === 'function') {
          const pt = owner.createSVGPoint()
          pt.x = event.clientX
          pt.y = event.clientY
          const res = pt.matrixTransform(inv)
          if (Number.isFinite(res.x) && Number.isFinite(res.y)) return { x: res.x, y: res.y }
        }
      }
    }
  } catch {
    // CTM が null・特異の場合は操作を無視する（原点への偽クリックを作らない）。
  }
  return { x: NaN, y: NaN }
}

/**
 * Canvas の論理座標へ変換する。
 * Canvas 自体の表示内容矩形を基準にし、border/padding は親側へ配置する前提。
 * DPR は掛けない（表示矩形は CSS px、論理寸法は描画単位）。
 */
export function clientToCanvas(
  canvas: HTMLCanvasElement | null | undefined,
  event: ClientPoint,
  logical: { width: number; height: number },
): { x: number; y: number } {
  if (!canvas) return { x: NaN, y: NaN }
  const rect = canvas.getBoundingClientRect()
  if (!rect.width || !rect.height || !logical.width || !logical.height) return { x: NaN, y: NaN }
  return {
    x: (event.clientX - rect.left) * (logical.width / rect.width),
    y: (event.clientY - rect.top) * (logical.height / rect.height),
  }
}

/** HTML surface 用：surface 矩形と実 scale から論理座標を求める。 */
export function clientToSurface(
  surface: HTMLElement | null | undefined,
  event: ClientPoint,
  scale: number,
): { x: number; y: number } {
  if (!surface || !Number.isFinite(scale) || scale <= 0) return { x: NaN, y: NaN }
  const rect = surface.getBoundingClientRect()
  if (!rect.width || !rect.height) return { x: NaN, y: NaN }
  return {
    x: (event.clientX - rect.left) / scale,
    y: (event.clientY - rect.top) / scale,
  }
}

/** 論理点を画面座標へ戻す（tooltip 配置用・二重 scale なし）。 */
export function canvasToClient(
  canvas: HTMLCanvasElement | null | undefined,
  point: { x: number; y: number },
  logical: { width: number; height: number },
): { x: number; y: number } {
  if (!canvas) return { x: NaN, y: NaN }
  const rect = canvas.getBoundingClientRect()
  if (!rect.width || !rect.height || !logical.width || !logical.height) return { x: NaN, y: NaN }
  return {
    x: rect.left + (point.x / logical.width) * rect.width,
    y: rect.top + (point.y / logical.height) * rect.height,
  }
}

/** Canvas 描画バッファ寸法：論理寸法 × 実表示 scale × DPR。 */
export function canvasBufferSize(
  logical: { width: number; height: number },
  scale: number,
  dpr: number,
): { width: number; height: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const r = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return {
    width: Math.max(1, Math.round(logical.width * s * r)),
    height: Math.max(1, Math.round(logical.height * s * r)),
  }
}
