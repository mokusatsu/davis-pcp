import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { init, setPlatformAPI } from 'echarts'
import { DEFAULT_TEXT_WIDTH_MAP, platformApi } from 'zrender/lib/core/platform.js'
import Text from 'zrender/lib/graphic/Text.js'
import { buildPcpLabelLayout } from '../src/engine/pcpLabelLayout'
import { pcpSvg } from '../src/engine/pcpSvgExport'
import { renderPcp, type PcpRenderSpec } from '../src/engine/pcpRenderer'
import { geometryToGraphic } from '../src/features/charts/EChartSurface'
import { wrapChartLabel } from '../src/utils/chartLabelLayout'

const measureText = platformApi.measureText
beforeEach(() => setPlatformAPI({ measureText: (value, font) => {
  const size = Number(/([\d.]+)px/.exec(font ?? '')?.[1] ?? 12)
  const weight = /(?:bold|700|600)/.test(font ?? '') ? 1.08 : 1
  return { width: Array.from(String(value)).reduce((sum, char) => sum + ((DEFAULT_TEXT_WIDTH_MAP as Record<string, number>)[char] ?? 1) * size * weight, 0) }
} }))
afterEach(() => setPlatformAPI({ measureText }))
const names = ['日本語の非常に長い設問名を複数行で読みやすくするための検証', 'Respondent_identifier_with_a_long_English_variable_name', 'か\u3099くせい 👩🏽‍💻 👨‍👩‍👧‍👦 🇯🇵 e\u0301 repeated label '.repeat(4)]
function makeSpec(orientation: 'horizontal' | 'vertical', count: number): PcpRenderSpec {
  const width = orientation === 'horizontal' ? Math.max(640, count * 90) : 640
  const height = orientation === 'vertical' ? Math.max(420, count * 48) : 420
  const bounds = orientation === 'horizontal' ? { left: 72, right: width - 72, top: 62, bottom: height - 64 }
    : { left: 84, right: width - 105, top: 66, bottom: height - 66 }
  const axisPos = Array.from({ length: count }, (_, i) => orientation === 'horizontal'
    ? bounds.left + i / Math.max(1, count - 1) * (bounds.right - bounds.left)
    : bounds.top + i / Math.max(1, count - 1) * (bounds.bottom - bounds.top))
  return { width, height, orientation, axisPos, bounds, axes: axisPos.map((_, i) => ({ key: `axis${i}`, label: names[i % names.length], isCategorical: i === 0, min: 0, max: i === 0 ? 2 : 10,
    categories: i === 0 ? ['0', '1', '2'] : undefined, valueLabels: i === 0 ? { '0': names[0], '1': names[1], '2': names[2] } : undefined })),
    reversed: {}, dpr: 1, nRows: 0, nAxes: count, points: new Float64Array(), selectedFlags: new Uint8Array(), rowColorSlots: new Uint16Array(),
    categoricalPalette: [], hoveredRow: -1, maxContextRows: 0, clusterSizes: null, viewportX: 0,
    style: { showContext: true, lineOpacity: .2, lineWidth: 1, selectedLineWidthBoost: 1.3 } }
}

for (const orientation of ['horizontal', 'vertical'] as const) {
  describe(`${orientation} PCP multiline labels`, () => {
    it.each([3, 10, 33])('keeps %i axes, actual glyph bounds and hit rectangles in fixed gutters', count => {
      const spec = makeSpec(orientation, count)
      const layout = buildPcpLabelLayout(spec)
      for (const label of [...layout.axes, ...layout.ticks]) {
        expect(label.x).toBeGreaterThanOrEqual(0)
        expect(label.y).toBeGreaterThanOrEqual(0)
        expect(label.x + label.width).toBeLessThanOrEqual(spec.width)
        expect(label.y + label.height).toBeLessThanOrEqual(spec.height)
        expect(label.lines.length).toBeLessThanOrEqual(label.kind === 'axis' && orientation === 'horizontal' ? 2 : 3)
        const font = label.kind === 'axis' ? `700 ${label.fontSize}px system-ui, sans-serif` : `${label.fontSize}px sans-serif`
        label.lines.forEach((line, index) => {
          const text = new Text({ style: { text: line, font, x: label.x + (label.align === 'right' ? label.width : label.width / 2), y: label.y + label.lineHeight * index,
            align: label.align, verticalAlign: 'top', lineHeight: label.lineHeight } })
          const bounds = text.getBoundingRect()
          expect(bounds.x).toBeGreaterThanOrEqual(label.x - .01)
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(label.x + label.width + .01)
          expect(bounds.y).toBeGreaterThanOrEqual(label.y - .01)
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(label.y + label.height + .01)
        })
      }
      for (let i = 0; i < layout.axes.length; i++) for (let j = i + 1; j < layout.axes.length; j++) {
        const a = layout.axes[i], b = layout.axes[j]
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false)
      }
      if (orientation === 'horizontal' && count >= 10) expect(new Set(layout.axes.map(label => label.y)).size).toBe(2)
    })
    it('uses identical unrotated Canvas/SVG lines and preserves escaped full metadata', () => {
      const spec = makeSpec(orientation, 10)
      spec.labelLayout = buildPcpLabelLayout(spec)
      const calls: Array<{ text: string; x: number; y: number }> = []
      const context = new Proxy({ fillText: (text: string, x: number, y: number) => calls.push({ text, x, y }), rotate: () => { throw new Error('labels must be horizontal') } }, { get: (target, key) => target[key as keyof typeof target] ?? (() => {}) })
      renderPcp(context as any, spec)
      const svg = new DOMParser().parseFromString(pcpSvg(spec), 'image/svg+xml')
      expect(svg.querySelector('parsererror')).toBeNull()
      const texts = [...svg.querySelectorAll('text')]
      expect(texts.map(text => ({ text: text.textContent, x: Number(text.getAttribute('x')), y: Number(text.getAttribute('y')) }))).toEqual(calls.map(call => ({ ...call, x: Number(call.x.toFixed(6)), y: Number(call.y.toFixed(6)) })))
      expect(svg.querySelector('metadata')?.textContent).toContain(names[2])
      expect(texts.every(text => text.getAttribute('transform') === 'matrix(1 0 0 1 0 0)')).toBe(true)
      for (const dpr of [.5, 1, 2, 3]) expect(pcpSvg({ ...spec, dpr })).toBe(pcpSvg(spec))
    })
  })
}

