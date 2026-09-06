import { describe, it, expect } from 'vitest'
import { normalizedRect, pointInRect, segmentIntersectsRect, hitRows, nearestRow, type Rect } from '../src/features/pcp/brush'
import { signedNoise } from '../src/features/pcp/geometry'
import { entityColor, vizTheme, CATEGORICAL } from '../src/theme/viz'
import { store, selectionApplied, datasetLoaded } from '../src/app/store'
import { renderPcp, type PcpRenderSpec } from '../src/engine/pcpRenderer'
import { LocalEngine } from '../src/engine/local'
import type { PcpGeometryRequest } from '../src/engine/types'

describe('brush geometry', () => {
  const rect: Rect = { x1: 10, y1: 10, x2: 20, y2: 20 }

  it('pointInRect includes boundary', () => {
    expect(pointInRect({ x: 10, y: 15 }, rect)).toBe(true)
    expect(pointInRect({ x: 9.999, y: 15 }, rect)).toBe(false)
  })

  it('segment intersection catches crossing lines without vertices inside (Liang-Barsky)', () => {
    const crossing = segmentIntersectsRect({ x: 0, y: 15 }, { x: 30, y: 15 }, rect)
    expect(crossing).toBe(true)
    const outside = segmentIntersectsRect({ x: 0, y: 25 }, { x: 30, y: 25 }, rect)
    expect(outside).toBe(false)
  })

  it('legacyVertex requires a vertex inside; segment does not', () => {
    const points = new Map([['a', [{ x: 0, y: 15 }, { x: 30, y: 15 }]]])
    expect(hitRows(points, ['a'], rect, 'legacyVertex')).toEqual([])
    expect(hitRows(points, ['a'], rect, 'segment')).toEqual(['a'])
  })

  it('normalizedRect sorts corners', () => {
    expect(normalizedRect({ x: 20, y: 5 }, { x: 10, y: 25 })).toEqual({ x1: 10, y1: 5, x2: 20, y2: 25 })
  })

  it('nearestRow finds the closest polyline within threshold', () => {
    const points = new Map([
      ['near', [{ x: 0, y: 12 }, { x: 30, y: 12 }]],
      ['far', [{ x: 0, y: 19.5 }, { x: 30, y: 19.5 }]],
    ])
    expect(nearestRow({ x: 15, y: 13 }, points, ['near', 'far'])).toBe('near')
    expect(nearestRow({ x: 15, y: 100 }, points, ['near', 'far'])).toBeNull()
  })
})

describe('jitter determinism (static v1 recipe)', () => {
  it('same seed|rowId|key yields identical noise', () => {
    expect(signedNoise(42, 'IRIS-001', 'petal')).toBe(signedNoise(42, 'IRIS-001', 'petal'))
  })
  it('different seed changes placement', () => {
    expect(signedNoise(42, 'IRIS-001', 'petal')).not.toBe(signedNoise(43, 'IRIS-001', 'petal'))
  })
  it('noise is within [-1, 1]', () => {
    for (let s = 0; s < 50; s += 7) {
      const v = signedNoise(s, `row${s}`, 'axis')
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
    }
  })
})

describe('viz palette', () => {
  it('categorical slots are the validated hexes in fixed order', () => {
    expect(CATEGORICAL[0]).toBe('#2a78d6')
    expect(CATEGORICAL.length).toBe(8)
  })
  it('entityColor skips slot 0 (reserved for selection accent)', () => {
    expect(entityColor(vizTheme(false), 0)).toBe(CATEGORICAL[1])
  })
})

