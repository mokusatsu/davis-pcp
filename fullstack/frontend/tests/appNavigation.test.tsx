import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, BrowserRouter, HashRouter, useLocation, useNavigate } from 'react-router-dom'
import { FeatureNavigation, NAV_GROUPS, NAV_ITEMS } from '../src/app/AppShell'

const src = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

const mockState = vi.hoisted(() => ({ wide: true, realBreakpoint: false }))

vi.mock('antd', async importOriginal => {
  const actual = await importOriginal<typeof import('antd')>()
  return {
    ...actual,
    Menu: (props: React.ComponentProps<typeof actual.Menu>) => <actual.Menu {...props} disabledOverflow />,
    Grid: Object.assign(() => null, { useBreakpoint: () => {
      const screens = actual.Grid.useBreakpoint()
      return mockState.realBreakpoint ? screens : { lg: mockState.wide }
    } }),
  }
})

function Harness({ onKeyboardNavigate = vi.fn() }: { onKeyboardNavigate?: () => void } = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  return <>
    <FeatureNavigation datasetId="test" expanded={false} onKeyboardNavigate={onKeyboardNavigate} />
    <output data-testid="path">{location.pathname}</output>
    <output data-testid="key">{location.key}</output>
    <button onClick={() => navigate('/ranking')}>外部Ranking</button>
    <button onClick={() => navigate(-1)}>戻る</button>
    <button onClick={() => navigate(1)}>進む</button>
  </>
}

async function choose(group: typeof NAV_GROUPS[number], key: string) {
  fireEvent.click(screen.getByText(group.label))
  const item = group.children.find(item => item.key === key)!
  fireEvent.click(await screen.findByText(item.label))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockState.wide = true
  mockState.realBreakpoint = false
  window.history.replaceState(null, '', '/')
})

