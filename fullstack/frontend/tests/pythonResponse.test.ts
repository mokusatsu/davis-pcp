import { describe, expect, it, vi } from 'vitest'
import { consumePythonResponse } from '../src/engine/pythonResponse'

function fixture(failure?: string) {
  const headers = { destroy: vi.fn(), toJs: vi.fn(() => { if (failure === 'headers conversion') throw Error(failure); return { 'content-type': 'application/json' } }) }
  const content = { destroy: vi.fn(), toJs: vi.fn(() => { if (failure === 'content conversion') throw Error(failure); return new Uint8Array([1, 2, 3]) }) }
  const acquired: any[] = []
  const result = { destroy: vi.fn(), get: vi.fn((key: string) => {
    if (failure === key) throw Error(key)
    const values: Record<string, unknown> = { status_code: 200, headers, is_binary: false, content, text: '{"value":1}' }
    const value = values[key]
    if (value === headers || value === content) acquired.push(value)
    return value
  }) }
  return { result, headers, content, acquired }
}

describe('Python response proxy cleanup', () => {
  it.each(['status_code', 'headers', 'headers conversion', 'is_binary', 'content', 'content conversion', 'text'])('destroys all and only acquired proxies exactly once when %s fails', failure => {
    const { result, headers, content, acquired } = fixture(failure)
    expect(() => consumePythonResponse(result)).toThrow(failure)
    expect(result.destroy).toHaveBeenCalledTimes(1)
    for (const proxy of [headers, content]) expect(proxy.destroy).toHaveBeenCalledTimes(acquired.includes(proxy) ? 1 : 0)
  })
  it('returns successful JSON and releases all owned proxies', () => {
    const { result, headers, content } = fixture()
    expect(consumePythonResponse(result)).toEqual({ statusCode: 200, resHeaders: { 'content-type': 'application/json' }, isBinary: false, rawBytes: new Uint8Array([1, 2, 3]), text: '{"value":1}' })
    for (const proxy of [result, headers, content]) expect(proxy.destroy).toHaveBeenCalledTimes(1)
  })
  it('keeps binary data available after proxy cleanup and supports the Arrow flag', () => {
    const { result, headers, content } = fixture()
    result.get.mockImplementation(key => ({ status_code: 200, headers, content, is_arrow: true, text: null })[key])
    const response = consumePythonResponse(result)
    expect(response.isBinary).toBe(true)
    expect(response.rawBytes.slice()).toEqual(new Uint8Array([1, 2, 3]))
    expect(response.text).toBeNull()
    for (const proxy of [result, headers, content]) expect(proxy.destroy).toHaveBeenCalledTimes(1)
  })
  it('continues cleaning up if one destroy throws, and deduplicates acquired proxy identities', () => {
    const { result, headers } = fixture()
    result.destroy.mockImplementation(() => { throw Error('destroy failed') })
    result.get.mockImplementation(key => ({ status_code: 200, headers, content: headers, is_binary: false, text: '{}' })[key])
    consumePythonResponse(result)
    expect(result.destroy).toHaveBeenCalledTimes(1)
    expect(headers.destroy).toHaveBeenCalledTimes(1)
  })
})
