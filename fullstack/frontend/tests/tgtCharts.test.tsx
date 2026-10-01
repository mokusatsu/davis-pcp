import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import TgtPage from '../src/features/tgt/TgtPage'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionApplied } from '../src/app/store'
import { GeodesicEngine } from '../src/features/tgt/geodesicEngine'
import { TgtCanvas, tourOption } from '../src/features/tgt/TgtCanvas'

const tourViewport=vi.hoisted(()=>({logicalWidth:860,logicalHeight:540,scale:1,zoom:null as number|null,dpr:1,revision:0}))
const touringData = vi.hoisted(() => ({ rowIds: ['a', 'b'], rowIndex: new Map([['a', 0], ['b', 1]]),
  schema: ['x', 'y', 'z'].map(name => ({ name, semanticType: 'numeric' })),
  numeric: { x: new Float64Array([0, 1]), y: new Float64Array([0, 2]), z: new Float64Array([0, 3]) } }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => touringData }))
vi.mock('../src/features/tgt/ProjectionCircle', () => ({ ProjectionCircle: () => null }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({children}:any)=>children,
  useGraphPopupContainer:()=>()=>document.body, useGraphViewport:()=>tourViewport }))
vi.mock('../src/features/tgt/TgtControlPanel', () => ({ TgtControlPanel: (props: any) => <div>
  <button onClick={props.onTogglePlay}>Toggle tour</button><button onClick={props.onStep}>Step tour</button><button onClick={props.onReset}>Reset tour</button>
</div> }))

