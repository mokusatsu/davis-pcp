import { expect, it } from 'vitest'
import { crosstabToCsv } from '../src/features/crosstab/CrosstabPage'

// Read CSV independently of the exporter, including quoted multiline fields.
function readCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(field); field = ''
    } else if (char === '\n' && !quoted) {
      row.push(field); rows.push(row); row = []; field = ''
    } else field += char
  }
  expect(quoted).toBe(false)
  row.push(field); rows.push(row)
  return rows
}

function result(label: string, categoryId = 'Rezydencjalny') {
  return {
    meta: { datasetId: 'ds-builtin-siechnice-cbc96', dataRevision: 1, schemaRevision: 1,
      scope: 'active', scopeHash: 'sha256:test', weightApplied: false },
    cells: [{ rowCategoryId: categoryId, rowLabel: label, colCategoryId: '0',
      colLabel: 'Not chosen / 非選択', unweightedCount: 259, count: 259, rowPct: 53.96,
      colPct: 20.75, totalPct: 11.24, expectedCount: 260, asr: -0.103,
      significance: '', rowIdCount: 259 }],
    analysisProvenance: { weightType: 'none', note: 'quoted "source",\nsecond line' },
  } as Parameters<typeof crosstabToCsv>[0]
}

it('round-trips the real Siechnice comma/quote label without shifting its 13 columns', () => {
  const label = 'Miasto staje się przede wszystkim "sypialnią" Wrocławia. Polityka miasta wspiera głównie budownictwo mieszkaniowe i podstawowe, lokalne usługi (sklepy, szkoły, przedszkola) dla mieszkańców, którzy pracują i spędzają czas głównie we Wrocławiu.'
  const rows = readCsv(crosstabToCsv(result(label)))
  expect(rows[0]).toHaveLength(13)
  expect(rows[1]).toHaveLength(13)
  expect(rows[1]).toEqual(['Rezydencjalny', label, '0', 'Not chosen / 非選択', '259',
    '259', '53.96', '20.75', '11.24', '260', '-0.103', '', '259'])
  expect(rows.find(row => row[0] === '# note')).toEqual(['# note', 'quoted "source",\nsecond line'])
})

it.each(['=SUM(1,2)', '+cmd', '-text', '@cmd', '\t=cmd', '\r=cmd'])('neutralizes text formula prefix %s while preserving numeric negative residuals', prefix => {
  const rows = readCsv(crosstabToCsv(result(prefix + '\n"continued"', prefix)))
  expect(rows[1]).toHaveLength(13)
  expect(rows[1][0]).toBe("'" + prefix)
  expect(rows[1][1]).toBe("'" + prefix + '\n"continued"')
  expect(rows[1][10]).toBe('-0.103')
})
