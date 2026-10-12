import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useImputationMutationLock } from '../src/features/dataset/useImputationMutationLock'

afterEach(cleanup)

it('preserves independent owners and detaches unmounted subscribers without allowing an old release to clear a new owner', () => {
  const renderA = vi.fn()
  const first = renderHook(() => { renderA(); return useImputationMutationLock('owner-a') })
  const other = renderHook(() => useImputationMutationLock('owner-b'))
  let releaseFirst: (() => void) | null = null, releaseOther: (() => void) | null = null
  let releaseNext: (() => void) | null = null
  try {
    act(() => {
      releaseFirst = first.result.current.acquire()
      expect(first.result.current.acquire()).toBeNull()
    })
    expect(releaseFirst).not.toBeNull()
    expect(first.result.current.pending).toBe(true)
    expect(other.result.current.pending).toBe(false)
    act(() => { releaseOther = other.result.current.acquire() })
    expect(releaseOther).not.toBeNull()
    first.unmount()
    const detachedRenders = renderA.mock.calls.length
    const reopened = renderHook(() => useImputationMutationLock('owner-a'))
    expect(reopened.result.current.pending).toBe(true)
    expect(reopened.result.current.acquire()).toBeNull()
    act(() => { releaseFirst?.() })
    expect(reopened.result.current.pending).toBe(false)
    act(() => { releaseNext = reopened.result.current.acquire() })
    expect(releaseNext).not.toBeNull()
    act(() => { releaseFirst?.(); releaseFirst?.() })
    expect(reopened.result.current.pending).toBe(true)
    expect(other.result.current.pending).toBe(true)
    expect(reopened.result.current.acquire()).toBeNull()
    expect(renderA).toHaveBeenCalledTimes(detachedRenders)
    act(() => { releaseOther?.() })
    expect(other.result.current.pending).toBe(false)
    expect(reopened.result.current.pending).toBe(true)
  } finally {
    act(() => { releaseFirst?.(); releaseOther?.(); releaseNext?.() })
  }
})