const controls = vi.hoisted(() => ({ chart: null as any, props: null as any }))
vi.mock('../src/features/charts/EChart', async () => {
  const { useEffect } = await import('react')
  return { default: (props: any) => {
    controls.props = props
    useEffect(() => { props.chartRef.current = controls.chart; props.onReady(controls.chart)
      return () => { props.chartRef.current = null }
    }, [props.chartRef])
    return <div data-testid="echart-renderer">{props.renderer}</div>
  } }
})
vi.mock('../src/theme/useRowColor', async () => {
  const { useSelector } = await import('react-redux')
  const { useMemo } = await import('react')
  return { useRowColorResolver: () => {
    const selected = useSelector((s: any) => s.selection.selectedRowIds)
    return useMemo(() => ({ getColor: (id: string) => id === 'a' ? '#abcdef' : '#fedcba',
      isSelected: (id: string) => selected.includes(id), selectionColor: '#2a78d6' }), [selected])
  } }
})
const rowIds = ['a', 'b']
const matrix = [[0, 0, 0], [1, 0, 0]]
let frames = new Map<number, FrameRequestCallback>()
let resizers: (() => void)[] = []
let nextFrame = 0
beforeEach(() => {
  Object.assign(tourViewport,{logicalWidth:860,logicalHeight:540,scale:1,zoom:null,dpr:1,revision:0})
  frames = new Map(); resizers = []; nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizers.push(callback) } observe() {} disconnect() {} })
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  })
  controls.chart = { isDisposed: () => false, getWidth: () => 640, getHeight: () => 480,
    setOption: vi.fn(), resize: vi.fn(), convertToPixel: vi.fn((_finder: unknown, value: number[]) => [320 + value[0] * 100, 240 - value[1] * 100]) }
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function frame() {
  const [id, callback] = frames.entries().next().value!
  frames.delete(id)
  act(() => callback(0))
}
function setup(playing = false, tracking = true, updateParent = false) {
  const base = store.getState()
  const local = configureStore({ reducer: (state = base, action: any) => {
    if (selectionApplied.match(action)) return { ...state, selection: { ...state.selection, selectedRowIds: action.payload.rowIds } }
    if (action.type === 'selection/hovered') return { ...state, selection: { ...state.selection, hoveredRowId: action.payload } }
    return state
  }, middleware: get => get({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const engine = new GeodesicEngine(3)
  engine.alpha = [1, 0, 0]; engine.beta = [0, 1, 0]
  const project = vi.spyOn(engine, 'project'), step = vi.spyOn(engine, 'step')
  const update = vi.fn()
  function Host({ playing, tracking }: { playing: boolean; tracking: boolean }) {
    const [, setVersion] = useState(0)
    return <Provider store={local}><TgtCanvas engine={engine} rowIds={rowIds} dataMatrix={matrix}
      isPlaying={playing} isTracking={tracking} onBasisUpdate={(...basis) => { update(...basis); if (updateParent) setVersion(n => n + 1) }} /></Provider>
  }
  const view = render(<Host playing={playing} tracking={tracking} />)
  const host = view.getByTestId('tgt-canvas')
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 640, height: 480 } as DOMRect)
  const captured = new Set<number>()
  Object.assign(host, { setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: vi.fn((id: number) => captured.delete(id)) })
  return { engine, project, step, local, dispatch, view, host, update,
    rerender: (playing: boolean, tracking: boolean) => view.rerender(<Host playing={playing} tracking={tracking} />) }
}
const selectionCalls = (dispatch: ReturnType<typeof vi.spyOn>) => dispatch.mock.calls.filter(([action]: any) => selectionApplied.match(action))

it('uses Canvas ECharts and projects once per frame despite parent basis renders', () => {
  const { project, step, update, engine } = setup(true, true, true)
  expect(controls.props.renderer).toBe('canvas')
  expect(step).toHaveBeenCalledTimes(1)
  expect(project).toHaveBeenCalledTimes(1)
  frame(); frame()
  expect(step).toHaveBeenCalledTimes(3)
  expect(project).toHaveBeenCalledTimes(3)
  expect(update).toHaveBeenCalledTimes(3)
  expect(engine.getTrails('a')).toHaveLength(3)
  expect(frames.size).toBe(1)
})

it('redraws pause, trail visibility, selection and resize without appending history', () => {
  const { project, engine, rerender, local } = setup(true)
  frame()
  expect(project).toHaveBeenCalledTimes(2)
  rerender(false, true)
  expect(frames.size).toBe(0)
  rerender(false, false); rerender(false, true)
  act(() => { local.dispatch(selectionApplied({ rowIds: ['a'], operation: 'replace' })) })
  act(() => resizers.forEach(resize => resize()))
  expect(project).toHaveBeenCalledTimes(2)
  expect(engine.getTrails('a')).toHaveLength(2)
  expect(controls.chart.resize).toHaveBeenCalledTimes(1)
  const chartOptions = controls.chart.setOption.mock.calls.map(([option]: any) => option).filter((option: any) => option.series)
  const data = chartOptions.at(-1).series[1].data
  expect(data[0].itemStyle.color).toBe('#2a78d6')
  expect(data[1].itemStyle.color).toBe('#fedcba')
})

it('redraws paused manual step and reset exactly once and keeps the engine authoritative', () => {
  const { engine, project, step, rerender } = setup(false)
  expect(project).toHaveBeenCalledTimes(1)
  engine.step(); rerender(false, true)
  expect(step).toHaveBeenCalledTimes(1)
  expect(project).toHaveBeenCalledTimes(2)
  expect(engine.getTrails('a')).toHaveLength(2)
  engine.reset(); rerender(false, true)
  expect(project).toHaveBeenCalledTimes(3)
  expect(engine.getTrails('a')).toHaveLength(1)
  expect(frames.size).toBe(0)
})

it('fades each trail segment separately and preserves original projected coordinates', () => {
  const option = tourOption([{ rowId: 'a', x: -2, y: 3, color: '#abc', selected: true,
    trails: [{ x: -4, y: 1 }, { x: -3, y: 2 }, { x: -2, y: 3 }] }], 640, 480, '#2a78d6') as any
  expect(option.series[1].data[0].value).toEqual([-2, 3])
  const graphic = option.series[0].renderItem(null, { value: () => 0, coord: (point: number[]) => point })
  expect(graphic.children).toHaveLength(2)
  expect(graphic.children[0].shape).toMatchObject({ x1: -4, y1: 1, x2: -3, y2: 2 })
  expect(graphic.children[0].style.opacity).toBeCloseTo(1 / 6)
  expect(graphic.children[1].style.opacity).toBeCloseTo(1 / 3)
  expect(graphic.children[1].style.stroke).toBe('#2a78d6')
})

it('uses final release coordinates, draws the brush, and explicitly releases pointer capture', () => {
  const { host, dispatch, project } = setup(false)
  fireEvent.pointerDown(host, { clientX: 400, clientY: 250, pointerId: 4, button: 0 })
  fireEvent.pointerMove(host, { clientX: 440, clientY: 310, pointerId: 4, button: 0 })
  expect(controls.chart.setOption).toHaveBeenCalledWith(expect.objectContaining({ graphic: [expect.objectContaining({ id: 'tour-brush', invisible: false,
    style: expect.objectContaining({ lineWidth: 1.5 }) })] }))
  fireEvent.pointerUp(host, { clientX: 560, clientY: 320, pointerId: 4, button: 0 })
  const calls = selectionCalls(dispatch as any)
  expect((calls[0][0] as any).payload.rowIds).toEqual(['a', 'b'])
  expect(host.releasePointerCapture).toHaveBeenCalledWith(4)
  expect(project).toHaveBeenCalledTimes(1)
})

it.each(['pointerCancel', 'lostPointerCapture'] as const)('cancels %s without selecting or projecting', kind => {
  const { host, dispatch, project } = setup(false)
  fireEvent.pointerDown(host, { clientX: 400, clientY: 250, pointerId: 2, button: 0 })
  fireEvent.pointerMove(host, { clientX: 550, clientY: 320, pointerId: 2 })
  fireEvent[kind](host, { pointerId: 2 })
  fireEvent.pointerUp(host, { clientX: 550, clientY: 320, pointerId: 2, button: 0 })
  expect(selectionCalls(dispatch as any)).toHaveLength(0)
  expect(project).toHaveBeenCalledTimes(1)
})

it('ignores other pointers and disables rectangle selection while playing', () => {
  const { host, dispatch, rerender } = setup(false)
  fireEvent.pointerDown(host, { clientX: 400, clientY: 250, pointerId: 1, button: 0 })
  fireEvent.pointerUp(host, { clientX: 550, clientY: 320, pointerId: 2, button: 0 })
  expect(selectionCalls(dispatch as any)).toHaveLength(0)
  rerender(true, true)
  fireEvent.pointerUp(host, { clientX: 550, clientY: 320, pointerId: 1, button: 0 })
  expect(selectionCalls(dispatch as any)).toHaveLength(0)
  expect(host.releasePointerCapture).toHaveBeenCalledWith(1)
})

it('uses an eight CSS-pixel nearest-point hit region and synchronizes hover', () => {
  const { host, dispatch, local } = setup(false)
  for (const x of [429, 428]) {
    fireEvent.pointerDown(host, { clientX: x, clientY: 290, pointerId: 1, button: 0 })
    fireEvent.pointerUp(host, { clientX: x, clientY: 290, pointerId: 1, button: 0 })
  }
  expect(selectionCalls(dispatch as any)).toHaveLength(1)
  expect((selectionCalls(dispatch as any)[0][0] as any).payload).toMatchObject({ rowIds: ['a'], operation: 'toggle' })
  act(() => controls.props.onEvents.mouseover({ seriesId: 'tour-points', data: { rowId: 'b' } }))
  expect(local.getState().selection.hoveredRowId).toBe('b')
  act(() => controls.props.onEvents.mouseout({ seriesId: 'tour-points' }))
  expect(local.getState().selection.hoveredRowId).toBeNull()
})

function pageStore(activeRows: string[]) {
  const base = store.getState()
  return configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'tour-dataset', allRowIds: rowIds, activeRowIds: activeRows },
    globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: activeRows } },
    globalVariables: { ...base.globalVariables, datasetId: 'tour-dataset', activeEntities: null },
    codebook: { ...base.codebook, datasetId: 'tour-dataset', columns: ['x', 'y', 'z'].map(name => ({
      name, columnId: name, role: 'question', scaleType: 'ratio', categoryOrder: [], missingCodes: [], valueLabels: {}, multiResponseGroup: null })) },
  }) as any, middleware: get => get({ serializableCheck: false }) })
}

