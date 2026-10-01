import { getWidth } from 'zrender/lib/contain/text.js'

/** Logical pixels only: container geometry flows into labels, never back into it. */
export const chartLabelLineHeight = (fontSize = 12): number => Math.ceil(fontSize * 1.25)

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const graphemes = (text: string): string[] => segmenter
  ? Array.from(segmenter.segment(text), part => part.segment) : [text]

/** The same font metrics used by ECharts, with no per-label DOM measurements. */
export function chartLabelWidth(text: string, fontSize = 12, font = `${fontSize}px sans-serif`): number {
  return getWidth(text, font)
}

/** Wrap display text without modifying source names/IDs. Explicit paragraphs keep
 * at least one line when possible (e.g. a KDA direction below its variable name). */
export function wrapChartLabel(text: string, width: number, maxLines = 2, fontSize = 12, font = `${fontSize}px sans-serif`): string[] {
  const limit = Math.max(1, Math.floor(maxLines))
  const available = Math.max(1, width)
  const paragraphs = String(text ?? '').split(/\r?\n/)
  const lines: string[] = []
  const fit = (value: string) => chartLabelWidth(value, fontSize, font) <= available
  const ellipsize = (value: string) => {
    if (!fit('…')) return ''
    const chars = graphemes(value.trimEnd())
    while (chars.length && !fit(chars.join('') + '…')) chars.pop()
    return chars.join('') + '…'
  }
  for (let p = 0; p < paragraphs.length && lines.length < limit; p++) {
    const reserved = Math.min(paragraphs.length - p - 1, limit - lines.length - 1)
    const end = limit - reserved
    let chars = graphemes(paragraphs[p])
    if (!chars.length) { lines.push(''); continue }
    while (chars.length && lines.length < end) {
      const remaining = chars.join('')
      if (fit(remaining)) { lines.push(remaining); chars = []; break }
      if (!fit(chars[0])) { lines.push(fit('…') ? '…' : ''); chars = []; break }
      if (lines.length === end - 1) { lines.push(ellipsize(remaining)); chars = []; break }
      let count = 1
      while (count < chars.length && fit(chars.slice(0, count + 1).join(''))) count++
      // Prefer word boundaries but allow long source identifiers/CJK to wrap.
      let cut = count
      for (let i = count - 1; i >= Math.floor(count * .5); i--) {
        if (/\s/.test(chars[i])) { cut = i + 1; break }
      }
      lines.push(chars.slice(0, cut).join('').trimEnd())
      chars = chars.slice(cut)
      while (chars.length && /^\s+$/.test(chars[0])) chars.shift()
    }
  }
  if (paragraphs.length > limit && lines.length) lines[lines.length - 1] = ellipsize(lines[lines.length - 1])
  return lines.length ? lines : ['']
}
