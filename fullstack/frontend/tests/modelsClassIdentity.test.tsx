import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { getInstanceByDom, type ECharts } from 'echarts'
import { afterEach, expect, it, vi } from 'vitest'
import { store } from '../src/app/store'
import { chartSvg } from '../src/features/charts/chartExport'
import { TreeDiagram, treeDiagramDimensions } from '../src/features/models/ModelsPage'

type Props = ComponentProps<typeof TreeDiagram>
type Categories = NonNullable<Props['classCategories']>

// Five fitted rows, with the larger class second in fitted order. Node values
// are already count-sorted by the API and must not be reordered by the view.
function splitTree(label = '同じ'): Props['root'] {
  const value = (classIndex: number, count: number, total: number) => ({ classIndex, label, count, ratio: count / total })
  return { nodeId: 5, isLeaf: false, count: 5, feature: 'x', threshold: 0.5, majority: label,
    values: [value(1, 3, 5), value(0, 2, 5)], children: [
      { nodeId: 10, isLeaf: true, count: 2, majority: label, values: [value(0, 2, 2), value(1, 0, 2)] },
      { nodeId: 20, isLeaf: true, count: 3, majority: label, values: [value(1, 3, 3), value(0, 0, 3)] },
    ] }
}

function mountTree(overrides: Partial<Props> = {}) {
  const onLeafSelect = vi.fn()
  const props: Props = { root: splitTree(), targetDtype: 'Int64',
    classCategories: [[{ rawValue: '10', code: '10', label: '同じ' }], [{ rawValue: '20', code: '20', label: '同じ' }]],
    treeIndex: 0, selectedRowIds: [], onLeafSelect,
    leafMembership: [{ treeIndex: 0, nodeId: 10, rowIds: ['r1', 'r2'] },
      { treeIndex: 0, nodeId: 20, rowIds: ['r3', 'r4', 'r5'] }], ...overrides }
  const size = treeDiagramDimensions(props.root, props.targetDtype, props.classCategories)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(size.width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(size.height)
  // The current dictionary deliberately differs from the fitted response.
  const base = store.getState()
  const state: any = { ...base, selection: { ...base.selection, datasetId: 'd' },
    codebook: { ...base.codebook, datasetId: 'd', isLoading: false, columns: [
      { name: 'answer', columnId: 'answer', label: 'answer', valueLabels: { '10': '現在の別名A', '20': '現在の別名B' } },
    ] } }
  const local = configureStore({ reducer: () => state, middleware: get => get({ serializableCheck: false }) })
  const draw = (next: Props) => <Provider store={local}><TreeDiagram {...next} /></Provider>
  const view = render(draw(props))
  const element = view.container.querySelector('[data-chart-renderer="echarts"]') as HTMLElement
  const chart = getInstanceByDom(element)!
  expect(chart).toBeTruthy()
  return { view, chart, element, props, size, onLeafSelect,
    rerender: (next: Partial<Props>) => view.rerender(draw({ ...props, ...next })) }
}

const nodes = (chart: ECharts): any[] => (chart.getOption() as any).series[0].data
const exportedSvg = (chart: ECharts) => new DOMParser().parseFromString(chartSvg(chart), 'image/svg+xml')
const svgText = (chart: ECharts) => Array.from(exportedSvg(chart).querySelectorAll('text'), node => node.textContent).join('\n')
const compact = (text: string) => text.replace(/\s+/g, '')
const transformedBox = (element: any) => {
  const box = element.getBoundingRect().clone()
  box.applyTransform(element.transform)
  return box
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps duplicate labels distinct in SVG, colors, full descriptions and row selection', () => {
  const { view, chart, element, props, size, onLeafSelect, rerender } = mountTree()
  const descriptions = ['C1: 10（同じ）', 'C2: 20（同じ）']
  const leaves = nodes(chart).filter(node => node.isLeaf)
  expect(leaves.map(node => node.nodeId)).toEqual([10, 20])
  expect(leaves.map(node => node.name.split('\n')[0])).toEqual(['C1: 同じ', 'C2: 同じ'])
  expect(new Set(leaves.map(node => node.itemStyle.color)).size).toBe(2)
  const svg = exportedSvg(chart)
  expect(svg.querySelector('parsererror')).toBeNull()
  expect(svg.documentElement.getAttribute('width')).toBe(String(size.width))
  expect(svg.documentElement.getAttribute('height')).toBe(String(size.height))
  const exportText = svgText(chart)
  expect(exportText).toContain('クラス対応（元の値・値ラベル）')
  expect(exportText).not.toContain('現在の別名')
  for (const [index, leaf] of leaves.entries()) {
    expect(exportText).toContain(descriptions[index])
    expect(element).toHaveAccessibleName(expect.stringContaining(descriptions[index]))
    expect(leaf.description).toContain(descriptions[index])
    const tooltip = (chart.getOption() as any).tooltip[0].formatter({ data: leaf })
    expect(tooltip).toBe(leaf.description)
    const legend = (chart.getOption() as any).graphic[0].elements.find((entry: any) => entry.id === `class-${index}-color`)
    expect(legend.style.fill).toBe(leaf.itemStyle.color)
    // Both the leaf and mapping swatch are present in the actual SVG.
    expect(svg.querySelectorAll(`[fill="${leaf.itemStyle.color}"]`).length).toBeGreaterThanOrEqual(2)
    const rowIds = props.leafMembership[index].rowIds
    onLeafSelect.mockClear()
    ;(chart as any).trigger('click', { dataType: 'node', data: leaf })
    expect(onLeafSelect).toHaveBeenCalledTimes(1)
    expect(onLeafSelect).toHaveBeenCalledWith(rowIds)
    const button = view.getByTestId(`tree-leaf-0-${leaf.nodeId}`)
    expect(button).toHaveAccessibleName(expect.stringContaining(descriptions[index]))
    expect(button).toHaveAttribute('aria-pressed', 'false')
    for (const key of ['Enter', ' ']) {
      onLeafSelect.mockClear()
      fireEvent.keyDown(button, { key })
      expect(onLeafSelect).toHaveBeenCalledTimes(1)
      expect(onLeafSelect).toHaveBeenCalledWith(rowIds)
    }
    onLeafSelect.mockClear()
    fireEvent.click(button)
    expect(onLeafSelect).toHaveBeenCalledTimes(1)
    expect(onLeafSelect).toHaveBeenCalledWith(rowIds)
  }
  onLeafSelect.mockClear()
  ;(chart as any).trigger('click', { dataType: 'node', data: nodes(chart).find(node => !node.isLeaf) })
  ;(chart as any).trigger('click', { dataType: 'edge', data: leaves[0] })
  expect(onLeafSelect).not.toHaveBeenCalled()
  rerender({ selectedRowIds: ['r5', 'r3', 'r4'] })
  expect(view.getByTestId('tree-leaf-0-20')).toHaveAttribute('aria-pressed', 'true')
  expect(view.getByTestId('tree-leaf-0-10')).toHaveAttribute('aria-pressed', 'false')
  expect(nodes(chart).find(node => node.nodeId === 20).name).toContain('C2: 同じ ✓')
  expect(nodes(chart).filter(node => node.isLeaf).map(node => node.itemStyle.color)).toEqual(leaves.map(node => node.itemStyle.color))
  descriptions.forEach(description => expect(svgText(chart)).toContain(description))
  rerender({ selectedRowIds: ['r3'] })
  expect(view.getByTestId('tree-leaf-0-20')).toHaveAttribute('aria-pressed', 'false')
})

