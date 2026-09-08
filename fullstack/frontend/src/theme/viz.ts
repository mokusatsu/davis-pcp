/**
 * Shared visualization color tokens — validated categorical palette
 * (dataviz reference palette; adjacent-pair CVD ΔE 9.1 light / 8.4 dark).
 * Color follows the entity (cluster/group id), never its rank: a group keeps
 * its slot even when other groups are filtered.
 */

// Fixed slot order (light surface). Dark-mode steps in DARK_CATEGORICAL.
export const CATEGORICAL = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#1baf7a', // 3 aqua
  '#eda100', // 4 yellow
  '#e87ba4', // 5 magenta
  '#008300', // 6 green
  '#4a3aa7', // 7 violet
  '#e34948', // 8 red
] as const

export const DARK_CATEGORICAL = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const

/** Context (non-selected) lines: de-emphasis gray, recessive on the surface. */
export const CONTEXT_LINE = '#9aa3ad'
export const CONTEXT_LINE_DARK = '#5c6470'

/** Selection accent + halo. */
export const SELECTION = '#2a78d6'
export const SELECTION_DARK = '#3987e5'
export const SURFACE = '#ffffff'
export const SURFACE_DARK = '#1a1a19'

/** Chrome inks (text never wears the series color). */
export const INK_PRIMARY = '#0b0b0b'
export const INK_SECONDARY = '#52514e'
export const INK_MUTED = '#898781'
export const GRIDLINE = '#e1e0d9'
export const AXIS = '#c3c2b7'

export interface VizTheme {
  categorical: readonly string[]
  contextLine: string
  selection: string
  surface: string
  inkPrimary: string
  inkSecondary: string
  inkMuted: string
  gridline: string
  axis: string
}

export function vizTheme(isDark: boolean): VizTheme {
  return isDark
    ? {
        categorical: DARK_CATEGORICAL,
        contextLine: CONTEXT_LINE_DARK,
        selection: SELECTION_DARK,
        surface: SURFACE_DARK,
        inkPrimary: '#ffffff',
        inkSecondary: '#c3c2b7',
        inkMuted: INK_MUTED,
        gridline: '#2c2c2a',
        axis: '#383835',
      }
    : {
        categorical: CATEGORICAL,
        contextLine: CONTEXT_LINE,
        selection: SELECTION,
        surface: SURFACE,
        inkPrimary: INK_PRIMARY,
        inkSecondary: INK_SECONDARY,
        inkMuted: INK_MUTED,
        gridline: GRIDLINE,
        axis: AXIS,
      }
}

/**
 * Stable color for a group/cluster entity. Slot = entity's stable index
 * (assigned once at creation), so filtering never repaints survivors.
 * Slot 0 is reserved for the selection accent; groups start at slot 1.
 */
export function entityColor(theme: VizTheme, stableIndex: number): string {
  return theme.categorical[(stableIndex + 1) % theme.categorical.length]
}

// L1 slots are independent of analytical-group colors; no repeated slots at 20 levels.
export const L1_COLORS = [
  '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948', '#2a78d6',
  '#7f4f24', '#00a6a6', '#a12d85', '#596d13', '#9c6ade', '#c75300', '#167064', '#cf486e',
  '#496b9f', '#9b8b00', '#684354', '#6a9b80',
] as const
export const DARK_L1_COLORS = [
  '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#3987e5',
  '#bf956c', '#36c9c9', '#da70bc', '#a6bd50', '#c599f3', '#ef9856', '#53a99c', '#f48eac',
  '#89aadf', '#c8b849', '#ba91a2', '#91c9a7',
] as const
export function l1Palette(theme: VizTheme): readonly string[] {
  return theme.surface === SURFACE_DARK ? DARK_L1_COLORS : L1_COLORS
}
export function l1Color(theme: VizTheme, index: number): string {
  return l1Palette(theme)[index] ?? theme.contextLine
}

/* ---------- L2 (analysis groups) × L1 (nominal) color composition ---------- */

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h, s, l }
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  if (s === 0) {
    const v = Math.round(l * 255).toString(16).padStart(2, '0')
    return `#${v}${v}${v}`
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255)
  const g = Math.round(hue2rgb(p, q, h) * 255)
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Lightness steps for L2 groups: base → lighter → darker (cyclic).
 *  Same hue as the L1/base color; only lightness varies. */
const L2_LIGHTNESS_STEPS = [1.0, 1.28, 0.72, 1.14, 0.86]

function shiftLightness(hex: string, factor: number): string {
  const { h, s, l } = hexToHsl(hex)
  const next = factor >= 1 ? Math.min(0.86, l * factor) : Math.max(0.22, l * factor)
  return hslToHex(h, s, next)
}

/**
 * Composed color per AGENTS.md rule 4:
 * - both L1 and L2 active → L1 hue kept, L2 group shown as a lightness step
 *   of that same hue (hue × lightness composition);
 * - only L2 active → neutral blue hue varied by lightness;
 * - only L1 active → the L1 categorical hue itself.
 */
export function composedColor(
  theme: VizTheme,
  opts: { l1?: string | null; l2Group?: number | null },
): string {
  const baseHue = opts.l1 ?? '#5b8ec4' // neutral blue when only L2 is present
  if (opts.l2Group == null) return opts.l1 ?? theme.contextLine
  const step = L2_LIGHTNESS_STEPS[Math.abs(opts.l2Group) % L2_LIGHTNESS_STEPS.length]
  return shiftLightness(baseHue, step)
}

function hashString(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Deterministic noise in [-1, 1] — same FNV/xorshift recipe as static v1
 *  signedNoise, usable without a seed (fixed seed for view-local jitter). */
export function signedNoiseViz(rowId: string, key: string, seed = 20020801): number {
  let x = hashString(`${seed}|${rowId}|${key}`) || 1
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) / 4294967295) * 2 - 1
}
