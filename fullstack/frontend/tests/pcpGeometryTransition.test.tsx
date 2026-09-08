import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { usePcpGeometry, type PcpAxis } from '../src/features/pcp/usePcpPipeline'
import { graphEngine } from '../src/engine/graphClient'

const data = vi.hoisted(() => ({ rowIds: ['r'], rowIndex: new Map([['r', 0]]), columns: { A: [1], B: [2] } }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => data }))
vi.mock('../src/engine/graphClient', () => ({ graphEngine: { pcpGeometry: vi.fn() } }))

describe('PCP geometry during axis changes', () => {
  it('withholds old coordinates until the new axis order is computed', async () => {
    const testStore = configureStore({ reducer: () => store.getState() })
    const wrapper = ({ children }: any) => <Provider store={testStore}>{children}</Provider>
    const a = { key: 'A', type: 'numeric', min: 0, max: 3 } as PcpAxis
    const b = { key: 'B', type: 'numeric', min: 0, max: 3 } as PcpAxis
    const rows = [0]
    const pending: Array<(v: any) => void> = []
    vi.mocked(graphEngine.pcpGeometry).mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    const { result, rerender } = renderHook(({ axes }) => usePcpGeometry({ width: 500, height: 300, orderedVisibleAxes: axes, activeRowIndexes: rows }), { wrapper, initialProps: { axes: [a, b] } })
    const geometry = { points: new Float64Array([10, 20, 30, 40]), axisPos: [10, 30], bounds: { left: 0, right: 500, top: 0, bottom: 300 } }
    await act(async () => pending[0](geometry))
    expect(result.current?.nAxes).toBe(2)
    rerender({ axes: [b, a] })
    expect(result.current).toBeNull()
    await act(async () => pending[1](geometry))
    await waitFor(() => expect(result.current?.nAxes).toBe(2))
    rerender({ axes: [a] })
    expect(result.current).toBeNull()
    await act(async () => pending[2]({ ...geometry, axisPos: [10], points: new Float64Array([10, 20]) }))
    await waitFor(() => expect(result.current?.nAxes).toBe(1))
  })
})
