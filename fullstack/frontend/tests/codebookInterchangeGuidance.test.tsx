import { configureStore } from '@reduxjs/toolkit'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { notification } from 'antd'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadCodebookExport, importCodebook, type CodebookResponse } from '../src/api/client'
import { datasetLoaded, selectionReducer } from '../src/app/store'
import CodebookCsvImportDialog from '../src/features/dataset/CodebookCsvImportDialog'
import CodebookEditorModal from '../src/features/dataset/CodebookEditorModal'
import { codebookReceived, codebookSlice, draftColumnUpdated, editorModalOpened } from '../src/features/dataset/codebookSlice'

// Exercise the real menu, import dialog, file picker and commit button. The
// unrelated column/MA/license editors do not participate in format guidance.
vi.mock('../src/features/dataset/CodebookVariableList', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookDetailForm', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookGridView', () => ({ default: () => null }))
vi.mock('../src/features/dataset/BulkLabelPasteModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/MultiResponseGroupDialog', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookLicenseEditor', () => ({ default: () => null }))
vi.mock('../src/api/client', async original => ({
  ...await original<typeof import('../src/api/client')>(),
  downloadCodebookExport: vi.fn().mockResolvedValue(undefined),
  importCodebook: vi.fn(),
}))

const restoreViewportProperties: Array<() => void> = []
// Native 175% browser zoom at CSS 320×432 and 375×432: both measured the
// same trigger; their wrapped menu heights were 302px and 280px respectively.
const observedExportTrigger = {
  x: 43.71428680419922, y: 178.42857360839844,
  width: 138.7232208251953, height: 24.000001907348633,
}

beforeEach(() => {
  vi.mocked(downloadCodebookExport).mockReset().mockResolvedValue(undefined)
  vi.mocked(importCodebook).mockReset().mockResolvedValue({
    status: 'success', datasetId: 'survey', updatedColumns: 1, schemaRevision: 2,
  })
  vi.spyOn(notification, 'success').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  restoreViewportProperties.splice(0).forEach(restore => restore())
  vi.restoreAllMocks()
})

function createStore() {
  const local = configureStore({
    reducer: { selection: selectionReducer, codebook: codebookSlice.reducer },
    middleware: get => get({ serializableCheck: false }),
  })
  local.dispatch(datasetLoaded({ datasetId: 'survey', name: 'survey.csv', rowIds: ['r1'], dataRevision: 1 }))
  const snapshot: CodebookResponse = {
    datasetId: 'survey', schemaRevision: 1, multiResponseGroups: [],
    columns: [{ columnId: 'q', name: 'answer', label: '保存済み', scaleType: 'nominal', role: 'question',
      valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
      isReversed: false, multiResponseGroup: null, multiResponseOptionLabel: '' }],
  }
  local.dispatch(codebookReceived(snapshot))
  local.dispatch(editorModalOpened())
  return local
}

function mockExportGeometry(initialWidth: number, {
  height = 800, menuHeight = 200, triggerY = 100, menuWidth, scrollbarWidth = 15, triggerRect,
}: {
  height?: number; menuHeight?: number; triggerY?: number; menuWidth?: number; scrollbarWidth?: number
  triggerRect?: { x: number; y: number; width: number; height: number }
} = {}) {
  // jsdom has no layout. Supply viewport/element measurements while keeping
  // the real AntD/rc-trigger positioning, resize listener and popup styles.
  const viewport = { width: initialWidth, height, menuHeight }
  const trigger = triggerRect ?? { x: 43, y: triggerY, width: 104, height: 24 }
  const dimension = (property: string, get: () => number) => {
    const original = Object.getOwnPropertyDescriptor(document.documentElement, property)
    Object.defineProperty(document.documentElement, property, { configurable: true, get })
    restoreViewportProperties.push(() => {
      if (original) Object.defineProperty(document.documentElement, property, original)
      else Reflect.deleteProperty(document.documentElement, property)
    })
  }
  dimension('clientWidth', () => viewport.width - scrollbarWidth)
  dimension('clientHeight', () => viewport.height)
  dimension('scrollWidth', () => viewport.width + 40)
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const rectangle = (x: number, y: number, width: number, height: number) => ({
    x, y, width, height, left: x, right: x + width, top: y, bottom: y + height,
    toJSON: () => ({}),
  })
  const menuMaxHeight = (menu: HTMLElement | null) => {
    if (!menu) return Infinity
    const css = getComputedStyle(menu).maxHeight
    const calc = /^calc\(([\d.]+)vh - ([\d.]+)px\)$/.exec(css)
    if (calc) return viewport.height * Number(calc[1]) / 100 - Number(calc[2])
    if (css.endsWith('vh')) return viewport.height * parseFloat(css) / 100
    if (css.endsWith('px')) return parseFloat(css)
    return Infinity
  }
  const popupRectangle = (popup: HTMLElement) => {
    const width = menuWidth ?? Math.min(360, viewport.width - 32)
    const padding = parseFloat(popup.style.paddingBlock) || 0
    const height = Math.min(viewport.menuHeight, menuMaxHeight(popup.querySelector('[role="menu"]'))) + padding * 2
    const left = popup.style.left === 'auto'
      ? document.documentElement.clientWidth - width - (parseFloat(popup.style.right) || 0)
      : parseFloat(popup.style.left) || 0
    const top = popup.style.top === 'auto'
      ? viewport.height - height - (parseFloat(popup.style.bottom) || 0)
      : parseFloat(popup.style.top) || 0
    return rectangle(left, top, width, height)
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.tagName === 'BUTTON' && this.textContent?.includes('エクスポート')) {
      return rectangle(trigger.x, trigger.y, trigger.width, trigger.height)
    }
    if (this.classList.contains('ant-dropdown')) return popupRectangle(this)
    if (this.getAttribute('role') === 'menu') {
      const popup = this.closest('.ant-dropdown') as HTMLElement
      const bounds = popupRectangle(popup)
      const padding = parseFloat(popup.style.paddingBlock) || 0
      return rectangle(bounds.left, bounds.top + padding, bounds.width, bounds.height - padding * 2)
    }
    // rc-menu checks a nonempty item rect before focusing. This fixture does
    // not model text layout or browser scrolling; native acceptance covers it.
    if (this.getAttribute('role') === 'menuitem') return rectangle(0, 0, 100, 24)
    return originalRect.call(this)
  })
  return viewport
}

