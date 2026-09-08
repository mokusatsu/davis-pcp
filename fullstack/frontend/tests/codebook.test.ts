import { describe, it, expect } from 'vitest'
import { parseBulkLabels, parseQuickValueLabels } from '../src/features/dataset/codebookParsers'
import { CODEBOOK_PRESETS } from '../src/features/dataset/codebookPresets'
import {
  codebookSlice,
  draftColumnUpdated,
  bulkLabelsApplied,
  presetAppliedToColumns,
  quickValueLabelsApplied,
  draftReverted,
  CodebookState,
} from '../src/features/dataset/codebookSlice'
import { CodebookColumn } from '../src/api/client'

describe('codebookParsers', () => {
  describe('parseBulkLabels', () => {
    it('splits lines and skips empty lines by default', () => {
      const text = 'Q1質問文\n\nQ2質問文\r\n   \nQ3質問文'
      const rows = parseBulkLabels(text, true)
      expect(rows).toHaveLength(3)
      expect(rows[0].label).toBe('Q1質問文')
      expect(rows[1].label).toBe('Q2質問文')
      expect(rows[2].label).toBe('Q3質問文')
      expect(rows[0].lineIndex).toBe(1)
      expect(rows[1].lineIndex).toBe(3)
      expect(rows[2].lineIndex).toBe(5)
    })

    it('keeps empty lines when skipEmptyLines is false', () => {
      const text = 'Line 1\n\nLine 3'
      const rows = parseBulkLabels(text, false)
      expect(rows).toHaveLength(3)
      expect(rows[1].label).toBe('')
    })

    it('parses TSV formatted variable name and label', () => {
      const text = 'Q1_satisfaction\t当サービスの総合満足度\nQ2_speed\tシステムの処理速度'
      const rows = parseBulkLabels(text)
      expect(rows).toHaveLength(2)
      expect(rows[0].variableName).toBe('Q1_satisfaction')
      expect(rows[0].label).toBe('当サービスの総合満足度')
      expect(rows[1].variableName).toBe('Q2_speed')
      expect(rows[1].label).toBe('システムの処理速度')
    })
  })

  describe('parseQuickValueLabels', () => {
    it('parses colon-separated numbered options', () => {
      const text = '1: とても不満\n2: やや不満\n3: 普通\n4: やや満足\n5: とても満足'
      const opts = parseQuickValueLabels(text)
      expect(opts).toHaveLength(5)
      expect(opts[0]).toEqual({ code: '1', label: 'とても不満' })
      expect(opts[4]).toEqual({ code: '5', label: 'とても満足' })
    })

    it('parses equal-separated or dot-separated options', () => {
      const text = '1 = 不満\n2 = 満足'
      const opts1 = parseQuickValueLabels(text)
      expect(opts1[0]).toEqual({ code: '1', label: '不満' })
      expect(opts1[1]).toEqual({ code: '2', label: '満足' })

      const text2 = '1. 男性\n2. 女性'
      const opts2 = parseQuickValueLabels(text2)
      expect(opts2[0]).toEqual({ code: '1', label: '男性' })
      expect(opts2[1]).toEqual({ code: '2', label: '女性' })
    })

    it('auto-numbers options when codes are missing', () => {
      const text = '大いに不満\nやや不満\n普通\nやや満足\n大いに満足'
      const opts = parseQuickValueLabels(text, 1)
      expect(opts).toHaveLength(5)
      expect(opts[0]).toEqual({ code: '1', label: '大いに不満' })
      expect(opts[1]).toEqual({ code: '2', label: 'やや不満' })
      expect(opts[4]).toEqual({ code: '5', label: '大いに満足' })
    })

    it('supports custom startNumber such as 0', () => {
      const text = 'いいえ\nはい'
      const opts = parseQuickValueLabels(text, 0)
      expect(opts).toHaveLength(2)
      expect(opts[0]).toEqual({ code: '0', label: 'いいえ' })
      expect(opts[1]).toEqual({ code: '1', label: 'はい' })
    })
  })
})

describe('codebookPresets', () => {
  it('contains expected standard survey presets', () => {
    expect(CODEBOOK_PRESETS.length).toBeGreaterThanOrEqual(6)
    const sat5 = CODEBOOK_PRESETS.find((p) => p.id === 'satisfaction_5')
    expect(sat5).toBeDefined()
    expect(sat5?.scaleType).toBe('ordinal')
    expect(sat5?.options).toHaveLength(5)
    expect(sat5?.options[0].code).toBe('1')
    expect(sat5?.options[4].code).toBe('5')

    const binary = CODEBOOK_PRESETS.find((p) => p.id === 'binary_yes_no')
    expect(binary).toBeDefined()
    expect(binary?.scaleType).toBe('nominal')
    expect(binary?.options).toEqual([
      { code: '0', label: 'いいえ' },
      { code: '1', label: 'はい' },
    ])
  })
})

