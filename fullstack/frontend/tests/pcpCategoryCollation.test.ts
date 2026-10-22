import { describe, expect, it } from 'vitest'
import { buildAxes } from '../src/features/pcp/usePcpPipeline'
import type { ColumnarData } from '../src/features/pcp/useDatasetColumns'
import type { CodebookColumn } from '../src/api/client'

function data(values: unknown[]): ColumnarData {
  const rowIds = values.map((_, i) => `r${i}`)
  return {
    rowIds, rowIndex: new Map(rowIds.map((id, i) => [id, i])),
    schema: [{ name: 'Q', columnId: 'q', semanticType: 'categorical' }],
    columns: { Q: values }, numeric: {}, categories: {}, minMax: {},
  }
}

describe('PCP categorical collation', () => {
  it('preserves legacy default-locale numeric ordering for Japanese and mixed labels', () => {
    const values = ['回答10', '回答2', 'ア', 'あ', 'ｱ', '漢字', 'e', 'é', 'e\u0301', 'E',
      '１２', '12', '2', '10', '-1', '1.2', '1.10', '', ' ', 'a10', 'a2', '回答2']
    const expected = [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    expect(buildAxes(data(values))[0].categories).toEqual(expected)
  })

  it('retains first-observed order for distinct numeric-like codes that compare equal', () => {
    for (const ties of [['001', '1', '01'], ['01', '001', '1']]) {
      const values = ['10', ...ties, '2', ties[0]]
      expect(buildAxes(data(values))[0].categories).toEqual([...ties, '2', '10'])
    }
  })

  it('keeps explicit category order ahead of observed codes and excludes missing values', () => {
    const spec: CodebookColumn = {
      name: 'Q', columnId: 'q', label: '設問', scaleType: 'nominal', role: 'question',
      valueLabels: {}, categoryOrder: ['回答10', '未観測', '99', '01'], missingCodes: ['99'],
      missingReasons: {}, isReversed: false, multiResponseGroup: null,
    }
    const values = ['回答2', '回答10', '001', '1', '01', '99', null, undefined, NaN, Infinity]
    const observed = ['回答2', '回答10', '001', '1', '01']
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const expected = [...new Set(['回答10', '未観測', '01', ...observed])]
    expect(buildAxes(data(values), [spec])[0].categories).toEqual(expected)
  })
})
