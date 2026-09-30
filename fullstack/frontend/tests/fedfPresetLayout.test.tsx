import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { getInstanceByDom } from 'echarts'
import { api } from '../src/api/client'
import { store, selectionApplied } from '../src/app/store'
import FedfPage from '../src/features/fedf/FedfPage'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'

const fixture = vi.hoisted(() => ({ data: { schema: [] as any[] }, operation: 'replace' }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => fixture.data }))
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (p: any) => <select data-testid="columns" multiple value={p.value} onChange={e => p.onChange([...e.target.selectedOptions].map(o => o.value))}>{p.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ useBrushOp: () => [fixture.operation] }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1677ff' }) }))
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(630)
  fixture.operation = 'replace'
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function rectangle(item: any) {
  const rect = item.getBoundingRect().clone()
  if (item.transform) rect.applyTransform(item.transform)
  return rect
}
async function setup(count: number, boundary?: 'min' | 'max') {
  const names = Array.from({ length: count }, (_, i) => `Variable${i + 1}`), ids = ['r0', 'r1', 'r2', 'r3', 'r4']
  const values = boundary === 'max' ? [0, 4, 4, 4, 4] : boundary === 'min' ? [0, 0, 0, 0, 4] : [0, 1, 2, 3, 4]
  fixture.data = { schema: names.map(name => ({ name, semanticType: 'numeric' })) }
  const base = store.getState(), state = { ...base,
    selection: { ...base.selection, datasetId: 'fedf-layout', activeRowIds: ids, selectedRowIds: [] },
    globalVariables: { ...base.globalVariables, activeVariableIds: names, activeEntities: names.map(columnId => ({ kind: 'column' as const, columnId })) },
    codebook: { ...base.codebook, columns: names.map(name => ({ name, columnId: name, label: name, scaleType: 'ratio', role: 'question' })) },
  }
  const local = configureStore({ reducer: () => state }), dispatch = vi.spyOn(local, 'dispatch')
  vi.spyOn(api, 'post').mockImplementation(async (_url, body: any) => ({ columns: body.columns,
    profiles: Object.fromEntries(body.columns.map((name: string) => [name, { curve: ids.map((_, i) => ({ val: values[i], quantile: i / 4, folded: 1 - Math.abs(i / 2 - 1) })), minVal: 0, maxVal: 4 }])),
    rowCoords: Object.fromEntries(ids.map((id, i) => [id, Object.fromEntries(body.columns.map((name: string) => [name, { val: values[i], quantile: i / 4, folded: 1 - Math.abs(i / 2 - 1), rank: i + 1 }]))])),
    statistics: Object.fromEntries(body.columns.map((name: string) => [name, { min: 0, q25: 1, median: values[2], q75: 3, max: 4, iqr: 2, mean: 2, std: 1, validCount: 5 }])), totalRows: 5, mode: body.mode,
  }) as any)
  const view = render(<Provider store={local}><GraphExpansionProvider><FedfPage /></GraphExpansionProvider></Provider>)
  await view.findByTestId('fedf-svg')
  const select = view.getByTestId('columns') as HTMLSelectElement
  for (const option of select.options) option.selected = true
  fireEvent.change(select)
  await waitFor(() => expect(view.getByTestId('fedf-svg').querySelector('[data-chart-renderer="echarts"]')).toBeTruthy())
  const dom = view.getByTestId('fedf-svg').querySelector('[data-chart-renderer="echarts"]') as HTMLElement
  const chart = getInstanceByDom(dom)!
  await waitFor(() => expect(chart.getZr().storage.getDisplayList().filter((e: any) => e.type === 'tspan' && e.style.text === 'IQR 25–75%')).toHaveLength(count))
  return { view, chart, dom, dispatch }
}
it.each([4, 5, 8])('keeps all %s-column preset labels and targets disjoint at normal and scaled display sizes', async count => {
  const { chart } = await setup(count)
  const labels = chart.getZr().storage.getDisplayList().filter((e: any) => e.type === 'tspan' && /^(IQR 25–75%|Top 5%|Bottom 5%)$/.test(e.style.text))
  expect(labels).toHaveLength(count * 3)
  for (const scale of [0.65, 1, 1.5]) {
    const boxes = labels.map(rectangle).map(r => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale }))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
      expect(overlaps, `preset ${i}/${j}, display scale ${scale}`).toBe(false)
    }
  }
  const presetRects = chart.getZr().storage.getDisplayList().filter((e: any) => e.type === 'rect' && e.parent?.name?.startsWith('fedf-preset-'))
  expect(presetRects).toHaveLength(count * 3)
  for (const rect of presetRects) expect(rect.shape.height).toBe(24)
})
it('keeps IQR, upper-tail and lower-tail presets linked to central selection', async () => {
  const { chart, dom, dispatch } = await setup(5)
  for (const [key, expected] of [['iqr', ['r1', 'r2', 'r3']], ['top', ['r4']], ['bottom', ['r0']]] as const) {
    const mark = chart.getZr().storage.getDisplayList().find((e: any) => e.type === 'rect' && e.parent?.name === `fedf-preset-0-${key}`) as any
    expect(mark).toBeDefined()
    const box = rectangle(mark), event = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, button: 0 }
    const svg = dom.querySelector('svg')!
    fireEvent.mouseDown(svg, event)
    fireEvent.mouseUp(svg, event)
    fireEvent.click(svg, event)
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: selectionApplied.type, payload: expect.objectContaining({ rowIds: expected, operation: 'replace' }) }))
  }
})

it.each(['min', 'max'] as const)('separates median annotations from coincident %s tick labels without moving the median line', async boundary => {
  const { chart } = await setup(5, boundary)
  const list = chart.getZr().storage.getDisplayList(), endpoint = boundary === 'min' ? '0.00' : '4.00'
  const medians = list.filter((e: any) => e.type === 'tspan' && e.style.text === `Med: ${endpoint}`).map(rectangle).sort((a,b) => a.x - b.x)
  const ticks = list.filter((e: any) => e.type === 'tspan' && e.style.text === endpoint).map(rectangle).sort((a,b) => a.x - b.x)
  expect(medians).toHaveLength(5); expect(ticks).toHaveLength(5)
  for (let i = 0; i < 5; i++) expect(medians[i].y + medians[i].height <= ticks[i].y || ticks[i].y + ticks[i].height <= medians[i].y).toBe(true)
  const lines = list.filter((e: any) => e.type === 'line' && e.style.stroke === '#ef4444') as any[]
  expect(lines).toHaveLength(5)
  for (const line of lines) expect(line.shape.y1).toBe(boundary === 'max' ? 100 : 540)
})
