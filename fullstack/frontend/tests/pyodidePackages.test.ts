import { describe, expect, it, vi } from 'vitest'
import { loadRequiredPackages } from '../src/engine/pyodidePackages'

// Matches the dependency names and marker spelling in the pinned 0.27.7 lock.
const lock = {
  pydantic: { name: 'pydantic', depends: ['typing-extensions', 'pydantic_core', 'annotated-types'] },
  'pydantic-core': { name: 'pydantic_core', depends: [] },
  'typing-extensions': { name: 'typing-extensions', depends: [] },
  'annotated-types': { name: 'annotated-types', depends: [] },
}
const completeMarkers = {
  pydantic: 'default channel',
  pydantic_core: 'default channel',
  'typing-extensions': 'default channel',
  'annotated-types': 'default channel',
}

describe('required Pyodide packages', () => {
  it('retries the missing dependency explicitly when a partial load has marked its parent loaded', async () => {
    const loadedPackages: Record<string, string> = {}
    const loadPackage = vi.fn()
      .mockImplementationOnce(async () => {
        Object.assign(loadedPackages, completeMarkers)
        delete loadedPackages['annotated-types']
        return [{ name: 'pydantic' }, { name: 'pydantic_core' }, { name: 'typing-extensions' }]
      })
      .mockImplementationOnce(async () => {
        loadedPackages['annotated-types'] = 'default channel'
        return [{ name: 'annotated-types' }]
      })

    await loadRequiredPackages({ loadPackage, loadedPackages }, lock, ['pydantic'])

    expect(loadPackage.mock.calls).toEqual([[['pydantic']], [['annotated-types']]])
  })

  it('walks the full lock closure even when the parent was loaded before this request', async () => {
    const loadedPackages: Record<string, string> = { ...completeMarkers }
    delete loadedPackages['annotated-types']
    const loadPackage = vi.fn(async (names: string[]) => {
      // The loader does no dependency traversal for an already-loaded parent.
      if (names.includes('annotated-types')) loadedPackages['annotated-types'] = 'default channel'
      return []
    })
    await loadRequiredPackages({ loadPackage, loadedPackages }, lock, ['pydantic'])
    expect(loadPackage.mock.calls).toEqual([[['pydantic']], [['annotated-types']]])
  })

  it('accepts complete existing markers even when the fulfilled result is empty', async () => {
    const loadPackage = vi.fn(async () => [])
    await loadRequiredPackages({ loadPackage, loadedPackages: completeMarkers }, lock, ['Pydantic', 'pydantic.core'])
    expect(loadPackage.mock.calls).toEqual([[['Pydantic', 'pydantic.core']]])
  })

  it('checks every transitive dependency and retries only the missing canonical names', async () => {
    const transitiveLock = {
      ...lock,
      'pydantic-core': { name: 'pydantic_core', depends: ['native_leaf'] },
      'native-leaf': { name: 'native_leaf', depends: [] },
    }
    const loadedPackages: Record<string, string> = { ...completeMarkers }
    delete loadedPackages.pydantic_core
    const loadPackage = vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      loadedPackages.pydantic_core = 'default channel'
      loadedPackages.native_leaf = 'default channel'
      return []
    })
    await loadRequiredPackages({ loadPackage, loadedPackages }, transitiveLock, ['pydantic'])
    expect(loadPackage.mock.calls[1]).toEqual([['native-leaf', 'pydantic-core']])
    expect(loadPackage).toHaveBeenCalledTimes(2)
  })

  it('includes shared libraries and standard-library modules in the dependency closure', async () => {
    const nativeLock = {
      anyio: { name: 'anyio', depends: ['ssl'], package_type: 'package' },
      ssl: { name: 'ssl', depends: ['openssl'], package_type: 'cpython_module' },
      openssl: { name: 'openssl', depends: [], package_type: 'shared_library' },
    }
    const loadPackage = vi.fn(async () => [])
    await expect(loadRequiredPackages({ loadPackage, loadedPackages: { anyio: 'default channel' } }, nativeLock, ['anyio']))
      .rejects.toThrow('Failed to load required Pyodide packages: openssl, ssl')
    expect(loadPackage.mock.calls).toEqual([[['anyio']], [['openssl', 'ssl']]])
  })

  it('stops after one retry and names all dependencies still missing', async () => {
    const loadedPackages: Record<string, string> = { pydantic: 'default channel', pydantic_core: 'default channel' }
    const loadPackage = vi.fn(async () => [])
    await expect(loadRequiredPackages({ loadPackage, loadedPackages }, lock, ['pydantic']))
      .rejects.toThrow('Failed to load required Pyodide packages: annotated-types, typing-extensions')
    expect(loadPackage.mock.calls).toEqual([[['pydantic']], [['annotated-types', 'typing-extensions']]])
  })

  it('does not treat a fulfilled result as proof of a loaded package', async () => {
    const loadPackage = vi.fn(async () => [{ name: 'annotated-types' }])
    await expect(loadRequiredPackages({ loadPackage, loadedPackages: {} }, lock, ['annotated-types']))
      .rejects.toThrow('Failed to load required Pyodide packages: annotated-types')
    expect(loadPackage).toHaveBeenCalledTimes(2)
  })

  it('requires an actual loaded marker, not an inherited property', async () => {
    const loadPackage = vi.fn(async () => [])
    await expect(loadRequiredPackages({ loadPackage, loadedPackages: Object.create(completeMarkers) }, lock, ['annotated-types']))
      .rejects.toThrow('Failed to load required Pyodide packages: annotated-types')
  })

  it.each([undefined, null, [], 'invalid'])('reports an unavailable or invalid loaded-package marker map (%#)', async loadedPackages => {
    const loadPackage = vi.fn(async () => [])
    await expect(loadRequiredPackages({ loadPackage, loadedPackages }, lock, ['pydantic']))
      .rejects.toThrow('Missing or invalid Pyodide loaded-package markers')
    expect(loadPackage).toHaveBeenCalledTimes(1)
  })

  it.each([
    [undefined, 'Missing or invalid Pyodide package lock'],
    [{}, 'Required Pyodide package is missing from the lock: pydantic'],
    [{ ...lock, pydantic: { name: 'pydantic', depends: ['unknown-package'] } }, 'missing from the lock: unknown-package'],
    [{ ...lock, pydantic: { name: 'different', depends: [] } }, 'Invalid Pyodide package lock entry: pydantic'],
    [{ ...lock, pydantic: { name: 'pydantic', depends: null } }, 'Invalid Pyodide package lock entry: pydantic'],
    [{ ...lock, pydantic: { name: 'pydantic', depends: [null] } }, 'Invalid Pyodide package name: null'],
    [{ ...lock, pydantic: { name: 'pydantic', depends: ['https://outside.invalid/a.whl'] } }, 'Invalid Pyodide package name'],
  ])('rejects an unknown or invalid required lock entry before loading (%#)', async (invalidLock, message) => {
    const loadPackage = vi.fn(async () => [])
    await expect(loadRequiredPackages({ loadPackage, loadedPackages: completeMarkers }, invalidLock, ['pydantic']))
      .rejects.toThrow(message as string)
    expect(loadPackage).not.toHaveBeenCalled()
  })

  it('preserves a rejecting native load without starting an unrelated retry', async () => {
    const loadPackage = vi.fn(async () => { throw new Error('loader rejected') })
    await expect(loadRequiredPackages({ loadPackage, loadedPackages: {} }, lock, ['pydantic']))
      .rejects.toThrow('loader rejected')
    expect(loadPackage).toHaveBeenCalledTimes(1)
  })

  it('names the targeted dependency and retains the cause when its retry rejects', async () => {
    const loadedPackages: Record<string, string> = { ...completeMarkers }
    delete loadedPackages['annotated-types']
    const cause = new Error('runtime failed')
    const loadPackage = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(cause)
    await expect(loadRequiredPackages({ loadPackage, loadedPackages }, lock, ['pydantic']))
      .rejects.toMatchObject({
        message: 'Failed to retry required Pyodide packages (annotated-types): runtime failed',
        cause,
      })
    expect(loadPackage.mock.calls).toEqual([[['pydantic']], [['annotated-types']]])
  })
})