it('keeps TgtPage matrix identity stable through real basis updates and paused controls', () => {
  const project = vi.spyOn(GeodesicEngine.prototype, 'project')
  const step = vi.spyOn(GeodesicEngine.prototype, 'step')
  const view = render(<Provider store={pageStore(rowIds)}><MemoryRouter initialEntries={['/touring']}><TgtPage /></MemoryRouter></Provider>)
  expect(project).toHaveBeenCalledTimes(1)
  const firstMatrix = project.mock.calls[0][1]
  frame(); frame()
  expect(project).toHaveBeenCalledTimes(3)
  expect(project.mock.calls.every(call => call[1] === firstMatrix)).toBe(true)
  fireEvent.click(view.getByText('Toggle tour'))
  expect(project).toHaveBeenCalledTimes(3)
  expect(frames.size).toBe(0)
  fireEvent.click(view.getByText('Step tour'))
  expect(project).toHaveBeenCalledTimes(4)
  expect(step).toHaveBeenCalledTimes(4)
  fireEvent.click(view.getByText('Reset tour'))
  expect(project).toHaveBeenCalledTimes(5)
})

it('does not replace an empty effective observation scope with all rows', () => {
  const project = vi.spyOn(GeodesicEngine.prototype, 'project')
  const view = render(<Provider store={pageStore([])}><MemoryRouter initialEntries={['/touring']}><TgtPage /></MemoryRouter></Provider>)
  expect(view.queryByTestId('tgt-canvas')).toBeNull()
  expect(project).not.toHaveBeenCalled()
  expect(frames.size).toBe(0)
})

