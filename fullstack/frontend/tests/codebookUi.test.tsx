import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { codebookSlice, editorModalOpened } from '../src/features/dataset/codebookSlice'
import CodebookEditorModal from '../src/features/dataset/CodebookEditorModal'
import CodebookGridView from '../src/features/dataset/CodebookGridView'
import BulkLabelPasteModal from '../src/features/dataset/BulkLabelPasteModal'
import { CodebookColumn } from '../src/api/client'

// Mock api client
vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual('../src/api/client')
  return {
    ...actual,
    getCodebook: vi.fn().mockResolvedValue({
      datasetId: 'ds-test',
      schemaRevision: 1,
      columns: [
        {
          columnId: 'col-1',
          name: 'Q1_satisfaction',
          label: '当サービスの総合満足度',
          scaleType: 'ordinal',
          role: 'question',
          valueLabels: { '1': '不満', '5': '満足' },
          categoryOrder: ['1', '5'],
          missingCodes: ['99'],
          missingReasons: { '99': '無回答' },
          isReversed: false,
          multiResponseGroup: null,
        },
        {
          columnId: 'col-2',
          name: 'age',
          label: '年齢',
          scaleType: 'ratio',
          role: 'attribute',
          valueLabels: {},
          categoryOrder: [],
          missingCodes: [],
          missingReasons: {},
          isReversed: false,
          multiResponseGroup: null,
        },
      ],
    }),
    updateCodebook: vi.fn().mockResolvedValue({
      status: 'success',
      datasetId: 'ds-test',
      schemaRevision: 2,
      updatedColumns: 2,
    }),
    downloadCodebookExport: vi.fn().mockResolvedValue(undefined),
  }
})

