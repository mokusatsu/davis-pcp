import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodebookColumn, CodebookResponse } from '../src/api/client'
import { activeEntitiesSet, datasetLoaded, store, variablesInitialized, weightColumnCleared, weightColumnSet } from '../src/app/store'
import { codebookReceived, codebookReset } from '../src/features/dataset/codebookSlice'
import DistributionPage from '../src/features/distribution/DistributionPage'
import GlobalHeaderControlBar from '../src/features/selection/GlobalHeaderControlBar'
import fixture from './fixtures/distributionWeightModeApi.json'

// Keep the header, picker, Redux, Distribution, QuestionCard, and api.post real.
// Only fetch is mocked. Captured native responses provide the numerical oracle;
// these jsdom checks establish rendered content, not browser paint or backend E2E.
const book = fixture.codebook as CodebookResponse
const weight = book.columns.find(column => column.role === 'weight')!
const question = book.columns.find(column => column.name === fixture.request.columns[0])!
type RequestBody = Record<string, unknown>
type CapturedRequest = { path: string; method: string; body: RequestBody }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function installTransport() {
  const requests: CapturedRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody
    requests.push({ path, method: init?.method ?? 'GET', body })
    let response: unknown
    if (path === '/api/v1/summaries') {
      // Mirror the accepted native contract, never the test phase or call count.
      // In particular, clearing without explicit none still returns saved weights.
      const mode = body.weightMode ?? (body.weightColumn ? 'column' : 'dataset')
      if (mode === 'none') response = fixture.responses.unweighted
      else {
        const savedWeight = book.columns.find(column => column.columnId === book.weightConfig?.weightColumnId)?.name
        const selectedWeight = mode === 'column' ? body.weightColumn : body.weightColumn ?? savedWeight
        if (!['column', 'dataset'].includes(String(mode)) || selectedWeight !== weight.name) {
          throw new Error(`Unexpected summary weight: ${JSON.stringify(body)}`)
        }
        response = fixture.responses.weighted
      }
    } else if (path === '/api/v1/summaries/multi-response') response = { groups: [] }
    else if (path.endsWith('/color-domains')) response = { domains: [] }
    else throw new Error(`Unexpected request: ${path}`)
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return requests
}

function installDataset(codebook = book, rowIds = fixture.request.rowIds) {
  store.dispatch(codebookReset())
  store.dispatch(datasetLoaded({ datasetId: codebook.datasetId, name: 'Distribution weight regression', rowIds,
    dataRevision: fixture.request.expectedDataRevision }))
  store.dispatch(variablesInitialized({ datasetId: codebook.datasetId, variables: codebook.columns.map(column => column.name),
    meta: Object.fromEntries(codebook.columns.map(column => [column.name, {
      columnId: column.columnId, name: column.name,
      semanticType: column.role === 'weight' ? 'numeric' : 'categorical',
      physicalType: column.role === 'weight' ? 'Float64' : 'String', missingCount: 0, isTargetCandidate: false,
    }])) }))
  store.dispatch(codebookReceived(codebook))
  store.dispatch(weightColumnSet({ datasetId: codebook.datasetId, columnId: weight.columnId }))
}

function mountCensus() {
  installDataset()
  store.dispatch(activeEntitiesSet([{ kind: 'column', columnId: question.columnId }]))
  render(<Provider store={store}><MemoryRouter initialEntries={['/distribution']}>
    <GlobalHeaderControlBar /><DistributionPage />
  </MemoryRouter></Provider>)
}

async function chooseWeight(selected: boolean) {
  fireEvent.click(within(screen.getByTestId('global-weight-controls')).getByRole('button', { name: '変数を選択', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '変数を選択', exact: true })
  if (selected) fireEvent.click(within(dialog).getByRole('radio', { name: /^MARSUPWT(?:\s|$)/ }))
  else fireEvent.click(within(dialog).getByRole('button', { name: '選択解除', exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: /^決\s*定$/ }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '変数を選択', exact: true })).not.toBeInTheDocument())
  expect(store.getState().globalVariables.weightColumnId).toBe(selected ? weight.columnId : null)
  expect(screen.getByTestId('global-weight-select')).toHaveTextContent(selected ? weight.name : '未選択')
  expect(store.getState().codebook.weightConfig).toEqual(book.weightConfig)
}

async function summaryRequest(requests: CapturedRequest[], count: number, path = '/api/v1/summaries') {
  await waitFor(() => expect(requests.filter(request => request.path === path)).toHaveLength(count))
  const request = requests.filter(request => request.path === path)[count - 1]
  expect(request.method).toBe('POST')
  return request.body
}