it('does not start a rectangle on a selectable mark and still toggles a stationary click', () => {
  const { host, dispatch, project } = setup(false)
  controls.chart.setOption.mockClear()
  fireEvent.pointerDown(host, { clientX: 420, clientY: 290, pointerId: 1, button: 0 })
  fireEvent.pointerMove(host, { clientX: 550, clientY: 320, pointerId: 1, button: 0 })
  fireEvent.pointerUp(host, { clientX: 550, clientY: 320, pointerId: 1, button: 0 })
  expect(selectionCalls(dispatch as any)).toHaveLength(0)
  expect(controls.chart.setOption.mock.calls.some(([option]: any) => option.graphic?.some((item: any) => item.id === 'tour-brush' && item.invisible === false))).toBe(false)
  fireEvent.pointerDown(host, { clientX: 420, clientY: 290, pointerId: 1, button: 0 })
  fireEvent.pointerUp(host, { clientX: 420, clientY: 290, pointerId: 1, button: 0 })
  expect((selectionCalls(dispatch as any)[0][0] as any).payload).toMatchObject({ rowIds: ['a'], operation: 'toggle' })
  expect(project).toHaveBeenCalledTimes(1)
})

it('redraws GraphPanel zoom and DPR changes without advancing projections',()=>{
 const {project,engine,rerender,host,dispatch}=setup(false,true)
 const history=engine.getTrails('a').slice(),calls=project.mock.calls.length
 fireEvent.pointerDown(host,{clientX:150,clientY:120,pointerId:1,button:0})
 tourViewport.scale=2;tourViewport.zoom=2;tourViewport.dpr=2
 rerender(false,true)
 fireEvent.pointerUp(host,{clientX:500,clientY:350,pointerId:1,button:0})
 expect(selectionCalls(dispatch as any)).toHaveLength(0)
 expect(project).toHaveBeenCalledTimes(calls)
 expect(engine.getTrails('a')).toEqual(history)
})
