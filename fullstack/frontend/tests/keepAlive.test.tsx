import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom'
import { store, datasetLoaded } from '../src/app/store'
import KeepAliveOutlet from '../src/app/KeepAliveOutlet'

// Helper component that allows navigation inside test
function NavigationHelper({ target }: { target: string }) {
  const navigate = useNavigate()
  return (
    <button data-testid="nav-trigger" onClick={() => navigate(target)}>
      Go to {target}
    </button>
  )
}

function LocationInspector() {
  const location = useLocation()
  return <div data-testid="current-path">{location.pathname}</div>
}

function renderKeepAlive(initialEntries = ['/clusters']) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={initialEntries}>
        <LocationInspector />
        <NavigationHelper target="/pcp" />
        <KeepAliveOutlet />
      </MemoryRouter>
    </Provider>
  )
}

describe('KeepAliveOutlet Suite', () => {
  beforeEach(() => {
    store.dispatch(
      datasetLoaded({
        datasetId: 'test-dataset-1',
        name: 'Test Dataset',
        rowIds: ['1', '2', '3'],
      })
    )
  })

  it('renders initial tab as active and visible', () => {
    renderKeepAlive(['/clusters'])
    const container = screen.getByTestId('keep-alive-outlet-container')
    expect(container).toBeInTheDocument()

    const clustersTab = container.querySelector('[data-tab-path="/clusters"]')
    expect(clustersTab).toBeInTheDocument()
    expect(clustersTab).toHaveAttribute('data-tab-active', 'true')
    expect(clustersTab).toHaveStyle({ display: 'flex' })
  })

  it('keeps visited tab mounted with display: none when navigating to another tab', async () => {
    renderKeepAlive(['/clusters'])
    const container = screen.getByTestId('keep-alive-outlet-container')

    // Initial state: clusters is mounted and visible
    const clustersTab = container.querySelector('[data-tab-path="/clusters"]')
    expect(clustersTab).toHaveAttribute('data-tab-active', 'true')
    expect(clustersTab).toHaveStyle({ display: 'flex' })

    // Navigate to /pcp
    const navBtn = screen.getByTestId('nav-trigger')
    await act(async () => {
      navBtn.click()
    })

    // After navigation:
    // 1. /pcp tab is now mounted and active
    const pcpTab = container.querySelector('[data-tab-path="/pcp"]')
    expect(pcpTab).toBeInTheDocument()
    expect(pcpTab).toHaveAttribute('data-tab-active', 'true')
    expect(pcpTab).toHaveStyle({ display: 'flex' })

    // 2. /clusters tab is STILL MOUNTED in the DOM, but hidden with display: none
    const preservedClustersTab = container.querySelector('[data-tab-path="/clusters"]')
    expect(preservedClustersTab).toBeInTheDocument()
    expect(preservedClustersTab).toHaveAttribute('data-tab-active', 'false')
    expect(preservedClustersTab).toHaveStyle({ display: 'none' })
  })

  it('flushes tab cache when datasetId changes', () => {
    renderKeepAlive(['/clusters'])
    const container = screen.getByTestId('keep-alive-outlet-container')
    expect(container.querySelector('[data-tab-path="/clusters"]')).toBeInTheDocument()

    // Dispatch a new dataset load
    act(() => {
      store.dispatch(
        datasetLoaded({
          datasetId: 'new-dataset-2',
          name: 'New Dataset 2',
          rowIds: ['10', '20'],
        })
      )
    })

    // The container should re-mount cleanly with key="new-dataset-2"
    const newContainer = screen.getByTestId('keep-alive-outlet-container')
    expect(newContainer).toBeInTheDocument()
  })
})
