export interface ParsedLabelRow {
  lineIndex: number
  rawText: string
  variableName?: string
  label: string
}

export function parseBulkLabels(text: string, skipEmptyLines = true): ParsedLabelRow[] {
  const lines = text.split(/\r?\n/)
  const results: ParsedLabelRow[] = []

  lines.forEach((line, idx) => {
    const trimmed = line.trim()
    if (skipEmptyLines && trimmed === '') return

    if (line.includes('\t')) {
      const parts = line.split('\t')
      results.push({
        lineIndex: idx + 1,
        rawText: line,
        variableName: parts[0].trim(),
        label: parts.slice(1).join('\t').trim(),
      })
    } else {
      results.push({
        lineIndex: idx + 1,
        rawText: line,
        label: trimmed,
      })
    }
  })

  return results
}

export interface ParsedOption {
  code: string
  label: string
}

export function parseQuickValueLabels(text: string, startNumber = 1): ParsedOption[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const options: ParsedOption[] = []
  const numberedPattern = /^([0-9A-Za-z_-]+)[\s:=.\t]+(.*)$/

  let autoNum = startNumber

  for (const line of lines) {
    const match = line.match(numberedPattern)
    if (match) {
      options.push({
        code: match[1].trim(),
        label: match[2].trim(),
      })
    } else {
      options.push({
        code: String(autoNum++),
        label: line,
      })
    }
  }

  return options
}
