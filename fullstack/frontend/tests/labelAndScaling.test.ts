import { describe, it, expect, vi } from 'vitest'
import { truncateText } from '../src/utils/textUtils'
import { getSvgPoint } from '../src/utils/svgCoordinates'
import { renderPcp, type PcpRenderSpec } from '../src/engine/pcpRenderer'
import { vizTheme } from '../src/theme/viz'

describe('truncateText utility', () => {
  it('returns empty string for null or undefined or empty', () => {
    expect(truncateText(null, 10)).toBe('')
    expect(truncateText(undefined, 10)).toBe('')
    expect(truncateText('', 10)).toBe('')
  })

  it('returns original string if length <= maxLength', () => {
    expect(truncateText('hello', 5)).toBe('hello')
    expect(truncateText('hello', 10)).toBe('hello')
    expect(truncateText('日本語テスト', 6)).toBe('日本語テスト')
  })

  it('truncates string and appends ellipsis when exceeding maxLength', () => {
    expect(truncateText('abcdefghij', 5)).toBe('abcd…')
    expect(truncateText('とても長いアンケートの設問タイトル', 8)).toBe('とても長いアン…')
  })

  it('handles unicode and surrogate pairs correctly without splitting code units', () => {
    const textWithEmoji = '項目A😀😃😄😁'
    expect(truncateText(textWithEmoji, 5)).toBe('項目A😀…')
  })

  it('supports custom ellipsis', () => {
    expect(truncateText('abcdefghij', 6, '...')).toBe('abc...')
  })

  it('handles small or zero maxLength safely', () => {
    expect(truncateText('abc', 0)).toBe('')
    expect(truncateText('abc', -1)).toBe('')
    expect(truncateText('abc', 1)).toBe('a')
  })
})

describe('getSvgPoint coordinate conversion', () => {
  it('returns NaN for missing svg or zero dimensions', () => {
    expect(getSvgPoint(null, { clientX: 100, clientY: 200 })).toEqual({ x: NaN, y: NaN })
  })

  it('uses getScreenCTM() inverse transform when available', () => {
    const mockPoint = { x: 0, y: 0, matrixTransform: vi.fn((matrix: any) => ({ x: 50, y: 75 })) }
    const mockSvg = {
      getScreenCTM: () => ({
        inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: -10, f: -20 }),
      }),
      createSVGPoint: () => mockPoint,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 150 }),
    } as unknown as SVGSVGElement

    const pt = getSvgPoint(mockSvg, { clientX: 60, clientY: 95 })
    expect(pt).toEqual({ x: 50, y: 75 })
    expect(mockPoint.x).toBe(60)
    expect(mockPoint.y).toBe(95)
  })

  it('calculates fallback correctly with high-DPI / browser zoom and viewBox', () => {
    // Simulated SVG with viewBox 0 0 1000 500, but client bounding box is 500 x 250 (e.g. 50% scale or styled)
    const mockSvg = {
      getScreenCTM: null,
      viewBox: {
        baseVal: { x: 0, y: 0, width: 1000, height: 500 },
      },
      getAttribute: (attr: string) => (attr === 'preserveAspectRatio' ? 'none' : null),
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 500, height: 250 }),
    } as unknown as SVGSVGElement

    // clientX = 350 (250px from left = 50% of width) -> should map to 500 in viewBox
    // clientY = 175 (125px from top = 50% of height) -> should map to 250 in viewBox
    const pt = getSvgPoint(mockSvg, { clientX: 350, clientY: 175 })
    expect(pt.x).toBeCloseTo(500)
    expect(pt.y).toBeCloseTo(250)
  })
})

describe('pcpRenderer with rotated & truncated labels', () => {
  it('renders horizontal axes without error and formats long labels', () => {
    const fills: string[] = []
    const transforms: any[] = []
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn((x, y) => transforms.push({ x, y })),
      rotate: vi.fn((angle) => transforms.push({ angle })),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn((text) => fills.push(String(text))),
      setTransform: vi.fn(),
      setLineDash: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      font: '',
      textAlign: '',
      textBaseline: '',
    } as unknown as CanvasRenderingContext2D

    const spec: PcpRenderSpec = {
      width: 800,
      height: 400,
      dpr: 1,
      orientation: 'horizontal',
      points: new Float64Array([100, 100, 300, 150]),
      nRows: 1,
      nAxes: 2,
      axisPos: [100, 300],
      bounds: { left: 50, right: 750, top: 50, bottom: 350 },
      axes: [
        {
          key: 'var1',
          label: 'とても長いアンケートの設問タイトル1（満足度）',
          isCategorical: false,
          min: 0,
          max: 100,
        },
        {
          key: 'var2',
          label: 'カテゴリ変数ラベル',
          isCategorical: true,
          min: 0,
          max: 2,
          categories: ['非常に当てはまる', '普通', '全く当てはまらない'],
        },
      ],
      reversed: {},
      style: {
        showContext: true,
        lineOpacity: 0.5,
        lineWidth: 1,
        selectedLineWidthBoost: 1.5,
      },
      rowColorSlots: new Uint16Array([0]),
      categoricalPalette: [...vizTheme(false).categorical],
      selectedFlags: new Uint8Array([0]),
    }

    renderPcp(ctx, spec)

    // The long label should be truncated
    const truncatedFound = fills.some((f) => f.includes('…'))
    expect(truncatedFound).toBe(true)

    // A rotation transform should have been applied for axis label (-Math.PI / 4)
    const rotateCalled = transforms.some((t) => t.angle && Math.abs(t.angle - -Math.PI / 4) < 0.001)
    expect(rotateCalled).toBe(true)
  })
})
