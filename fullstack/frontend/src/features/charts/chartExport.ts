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