describe('selection algebra in the central store', () => {
  const ids = ['r1', 'r2', 'r3']
  it('add / subtract / toggle / replace follow set semantics', () => {
    store.dispatch(datasetLoaded({ datasetId: 'd', name: 'n', rowIds: ids }))
    store.dispatch(selectionApplied({ rowIds: ['r1'], operation: 'add', label: '' }))
    expect(store.getState().selection.selectedRowIds).toEqual(['r1'])
    store.dispatch(selectionApplied({ rowIds: ['r2'], operation: 'add', label: '' }))
    expect([...store.getState().selection.selectedRowIds].sort()).toEqual(['r1', 'r2'])
    store.dispatch(selectionApplied({ rowIds: ['r1'], operation: 'subtract', label: '' }))
    expect(store.getState().selection.selectedRowIds).toEqual(['r2'])
    store.dispatch(selectionApplied({ rowIds: ['r2', 'r3'], operation: 'toggle', label: '' }))
    expect([...store.getState().selection.selectedRowIds].sort()).toEqual(['r3'])
    store.dispatch(selectionApplied({ rowIds: ['r3', 'r1'], operation: 'replace', label: '' }))
    expect([...store.getState().selection.selectedRowIds].sort()).toEqual(['r1', 'r3'])
  })
})

describe('PCP vertical orientation rendering', () => {
  it('renderPcp supports viewportY transform without errors', () => {
    const calls: unknown[][] = []
    const ctx = {
      setTransform: (...args: unknown[]) => { calls.push(args) },
      save: () => {},
      restore: () => {},
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fillText: () => {},
    } as unknown as CanvasRenderingContext2D

    const spec: PcpRenderSpec = {
      width: 400,
      height: 300,
      dpr: 2,
      orientation: 'vertical',
      points: new Float64Array([50, 100, 150, 200]),
      nRows: 1,
      nAxes: 2,
      axisPos: [100, 200],
      bounds: { left: 84, right: 295, top: 66, bottom: 234 },
      axes: [
        { key: 'a', label: 'A', isCategorical: false, min: 0, max: 10 },
        { key: 'b', label: 'B', isCategorical: false, min: 0, max: 10 },
      ],
      reversed: {},
      style: { showContext: true, lineOpacity: 0.5, lineWidth: 1, selectedLineWidthBoost: 1.3 },
      rowColorSlots: new Uint16Array([0]),
      categoricalPalette: ['#2a78d6'],
      selectedFlags: new Uint8Array([0]),
      hoveredRow: -1,
      maxContextRows: 1000,
      clusterSizes: null,
      viewportX: 10,
      viewportY: 150,
    }

    renderPcp(ctx, spec)
    // First setTransform call should translate by -viewportX * dpr and -viewportY * dpr
    expect(calls[0]).toEqual([2, 0, 0, 2, -20, -300])
  })

  it('calculates comfortable vertical pitch >= 45px for 33 axes when virtualHeight is used', async () => {
    const local = new LocalEngine()
    const nAxes = 33
    const nRows = 10
    const rowIds = Array.from({ length: nRows }, (_, i) => `row${i}`)
    const values = new Float64Array(nRows * nAxes).fill(0.5)
    const axes = Array.from({ length: nAxes }, (_, i) => ({
      key: `axis_${i}`,
      min: 0,
      max: 10,
      isCategorical: false,
    }))

    const MIN_AXIS_HEIGHT = 48
    const frameHeight = 500
    const virtualHeight = Math.max(frameHeight, nAxes * MIN_AXIS_HEIGHT) // 33 * 48 = 1584

    const req: PcpGeometryRequest = {
      width: 900,
      height: virtualHeight,
      orientation: 'vertical',
      axes,
      reversed: {},
      jitterEnabled: false,
      jitterMode: 'pixel',
      jitterAmount: 0,
      jitterSeed: 1,
      rowIds,
      values,
    }

    const result = await local.pcpGeometry(req)
    expect(result.axisPos.length).toBe(33)

    // Check pitch between consecutive axes
    const pitches: number[] = []
    for (let i = 1; i < result.axisPos.length; i++) {
      pitches.push(result.axisPos[i] - result.axisPos[i - 1])
    }

    const minPitch = Math.min(...pitches)
    const maxPitch = Math.max(...pitches)

    // With margin.top=66, margin.bottom=66, bounds.bottom-bounds.top = 1584 - 132 = 1452
    // 1452 / 32 = 45.375px
    expect(minPitch).toBeGreaterThan(45)
    expect(maxPitch).toBeCloseTo(45.375, 2)
  })
})

