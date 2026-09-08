import { describe, expect, it } from 'vitest'
import { buildL1Domains, defaultL1Column, l1Index } from '../src/theme/useL1ColorDomain'
import { buildAxes, buildValues } from '../src/features/pcp/usePcpPipeline'
import { L1_COLORS, DARK_L1_COLORS, l1Color, l1Palette, vizTheme, composedColor } from '../src/theme/viz'
import { rowColor, type PcpRenderSpec } from '../src/engine/pcpRenderer'
import type { ColumnarData } from '../src/features/pcp/useDatasetColumns'
import type { CodebookColumn } from '../src/api/client'

function data(values: unknown[], semanticType = 'numeric'): ColumnarData {
  return { rowIds: values.map((_, i) => `r${i}`), rowIndex: new Map(values.map((_, i) => [`r${i}`, i])),
    schema: [{ name: 'Q', columnId: 'q', semanticType }], columns: { Q: values },
    numeric: { Q: Float64Array.from(values.map(v => Number(v))) }, categories: {}, minMax: {} }
}
const spec: CodebookColumn = { name: 'Q', columnId: 'q', label: '設問文', scaleType: 'ratio', role: 'question',
  valueLabels: {}, categoryOrder: [], missingCodes: ['99'], missingReasons: {}, isReversed: false, multiResponseGroup: null }

describe('L1 observed domains', () => {
  for (const type of ['numeric', 'categorical']) for (const n of [0, 1, 2, 15, 16, 20, 21]) {
    it(`${type}: ${n} distinct values`, () => {
      const domains = buildL1Domains(data(Array.from({ length: n }, (_, i) => i), type))
      expect(domains.length).toBe(n > 0 && n <= 20 ? 1 : 0)
      if (domains.length) expect(domains[0].codes).toHaveLength(n)
    })
  }
  it('excludes missing values and unobserved definitions without conflating empty/string null', () => {
    const domains = buildL1Domains(data([1, '1', '01', '', null, undefined, NaN, Infinity, -Infinity, 99, 'null']),
      [{ ...spec, categoryOrder: ['missing', '01', '1'], valueLabels: { missing: '未観測', '1': '同名', '01': '同名' } }])
    expect(domains[0].codes).toEqual(['01', '1', '', 'null'])
    expect(l1Index(domains[0], null)).toBeNull()
    expect(l1Index(domains[0], 99)).toBeNull()
    expect(l1Index(domains[0], 1)).toBe(1)
  })
  it('keeps numeric ordering, precision, and geometry independent of L1', () => {
    const fixture = data([10, -2, 1.1, 1.10001, 2])
    const axes = buildAxes(fixture, [spec])
    const before = buildValues(fixture, axes, [0, 1, 2, 3, 4]).values
    const domains = buildL1Domains(fixture, [spec])
    expect(domains[0].codes).toEqual(['-2', '1.1', '1.10001', '2', '10'])
    expect(buildAxes(fixture, [spec])[0]).toMatchObject({ type: 'numeric', min: -2, max: 10 })
    expect(buildValues(fixture, axes, [0, 1, 2, 3, 4]).values).toEqual(before)
    expect(buildL1Domains(data([...fixture.columns.Q].reverse()), [{ ...spec, isReversed: true, label: '変更' }])[0].codes).toEqual(domains[0].codes)
  })
  it('selects multi-level columns over a constant, using only valid codes', () => {
    const fixture = data([1, 1, 2, 99])
    fixture.schema.unshift({ name: 'constant', columnId: 'constant', semanticType: 'numeric' })
    fixture.columns.constant = [7, 7, 7, 7]
    expect(defaultL1Column(fixture, buildL1Domains(fixture, [spec]))).toBe('Q')
    expect(defaultL1Column(data([1]), buildL1Domains(data([1])))).toBe('Q')
    expect(defaultL1Column(data([]), [])).toBeNull()
  })
  it('matches packed PCP colors to shared L1 colors including L2 and missing', () => {
    const theme = vizTheme(false)
    for (let i = 0; i < 20; i++) for (const group of [null, 0, 1, 2]) {
      const packed = i | (group === null ? 0 : 0x8000 | group << 8)
      const render = { rowColorSlots: new Uint16Array([packed]), categoricalPalette: [...l1Palette(theme)] } as PcpRenderSpec
      expect(rowColor(render, 0)).toBe(composedColor(theme, { l1: l1Color(theme, i), l2Group: group }))
    }
    expect(rowColor({ rowColorSlots: new Uint16Array([0xff]), categoricalPalette: [...L1_COLORS] } as PcpRenderSpec, 0)).toBe(theme.contextLine)
    expect(new Set(L1_COLORS).size).toBe(20)
    expect(new Set(DARK_L1_COLORS).size).toBe(20)
  })
})
