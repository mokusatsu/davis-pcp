interface PackageRuntime {
  loadPackage: (names: string[]) => Promise<unknown>
  loadedPackages: unknown
}

interface RequiredPackage {
  canonicalName: string
  markerName: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalName(name: unknown): string {
  if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(name)) {
    throw new Error(`Invalid Pyodide package name: ${String(name)}`)
  }
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function requiredPackageClosure(lockPackages: unknown, requested: readonly string[]): RequiredPackage[] {
  if (!isRecord(lockPackages)) throw new Error('Missing or invalid Pyodide package lock')
  const required = new Map<string, RequiredPackage>()
  const visit = (name: string) => {
    const canonical = canonicalName(name)
    if (required.has(canonical)) return
    if (!Object.hasOwn(lockPackages, canonical)) {
      throw new Error(`Required Pyodide package is missing from the lock: ${canonical}`)
    }
    const entry = lockPackages[canonical]
    if (!isRecord(entry) || typeof entry.name !== 'string'
      || canonicalName(entry.name) !== canonical || !Array.isArray(entry.depends)) {
      throw new Error(`Invalid Pyodide package lock entry: ${canonical}`)
    }
    required.set(canonical, { canonicalName: canonical, markerName: entry.name })
    // Walk dependencies even when their parent is already marked loaded.
    for (const dependency of entry.depends) {
      visit(canonicalName(dependency))
    }
  }
  requested.forEach(visit)
  return [...required.values()]
}

export async function loadRequiredPackages(
  runtime: PackageRuntime,
  lockPackages: unknown,
  requested: readonly string[],
): Promise<void> {
  const required = requiredPackageClosure(lockPackages, requested)
  const missingPackages = () => {
    const markers = runtime.loadedPackages
    if (!isRecord(markers)) throw new Error('Missing or invalid Pyodide loaded-package markers')
    return required
      .filter(({ markerName }) => !Object.hasOwn(markers, markerName)
        || typeof markers[markerName] !== 'string' || markers[markerName] === '')
      .map(({ canonicalName }) => canonicalName)
      .sort()
  }

  // Pyodide 0.27.7 can fulfill this call after individual installs fail. The
  // return value also excludes already-loaded packages, so verify the markers.
  await runtime.loadPackage([...requested])
  let missing = missingPackages()
  if (missing.length === 0) return

  // Retrying the parents alone skips dependencies of already-loaded parents.
  // Keep default integrity verification and explicitly retry missing names once.
  try {
    await runtime.loadPackage(missing)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to retry required Pyodide packages (${missing.join(', ')}): ${detail}`, { cause: error })
  }
  missing = missingPackages()
  if (missing.length > 0) {
    throw new Error(`Failed to load required Pyodide packages: ${missing.join(', ')}`)
  }
}