describe('SVG coordinate projection (getSvgPoint)', () => {
  it('handles null/undefined gracefully', async () => {
    const { getSvgPoint } = await import('../src/utils/svgCoordinates')
    expect(getSvgPoint(null, { clientX: 100, clientY: 200 })).toEqual({ x: NaN, y: NaN })
  })

  it('uses native getScreenCTM when available', async () => {
    const { getSvgPoint } = await import('../src/utils/svgCoordinates')
    // Mock SVG with getScreenCTM: scale 2.0, translate (100, 50)
    const mockSvg = {
      getScreenCTM: () => ({
        // CTM: x' = 2*x + 100, y' = 2*y + 50
        inverse: () => ({
          a: 0.5, b: 0, c: 0, d: 0.5, e: -50, f: -25,
        }),
      }),
      createSVGPoint: () => ({
        x: 0,
        y: 0,
        matrixTransform(m: { a: number; d: number; e: number; f: number }) {
          return { x: this.x * m.a + m.e, y: this.y * m.d + m.f }
        },
      }),
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }),
    } as unknown as SVGSVGElement

    // Pointer at client (300, 250): (300*0.5 - 50 = 100, 250*0.5 - 25 = 100)
    const pt = getSvgPoint(mockSvg, { clientX: 300, clientY: 250 })
    expect(pt.x).toBe(100)
    expect(pt.y).toBe(100)
  })

  it('calculates exact xMidYMid meet letterbox in analytical fallback', async () => {
    const { getSvgPoint } = await import('../src/utils/svgCoordinates')
    // Square viewBox 600x600 inside a 1600x800 wide screen container
    // Scale = min(1600/600, 800/600) = 800/600 = 1.333333
    // Rendered size = 800x800 centered in 1600 width -> offsetX = (1600 - 800) / 2 = 400
    const mockSvg = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 800 }),
      getAttribute: () => 'xMidYMid meet',
      viewBox: { baseVal: { x: 0, y: 0, width: 600, height: 600 } },
    } as unknown as SVGSVGElement

    // Left edge of the rendered chart is at clientX = 400
    const ptLeft = getSvgPoint(mockSvg, { clientX: 400, clientY: 0 }, { width: 600, height: 600 })
    expect(ptLeft.x).toBeCloseTo(0, 4)
    expect(ptLeft.y).toBeCloseTo(0, 4)

    // Center of the chart is at clientX = 800, clientY = 400
    const ptCenter = getSvgPoint(mockSvg, { clientX: 800, clientY: 400 }, { width: 600, height: 600 })
    expect(ptCenter.x).toBeCloseTo(300, 4)
    expect(ptCenter.y).toBeCloseTo(300, 4)

    // Right edge of the rendered chart is at clientX = 1200
    const ptRight = getSvgPoint(mockSvg, { clientX: 1200, clientY: 800 }, { width: 600, height: 600 })
    expect(ptRight.x).toBeCloseTo(600, 4)
    expect(ptRight.y).toBeCloseTo(600, 4)
  })

  it('handles non-uniform stretch when preserveAspectRatio is none', async () => {
    const { getSvgPoint } = await import('../src/utils/svgCoordinates')
    const mockSvg = {
      getBoundingClientRect: () => ({ left: 50, top: 20, width: 1000, height: 500 }),
      getAttribute: (attr: string) => (attr === 'preserveAspectRatio' ? 'none' : null),
      viewBox: { baseVal: { x: 0, y: 0, width: 500, height: 250 } },
    } as unknown as SVGSVGElement

    const pt = getSvgPoint(mockSvg, { clientX: 550, clientY: 270 })
    expect(pt.x).toBeCloseTo(250, 4)
    expect(pt.y).toBeCloseTo(125, 4)
  })
})