describe('Distribution explicit weight mode', () => {
  it('serializes column/none/column through the real header without changing scope, revisions, or selection', async () => {
    const requests = installTransport()
    mountCensus()
    const expectedWeighted = { ...fixture.request, weightColumn: weight.name, weightMode: 'column' }
    // Soft payload checks allow the unchanged baseline to complete the whole cycle.
    expect.soft(await summaryRequest(requests, 1)).toEqual(expectedWeighted)
    await screen.findByTestId(`question-card-${question.name}`)
    await chooseWeight(false)
    expect.soft(await summaryRequest(requests, 2)).toEqual({ ...fixture.request, weightMode: 'none' })
    await chooseWeight(true)
    expect.soft(await summaryRequest(requests, 3)).toEqual(expectedWeighted)
    expect(store.getState().selection.selectedRowIds).toEqual(fixture.request.selectedRowIds)
    expect(store.getState().selection.activeRowIds).toEqual(fixture.request.rowIds)
  })

  it('removes weighted card content on clear and restores it, retaining six valid responses and semantic missing exclusions', async () => {
    const requests = installTransport()
    mountCensus()
    const card = within(await screen.findByTestId(`question-card-${question.name}`))
    const assertRawCounts = () => {
      expect(card.getByTestId('denominators-bar')).toHaveTextContent('全: 8')
      expect(card.getByTestId('denominators-bar')).toHaveTextContent('有効: 6')
      expect(card.getByTestId('denominators-bar')).toHaveTextContent('無回答: 2')
      expect(card.getByTestId(`category-${question.name}-?`)).toHaveTextContent('対象外 (2)')
      expect(card.getByTestId(`category-${question.name}-Not in universe`)).toHaveTextContent('対象外 (0)')
      expect(card.getByRole('button', { name: 'Abroad to MSAの回答者を選択' })).toBeDisabled()
    }
    const assertWeighted = () => {
      expect(card.getByText('ウェイト適用中')).toBeInTheDocument()
      // This note is scope mass. Category-valid mass is 13539.87, not 18155.39.
      expect(card.getByTestId('weight-note')).toHaveTextContent('非加重n=8 / 加重Σw=18,155.39')
      expect(fixture.responses.weighted.columns.migration_msa.weighted.weightedN).toBe(13539.87)
      expect(card.getByTestId(`category-${question.name}-MSA to MSA`)).toHaveTextContent('33.3% (2) / 加重40.8% (5,520.57)')
      expect(card.getByTestId(`category-${question.name}-MSA to nonMSA`)).toHaveTextContent('16.7% (1) / 加重24.4% (3,297.07)')
      expect(card.getByTestId(`category-${question.name}-NonMSA to nonMSA`)).toHaveTextContent('16.7% (1) / 加重3.4% (459.87)')
      expect(card.getByTestId(`category-${question.name}-Nonmover`)).toHaveTextContent('33.3% (2) / 加重31.5% (4,262.36)')
      assertRawCounts()
    }
    assertWeighted()
    await chooseWeight(false)
    await summaryRequest(requests, 2)
    await waitFor(() => expect(card.queryByText('ウェイト適用中')).not.toBeInTheDocument())
    expect(card.queryByTestId('weight-note')).not.toBeInTheDocument()
    expect(card.queryByText(/加重/)).not.toBeInTheDocument()
    expect(card.getByTestId(`category-${question.name}-MSA to MSA`)).toHaveTextContent('33.3% (2)')
    assertRawCounts()
    await chooseWeight(true)
    await summaryRequest(requests, 3)
    await waitFor(assertWeighted)
  })

  it('keeps the MA payload column/omitted/column contract without adding weightMode', async () => {
    const requests = installTransport()
    const option: CodebookColumn = { columnId: 'option-a', name: 'OptionA', label: 'Option A', scaleType: 'nominal',
      role: 'question', valueLabels: { '0': 'No', '1': 'Yes' }, categoryOrder: ['0', '1'], missingCodes: [],
      missingReasons: {}, isReversed: false, multiResponseGroup: 'services' }
    const maBook: CodebookResponse = { datasetId: 'ma-weight-contract', schemaRevision: 1, columns: [weight, option],
      multiResponseGroups: [{ groupId: 'services', label: 'Services', selectedCodes: ['1'], unselectedCodes: ['0'],
        allUnselectedMeaning: 'valid', maxSelections: null, optionOrder: [option.columnId] }], weightConfig: book.weightConfig }
    installDataset(maBook, ['r1', 'r2'])
    store.dispatch(activeEntitiesSet([{ kind: 'ma', groupId: 'services' }]))
    render(<Provider store={store}><MemoryRouter><DistributionPage /></MemoryRouter></Provider>)
    const expected = { datasetId: maBook.datasetId, rowIds: ['r1', 'r2'], expectedDataRevision: 1,
      expectedSchemaRevision: 1, groupIds: ['services'], selectedRowIds: [] }
    const path = '/api/v1/summaries/multi-response'
    expect(await summaryRequest(requests, 1, path)).toEqual({ ...expected, weightColumn: weight.name })
    act(() => { store.dispatch(weightColumnCleared()) })
    expect(await summaryRequest(requests, 2, path)).toEqual(expected)
    act(() => { store.dispatch(weightColumnSet({ datasetId: maBook.datasetId, columnId: weight.columnId })) })
    expect(await summaryRequest(requests, 3, path)).toEqual({ ...expected, weightColumn: weight.name })
    expect(requests.some(request => request.path === '/api/v1/summaries')).toBe(false)
  })
})
