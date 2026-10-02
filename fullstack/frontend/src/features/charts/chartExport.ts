import { init, type ECharts, type EChartsOption } from 'echarts'

/** Use a same-origin Blob, not detached data-URL navigation. Keep the URL alive
 * until the browser has started reading it, including on slower devices. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}

export function downloadSvg(svg: SVGSVGElement, fileName: string): void {
  downloadBlob(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }), fileName)
}

/** Resolve the SVG's viewport, never its CSS-transformed screen rectangle. */
export function svgDimensions(svg: SVGSVGElement): { width: number; height: number } {
  const length = (value: string | null) => {
    const match = value?.trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm|q)?$/i)
    if (!match) return undefined
    const units: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 }
    const valueInPx = Number(match[1]) * units[(match[2] ?? 'px').toLowerCase()]
    return Number.isFinite(valueInPx) && valueInPx > 0 ? valueInPx : undefined
  }
  const box = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const ratio = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : undefined
  let width = length(svg.getAttribute('width')), height = length(svg.getAttribute('height'))
  if (ratio) {
    if (width && !height) height = width / ratio
    else if (height && !width) width = height * ratio
    else if (!width && !height) { width = box[2]; height = box[3] }
  }
  if (!width || !height) throw new Error('SVGの幅・高さを取得できません')
  return { width, height }
}

/** PNG resolution is a multiplier of the original SVG, preserving its shape. */
export async function downloadPng(svg: SVGSVGElement, fileName: string, scale = 2): Promise<void> {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('PNGの解像度倍率が不正です')
  const { width, height } = svgDimensions(svg)
  const source = svg.cloneNode(true) as SVGSVGElement
  // Percentage-sized SVGs need a concrete viewport when loaded as an image.
  source.setAttribute('width', String(width))
  source.setAttribute('height', String(height))
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(source)], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('SVG画像を読み込めません'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('PNG描画用のCanvasを利用できません')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error('PNG画像を生成できません')), 'image/png',
    ))
    downloadBlob(blob, fileName)
  } finally { URL.revokeObjectURL(url) }
}

/** SVG-rendered plots can export their current display list directly. Canvas
 * plots need a separate vector painter: renaming a PNG is not an SVG export.
 * getOption includes the current Grand Tour frame, trails, zoom and legend
 * choices; no selection state, animation engine or live painter is changed. */
export function chartSvg(chart: ECharts): string {
  if (chart.isDisposed()) throw new Error('グラフは閉じられています')
  if (chart.getZr().painter.getType() === 'svg') {
    const dataUrl = chart.getDataURL({ type: 'svg', excludeComponents: ['toolbox'] })
    return decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1))
  }
  const snapshot = init(null, undefined, {
    renderer: 'svg', ssr: true, width: chart.getWidth(), height: chart.getHeight(),
  })
  try {
    const option = chart.getOption() as EChartsOption
    snapshot.setOption({ ...option, animation: false, toolbox: [], tooltip: { show: false },
      series: (Array.isArray(option.series) ? option.series : option.series ? [option.series] : [])
        .map(series => ({ ...series, animation: false, progressive: 0 })),
    }, { notMerge: true })
    return snapshot.renderToSVGString()
  } finally { snapshot.dispose() }
}

export function chartSvgAtScale(chart: ECharts, scale = 1): string {
  const svg = chartSvg(chart)
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return svg
  // The host transform is outside ECharts' SVG. Give the exported viewport the
  // displayed dimensions so Fit-compensated dots retain their on-screen size.
  return svg.replace(/<svg\b([^>]*)>/, (_root, attributes: string) => {
    const width = chart.getWidth(), height = chart.getHeight()
    const dimensions = attributes.replace(/\s(?:width|height)="[^"]*"/g, '')
    return `<svg${dimensions} width="${width * scale}" height="${height * scale}"${/\sviewBox=/.test(attributes) ? '' : ` viewBox="0 0 ${width} ${height}"`}>`
  })
}

export function downloadChartSvg(chart: ECharts, name: string, scale = 1): void {
  downloadBlob(new Blob([chartSvgAtScale(chart, scale)], { type: 'image/svg+xml;charset=utf-8' }), `${name}.svg`)
}

export function downloadChartPng(chart: ECharts, name: string, scale = 1): Promise<void> {
  const doc = new DOMParser().parseFromString(chartSvgAtScale(chart, scale), 'image/svg+xml')
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('SVG画像を生成できません')
  return downloadPng(doc.documentElement as unknown as SVGSVGElement, `${name}.png`)
}