describe('Feature 036 navigation', () => {
  it('matches all main and KeepAlive routes exactly once in six groups', () => {
    const main = src('../src/main.tsx')
    const keepAlive = src('../src/app/KeepAliveOutlet.tsx')
    const routes = [...main.matchAll(/path: '([^']+)'/g)].map(match => '/' + match[1]).filter(path => path !== '//')
    const cached = [...keepAlive.matchAll(/^  '(\/[^']+)':/gm)].map(match => match[1])
    const keys = NAV_ITEMS.map(item => item.key)
    expect(NAV_GROUPS).toHaveLength(6)
    expect(keys).toHaveLength(31)
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(routes.sort())
    expect([...keys].sort()).toEqual(cached.sort())
    expect(NAV_GROUPS.map(group => group.children.length)).toEqual([4, 7, 4, 4, 7, 5])
  })

  it.each(['/', '/pcp/', '/models', '/models/ca', '/models/factor-analysis/', '/unknown'])('tracks exact normalized location %s', path => {
    render(<MemoryRouter initialEntries={[path]}><Harness /></MemoryRouter>)
    const normalized = path.replace(/\/$/, '') || '/pcp'
    const group = NAV_GROUPS.find(group => group.children.some(item => item.key === normalized))
    const item = NAV_ITEMS.find(item => item.key === normalized)
    expect(screen.getByTestId('navigation-current').textContent).toBe(group && item ? `${group.label} › ${item.label}` : '未登録の画面')
  })

  it('opens groups without navigation and reaches every feature', async () => {
    render(<MemoryRouter initialEntries={['/pcp']}><Harness /></MemoryRouter>)
    for (const group of NAV_GROUPS) {
      for (const item of group.children) {
        const before = screen.getByTestId('key').textContent
        fireEvent.click(screen.getByText(group.label))
        expect(screen.getByTestId('key').textContent).toBe(before)
        fireEvent.click(await screen.findByText(item.label))
        expect(screen.getByTestId('path').textContent).toBe(item.key)
        expect(screen.getByTestId('navigation-current').textContent).toBe(`${group.label} › ${item.label}`)
      }
    }
  })

  it('does not create history on reselection and tracks external navigation', async () => {
    render(<MemoryRouter initialEntries={['/table', '/pcp']} initialIndex={1}><Harness /></MemoryRouter>)
    const before = screen.getByTestId('key').textContent
    await choose(NAV_GROUPS[1], '/pcp')
    expect(screen.getByTestId('key').textContent).toBe(before)
    fireEvent.click(screen.getByText('戻る'))
    expect(screen.getByTestId('path').textContent).toBe('/table')
    fireEvent.click(screen.getByText('進む'))
    expect(screen.getByTestId('path').textContent).toBe('/pcp')
    fireEvent.click(screen.getByText('外部Ranking'))
    expect(screen.getByTestId('navigation-current').textContent).toContain('パターン探索 › 変数ランキング')
  })

  it.each([['BrowserRouter', BrowserRouter, '/models/ca'], ['HashRouter', HashRouter, '/#/models/ca']] as const)('%s follows direct URLs and history', async (_, Router, initial) => {
    window.history.replaceState(null, '', initial)
    render(<Router><Harness /></Router>)
    expect(screen.getByTestId('navigation-current').textContent).toContain('対応分析（CA）')
    fireEvent.click(screen.getByText('外部Ranking'))
    expect(screen.getByTestId('path').textContent).toBe('/ranking')
    fireEvent.click(screen.getByText('戻る'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/models/ca'))
    fireEvent.click(screen.getByText('進む'))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/ranking'))
  })

  it.each([992, 1023, 1024, 1280])('uses the real Grid breakpoint at %ipx', async width => {
    mockState.realBreakpoint = true
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
      matches: query.includes('min-width')
        ? width >= Number(query.match(/\d+/)?.[0])
        : width <= Number(query.match(/\d+/)?.[0]),
      media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }))
    render(<MemoryRouter><Harness /></MemoryRouter>)
    await waitFor(() => expect(Boolean(screen.queryByTestId('feature-list-button'))).toBe(width < 1024))
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)')
  })

  it('returns focus to the list button on Escape', () => {
    mockState.wide = false
    render(<MemoryRouter><Harness /></MemoryRouter>)
    const button = screen.getByTestId('feature-list-button')
    fireEvent.click(button)
    const item = screen.getByText('平行座標（PCP）')
    item.closest<HTMLElement>('[role="menuitem"]')!.focus()
    fireEvent.keyDown(item, { key: 'Escape', keyCode: 27 })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()
  })

  it('closes the open submenu on Escape in horizontal mode', async () => {
    render(<MemoryRouter initialEntries={['/pcp']}><Harness /></MemoryRouter>)
    const group = screen.getByText('データ・概要').closest<HTMLElement>('[role="menuitem"]')!
    fireEvent.click(group)
    await screen.findByText('データ表（Table）')
    expect(group).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(group, { key: 'Escape', keyCode: 27 })
    await waitFor(() => expect(group).toHaveAttribute('aria-expanded', 'false'))
  })

  it.each([true, false])('keyboard selection and reselection close the menu without extra history (wide=%s)', async wide => {
    mockState.wide = wide
    const onKeyboardNavigate = vi.fn()
    render(<MemoryRouter initialEntries={['/pcp']}><Harness onKeyboardNavigate={onKeyboardNavigate} /></MemoryRouter>)

    const openData = async () => {
      if (!wide) fireEvent.click(screen.getByTestId('feature-list-button'))
      const group = screen.getByRole('menuitem', { name: 'データ・概要' })
      if (group.getAttribute('aria-expanded') !== 'true') fireEvent.click(group)
      const leaf = await screen.findByRole('menuitem', { name: 'データ表（Table）' })
      leaf.focus()
      return leaf
    }

    fireEvent.keyDown(await openData(), { key: 'Enter', code: 'Enter', keyCode: 13 })
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/table'))
    expect(onKeyboardNavigate).toHaveBeenCalledTimes(1)
    const historyKey = screen.getByTestId('key').textContent

    fireEvent.keyDown(await openData(), { key: 'Enter', code: 'Enter', keyCode: 13 })
    await waitFor(() => expect(onKeyboardNavigate).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('path').textContent).toBe('/table')
    expect(screen.getByTestId('key').textContent).toBe(historyKey)
    if (wide) {
      await waitFor(() => expect(screen.getByRole('menuitem', { name: 'データ・概要' })).toHaveAttribute('aria-expanded', 'false'))
    } else {
      expect(screen.getByTestId('feature-list-button')).toHaveAttribute('aria-expanded', 'false')
    }

    fireEvent.click(await openData())
    expect(onKeyboardNavigate).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('key').textContent).toBe(historyKey)
  })

  it('compact mode opens the current group and closes on selection', () => {
    mockState.wide = false
    try {
      render(<MemoryRouter initialEntries={['/table']}><Harness /></MemoryRouter>)
      const button = screen.getByTestId('feature-list-button')
      expect(button).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
      const groupLabel = NAV_GROUPS[0].label
      expect(screen.getByRole('menuitem', { name: groupLabel })).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(screen.getByText(NAV_GROUPS[0].children[1].label))
      expect(screen.getByTestId('path').textContent).toBe(NAV_GROUPS[0].children[1].key)
      expect(screen.getByTestId('feature-list-button')).toHaveAttribute('aria-expanded', 'false')
    } finally {
      mockState.wide = true
    }
  })
})
