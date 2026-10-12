import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useOneHotMutationLock } from '../src/features/dataset/useOneHotMutationLock'

afterEach(cleanup)

it('keeps different sources independent and prevents a late repeated release from clearing a newer owner', () => {
  const first = renderHook(() => useOneHotMutationLock('source-independence', 'q'))
  const other = renderHook(() => useOneHotMutationLock('source-independence', 'other'))
  let releaseFirst!: () => void, releaseOther!: () => void, releaseNext: (() => void) | null = null
  try {
    act(() => { releaseFirst = first.result.current.acquire()! })
    expect(first.result.current.pending).toBe(true)
    expect(other.result.current.pending).toBe(false)
    act(() => { releaseOther = other.result.current.acquire()! })
    expect(releaseOther).not.toBeNull()
    first.unmount()
    const reopened = renderHook(() => useOneHotMutationLock('source-independence', 'q'))
    expect(reopened.result.current.pending).toBe(true)
    expect(reopened.result.current.acquire()).toBeNull()
    act(() => { releaseFirst() })
    act(() => { releaseNext = reopened.result.current.acquire() })
    expect(releaseNext).not.toBeNull()
    act(() => { releaseFirst() })
    expect(reopened.result.current.pending).toBe(true)
    expect(other.result.current.pending).toBe(true)
  } finally {
    act(() => { releaseFirst?.(); releaseOther?.(); releaseNext?.() })
  }
})