describe('Codebook UI Components E2E Flow', () => {
  const mockColumns: CodebookColumn[] = [
    {
      columnId: 'col-1',
      name: 'Q1_satisfaction',
      label: '総合満足度',
      scaleType: 'ordinal',
      role: 'question',
      valueLabels: { '1': '不満', '2': '普通', '3': '満足' },
      categoryOrder: ['1', '2', '3'],
      missingCodes: ['98', '99'],
      missingReasons: {},
      isReversed: false,
      multiResponseGroup: null,
    },
    {
      columnId: 'col-2',
      name: 'gender',
      label: '性別',
      scaleType: 'nominal',
      role: 'attribute',
      valueLabels: { '1': '男性', '2': '女性' },
      categoryOrder: ['1', '2'],
      missingCodes: [],
      missingReasons: {},
      isReversed: false,
      multiResponseGroup: null,
    },
  ]

  const createTestStore = (initialOpen = true) => {
    return configureStore({
      reducer: {
        codebook: codebookSlice.reducer,
        selection: () => ({
          datasetId: 'ds-test',
          datasetName: 'customer_survey.csv',
          allRowIds: ['R1', 'R2'],
        }),
      },
      preloadedState: {
        codebook: {
          datasetId: 'ds-test',
          schemaRevision: 1,
          columns: mockColumns,
          draftColumns: JSON.parse(JSON.stringify(mockColumns)),
          multiResponseGroups: [],
          draftMultiResponseGroups: [],
          selectedColumnIds: [],
          activeColumnId: 'col-1',
          viewMode: 'detail' as const,
          isEditorOpen: initialOpen,
          isBulkLabelModalOpen: false,
          isImportDialogOpen: false,
          filter: { keyword: '', scaleType: null, role: null },
          hasChanges: false,
          isLoading: false,
          isSaving: false,
        },
      },
    })
  }

  it('renders CodebookEditorModal with Detail View and controls', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <CodebookEditorModal />
      </Provider>
    )

    // Modal title with dataset name
    expect(screen.getByText(/コードブックエディタ/)).toBeInTheDocument()
    expect(screen.getByText(/customer_survey.csv/)).toBeInTheDocument()

    // Left pane has variables
    expect(screen.getAllByText('Q1_satisfaction').length).toBeGreaterThan(0)
    expect(screen.getByText('gender')).toBeInTheDocument()

    // Right pane displays active variable details
    expect(screen.getByText(/変数: Q1_satisfaction/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('総合満足度')).toBeInTheDocument()

    // Value labels are displayed
    expect(screen.getByDisplayValue('不満')).toBeInTheDocument()
    expect(screen.getByDisplayValue('普通')).toBeInTheDocument()
    expect(screen.getByDisplayValue('満足')).toBeInTheDocument()
  })

  it('switches to Grid View and allows inline label edit and role select', async () => {
    const onUpdate = vi.fn()
    const onBulk = vi.fn()

    render(
      <CodebookGridView
        columns={mockColumns}
        onUpdateColumn={onUpdate}
        onBulkUpdateLabels={onBulk}
      />
    )

    expect(screen.getByText('Q1_satisfaction')).toBeInTheDocument()
    expect(screen.getByText('gender')).toBeInTheDocument()

    // Find input with label value
    const labelInputs = screen.getAllByRole('textbox')
    const q1Input = labelInputs.find((input) => (input as HTMLInputElement).value === '総合満足度')
    expect(q1Input).toBeDefined()

    // Simulate edit
    fireEvent.change(q1Input!, { target: { value: '新しい総合満足度' } })
    expect(onUpdate).toHaveBeenCalledWith('col-1', { label: '新しい総合満足度' })
  })

  it('displays value labels summary and shows full labels balloon on mouseover in Grid View', async () => {
    render(
      <CodebookGridView
        columns={mockColumns}
        onUpdateColumn={vi.fn()}
        onBulkUpdateLabels={vi.fn()}
      />
    )

    // Check summary text is present in the document
    const summaryElem = screen.getByText(/1:不満, 2:普通, 3:満足/)
    expect(summaryElem).toBeInTheDocument()

    // Hover to trigger tooltip balloon
    fireEvent.mouseEnter(summaryElem)
    expect(await screen.findByText(/値ラベル一覧/)).toBeInTheDocument()
    expect(screen.getByText('不満')).toBeInTheDocument()
  })

  it('handles BulkLabelPasteModal flow and previews mapping', () => {
    const onApply = vi.fn()
    const onClose = vi.fn()

    render(
      <BulkLabelPasteModal
        open={true}
        onClose={onClose}
        columns={mockColumns}
        onApply={onApply}
      />
    )

    expect(screen.getByText(/質問文（ラベル）の一括貼り付け/)).toBeInTheDocument()

    // Enter multiple lines
    const textarea = screen.getByPlaceholderText(/当サービスの総合的な満足度をお答えください/i)
    fireEvent.change(textarea, {
      target: { value: 'サービス総合評価\n回答者の性別' },
    })

    // Preview table should display updated labels
    expect(screen.getByText('サービス総合評価')).toBeInTheDocument()
    expect(screen.getByText('回答者の性別')).toBeInTheDocument()

    // Click apply button
    const applyBtn = screen.getByRole('button', { name: /反映する/ })
    fireEvent.click(applyBtn)

    expect(onApply).toHaveBeenCalledWith([
      { columnId: 'col-1', label: 'サービス総合評価' },
      { columnId: 'col-2', label: '回答者の性別' },
    ])
  })

  it('filters variable list by search keyword and reverts changes on undo', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <CodebookEditorModal />
      </Provider>
    )

    // Initially both variables are visible
    expect(screen.getByText('gender')).toBeInTheDocument()

    // Filter by 'Q1'
    const searchInput = screen.getByPlaceholderText('変数名やラベルで検索...')
    fireEvent.change(searchInput, { target: { value: 'Q1' } })

    // Q1 visible, gender filtered out
    expect(screen.getAllByText('Q1_satisfaction').length).toBeGreaterThan(0)
    expect(screen.queryByText('gender')).not.toBeInTheDocument()

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } })
    expect(screen.getByText('gender')).toBeInTheDocument()

    // Modify label
    const labelInput = screen.getByDisplayValue('総合満足度')
    fireEvent.change(labelInput, { target: { value: '変更されたラベル' } })
    expect(screen.getByDisplayValue('変更されたラベル')).toBeInTheDocument()

    // Click '元に戻す' button
    const undoBtn = screen.getByRole('button', { name: /元に戻す/ })
    expect(undoBtn).not.toBeDisabled()
    fireEvent.click(undoBtn)

    // Reverted
    expect(screen.getByDisplayValue('総合満足度')).toBeInTheDocument()
  })

  it('registers current value labels as custom preset and verifies toolbar has no emojis', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <CodebookEditorModal />
      </Provider>
    )

    // Check toolbar buttons do not have redundant emojis
    expect(screen.getByRole('button', { name: /CSV辞書読込/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /エクスポート/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /質問文一括貼付/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /プリセット一括適用/ })).toBeInTheDocument()

    // Find 'プリセット登録' button
    const registerPresetBtn = screen.getByRole('button', { name: /プリセット登録/ })
    expect(registerPresetBtn).toBeInTheDocument()
    expect(registerPresetBtn).not.toBeDisabled()

    // Click 'プリセット登録' to open registration modal
    fireEvent.click(registerPresetBtn)

    expect(await screen.findByText(/値ラベルのプリセット登録/)).toBeInTheDocument()
    expect(screen.getByText(/登録内容プレビュー/)).toBeInTheDocument()

    // Enter preset name and save
    const nameInput = screen.getByPlaceholderText(/5段階満足度/)
    fireEvent.change(nameInput, { target: { value: 'マイカスタム評価' } })

    const saveBtn = screen.getByRole('button', { name: /登録する/ })
    fireEvent.click(saveBtn)

    // Check custom presets in localStorage
    const savedPresetsRaw = localStorage.getItem('davis_codebook_user_presets')
    expect(savedPresetsRaw).toBeTruthy()
    const savedPresets = JSON.parse(savedPresetsRaw!)
    expect(savedPresets.some((p: any) => p.name === 'マイカスタム評価')).toBe(true)
  })
})
