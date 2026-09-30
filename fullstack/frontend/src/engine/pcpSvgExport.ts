import { renderPcp, type PcpDrawingContext, type PcpRenderSpec } from './pcpRenderer'

type Matrix = [number, number, number, number, number, number]
type DrawingState = Pick<SvgDrawingContext,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineJoin' | 'lineCap' | 'globalAlpha'
  | 'font' | 'textAlign' | 'textBaseline'> & { transform: Matrix; dash: number[] }

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new Error('PCP SVG contains a non-finite coordinate')
  return String(Number(value.toFixed(6)))
}

/** Records only the Canvas subset used by renderPcp, without a DOM/Canvas
 * dependency. PCP completes each path before changing its transform. */
class SvgDrawingContext implements PcpDrawingContext {
  fillStyle = '#000000'
  strokeStyle = '#000000'
  lineWidth = 1
  lineJoin: CanvasLineJoin = 'miter'
  lineCap: CanvasLineCap = 'butt'
  globalAlpha = 1
  font = '10px sans-serif'
  textAlign: CanvasTextAlign = 'start'
  textBaseline: CanvasTextBaseline = 'alphabetic'
  private transform: Matrix = [1, 0, 0, 1, 0, 0]
  private dash: number[] = []
  private stack: DrawingState[] = []
  private path: string[] = []
  readonly elements: string[] = []

  save(): void {
    this.stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth,
      lineJoin: this.lineJoin, lineCap: this.lineCap, globalAlpha: this.globalAlpha,
      font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline,
      transform: [...this.transform], dash: [...this.dash],
    })
  }

  restore(): void {
    const state = this.stack.pop()
    if (state) Object.assign(this, state)
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f]
  }

  translate(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.transform
    this.transform = [a, b, c, d, e + a * x + c * y, f + b * x + d * y]
  }

  rotate(angle: number): void {
    const [a, b, c, d, e, f] = this.transform
    const cos = Math.cos(angle), sin = Math.sin(angle)
    this.transform = [a * cos + c * sin, b * cos + d * sin,
      c * cos - a * sin, d * cos - b * sin, e, f]
  }

  private attributes(): string {
    return `transform="matrix(${this.transform.map(number).join(' ')})" opacity="${number(this.globalAlpha)}"`
  }

  setLineDash(dash: number[]): void { this.dash = [...dash] }
  beginPath(): void { this.path = [] }
  moveTo(x: number, y: number): void { this.path.push(`M${number(x)} ${number(y)}`) }
  lineTo(x: number, y: number): void { this.path.push(`L${number(x)} ${number(y)}`) }
  closePath(): void { this.path.push('Z') }

  stroke(): void {
    if (!this.path.length) return
    const dash = this.dash.length ? ` stroke-dasharray="${this.dash.map(number).join(' ')}"` : ''
    this.elements.push(`<path d="${this.path.join(' ')}" fill="none" stroke="${xml(this.strokeStyle)}" stroke-width="${number(this.lineWidth)}" stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"${dash} ${this.attributes()}/>`)
  }

  fill(): void {
    if (!this.path.length) return
    this.elements.push(`<path d="${this.path.join(' ')}" fill="${xml(this.fillStyle)}" ${this.attributes()}/>`)
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.elements.push(`<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" fill="${xml(this.fillStyle)}" ${this.attributes()}/>`)
  }

  fillText(text: string, x: number, y: number): void {
    const anchor = this.textAlign === 'center' ? 'middle'
      : this.textAlign === 'right' || this.textAlign === 'end' ? 'end' : 'start'
    const baseline: Record<CanvasTextBaseline, string> = {
      top: 'text-before-edge', hanging: 'hanging', middle: 'central',
      alphabetic: 'alphabetic', ideographic: 'ideographic', bottom: 'text-after-edge',
    }
    this.elements.push(`<text x="${number(x)}" y="${number(y)}" fill="${xml(this.fillStyle)}" style="font: ${xml(this.font)}" xml:space="preserve" text-anchor="${anchor}" dominant-baseline="${baseline[this.textBaseline]}" ${this.attributes()}>${xml(text)}</text>`)
  }
}

/** A genuine vector snapshot of the last painted viewport, in logical pixels.
 * Device pixel ratio affects Canvas resolution, never SVG dimensions. Reusing
 * renderPcp preserves decimation, missing gaps, colors, halos and imputation. */
export function pcpSvg(spec: PcpRenderSpec): string {
  if (spec.width <= 0 || spec.height <= 0) throw new Error('PCP SVG requires a visible viewport')
  const width = number(spec.width), height = number(spec.height)
  const context = new SvgDrawingContext()
  renderPcp(context, { ...spec, dpr: 1 })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Parallel coordinates plot"><title>Parallel coordinates plot</title><defs><clipPath id="pcp-viewport"><rect width="${width}" height="${height}"/></clipPath></defs><g clip-path="url(#pcp-viewport)">${context.elements.join('')}</g></svg>`
}