describe('codebookSlice reducers', () => {
  const dummyCol1: CodebookColumn = {
    columnId: 'col-001',
    name: 'Q1',
    label: '',
    scaleType: 'nominal',
    role: 'question',
    valueLabels: {},
    categoryOrder: [],
    missingCodes: [],
    missingReasons: {},
    isReversed: false,
    multiResponseGroup: null,
  }

  const dummyCol2: CodebookColumn = {
    columnId: 'col-002',
    name: 'Q2',
    label: '',
    scaleType: 'nominal',
    role: 'question',
    valueLabels: {},
    categoryOrder: [],
    missingCodes: [],
    missingReasons: {},
    isReversed: false,
    multiResponseGroup: null,
  }

  const initialTestState: CodebookState = {
    datasetId: 'ds-test',
    schemaRevision: 1,
    columns: [dummyCol1, dummyCol2],
    draftColumns: [dummyCol1, dummyCol2],
    selectedColumnIds: [],
    activeColumnId: 'col-001',
    viewMode: 'detail',
    isEditorOpen: false,
    isBulkLabelModalOpen: false,
    isImportDialogOpen: false,
    filter: { keyword: '', scaleType: null, role: null },
    hasChanges: false,
    isLoading: false,
    isSaving: false,
  }

  it('updates draftColumn and marks hasChanges', () => {
    const nextState = codebookSlice.reducer(
      initialTestState,
      draftColumnUpdated({
        columnId: 'col-001',
        patch: { label: '総合満足度', isReversed: true },
      })
    )
    expect(nextState.draftColumns[0].label).toBe('総合満足度')
    expect(nextState.draftColumns[0].isReversed).toBe(true)
    expect(nextState.hasChanges).toBe(true)
    // Original untouched
    expect(nextState.columns[0].label).toBe('')
  })

  it('reverts draftColumns to original on draftReverted', () => {
    const modifiedState = codebookSlice.reducer(
      initialTestState,
      draftColumnUpdated({
        columnId: 'col-001',
        patch: { label: '一時ラベル' },
      })
    )
    expect(modifiedState.hasChanges).toBe(true)

    const revertedState = codebookSlice.reducer(modifiedState, draftReverted())
    expect(revertedState.hasChanges).toBe(false)
    expect(revertedState.draftColumns[0].label).toBe('')
  })

  it('applies bulk labels to matching columnIds', () => {
    const nextState = codebookSlice.reducer(
      initialTestState,
      bulkLabelsApplied([
        { columnId: 'col-001', label: '設問1の質問文' },
        { columnId: 'col-002', label: '設問2の質問文' },
      ])
    )
    expect(nextState.draftColumns[0].label).toBe('設問1の質問文')
    expect(nextState.draftColumns[1].label).toBe('設問2の質問文')
    expect(nextState.hasChanges).toBe(true)
  })

  it('applies preset to multiple selected columns', () => {
    const preset = CODEBOOK_PRESETS.find((p) => p.id === 'satisfaction_5')!
    const nextState = codebookSlice.reducer(
      initialTestState,
      presetAppliedToColumns({
        columnIds: ['col-001', 'col-002'],
        preset,
      })
    )
    expect(nextState.draftColumns[0].scaleType).toBe('ordinal')
    expect(nextState.draftColumns[0].categoryOrder).toEqual(['1', '2', '3', '4', '5'])
    expect(nextState.draftColumns[0].valueLabels['1']).toBe('大いに不満')
    expect(nextState.draftColumns[1].scaleType).toBe('ordinal')
    expect(nextState.draftColumns[1].categoryOrder).toEqual(['1', '2', '3', '4', '5'])
    expect(nextState.hasChanges).toBe(true)
  })

  it('applies quickValueLabels to targeted columns', () => {
    const options = [
      { code: '0', label: '無' },
      { code: '1', label: '有' },
    ]
    const nextState = codebookSlice.reducer(
      initialTestState,
      quickValueLabelsApplied({
        columnIds: ['col-001'],
        options,
      })
    )
    expect(nextState.draftColumns[0].valueLabels).toEqual({ '0': '無', '1': '有' })
    expect(nextState.draftColumns[0].categoryOrder).toEqual(['0', '1'])
    // col-002 untouched
    expect(nextState.draftColumns[1].valueLabels).toEqual({})
  })
})