it.each([
  ['Int64', ['1', '2'], ['1', '2'], ['C1: 1', 'C2: 2']],
  ['String', ['1', '2'], ['1', '2'], ['C1: "1"', 'C2: "2"']],
  ['String', ['01', '1.0'], ['1', '1'], ['C1: "01"', 'C2: "1.0"']],
  ['Float64', ['-0', '1.0'], ['0', '1'], ['C1: -0', 'C2: 1.0']],
] as const)('preserves raw code spellings and quoting for stored %s', (targetDtype, raw, codes, descriptions) => {
  const classCategories = raw.map((rawValue, index) => [{ rawValue, code: codes[index], label: codes[index] }])
  const { chart, element, view } = mountTree({ targetDtype, classCategories })
  const text = svgText(chart)
  descriptions.forEach((description, index) => {
    expect(text).toContain(description)
    expect(element).toHaveAccessibleName(expect.stringContaining(description))
    expect(view.getByTestId(`tree-leaf-0-${index === 0 ? 10 : 20}`)).toHaveAccessibleName(expect.stringContaining(description))
  })
})

it('maps all original codes in a fitted class and uses the existing sorted winner for a count tie', () => {
  const classCategories: Categories = [
    [{ rawValue: '10', code: '10', label: '非選択' }, { rawValue: '11', code: '11', label: '11' }],
    [{ rawValue: '20', code: '20', label: '選択' }, { rawValue: '21', code: '21', label: '選択' }],
  ]
  // The API's stable rounded-count sort retains class 0 even when class 1's
  // unrounded ratio is larger. Recomputing a winner from ratios is incorrect.
  const root: Props['root'] = { nodeId: 7, isLeaf: true, count: 4, majority: '非選択',
    values: [{ classIndex: 0, label: '非選択', count: 2, ratio: 0.49 }, { classIndex: 1, label: '選択', count: 2, ratio: 0.51 }] }
  const { chart, element, view, onLeafSelect } = mountTree({ root, classCategories,
    leafMembership: [{ treeIndex: 0, nodeId: 7, rowIds: ['r1', 'r2', 'r3', 'r4'] }] })
  const first = 'C1（複数の元の値）: 10（非選択）、11'
  const second = 'C2（複数の元の値）: 20（選択）、21（選択）'
  expect(svgText(chart)).toContain(first)
  expect(svgText(chart)).toContain(second)
  expect(element).toHaveAccessibleName(expect.stringContaining(first))
  expect(element).toHaveAccessibleName(expect.stringContaining(second))
  const leaf = nodes(chart)[0]
  expect(leaf.name).toBe('C1: 非選択\nn=4 · 49%')
  expect(leaf.description).toContain(first)
  const button = view.getByTestId('tree-leaf-0-7')
  expect(button).toHaveAccessibleName(expect.stringContaining(first))
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(onLeafSelect).toHaveBeenCalledTimes(1)
  expect(onLeafSelect).toHaveBeenCalledWith(['r1', 'r2', 'r3', 'r4'])
})

