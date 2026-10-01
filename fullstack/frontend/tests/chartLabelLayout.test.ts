import { describe, expect, it } from 'vitest'
import { chartLabelLineHeight, chartLabelWidth, wrapChartLabel } from '../src/utils/chartLabelLayout'
import { layoutCategoryAxes } from '../src/features/charts/categoryAxisLayout'

describe('bounded chart labels', () => {
  it('wraps Japanese, long identifiers and emoji at grapheme boundaries', () => {
    for (const text of ['日本語の長い設問名を二行以上に折り返して表示します'.repeat(4), 'LongSourceIdentifier_without_any_spaces_123456789'.repeat(2), '👨‍👩‍👧‍👦が👩🏽‍🔬🇯🇵'.repeat(8)]) {
      const lines = wrapChartLabel(text, 120, 3)
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.length).toBeLessThanOrEqual(3)
      expect(lines.at(-1)).toContain('…')
      for (const line of lines) {
        expect(chartLabelWidth(line)).toBeLessThanOrEqual(120)
        expect(line).not.toMatch(/^[\u200d\u3099]|[\u200d\uD800-\uDBFF]$/u)
      }
    }
  })
  it('does not overflow a slot narrower than one grapheme', () => {
    expect(wrapChartLabel('👨‍👩‍👧‍👦'.repeat(3), 10, 2)).toEqual(['…'])
    expect(wrapChartLabel('👨‍👩‍👧‍👦'.repeat(3), 1, 2)).toEqual([''])
  })
  it('preserves short names and explicit semantic suffixes', () => {
    expect(wrapChartLabel('Age', 100, 3)).toEqual(['Age'])
    const lines = wrapChartLabel('A very long driver label with detailed context\n+ 正の寄与', 140, 3)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('+ 正の寄与')
  })
  it('leaves numerical axes and ordinal numerical ticks untouched', () => {
    const option = { grid: { left: 30, containLabel: true }, xAxis: { type: 'category' as const, data: [1, 2, 3] }, yAxis: { type: 'value' as const } }
    expect(layoutCategoryAxes(option, 600, 400)).toBe(option)
  })
  it('uses two staggered horizontal rows and preserves raw data and series', () => {
    const names = Array.from({ length: 6 }, (_, i) => `設問${i} ${'長い名称'.repeat(20)}`)
    const series = [{ type: 'heatmap' as const, data: [[0, 0, -2.25]] }]
    const option = { grid: { left: 12, right: 24, top: 12, bottom: 44, containLabel: true },
      xAxis: { type: 'category' as const, position: 'top' as const, data: names, axisLabel: { rotate: 35 } },
      yAxis: { type: 'category' as const, data: names, axisLabel: { width: 130 } }, series }
    const result = layoutCategoryAxes(option, 600, 480) as any
    expect(result.xAxis.data).toBe(names)
    expect(result.yAxis.data).toBe(names)
    expect(result.series).toBe(series)
    expect(option.xAxis.axisLabel.rotate).toBe(35)
    expect(result.xAxis.axisLabel.rotate).toBe(0)
    const first = result.xAxis.axisLabel.formatter(names[0], 0).split('\n')
    const second = result.xAxis.axisLabel.formatter(names[1], 1).split('\n')
    expect(first).toHaveLength(4)
    expect(second).toHaveLength(4)
    expect(first.slice(2)).toEqual(['', ''])
    expect(second.slice(0, 2)).toEqual(['', ''])
    expect(result.yAxis.axisLabel.formatter(names[0], 0).split('\n')).toHaveLength(3)
    expect(result.grid.top).toBeLessThanOrEqual(100)
    expect(result.grid.left).toBeLessThanOrEqual(600 * .4)
    expect(result.yAxis.tooltip.formatter({ value: '<raw>&' })).toBe('&lt;raw&gt;&amp;')
    expect(result.xAxis.axisLabel.lineHeight).toBe(chartLabelLineHeight())
  })
  it('uses configured typography for bounded line height without scaling the chart twice', () => {
    const names = ['Long label with enough text to wrap over multiple lines', 'Second long label with details']
    const result = layoutCategoryAxes({ textStyle: { fontSize: 20, fontWeight: 'bold', fontFamily: 'serif' },
      grid: { left: 150, right: 40, top: 20, bottom: 40 },
      xAxis: { type: 'value' }, yAxis: { type: 'category', data: names },
    }, 600, 180) as any
    expect(result.yAxis.axisLabel.lineHeight).toBe(25)
    expect(result.yAxis.axisLabel.formatter(names[0], 0).split('\n')).toHaveLength(2)
    expect(result.textStyle).toEqual({ fontSize: 20, fontWeight: 'bold', fontFamily: 'serif' })
  })
  it('chooses side label rows from item height and keeps preformatted codes', () => {
    const data = ['raw-id-1', 'raw-id-2', 'raw-id-3']
    const option = { grid: { left: 150, right: 40, top: 20, bottom: 40 },
      xAxis: { type: 'value' as const, axisLabel: { formatter: (n: number) => `${n}%` } },
      yAxis: { type: 'category' as const, triggerEvent: true, data,
        axisLabel: { width: 130, formatter: (s: string) => `Long category display name for ${s}` } } }
    const low = layoutCategoryAxes(option, 600, 170) as any
    const high = layoutCategoryAxes(option, 600, 240) as any
    expect(low.yAxis.axisLabel.formatter(data[0], 0).split('\n')).toHaveLength(2)
    expect(high.yAxis.axisLabel.formatter(data[0], 0).split('\n')).toHaveLength(3)
    expect(high.yAxis.data).toBe(data)
    expect(high.yAxis.triggerEvent).toBe(true)
    expect(high.yAxis.tooltip).toBeUndefined()
    expect(high.xAxis).toBe(option.xAxis)
  })
})
