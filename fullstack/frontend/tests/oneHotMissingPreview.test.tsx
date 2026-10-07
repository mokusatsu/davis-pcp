import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { api, type CodebookColumn } from '../src/api/client'
import OverviewPage from '../src/features/dataset/OverviewPage'

// The real Overview, OneHotModal, ActiveModal, ColumnTable, and AntD controls run.
// Only unrelated modal/history siblings are replaced. Transport is modeled at
// api.get/api.post. No backend server, browser, or persisted mutation is claimed.
vi.mock('../src/features/dataset/BinningModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ImputationModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/AddVariableModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

interface Fixture {
  id: string
  values: string[]
  missingCodes: string[]
  missingReasons?: Record<string, string>
  categoryOrder: string[]
  expectedDefault: string[]
  expectedDropFirst: string[]
  schemaCategoryLimit?: number
  omitSchemaUniqueCount?: boolean
  allowPendingTransform?: boolean
}

async function openOneHot(fixture: Fixture) {
  const datasetId = `int04-${fixture.id}`
  const column: CodebookColumn = {
    columnId: 'stable-q', name: 'q', label: '回答コード', role: 'question', scaleType: 'nominal',
    valueLabels: Object.fromEntries(fixture.categoryOrder.map(v => [v, `回答 ${v}`])),
    categoryOrder: fixture.categoryOrder, missingCodes: fixture.missingCodes,
    missingReasons: fixture.missingReasons ?? {}, isReversed: fixture.id === 'reason-only-control',
    multiResponseGroup: null,
  }
  // Imported schema stores observed raw string categories, including explicit
  // missing codes; codebook semantics are separate. Revisions deliberately match.
  const categories = [...new Set(fixture.values)].sort()
  const schema = [{ columnId: 'stable-q', name: 'q', physicalType: 'String',
    semanticType: 'categorical', role: 'categorical_axis', missingCount: 0,
    uniqueCount: fixture.omitSchemaUniqueCount ? undefined : categories.length,
    categories: categories.slice(0, fixture.schemaCategoryLimit ?? categories.length) }]
  const base = store.getState()
  const rowIds = fixture.values.map((_, i) => `row-${i * 7 + 3}`)
  const state = { ...base,
    selection: { ...base.selection, datasetId, revision: 4, dataRevision: 7,
      allRowIds: rowIds, activeRowIds: rowIds, selectedRowIds: [rowIds[0]],
      activeRowIdSet: new Set(rowIds) },
    codebook: { ...base.codebook, datasetId, schemaRevision: 3, columns: [column], multiResponseGroups: [] },
  }
  const local = configureStore({ reducer: () => state,
    middleware: g => g({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const meta = { datasetId, name: `INT-04 ${fixture.id}`, format: 'csv', rowCount: rowIds.length,
    columnCount: 1, fingerprint: fixture.id, dataRevision: 7, schemaRevision: 3,
    rowIdentity: '__rowId__', createdAt: '2026-10-07T00:00:00Z', schema }
  // Summary analysis semantics can use the declared domain. This must NOT
  // accidentally become the transform preview's domain or scoring policy.
  const analysisValues = fixture.values.filter(v => !fixture.missingCodes.includes(v)
    && fixture.categoryOrder.includes(v))
  const frequencies: Record<string, number> = {}
  for (const v of analysisValues) frequencies[v] = (frequencies[v] ?? 0) + 1
  const summary = { rowCount: rowIds.length, columns: { q: {
    count: analysisValues.length, missing: rowIds.length - analysisValues.length,
    uniqueCount: Object.keys(frequencies).length, frequencies,
  } } }
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path !== `/datasets/${datasetId}`) throw new Error(`Unexpected GET ${path}`)
    return structuredClone(meta) as any
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path, body) => {
    if (fixture.allowPendingTransform && path === `/datasets/${datasetId}/transform`) {
      // Capture the real request without simulating a successful commit or reload.
      return await new Promise<any>(() => {})
    }
    if (path !== '/summaries') throw new Error(`Unexpected POST ${path}`)
    expect(body).toEqual({ datasetId, expectedDataRevision: 7, expectedSchemaRevision: 3 })
    return structuredClone(summary) as any
  })
  const view = render(<Provider store={local}><OverviewPage /></Provider>)
  await waitFor(() => expect(view.getByTestId('btn-onehot-q')).toBeVisible())
  fireEvent.click(view.getByTestId('btn-onehot-q'))
  const content = await view.findByTestId('one-hot-modal-content')
  await waitFor(() => expect(content).toBeVisible())
  expect(dispatch).not.toHaveBeenCalled()
  const readPreview = () => ({
    candidates: Array.from(content.querySelectorAll('.ant-tag')).map(n => n.textContent)
      .filter((text): text is string => Boolean(text?.startsWith('q_'))),
    rows: Array.from(content.querySelectorAll('tbody tr[data-row-key]')).map(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(cell => cell.textContent)
      return { index: cells[0], value: cells[1], status: cells[2] }
    }),
    singleLevelNotice: within(content).queryByText('水準が1つの場合は除外せず、0/1列を生成します。') !== null,
    dropFirstChecked: (within(content).getByTestId('one-hot-drop-first') as HTMLInputElement).checked,
  })
  return { view, content, readPreview, dispatch, post }
}

it('explicit missing99 is absent from leading-zero One-Hot candidates and generated-status rows', async () => {
  const f: Fixture = { id: 'leading-zero-missing', values: ['01', '02', '99'], missingCodes: ['99'],
    categoryOrder: ['01', '02', '99'], expectedDefault: ['q_01', 'q_02'], expectedDropFirst: ['q_02'] }
  const ui = await openOneHot(f)
  const actual = ui.readPreview()
  expect(actual.candidates).toEqual(f.expectedDefault)
  expect(actual.rows.find(row => row.value === '99')?.status).not.toBe('0/1列として生成')
})

const cappedValues = Array.from({ length: 101 }, (_, i) => String(i).padStart(3, '0'))
it.each<Fixture>([
  { id: 'capped-no-known-eligible', values: cappedValues, missingCodes: cappedValues.slice(0, 100),
    categoryOrder: cappedValues, schemaCategoryLimit: 100, expectedDefault: [], expectedDropFirst: [],
    allowPendingTransform: true },
  { id: 'capped-one-known-eligible', values: cappedValues, missingCodes: cappedValues.slice(0, 99),
    categoryOrder: cappedValues, schemaCategoryLimit: 100, expectedDefault: ['q_099'], expectedDropFirst: ['q_099'],
    allowPendingTransform: true },
  { id: 'unknown-cardinality', values: ['01', '02', '99'], missingCodes: ['01', '02'],
    categoryOrder: ['01', '02', '99'], schemaCategoryLimit: 2, omitSchemaUniqueCount: true,
    expectedDefault: [], expectedDropFirst: [], allowPendingTransform: true },
])('keeps incomplete preview provisional and execution available: $id', async f => {
  const ui = await openOneHot(f)
  expect(ui.readPreview().candidates).toEqual(f.expectedDefault)
  expect(within(ui.content).getByText('プレビューは一部の水準です。除外する水準と生成する列は実行時に確定します。')).toBeVisible()
  expect(within(ui.content).queryByText('生成できる有効なカテゴリ水準がありません。欠損コードの設定を確認してください。')).toBeNull()
  fireEvent.click(within(ui.content).getByTestId('one-hot-drop-first'))
  const afterDropFirst = ui.readPreview()
  expect(afterDropFirst.dropFirstChecked).toBe(true)
  expect(afterDropFirst.candidates).toEqual(f.expectedDropFirst)
  expect(afterDropFirst.singleLevelNotice).toBe(false)
  expect(afterDropFirst.rows.map(row => row.status)).toEqual(f.expectedDefault.map(() => '実行時に確定'))
  expect(within(ui.content).queryByText('除外 (Base)')).toBeNull()
  const apply = ui.view.getByRole('button', { name: '0/1二値列を生成' })
  expect(apply).toBeEnabled()
  fireEvent.click(apply)
  await waitFor(() => expect(ui.post).toHaveBeenCalledWith(`/datasets/int04-${f.id}/transform`, {
    type: 'nominal_to_binary', source_column: 'q', options: { drop_first: true, prefix: 'q' },
  }))
  expect(ui.post).toHaveBeenCalledTimes(2)
})

it('Drop First retains the sole eligible level and shows its single-level notice', async () => {
  const f: Fixture = { id: 'single-level-missing', values: ['01', '99'], missingCodes: ['99'],
    categoryOrder: ['01', '99'], expectedDefault: ['q_01'], expectedDropFirst: ['q_01'] }
  const ui = await openOneHot(f)
  expect(ui.readPreview().candidates).toEqual(f.expectedDefault)
  fireEvent.click(within(ui.content).getByTestId('one-hot-drop-first'))
  const afterDropFirst = ui.readPreview()
  expect(afterDropFirst.dropFirstChecked).toBe(true)
  expect(afterDropFirst.candidates).toEqual(f.expectedDropFirst)
  expect(afterDropFirst.rows.find(row => row.value === '01')?.status).toBe('0/1列として生成')
  expect(afterDropFirst.singleLevelNotice).toBe(true)
})

it('reason-only99 and undeclared07 remain raw observed candidates; unseen42 is not introduced', async () => {
  const f: Fixture = { id: 'reason-only-control', values: ['01', '02', '07', '99'], missingCodes: [],
    missingReasons: { '99': 'not_applicable' }, categoryOrder: ['02', '01', '99', '42'],
    expectedDefault: ['q_01', 'q_02', 'q_07', 'q_99'], expectedDropFirst: ['q_02', 'q_07', 'q_99'] }
  const ui = await openOneHot(f)
  const initial = ui.readPreview()
  fireEvent.click(within(ui.content).getByTestId('one-hot-drop-first'))
  const afterDropFirst = ui.readPreview()
  expect(initial.candidates).toEqual(f.expectedDefault)
  expect(afterDropFirst.candidates).toEqual(f.expectedDropFirst)
  expect(afterDropFirst.rows.find(row => row.value === '01')?.status).toBe('除外 (Base)')
  expect(afterDropFirst.rows.find(row => row.value === '07')?.status).toBe('0/1列として生成')
  expect(afterDropFirst.rows.find(row => row.value === '99')?.status).toBe('0/1列として生成')
  expect(ui.dispatch).not.toHaveBeenCalled()
})


it('explains zero eligible levels and never submits when all observed levels are explicit missing codes', async () => {
  const f: Fixture = { id: 'all-levels-missing', values: ['01', '99'], missingCodes: ['01', '99'],
    categoryOrder: ['01', '99'], expectedDefault: [], expectedDropFirst: [] }
  const ui = await openOneHot(f)
  expect(ui.readPreview().candidates).toEqual([])
  expect(ui.readPreview().rows).toEqual([])
  expect(within(ui.content).getByText('生成できる有効なカテゴリ水準がありません。欠損コードの設定を確認してください。')).toBeVisible()
  const apply = ui.view.getByRole('button', { name: '0/1二値列を生成' })
  expect(apply).toBeDisabled()
  fireEvent.click(within(ui.content).getByTestId('one-hot-drop-first'))
  expect(ui.readPreview().candidates).toEqual([])
  expect(ui.readPreview().singleLevelNotice).toBe(false)
  expect(apply).toBeDisabled()
  fireEvent.click(apply)
  expect(ui.post).toHaveBeenCalledTimes(1)
  expect(ui.post).toHaveBeenCalledWith('/summaries', {
    datasetId: 'int04-all-levels-missing', expectedDataRevision: 7, expectedSchemaRevision: 3,
  })
  expect(ui.dispatch).not.toHaveBeenCalled()
})