it('renders bounded custom chart text on multiple horizontal lines while retaining blank-question and explicit full metadata', () => {
  function Wrapper({ children }: any) { return children }
  const label = names[0]
  const graphics = geometryToGraphic(<Wrapper nameOrId={label}><text x={80} y={50} textAnchor="middle" fontSize={12} fontWeight={600} data-label-width={140} data-label-lines={3}><title>{'value <raw> & question'}</title>{label}</text></Wrapper>, undefined, { [label]: '' })
  expect(graphics[0].style.text.split('\n').length).toBe(3)
  expect(graphics[0].info.title).toContain(label)
  expect(graphics[0].info.title).toContain('value <raw> & question')
  expect(graphics[0].info.fullText).toBe(label)
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 200, height: 100 })
  try {
    chart.setOption({ animation: false, graphic: graphics })
    const texts = chart.getZr().storage.getDisplayList().filter((item: any) => item.type === 'tspan')
    expect(texts).toHaveLength(3)
    for (const item of texts) {
      const rect = item.getBoundingRect().clone()
      if (item.transform) rect.applyTransform(item.transform)
      expect(rect.x).toBeGreaterThanOrEqual(10)
      expect(rect.x + rect.width).toBeLessThanOrEqual(150)
      expect(rect.y).toBeGreaterThanOrEqual(5)
      expect(rect.y + rect.height).toBeLessThanOrEqual(50)
    }
  } finally { chart.dispose() }
})

it('never emits a partial grapheme at a custom label boundary', () => {
  for (const cluster of ['👩🏽‍💻', '👨‍👩‍👧‍👦', '🇯🇵', 'か\u3099', 'e\u0301']) {
    for (const line of wrapChartLabel(cluster.repeat(8), 90, 3, 12)) expect(line.replace(/…$/, '').split(cluster).join('')).toBe('')
  }
})

it.each(['horizontal', 'vertical'] as const)('keeps %s numerical ticks atomic and preserves exact values independently of display precision', orientation => {
  for (const magnitude of [1e15, 1e-9]) {
    const spec = makeSpec(orientation, 33)
    spec.axes = spec.axes.map(axis => ({ ...axis, isCategorical: false, min: -magnitude, max: magnitude, categories: undefined, valueLabels: undefined }))
    const layout = buildPcpLabelLayout(spec)
    expect(layout.ticks.length).toBeGreaterThan(0)
    for (const tick of layout.ticks) {
      expect(tick.lines).toHaveLength(1)
      expect(tick.lines[0]).not.toMatch(/[\n…]/)
      expect(Number.isFinite(Number(tick.lines[0]))).toBe(true)
      expect(tick.fullText).toBe(tick.code)
      expect(Math.abs(Number(tick.lines[0]) - Number(tick.code)) / (Math.abs(Number(tick.code)) || 1)).toBeLessThan(.02)
    }
    spec.labelLayout = layout
    const metadata = new DOMParser().parseFromString(pcpSvg(spec), 'image/svg+xml').querySelector('metadata')?.textContent
    expect(metadata).toContain(String(magnitude / 2))
  }
  const mapped = makeSpec(orientation, 3)
  mapped.axes[0] = { ...mapped.axes[0], isCategorical: false, min: 0, max: 4, valueLabels: { '0': names[0] } }
  const tick = buildPcpLabelLayout(mapped).ticks[0]
  expect(tick.code).toBe('0')
  expect(tick.fullText).toBe(names[0])
  expect(tick.lines.length).toBeGreaterThan(1)
})

it.each(['horizontal', 'vertical'] as const)('uses unique tick labels, hit keys and hairlines for %s constant/all-missing numeric domains', orientation => {
  for (const value of [0, 7]) {
    const spec = makeSpec(orientation, 3)
    spec.axes = spec.axes.map(axis => ({ ...axis, isCategorical: false, min: value, max: value, categories: undefined, valueLabels: undefined }))
    const layout = buildPcpLabelLayout(spec)
    expect(layout.ticks).toHaveLength(spec.nAxes)
    const hitKeys = layout.ticks.map(tick => `${spec.axes[tick.axisIndex].key}-${tick.code}`)
    expect(new Set(hitKeys).size).toBe(spec.nAxes)
    expect(layout.ticks.every(tick => tick.code === String(value) && tick.fullText === String(value))).toBe(true)
    spec.labelLayout = layout
    const svg = new DOMParser().parseFromString(pcpSvg(spec), 'image/svg+xml')
    expect(svg.querySelectorAll('path')).toHaveLength(spec.nAxes * 2)
    expect([...svg.querySelectorAll('text')].filter(text => text.textContent === value.toFixed(1))).toHaveLength(spec.nAxes)
  }
})
