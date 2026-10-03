import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); delete (window as any).__DAVIS_PCP_STATIC__ })

it('uses the offline worker ArrayBuffer for the separately licensed sample package', async () => {
  ;(window as any).__DAVIS_PCP_STATIC__ = true
  const { pyodideClient } = await import('../src/engine/pyodideClient')
  const data = new Uint8Array([80, 75, 3, 4]).buffer
  const request = vi.spyOn(pyodideClient, 'request').mockResolvedValue(data)
  const fetch = vi.spyOn(globalThis, 'fetch')
  const { api } = await import('../src/api/client')
  const blob = await api.downloadBlob('/datasets/samples/wine/package')
  expect(blob.type).toBe('application/zip'); expect(blob.size).toBe(4)
  expect(request).toHaveBeenCalledWith('/datasets/samples/wine/package', undefined)
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['json', 'csv'] as const)('exports licensed codebooks as %s through the offline worker', async format => {
  ;(window as any).__DAVIS_PCP_STATIC__ = true
  const { pyodideClient } = await import('../src/engine/pyodideClient')
  const payload = format === 'json' ? { licenseText: '出典\n©', columns: [] } : 'recordType,licenseText\ndataset,"出典\n©"\n'
  const request = vi.spyOn(pyodideClient, 'request').mockResolvedValue(payload)
  const fetch = vi.spyOn(globalThis, 'fetch')
  const create = vi.fn(() => 'blob:license')
  Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const { downloadCodebookExport } = await import('../src/api/client')
  await downloadCodebookExport('d', format)
  expect(request).toHaveBeenCalledWith(`/datasets/d/codebook/export?format=${format}`)
  expect(fetch).not.toHaveBeenCalled(); expect(click).toHaveBeenCalledOnce()
  expect(create.mock.calls[0][0].size).toBeGreaterThan(0)
})
