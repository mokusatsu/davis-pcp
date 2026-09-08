import { afterEach, expect, it, vi } from 'vitest'
import { Float64, tableFromArrays, tableToIPC, vectorFromArray } from 'apache-arrow'
import { fetchArrowView } from '../src/api/client'

afterEach(() => vi.unstubAllGlobals())

it('preserves numeric nulls when decoding Arrow for category and selection consumers', async () => {
  const bytes = tableToIPC(tableFromArrays({ Q: vectorFromArray([1, null, 99], new Float64()) }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }))
  expect(await fetchArrowView('survey')).toEqual({ Q: [1, null, 99] })
})