async function openExportMenu() {
  const trigger = screen.getByRole('button', { name: /エクスポート/ })
  await act(async () => { fireEvent.click(trigger) })
  const menu = await screen.findByRole('menu')
  const popup = menu.closest('.ant-dropdown') as HTMLElement
  // rc-trigger does not respond to resize until its opening motion finishes.
  await waitFor(() => {
    expect(popup).toBeVisible()
    expect(popup).not.toHaveClass('ant-dropdown-hidden')
    expect(popup.style.left === 'auto' ? popup.style.right : popup.style.left).toMatch(/^-?\d+(?:\.\d+)?px$/)
    expect(popup.className).not.toMatch(/ant-slide-up-(?:appear|enter)/)
  })
  return { trigger, menu, popup }
}

describe('Codebook interchange guidance at the action boundary', () => {
  it.each([
    ['fresh 375px', [375]],
    ['fresh 320px', [320]],
    ['fresh 768px', [768]],
    ['resize while open', [768, 375, 320, 768]],
  ] as const)('keeps the export popup inside the scrollbar-excluding viewport: %s', async (_name, widths) => {
    const viewport = mockExportGeometry(widths[0])
    render(<Provider store={createStore()}><CodebookEditorModal /></Provider>)
    const { popup } = await openExportMenu()
    for (const width of widths) {
      viewport.width = width
      fireEvent.resize(window)
      await waitFor(() => {
        const bounds = popup.getBoundingClientRect()
        expect(bounds.left).toBeGreaterThanOrEqual(0)
        expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth)
        expect(popup.style.left).not.toContain('vw')
      })
    }
  })

  it.each([
    ['observed 320×432 below trigger', 320, 302, 288.5714416503906, observedExportTrigger.y],
    ['observed 375×432 below trigger', 375, 280, 343.4285888671875, observedExportTrigger.y],
    ['320×432 above trigger', 320, 302, 288.5714416503906, 260],
    ['menu taller than viewport', 320, 600, 288.5714416503906, observedExportTrigger.y],
  ] as const)('keeps the export menu within the short viewport: %s', async (_name, width, menuHeight, menuWidth, triggerY) => {
    const height = 432
    mockExportGeometry(width, { height, menuHeight, menuWidth, scrollbarWidth: 0,
      triggerRect: { ...observedExportTrigger, y: triggerY } })
    render(<Provider store={createStore()}><CodebookEditorModal /></Provider>)
    const { menu, popup } = await openExportMenu()
    await waitFor(() => {
      for (const element of [popup, menu]) {
        const bounds = element.getBoundingClientRect()
        expect(bounds.top).toBeGreaterThanOrEqual(0)
        expect(bounds.bottom).toBeLessThanOrEqual(height)
      }
    })
    if (menuHeight > height) {
      expect(menu.getBoundingClientRect().height).toBeLessThan(height)
      expect(menu).toHaveStyle({ overflowY: 'auto' })
    } else {
      expect(menu.getBoundingClientRect().height).toBe(menuHeight)
    }
  })

  it.each([['below', 100], ['above', 760]] as const)('preserves the normal 4px visible gap %s the trigger', async (placement, triggerY) => {
    mockExportGeometry(1180, { triggerY })
    render(<Provider store={createStore()}><CodebookEditorModal /></Provider>)
    const { trigger, menu } = await openExportMenu()
    await waitFor(() => {
      const triggerBounds = trigger.getBoundingClientRect()
      const menuBounds = menu.getBoundingClientRect()
      expect(placement === 'below' ? menuBounds.top - triggerBounds.bottom : triggerBounds.top - menuBounds.bottom).toBe(4)
    })
  })

  it('repositions and constrains the open menu when the viewport becomes shorter', async () => {
    const viewport = mockExportGeometry(320, { menuHeight: 302, triggerRect: observedExportTrigger })
    render(<Provider store={createStore()}><CodebookEditorModal /></Provider>)
    const { menu, popup } = await openExportMenu()
    for (const height of [432, 240, 800]) {
      viewport.height = height
      fireEvent.resize(window)
      await waitFor(() => {
        const bounds = popup.getBoundingClientRect()
        expect(bounds.top).toBeGreaterThanOrEqual(0)
        expect(bounds.bottom).toBeLessThanOrEqual(height)
        expect(menu.getBoundingClientRect().height).toBe(Math.min(302, height - 32))
      })
    }
  })

  it('keeps Tab, arrow navigation, trigger dismissal and Enter export working in the constrained menu', async () => {
    mockExportGeometry(320, { height: 432, menuHeight: 600, triggerRect: observedExportTrigger })
    const local = createStore()
    local.dispatch(draftColumnUpdated({ columnId: 'q', patch: { label: '未保存の編集' } }))
    render(<Provider store={local}><CodebookEditorModal /></Provider>)
    const { trigger, menu, popup } = await openExportMenu()
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Tab', keyCode: 9, which: 9 })
    const csv = within(menu).getByRole('menuitem', { name: /CSV形式でエクスポート/ })
    const json = within(menu).getByRole('menuitem', { name: /JSON形式でエクスポート/ })
    await waitFor(() => expect(csv).toHaveFocus())
    fireEvent.keyDown(csv, { key: 'ArrowDown', keyCode: 40, which: 40 })
    await waitFor(() => expect(json).toHaveFocus())
    expect(downloadCodebookExport).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    await waitFor(() => expect(popup).toHaveClass('ant-dropdown-hidden'))
    expect(local.getState().codebook.isEditorOpen).toBe(true)
    expect(downloadCodebookExport).not.toHaveBeenCalled()

    const reopened = await openExportMenu()
    fireEvent.keyDown(trigger, { key: 'Tab', keyCode: 9, which: 9 })
    const reopenedJson = within(reopened.menu).getByRole('menuitem', { name: /JSON形式でエクスポート/ })
    // rc-menu may restore the previously active item on reopen.
    await waitFor(() => expect(within(reopened.menu).getAllByRole('menuitem')).toContain(document.activeElement))
    fireEvent.keyDown(document.activeElement!, { key: 'End', keyCode: 35, which: 35 })
    await waitFor(() => expect(reopenedJson).toHaveFocus())
    fireEvent.keyDown(reopenedJson, { key: 'Enter', keyCode: 13, which: 13 })
    expect(downloadCodebookExport).toHaveBeenCalledOnce()
    expect(downloadCodebookExport).toHaveBeenCalledWith('survey', 'json')
    expect(local.getState().codebook.hasChanges).toBe(true)
    expect(local.getState().codebook.draftColumns[0].label).toBe('未保存の編集')
    expect(importCodebook).not.toHaveBeenCalled()
  })

  it.each(['csv', 'json'] as const)('explains the saved format before exporting %s and preserves a dirty draft', async format => {
    const local = createStore()
    local.dispatch(draftColumnUpdated({ columnId: 'q', patch: { label: '未保存の編集' } }))
    render(<Provider store={local}><CodebookEditorModal /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /エクスポート/ }))
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveStyle({ width: '360px', maxWidth: 'calc(100vw - 32px)' })
    const savedNotice = within(menu).getByText('保存済みの設定を出力（未保存の編集は含みません）')
    await waitFor(() => expect(savedNotice).toBeVisible())
    expect(savedNotice).toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere' })
    const csv = within(menu).getByRole('menuitem', { name: /CSV形式でエクスポート/ })
    const json = within(menu).getByRole('menuitem', { name: /JSON形式でエクスポート/ })
    expect(csv).toHaveTextContent('列定義・ライセンスのみ（MA親設問・重み設定・調査設計は含みません）')
    expect(csv).toHaveTextContent('数式としての解釈を抑える接頭辞により文字列が変わる場合があります。正確な文字列の引継ぎにはJSONを選んでください。')
    expect(json).toHaveTextContent('MA親設問・重み設定・調査設計を含む対応メタデータ')
    expect(json).toHaveTextContent('文字列を変えずに出力')
    for (const item of [csv, json]) {
      expect(item.querySelector('div[style]')).toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere' })
    }
    fireEvent.click(format === 'csv' ? csv : json)
    expect(downloadCodebookExport).toHaveBeenCalledOnce()
    expect(downloadCodebookExport).toHaveBeenCalledWith('survey', format)
    expect(local.getState().codebook.hasChanges).toBe(true)
    expect(local.getState().codebook.draftColumns[0].label).toBe('未保存の編集')
    expect(importCodebook).not.toHaveBeenCalled()
  })

  it('explains immediate persistence while choosing and cancelling a file performs no import', async () => {
    const close = vi.fn(), success = vi.fn()
    render(<CodebookCsvImportDialog open datasetId="survey" onClose={close} onSuccess={success} />)
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText(/MA親設問・重み設定・調査設計も引き継ぐにはJSON/)).toBeVisible())
    expect(within(dialog).getByText(/「インポート実行」で検証後すぐに保存/)).toHaveTextContent(
      '外側の「保存」は不要で、実行後の「キャンセル」やUndoでは取り消せません。ファイルを選ぶだけでは検証・保存されません。')
    expect(within(dialog).getByText(/未保存の編集は別に保持/)).toHaveTextContent('後から保存すると取込内容を上書きする場合')
    const file = new File(['{"columns":[{"name":"answer","label":"更新"}]}'], 'dictionary.json')
    fireEvent.change(dialog.querySelector('input[type=file]')!, { target: { files: [file] } })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'インポート実行' })).toBeEnabled())
    expect(importCodebook).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(close).toHaveBeenCalledOnce()
    expect(importCodebook).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })

  it('imports the chosen file at the documented button without another Save step', async () => {
    const close = vi.fn(), success = vi.fn()
    render(<CodebookCsvImportDialog open datasetId="survey" onClose={close} onSuccess={success} />)
    const file = new File(['name,label\nanswer,更新'], 'dictionary.csv')
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } })
    const submit = screen.getByRole('button', { name: 'インポート実行' })
    await waitFor(() => expect(submit).toBeEnabled())
    expect(importCodebook).not.toHaveBeenCalled()
    fireEvent.click(submit)
    await waitFor(() => expect(success).toHaveBeenCalledOnce())
    expect(success).toHaveBeenCalledWith('survey')
    expect(importCodebook).toHaveBeenCalledOnce()
    expect(importCodebook).toHaveBeenCalledWith('survey', file)
    expect(close).toHaveBeenCalledOnce()
  })
})
