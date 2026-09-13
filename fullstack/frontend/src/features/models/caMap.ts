import type { CACategory } from './caTypes'

export type MapScaling = 'symmetric' | 'row_principal' | 'column_principal'

export function displayCoords(cat: CACategory, scaling: MapScaling): number[] {
  if (scaling === 'symmetric') return cat.principalCoordinates
  if (scaling === 'row_principal') {
    return cat.side === 'row' ? cat.principalCoordinates : cat.standardCoordinates
  }
  return cat.side === 'row' ? cat.standardCoordinates : cat.principalCoordinates
}

export function axisLabel(_rank: number, ratio: number[], axis: number): string {
  const pct = ((ratio[axis - 1] ?? 0) * 100).toFixed(2)
  return `第${axis}軸 (${pct}%)`
}