it('exports every long mapping line within real chart geometry below nonoverlapping nodes', () => {
  const longLabel = '保存されたとても長いカテゴリー説明と自由回答の補足'.repeat(18)
  const classCategories = [['A', 'B', 'C'], ['D', 'E', 'F']].map(codes => codes.map(rawValue => ({
    rawValue, code: rawValue, label: `${longLabel}終端${rawValue}`,
  })))
  const root = splitTree(longLabel)
  const { chart, element, size, view } = mountTree({ root, targetDtype: 'String', classCategories })
  const treeHeight = treeDiagramDimensions(root, 'String', null).height
  expect(size.height).toBeGreaterThan(treeHeight + 300)
  expect(chart.getWidth()).toBe(size.width)
  expect(chart.getHeight()).toBe(size.height)
  const text = compact(svgText(chart))
  classCategories.forEach((categories, index) => {
    const description = `C${index + 1}（複数の元の値）: ${categories.map(category => `"${category.rawValue}"（${category.label}）`).join('、')}`
    expect(text).toContain(compact(description))
    expect(element).toHaveAccessibleName(expect.stringContaining(description))
    expect(view.getByTestId(`tree-leaf-0-${index === 0 ? 10 : 20}`)).toHaveAccessibleName(expect.stringContaining(description))
  })
  expect(nodes(chart).filter(node => node.isLeaf).map(node => node.name.split('\n')[0])).toEqual([
    'C1: 保存されたとて…', 'C2: 保存されたとて…',
  ])
  chart.getZr().flush()
  const series = (chart as any).getModel().getSeriesByIndex(0), data = series.getData()
  const nodeBoxes = Array.from({ length: data.count() }, (_, index) => transformedBox(data.getItemGraphicEl(index)))
  const mappingBoxes = chart.getZr().storage.getDisplayList(true)
    .filter((entry: any) => typeof entry.style?.text === 'string')
    .map(transformedBox).filter(box => box.y >= treeHeight)
  expect(mappingBoxes.length).toBeGreaterThan(10)
  for (const box of [...nodeBoxes, ...mappingBoxes]) {
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(size.width)
    expect(box.y + box.height).toBeLessThanOrEqual(size.height)
  }
  expect(Math.max(...nodeBoxes.map(box => box.y + box.height))).toBeLessThan(Math.min(...mappingBoxes.map(box => box.y)))
  for (let i = 0; i < mappingBoxes.length; i++) for (let j = i + 1; j < mappingBoxes.length; j++) {
    const a = mappingBoxes[i], b = mappingBoxes[j]
    expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false)
  }
})

it('preserves numerical regression display, dimensions and leaf selection without a class mapping', () => {
  const root: Props['root'] = { nodeId: 7, isLeaf: true, count: 2, majority: '12.5', values: [] }
  const { chart, view, element, size, onLeafSelect } = mountTree({ root, targetDtype: 'Float64', classCategories: null,
    leafMembership: [{ treeIndex: 0, nodeId: 7, rowIds: ['r2', 'r8'] }], selectedRowIds: ['r8', 'r2'] })
  expect(size).toEqual({ width: 760, height: 122 })
  expect(nodes(chart)[0].name).toBe('12.5 ✓\nn=2')
  expect(nodes(chart)[0].description).toBe('12.5\n葉7 学習時n=2\nクリックで所属行を選択')
  expect(nodes(chart)[0].itemStyle.color).toBe('#eb6834')
  expect(svgText(chart)).toContain('12.5 ✓')
  expect(svgText(chart)).not.toContain('クラス対応')
  expect(element).toHaveAccessibleName('決定木構造')
  const button = view.getByRole('button', { name: '葉7の2行を選択' })
  expect(button).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(button)
  expect(onLeafSelect).toHaveBeenCalledTimes(1)
  expect(onLeafSelect).toHaveBeenCalledWith(['r2', 'r8'])
})
