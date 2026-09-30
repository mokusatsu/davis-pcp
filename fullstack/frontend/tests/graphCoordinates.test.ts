import { describe, expect, it } from 'vitest'
import {
  canvasBufferSize, canvasToClient, clientToCanvas, clientToSurface, clientToSvg,
} from '../src/features/common/graphCoordinates'

describe('graphCoordinates', () => {
  it('null CTM・無効寸法では操作を無視する（偽クリックを作らない）', () => {
    expect(clientToSvg(null, { clientX: 10, clientY: 10 })).toEqual({ x: NaN, y: NaN })
    expect(clientToCanvas(null, { clientX: 10, clientY: 10 }, { width: 600, height: 420 }))
      .toEqual({ x: NaN, y: NaN })
    expect(clientToSurface(null, { clientX: 10, clientY: 10 }, 2)).toEqual({ x: NaN, y: NaN })
    expect(clientToSurface(document.createElement('div'), { clientX: 10, clientY: 10 }, 0))
      .toEqual({ x: NaN, y: NaN })
  })

  it('Canvas 変換は表示矩形と論理寸法を基準にし DPR を掛けない', () => {
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({
      left: 100, top: 50, width: 300, height: 210,
      right: 400, bottom: 260, x: 100, y: 50, toJSON: () => ({}),
    })
    const pt = clientToCanvas(canvas, { clientX: 250, clientY: 155 }, { width: 600, height: 420 })
    expect(pt.x).toBeCloseTo(300)
    expect(pt.y).toBeCloseTo(210)
    const back = canvasToClient(canvas, pt, { width: 600, height: 420 })
    expect(back.x).toBeCloseTo(250)
    expect(back.y).toBeCloseTo(155)
  })

  it('Canvas バッファは論理×scale×DPR', () => {
    expect(canvasBufferSize({ width: 600, height: 420 }, 4, 2)).toEqual({ width: 4800, height: 3360 })
    expect(canvasBufferSize({ width: 600, height: 420 }, 0.5, 1)).toEqual({ width: 300, height: 210 })
  })

  it('HTML surface は scale で割って論理座標を求める', () => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 600,
      right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    })
    expect(clientToSurface(el, { clientX: 400, clientY: 300 }, 2)).toEqual({ x: 200, y: 150 })
  })
})
